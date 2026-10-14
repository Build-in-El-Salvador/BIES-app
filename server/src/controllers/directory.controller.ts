import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { recomputeListingScore, TRUSTED_THRESHOLD } from '../services/directoryReputation.service';
import { publishDirectoryListing } from '../services/nostr.service';
import { blockedEitherWay, blockedIds } from '../services/moderation.service';
import { config } from '../config';
import { transfersFor } from './listingTransfer.controller';
import { z } from 'zod';
import { discardUploads } from '../services/uploads.service';

// ─── Validation ───────────────────────────────────────────────────────────────

const phoneRegex = /^[+0-9\s()-]*$/;

/** Kinds of business in BIES Trusted (labels: directory.categories.* in the app). */
export const DIRECTORY_CATEGORIES = [
    'food', 'home', 'construction', 'legal', 'finance', 'real-estate', 'health', 'beauty',
    'auto', 'tech', 'education', 'travel', 'transport', 'shopping', 'professional', 'other',
] as const;

/** A downvote must say why, in at least this many characters. */
export const DOWNVOTE_REASON_MIN = 20;

/** A link to the place on a map app (Google, Apple, Waze, OpenStreetMap), for Directions. */
const MAPS_URL = /^https:\/\/((www\.)?google\.[a-z.]+\/maps|maps\.google\.[a-z.]+\/|maps\.app\.goo\.gl\/|goo\.gl\/maps|maps\.apple\.com\/|(www\.)?waze\.com\/|(www\.)?openstreetmap\.org\/)/i;

export const createDirectoryListingSchema = z.object({
    type: z.enum(['FARM', 'PROVIDER']),
    name: z.string().min(1).max(120),
    category: z.enum(DIRECTORY_CATEGORIES).optional().or(z.literal('')),
    hours: z.string().max(200).optional(),
    // The member adding it runs the business or works there.
    isOwnBusiness: z.boolean().optional(),
    // Create only: the member's own review, their vouch. Not a listing column.
    review: z.string().max(1000).optional(),
    about: z.string().max(5000).optional(),
    photo: z.string().max(500).optional().or(z.literal('')),
    logo: z.string().max(500).optional().or(z.literal('')),
    photos: z.array(z.string().max(500)).max(10).optional(),
    location: z.string().max(200).optional(),
    phone: z.string().max(30).regex(phoneRegex).optional().or(z.literal('')),
    whatsapp: z.string().max(30).regex(phoneRegex).optional().or(z.literal('')),
    email: z.string().email().max(254).optional().or(z.literal('')),
    // http(s) only — never allow javascript:/data: etc. to be stored as a link
    website: z.string().url().max(300).regex(/^https?:\/\//i).optional().or(z.literal('')),
    instagram: z.string().max(100).optional().or(z.literal('')),
    languages: z.array(z.string().max(20)).optional(),
    btcAccepted: z.boolean().optional(),
    products: z.array(z.object({
        label: z.string().min(1).max(60),
        icon: z.string().max(30).optional(),
    })).max(20).optional(),
    practices: z.array(z.enum(['regenerative', 'rotational-grazing', 'no-gmo-feed', 'animal-welfare'])).optional(),
    skills: z.array(z.string().max(60)).max(20).optional(),
    bestFor: z.string().max(200).optional(),
    pricing: z.string().max(200).optional(),
    comment: z.string().max(500).optional(),
    mapUrl: z.string().max(500).regex(MAPS_URL, 'Use a Google Maps, Apple Maps, Waze or OpenStreetMap link').optional().or(z.literal('')),
    memberUserId: z.string().optional().or(z.literal('')),
});

export const updateDirectoryListingSchema = createDirectoryListingSchema.omit({ review: true }).partial();

/** A member's review: a vouch (1) or a downvote (-1), which needs a reason. */
export const endorseSchema = z.object({
    vote: z.union([z.literal(1), z.literal(-1)]).default(1),
    comment: z.string().max(1000).optional(),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Fields writable by owners — never status/isFeatured/baseScore/reputationScore/
// the vote counts/isCertified/nostrListingEventId (admin- or system-controlled).
// memberUserId only by staff: a linked member's key signs the listing's Nostr
// event, so members can't link someone else (STAFF_FIELDS).
const ALLOWED_FIELDS = [
    'type', 'name', 'category', 'hours', 'isOwnBusiness', 'about', 'photo', 'logo', 'photos', 'location',
    'phone', 'whatsapp', 'email', 'website', 'instagram', 'languages',
    'btcAccepted', 'products', 'practices', 'skills', 'bestFor',
    'pricing', 'comment', 'mapUrl',
];
const STAFF_FIELDS = ['memberUserId'];

const isStaff = (req: Request) => !!req.user && (req.user.isAdmin || req.user.role === 'MOD');

const JSON_ARRAY_FIELDS = ['photos', 'languages', 'products', 'practices', 'skills'] as const;

const ownerSelect = {
    select: {
        id: true, nostrPubkey: true, role: true,
        profile: { select: { name: true, avatar: true } },
    },
};

// Detail-page memberUser include — adds the lightning fields the frontend
// ZapButton passes as lud16/bolt12Offer (same shape Discover's cards use).
const memberUserSelect = {
    select: {
        id: true, nostrPubkey: true, role: true,
        profile: { select: { name: true, avatar: true, lightningAddress: true, bolt12Offer: true } },
    },
};

/**
 * The member a listing belongs to: its linked member when staff entered it
 * for them, otherwise whoever created it. Blocks and reports go by this.
 */
export function listingMember(listing: { ownerId: string; memberUserId: string | null }): string {
    return listing.memberUserId ?? listing.ownerId;
}

function parseListing(listing: any): any {
    return {
        ...listing,
        photos: JSON.parse(listing.photos || '[]'),
        languages: JSON.parse(listing.languages || '[]'),
        products: JSON.parse(listing.products || '[]'),
        practices: JSON.parse(listing.practices || '[]'),
        skills: JSON.parse(listing.skills || '[]'),
    };
}

function pickAllowedFields(body: any, staff: boolean): any {
    const data: any = {};
    for (const field of staff ? [...ALLOWED_FIELDS, ...STAFF_FIELDS] : ALLOWED_FIELDS) {
        if (body[field] !== undefined) data[field] = body[field];
    }
    for (const field of JSON_ARRAY_FIELDS) {
        if (data[field]) data[field] = JSON.stringify(data[field]);
    }
    return data;
}

/**
 * Mirror a live listing to the BIES relay as a NIP-99 classified (replaceable
 * kind:30402 keyed by d-tag = listing id), signed by the linked member's key
 * when set, else the owner's. Doesn't wait; members who sign on their own
 * device mirror from the app instead.
 */
export function mirrorToNostr(listing: any): void {
    if (listing.status !== 'active') return;
    publishDirectoryListing(listing.memberUserId ?? listing.ownerId, listing)
        .then(async (eventId) => {
            if (eventId) {
                await prisma.directoryListing.update({
                    where: { id: listing.id },
                    data: { nostrListingEventId: eventId },
                });
            }
        })
        .catch((err) => console.error('[Nostr] Directory listing sync failed:', err));
}

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * GET /directory
 * List directory listings with filtering, sorting, and pagination.
 * Public scope: active + published. Owners see all statuses of their own.
 */
export async function listListings(req: Request, res: Response): Promise<void> {
    try {
        const {
            type, search, certified, btc, language, ownerId, category, saved,
            page = '1', limit = '20',
            sort = 'newest',
        } = req.query;

        const skip = (parseInt(page as string, 10) - 1) * parseInt(limit as string, 10);
        const take = Math.min(parseInt(limit as string, 10), 50);

        const where: any = { status: 'active', isPublished: true };

        if (type && typeof type === 'string') where.type = type.toUpperCase();
        if (ownerId && typeof ownerId === 'string') {
            where.ownerId = ownerId;
            // When viewing own listings, show all statuses
            if (req.user && req.user.id === ownerId) {
                delete where.isPublished;
                delete where.status;
            }
        }
        if (certified === 'true') where.isCertified = true;
        // The viewer's saved listings (signed out: none).
        if (saved === 'true') where.saves = { some: { userId: req.user?.id ?? '' } };
        if (category && typeof category === 'string') where.category = category;
        if (btc === 'true') where.btcAccepted = true;
        if (language && typeof language === 'string') {
            where.languages = { contains: language };
        }
        if (search && typeof search === 'string') {
            where.OR = [
                { name: { contains: search } },
                { about: { contains: search } },
                { location: { contains: search } },
                { products: { contains: search } },
                { skills: { contains: search } },
            ];
        }

        let orderBy: any = { createdAt: 'desc' };
        if (sort === 'name') orderBy = { name: 'asc' };
        if (sort === 'score') orderBy = [{ reputationScore: 'desc' }, { vouchCount: 'desc' }, { createdAt: 'desc' }];

        const [listings, total] = await Promise.all([
            prisma.directoryListing.findMany({
                where,
                include: {
                    owner: ownerSelect,
                    memberUser: ownerSelect,
                    _count: { select: { endorsements: true } },
                },
                skip,
                take,
                orderBy,
            }),
            prisma.directoryListing.count({ where }),
        ]);

        // Listings run by a member the viewer blocked are left out.
        const hidden = new Set(await blockedIds(req.user?.id));
        const visible = hidden.size ? listings.filter((l) => !hidden.has(listingMember(l))) : listings;

        res.json({
            data: visible.map(parseListing),
            trustedThreshold: TRUSTED_THRESHOLD,
            pagination: {
                page: parseInt(page as string, 10),
                limit: take,
                total,
                totalPages: Math.ceil(total / take),
            },
        });
    } catch (error) {
        console.error('List directory listings error:', error);
        res.status(500).json({ error: 'Failed to list directory listings' });
    }
}

/**
 * GET /directory/:id
 * Get a single listing. Non-active/unpublished listings are only visible
 * to the owner or an admin.
 */
export async function getListing(req: Request, res: Response): Promise<void> {
    try {
        const listing = await prisma.directoryListing.findUnique({
            where: { id: req.params.id },
            include: {
                owner: ownerSelect,
                memberUser: memberUserSelect,
                endorsements: {
                    orderBy: { createdAt: 'desc' },
                    include: { user: ownerSelect },
                },
                _count: { select: { endorsements: true } },
            },
        });

        if (!listing) {
            res.status(404).json({ error: 'Listing not found' });
            return;
        }

        // Only allow owner/admin to view non-active or unpublished listings
        if (listing.status !== 'active' || !listing.isPublished) {
            const isOwner = req.user && listing.ownerId === req.user.id;
            const isAdmin = req.user && req.user.isAdmin;
            if (!isOwner && !isAdmin) {
                res.status(404).json({ error: 'Listing not found' });
                return;
            }
        }

        // A member the viewer blocked: their listing is gone for the viewer,
        // and so are their recommendations on other listings.
        const hidden = new Set(await blockedIds(req.user?.id));
        if (hidden.has(listingMember(listing))) {
            res.status(404).json({ error: 'You blocked the member who runs this listing', reason: 'blocked' });
            return;
        }
        // Reviews are for members: signed out, only the counts.
        const reviews = req.user ? listing.endorsements.filter((e) => !hidden.has(e.userId)) : [];
        const savedByMe = req.user
            ? !!(await prisma.savedListing.findUnique({
                where: { userId_listingId: { userId: req.user.id, listingId: listing.id } },
                select: { id: true },
            }))
            : false;
        // Open ownership requests the viewer can see or answer.
        const transfers = await transfersFor(listing, req);
        const shown = { ...listing, endorsements: reviews, trustedThreshold: TRUSTED_THRESHOLD, savedByMe, transfers };

        // Fire-and-forget view count increment
        prisma.directoryListing.update({
            where: { id: listing.id },
            data: { viewCount: { increment: 1 } },
        }).catch(() => {});

        res.json(parseListing(shown));
    } catch (error) {
        console.error('Get directory listing error:', error);
        res.status(500).json({ error: 'Failed to get directory listing' });
    }
}

/**
 * POST /directory
 * Create a listing. Allow-listed fields only. It goes live at once, and its
 * Trust Score tells members how far to trust it — unless
 * DIRECTORY_REQUIRE_APPROVAL holds members' listings for staff to approve.
 */
export async function createListing(req: Request, res: Response): Promise<void> {
    try {
        const data = pickAllowedFields(req.body, isStaff(req));
        if (data.memberUserId === '') delete data.memberUserId;

        if (data.memberUserId) {
            const memberUser = await prisma.user.findUnique({
                where: { id: data.memberUserId },
                select: { id: true },
            });
            if (!memberUser) {
                res.status(400).json({ error: 'Linked member user not found' });
                return;
            }
        }

        const status = isStaff(req) || !config.directoryRequireApproval ? 'active' : 'pending-review';

        // A member recommending a business vouches for it with their review;
        // one adding their own business doesn't.
        const listing = await prisma.directoryListing.create({
            data: {
                ...data, ownerId: req.user!.id, status,
                ...(data.isOwnBusiness ? {} : {
                    endorsements: { create: { userId: req.user!.id, vote: 1, comment: (req.body.review || '').trim() } },
                }),
            },
            include: {
                owner: ownerSelect,
                memberUser: ownerSelect,
            },
        });

        await recomputeListingScore(listing.id).catch((err) =>
            console.error('[Directory] Score recompute failed:', err)
        );
        mirrorToNostr(listing);

        res.status(201).json(parseListing(listing));
    } catch (error) {
        console.error('Create directory listing error:', error);
        res.status(500).json({ error: 'Failed to create directory listing' });
    }
}

/**
 * PUT /directory/:id
 * Update a listing (owner or admin). Allow-listed fields only.
 */
export async function updateListing(req: Request, res: Response): Promise<void> {
    try {
        const existing = await prisma.directoryListing.findUnique({
            where: { id: req.params.id },
            select: { ownerId: true, photo: true, logo: true, photos: true },
        });

        if (!existing) { res.status(404).json({ error: 'Listing not found' }); return; }
        if (existing.ownerId !== req.user!.id && !req.user!.isAdmin) {
            res.status(403).json({ error: 'Not authorized to update this listing' }); return;
        }

        const data = pickAllowedFields(req.body, isStaff(req));
        if (data.memberUserId === '') data.memberUserId = null;

        if (data.memberUserId) {
            const memberUser = await prisma.user.findUnique({
                where: { id: data.memberUserId },
                select: { id: true },
            });
            if (!memberUser) {
                res.status(400).json({ error: 'Linked member user not found' });
                return;
            }
        }

        const listing = await prisma.directoryListing.update({
            where: { id: req.params.id },
            data,
            include: {
                owner: ownerSelect,
                memberUser: ownerSelect,
            },
        });

        // Photos taken off it go, if the owner or this editor uploaded them.
        const removed = listingPhotos(existing).filter((url) => !listingPhotos(listing).includes(url));
        if (removed.length) await discardUploads(removed, { uploadedBy: [existing.ownerId, req.user!.id] });

        // Now marked as their own business: their vouch goes.
        if (data.isOwnBusiness === true) {
            await prisma.directoryEndorsement.deleteMany({ where: { listingId: listing.id, userId: listing.ownerId } });
        }

        await recomputeListingScore(listing.id).catch((err) =>
            console.error('[Directory] Score recompute failed:', err)
        );

        mirrorToNostr(listing);

        res.json(parseListing(listing));
    } catch (error) {
        console.error('Update directory listing error:', error);
        res.status(500).json({ error: 'Failed to update directory listing' });
    }
}

/**
 * DELETE /directory/:id
 * Delete a listing (owner or admin).
 */
export async function deleteListing(req: Request, res: Response): Promise<void> {
    try {
        const existing = await prisma.directoryListing.findUnique({
            where: { id: req.params.id },
            select: { ownerId: true },
        });

        if (!existing) { res.status(404).json({ error: 'Listing not found' }); return; }
        if (existing.ownerId !== req.user!.id && !req.user!.isAdmin) {
            res.status(403).json({ error: 'Not authorized to delete this listing' }); return;
        }

        await deleteListingAndFiles(req.params.id, req.user!.id);

        res.json({ message: 'Listing deleted' });
    } catch (error) {
        console.error('Delete directory listing error:', error);
        res.status(500).json({ error: 'Failed to delete directory listing' });
    }
}

/** A listing's photo, logo and gallery, as stored. */
function listingPhotos(listing: { photo: string; logo: string; photos: string }): string[] {
    let gallery: unknown = [];
    try { gallery = JSON.parse(listing.photos || '[]'); } catch { /* not JSON: no gallery */ }
    return [listing.photo, listing.logo, ...(Array.isArray(gallery) ? gallery : [])]
        .filter((url): url is string => typeof url === 'string' && !!url);
}

/**
 * Delete a listing, and the files that showed only on it: its photos (when
 * its owner or `actorId` uploaded them) and its albums' photos. Admins'
 * deletes come here too (admin.controller.ts deleteDirectoryListing).
 */
export async function deleteListingAndFiles(id: string, actorId: string): Promise<void> {
    const listing = await prisma.directoryListing.findUnique({
        where: { id },
        select: { ownerId: true, photo: true, logo: true, photos: true, albums: { select: { photos: { select: { url: true } } } } },
    });
    if (!listing) return;
    await prisma.directoryListing.delete({ where: { id } });
    await discardUploads(listingPhotos(listing), { uploadedBy: [listing.ownerId, actorId] });
    await discardUploads(listing.albums.flatMap((a) => a.photos.map((p) => p.url)));
}

/** The new counts and status of a listing, for the review endpoints' answers. */
async function trustOf(listingId: string) {
    return prisma.directoryListing.findUnique({
        where: { id: listingId },
        select: { reputationScore: true, vouchCount: true, downvoteCount: true, isCertified: true },
    });
}

/**
 * POST /directory/:id/endorse
 * Review a listing: { vote: 1 | -1, comment }. One review per member per
 * listing; posting again changes it. A downvote needs a reason. Whoever runs
 * the business can't review it, and only live listings can be reviewed.
 */
export async function endorseListing(req: Request, res: Response): Promise<void> {
    try {
        const listing = await prisma.directoryListing.findUnique({
            where: { id: req.params.id },
            select: { id: true, ownerId: true, memberUserId: true, isOwnBusiness: true, status: true },
        });

        if (!listing) { res.status(404).json({ error: 'Listing not found' }); return; }
        if (listing.status !== 'active') {
            res.status(409).json({ error: 'This listing is not live yet', reason: 'not_live' });
            return;
        }
        const userId = req.user!.id;
        if (listing.memberUserId === userId || (listing.isOwnBusiness && listing.ownerId === userId)) {
            res.status(403).json({ error: "You can't review your own business", reason: 'own_business' });
            return;
        }
        if (await blockedEitherWay(userId, listingMember(listing))) {
            res.status(403).json({ error: "You can't recommend this listing", reason: 'blocked' });
            return;
        }

        const vote: number = req.body.vote;
        const comment = (req.body.comment || '').trim();
        if (vote < 0 && comment.length < DOWNVOTE_REASON_MIN) {
            res.status(400).json({
                error: `Say why you don't recommend them (at least ${DOWNVOTE_REASON_MIN} characters)`,
                reason: 'reason_required',
                min: DOWNVOTE_REASON_MIN,
            });
            return;
        }

        const endorsement = await prisma.directoryEndorsement.upsert({
            where: { listingId_userId: { listingId: listing.id, userId } },
            create: { listingId: listing.id, userId, vote, comment },
            update: { vote, comment },
        });

        await recomputeListingScore(listing.id);

        res.status(201).json({ ...endorsement, listing: await trustOf(listing.id) });
    } catch (error) {
        console.error('Endorse listing error:', error);
        res.status(500).json({ error: 'Failed to endorse listing' });
    }
}

/**
 * DELETE /directory/:id/endorse
 * Remove own endorsement.
 */
export async function removeEndorsement(req: Request, res: Response): Promise<void> {
    try {
        const deleted = await prisma.directoryEndorsement.deleteMany({
            where: { listingId: req.params.id, userId: req.user!.id },
        });

        if (deleted.count === 0) {
            res.status(404).json({ error: 'Endorsement not found' });
            return;
        }

        await recomputeListingScore(req.params.id).catch((err) =>
            console.error('[Directory] Score recompute failed:', err)
        );

        res.json({ message: 'Endorsement removed', listing: await trustOf(req.params.id) });
    } catch (error) {
        console.error('Remove endorsement error:', error);
        res.status(500).json({ error: 'Failed to remove endorsement' });
    }
}

/**
 * POST /directory/:id/save — keep a listing for later (Google Maps "Save").
 * DELETE /directory/:id/save — forget it. Both answer { saved }.
 */
export async function saveListing(req: Request, res: Response): Promise<void> {
    try {
        const listing = await prisma.directoryListing.findUnique({ where: { id: req.params.id }, select: { id: true } });
        if (!listing) { res.status(404).json({ error: 'Listing not found' }); return; }
        await prisma.savedListing.upsert({
            where: { userId_listingId: { userId: req.user!.id, listingId: listing.id } },
            create: { userId: req.user!.id, listingId: listing.id },
            update: {},
        });
        res.json({ saved: true });
    } catch (error) {
        console.error('Save directory listing error:', error);
        res.status(500).json({ error: 'Failed to save listing' });
    }
}

export async function unsaveListing(req: Request, res: Response): Promise<void> {
    try {
        await prisma.savedListing.deleteMany({ where: { userId: req.user!.id, listingId: req.params.id } });
        res.json({ saved: false });
    } catch (error) {
        console.error('Unsave directory listing error:', error);
        res.status(500).json({ error: 'Failed to unsave listing' });
    }
}
