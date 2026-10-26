/**
 * BIES Talents: members list what they offer to do for others (a skill or a
 * service), the work they take on (one-off jobs, short-term, long-term), and
 * their proof of work: examples of what they've made or done, with photos,
 * videos and links. It's on the Talents page and on their profile.
 *
 * A member lists only themselves, up to MAX_TALENTS_PER_MEMBER times, and only
 * they change what it says; staff can remove one (a report). Members only:
 * a person's WhatsApp and email are on it. Photos and videos (and a video's
 * poster) are the member's own BIES uploads (POST /upload/media), and their
 * files go when they're taken off or the listing goes
 * (services/uploads.service.ts).
 */

import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { blockedIds, hasBlocked, hiddenFromIds, isStaffUser } from '../services/moderation.service';
import { discardUploads, ownsUploads } from '../services/uploads.service';
import { alphabetical, inIdOrder, inOrder, newestFirst, pageIds } from '../utils/listOrder';
import { coverFrameSchema, frameNewCover } from '../utils/coverFrame';

// ─── Validation ───────────────────────────────────────────────────────────────

/** Kinds of talent (labels: talent.categories.* in the app). */
export const TALENT_CATEGORIES = [
    'tech', 'design', 'media', 'marketing', 'writing', 'teaching', 'professional',
    'trades', 'home', 'events', 'wellness', 'transport', 'other',
] as const;

/** The work a member takes on: a single job, a few weeks or months, or ongoing. */
export const WORK_TYPES = ['one-off', 'short-term', 'long-term'] as const;

export const MAX_TALENTS_PER_MEMBER = 5;
export const MAX_WORKS = 8;
/** Photos and videos, together, for one example of their work. */
export const MAX_WORK_MEDIA = 4;

const phoneRegex = /^[+0-9\s()-]*$/;
// http(s) only — never javascript:/data: etc. as a link
const webLink = z.string().url().max(300).regex(/^https?:\/\//i);
const uploadLink = z.string().min(1).max(500);

/** A photo, or a video with a still from it to show before it plays. */
const mediaSchema = z.object({
    url: uploadLink,
    poster: uploadLink.optional(),
});

/** One example of their work. "details", not "description": that name keeps HTML (middleware/sanitize.ts). */
const workSchema = z.object({
    title: z.string().min(1).max(100),
    details: z.string().max(1000).default(''),
    link: webLink.or(z.literal('')).default(''),
    year: z.string().max(20).default(''),
    media: z.array(mediaSchema).max(MAX_WORK_MEDIA).default([]),
});

export const createTalentSchema = z.object({
    title: z.string().min(1).max(80),
    category: z.enum(TALENT_CATEGORIES),
    about: z.string().max(3000).optional(),
    skills: z.array(z.string().min(1).max(40)).max(15).optional(),
    workTypes: z.array(z.enum(WORK_TYPES)).min(1),
    available: z.boolean().optional(),
    remote: z.boolean().optional(),
    location: z.string().max(120).optional(),
    rate: z.string().max(120).optional(),
    btcAccepted: z.boolean().optional(),
    languages: z.array(z.string().min(1).max(30)).max(10).optional(),
    photo: uploadLink.optional().or(z.literal('')),
    coverFrame: coverFrameSchema.optional(),
    works: z.array(workSchema).max(MAX_WORKS).optional(),
    whatsapp: z.string().max(30).regex(phoneRegex).optional().or(z.literal('')),
    email: z.string().email().max(254).optional().or(z.literal('')),
    website: webLink.optional().or(z.literal('')),
});

export const updateTalentSchema = createTalentSchema.partial();

// ─── Helpers ──────────────────────────────────────────────────────────────────

const FIELDS = [
    'title', 'category', 'about', 'skills', 'workTypes', 'available', 'remote', 'location',
    'rate', 'btcAccepted', 'languages', 'photo', 'coverFrame', 'works', 'whatsapp', 'email', 'website',
] as const;

const memberSelect = {
    select: {
        id: true, nostrPubkey: true, isBanned: true, deletedAt: true,
        profile: { select: { name: true, avatar: true } },
    },
};

type Work = z.infer<typeof workSchema>;

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
    try {
        const value = JSON.parse(raw || '');
        return Array.isArray(value) ? value as T : fallback;
    } catch {
        return fallback;
    }
}

const unique = (list: string[]) => [...new Set(list)];

/** The columns to write, from a validated body. */
function talentData(body: Record<string, any>): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    for (const field of FIELDS) {
        if (body[field] !== undefined) data[field] = body[field];
    }
    if (body.skills) data.skills = JSON.stringify(unique(body.skills));
    if (body.languages) data.languages = JSON.stringify(unique(body.languages));
    // Always in the same order, once each.
    if (body.workTypes) data.workTypes = JSON.stringify(WORK_TYPES.filter((w) => body.workTypes.includes(w)));
    if (body.works) data.works = JSON.stringify(body.works);
    return data;
}

/** A listing's files: its cover, and its works' photos, videos and posters, stored (JSON) or as sent. */
export function filesOf(listing: { photo?: string | null; works?: string | Work[] | null }): string[] {
    const works = typeof listing.works === 'string' ? parseJson<Work[]>(listing.works, []) : listing.works ?? [];
    const media = works.flatMap((w) => (Array.isArray(w?.media) ? w.media : []));
    return [listing.photo, ...media.flatMap((m) => [m?.url, m?.poster])]
        .filter((url): url is string => typeof url === 'string' && !!url);
}

/**
 * In a list, without the member's WhatsApp and email: those come only with
 * one talent (GET /talent/:id), so a list can't gather everyone's.
 */
function listedTalent(talent: any) {
    const { whatsapp: _whatsapp, email: _email, ...listed } = parseTalent(talent);
    return listed;
}

/** As the app gets it: lists parsed, and only the member's name and photo. */
function parseTalent(talent: any) {
    const { user, ...rest } = talent;
    return {
        ...rest,
        skills: parseJson(talent.skills, []),
        workTypes: parseJson(talent.workTypes, []),
        languages: parseJson(talent.languages, []),
        works: parseJson(talent.works, []),
        user: user && {
            id: user.id,
            nostrPubkey: user.nostrPubkey,
            profile: { name: user.profile?.name ?? '', avatar: user.profile?.avatar ?? '' },
        },
    };
}

// ─── Controllers ──────────────────────────────────────────────────────────────

// Talent's orders (?sort=): members taking on work first (the default), the
// newest, or A–Z by what they offer (in code: utils/listOrder.ts).
const TALENT_ORDERS: Record<string, any> = {
    available: [{ available: 'desc' }, { updatedAt: 'desc' }, { id: 'asc' }],
    newest: [{ createdAt: 'desc' }, { id: 'asc' }],
};
type TalentSortKeys = { id: string; title: string; createdAt: Date };
const TALENT_ORDERS_IN_CODE: Record<string, (a: TalentSortKeys, b: TalentSortKeys) => number> = {
    name: inOrder(alphabetical((t) => t.title), newestFirst<TalentSortKeys>((t) => t.createdAt)),
};

/**
 * GET /talent?search&category&workType&available&remote&btc&userId&sort&page&limit
 * Members taking on work first, then the most recently updated; or
 * ?sort=newest, or name (A–Z). Not the
 * talent of suspended or deleted members, nor of members blocked either way.
 */
export async function listTalent(req: Request, res: Response): Promise<void> {
    try {
        const { search, category, workType, available, remote, btc, userId } = req.query;
        const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
        const take = Math.min(Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20), 50);

        const where: any = { user: { isBanned: false, deletedAt: null } };
        const and: any[] = [];
        if (typeof userId === 'string' && userId) where.userId = userId;
        if (typeof category === 'string' && (TALENT_CATEGORIES as readonly string[]).includes(category)) where.category = category;
        if (typeof workType === 'string' && (WORK_TYPES as readonly string[]).includes(workType)) {
            where.workTypes = { contains: `"${workType}"` };
        }
        if (available === 'true') where.available = true;
        if (remote === 'true') where.remote = true;
        if (btc === 'true') where.btcAccepted = true;
        if (typeof search === 'string' && search.trim()) {
            const q = search.trim().slice(0, 100);
            where.OR = [
                { title: { contains: q } },
                { about: { contains: q } },
                { skills: { contains: q } },
                { location: { contains: q } },
                { user: { profile: { is: { name: { contains: q } } } } },
            ];
        }
        const hidden = await hiddenFromIds(req.user!.id, { staff: isStaffUser(req.user) });
        if (hidden.length) and.push({ userId: { notIn: hidden } });
        if (and.length) where.AND = and;

        const sort = typeof req.query.sort === 'string' ? req.query.sort : '';
        const inCode = TALENT_ORDERS_IN_CODE[sort];
        let talents: any[];
        let total: number;
        if (inCode) {
            const keys = await prisma.talentListing.findMany({ where, select: { id: true, title: true, createdAt: true } });
            const ids = pageIds(keys, inCode, (page - 1) * take, take);
            talents = inIdOrder(ids, await prisma.talentListing.findMany({ where: { id: { in: ids } }, include: { user: memberSelect } }));
            total = keys.length;
        } else {
            [talents, total] = await Promise.all([
                prisma.talentListing.findMany({
                    where,
                    include: { user: memberSelect },
                    orderBy: TALENT_ORDERS[sort] || TALENT_ORDERS.available,
                    skip: (page - 1) * take,
                    take,
                }),
                prisma.talentListing.count({ where }),
            ]);
        }

        res.json({
            data: talents.map(listedTalent),
            pagination: { page, limit: take, total, totalPages: Math.ceil(total / take) },
        });
    } catch (error) {
        console.error('List talent error:', error);
        res.status(500).json({ error: 'Failed to list talent' });
    }
}

/** GET /talent/:id */
export async function getTalent(req: Request, res: Response): Promise<void> {
    try {
        const talent = await prisma.talentListing.findUnique({
            where: { id: req.params.id },
            include: { user: memberSelect },
        });
        const viewer = req.user!;
        const own = !!talent && talent.userId === viewer.id;
        const staff = isStaffUser(viewer);
        if (!talent || ((talent.user.isBanned || talent.user.deletedAt) && !own && !staff)) {
            res.status(404).json({ error: 'Talent not found' });
            return;
        }
        // A member the viewer blocked: their talent is gone for the viewer.
        if ((await blockedIds(viewer.id)).includes(talent.userId)) {
            res.status(404).json({ error: 'You blocked this member', reason: 'blocked' });
            return;
        }
        // The member blocked the viewer: it isn't there for them.
        if (!own && !staff && await hasBlocked(talent.userId, { id: viewer.id })) {
            res.status(404).json({ error: 'Talent not found' });
            return;
        }
        res.json(parseTalent(talent));
    } catch (error) {
        console.error('Get talent error:', error);
        res.status(500).json({ error: 'Failed to get talent' });
    }
}

/** POST /talent: the member lists one of their talents. */
export async function createTalent(req: Request, res: Response): Promise<void> {
    try {
        const userId = req.user!.id;
        if (await prisma.talentListing.count({ where: { userId } }) >= MAX_TALENTS_PER_MEMBER) {
            res.status(409).json({
                error: `You can list up to ${MAX_TALENTS_PER_MEMBER} talents`,
                reason: 'too_many',
                max: MAX_TALENTS_PER_MEMBER,
            });
            return;
        }
        const files = filesOf(req.body);
        if (files.length && !(await ownsUploads(userId, files))) {
            res.status(400).json({ error: 'Add photos and videos by uploading them here', reason: 'not_your_photo' });
            return;
        }
        const talent = await prisma.talentListing.create({
            data: { ...talentData(req.body), userId } as any,
            include: { user: memberSelect },
        });
        // Counted again: requests sent at once all passed the count above.
        if (await prisma.talentListing.count({ where: { userId } }) > MAX_TALENTS_PER_MEMBER) {
            await prisma.talentListing.delete({ where: { id: talent.id } });
            res.status(409).json({
                error: `You can list up to ${MAX_TALENTS_PER_MEMBER} talents`,
                reason: 'too_many',
                max: MAX_TALENTS_PER_MEMBER,
            });
            return;
        }
        res.status(201).json(parseTalent(talent));
    } catch (error) {
        console.error('Create talent error:', error);
        res.status(500).json({ error: 'Failed to add talent' });
    }
}

/** PUT /talent/:id: only the member it belongs to. */
export async function updateTalent(req: Request, res: Response): Promise<void> {
    try {
        const existing = await prisma.talentListing.findUnique({
            where: { id: req.params.id },
            select: { userId: true, photo: true, works: true },
        });
        if (!existing) { res.status(404).json({ error: 'Talent not found' }); return; }
        if (existing.userId !== req.user!.id) {
            res.status(403).json({ error: 'Only the member it belongs to can change it' });
            return;
        }

        const before = filesOf(existing);
        const after = filesOf({
            photo: req.body.photo !== undefined ? req.body.photo : existing.photo,
            works: req.body.works !== undefined ? req.body.works : existing.works,
        });
        const added = after.filter((url) => !before.includes(url));
        if (added.length && !(await ownsUploads(existing.userId, added))) {
            res.status(400).json({ error: 'Add photos and videos by uploading them here', reason: 'not_your_photo' });
            return;
        }

        const data = talentData(req.body);
        frameNewCover(data, 'photo', existing.photo);
        const talent = await prisma.talentListing.update({
            where: { id: req.params.id },
            data,
            include: { user: memberSelect },
        });

        // Photos and videos taken off it go.
        const removed = before.filter((url) => !after.includes(url));
        if (removed.length) await discardUploads(removed, { uploadedBy: [existing.userId] });

        res.json(parseTalent(talent));
    } catch (error) {
        console.error('Update talent error:', error);
        res.status(500).json({ error: 'Failed to update talent' });
    }
}

/** DELETE /talent/:id: the member, or staff (a report). Its photos and videos go with it. */
export async function deleteTalent(req: Request, res: Response): Promise<void> {
    try {
        const existing = await prisma.talentListing.findUnique({
            where: { id: req.params.id },
            select: { userId: true, title: true, photo: true, works: true },
        });
        if (!existing) { res.status(404).json({ error: 'Talent not found' }); return; }
        const own = existing.userId === req.user!.id;
        if (!own && !isStaffUser(req.user)) {
            res.status(403).json({ error: 'Not authorized to delete this talent' });
            return;
        }

        await prisma.talentListing.delete({ where: { id: req.params.id } });
        if (!own) {
            await prisma.auditLog.create({
                data: {
                    userId: req.user!.id,
                    action: 'TALENT_REMOVED',
                    resource: `talent:${req.params.id}`,
                    metadata: JSON.stringify({ memberId: existing.userId, title: existing.title.slice(0, 200) }),
                },
            });
        }
        await discardUploads(filesOf(existing), { uploadedBy: [existing.userId] });

        res.json({ message: 'Talent deleted' });
    } catch (error) {
        console.error('Delete talent error:', error);
        res.status(500).json({ error: 'Failed to delete talent' });
    }
}
