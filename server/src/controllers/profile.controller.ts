import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { cache, cacheKey, TTL } from '../services/redis.service';
import { notifyProfileView } from '../services/notification.service';
import { publishProfileUpdate, publishAnnouncement } from '../services/nostr.service';
import { hasBlocked, hiddenFromIds, isStaffUser } from '../services/moderation.service';
import { matchesVisibly, nostrProfileFor, privacyOf, profileForViewer, type Viewer } from '../services/profilePrivacy';
import { z } from 'zod';
import { discardUploads } from '../services/uploads.service';
import { isEnabled } from '../services/featureFlags.service';
import { openNow } from './project.controller';
import { removeTags } from '../middleware/sanitize';
import { alphabetical, inOrder } from '../utils/listOrder';
import { networkPreviews } from '../services/memberNetwork';

// What a member card shows (Members: icons, list and cards). Everything else
// comes with the profile page itself (GET /profiles/:id), so a list of 48
// members doesn't carry 48 full bios, work histories and custom sections.
const CARD_BIO_CHARS = 200;
function memberCard(p: any) {
    return {
        id: p.id,
        userId: p.userId,
        name: p.name,
        avatar: p.avatar,
        title: p.title,
        company: p.company,
        location: p.location,
        bio: typeof p.bio === 'string' ? removeTags(p.bio).slice(0, CARD_BIO_CHARS) : p.bio,
        skills: Array.isArray(p.skills) ? p.skills.slice(0, 3) : [],
        tags: Array.isArray(p.tags) ? p.tags.slice(0, 3) : [],
        user: p.user ? { id: p.user.id, nostrPubkey: p.user.nostrPubkey } : undefined,
        // When their account was made, as their profile's "Joined" shows it.
        joinedAt: p.user?.createdAt ?? null,
    };
}

// ─── Validation ───────────────────────────────────────────────────────────────

// Every field has a size limit: what's saved is filtered and cached, so
// without one a single save could hold the server (generous for real use).
const short = z.string().max(200);
const url = z.string().max(2000);
const longText = z.string().max(10_000);
const list = (item: z.ZodTypeAny = short, max = 50) => z.array(item).max(max);

export const updateProfileSchema = z.object({
    name: z.string().max(100).optional(),
    bio: longText.optional(),
    avatar: url.optional(),
    banner: url.optional(),
    location: short.optional(),
    skills: list().optional(),
    website: z.string().max(2000).url().optional().or(z.literal('')),
    twitter: short.optional(),
    linkedin: url.optional(),
    github: short.optional(),
    company: short.optional(),
    title: short.optional(),
    tags: list().optional(),
    // Profile sections
    experience: list(z.object({
        title: short.optional(),
        company: short.optional(),
        date: short.optional(),
        description: longText.optional(),
    })).optional(),
    biesProjects: list(z.object({
        id: short,
        name: short,
        role: short.optional(),
        status: short.optional(),
        image: url.optional(),
    })).optional(),
    customSections: list(z.object({
        title: short.default(''),
        type: z.enum(['TEXT', 'PHOTO', 'CAROUSEL', 'GRAPH']).default('TEXT'),
        placement: z.enum(['LEFT', 'RIGHT']).default('LEFT'),
        body: z.string().max(20_000).optional(),
        content: z.string().max(20_000).optional(),
        imageUrl: url.optional(),
        images: list(url).optional(),
        graphType: short.optional(),
        xAxisLabel: short.optional(),
        yAxisLabel: short.optional(),
        dataPoints: list(z.object({ label: short, value: z.union([short, z.number()]) }), 100).optional(),
    }), 20).optional(),
    showExperience: z.boolean().optional(),
    nostrFeedMode: z.enum(['off', 'private', 'public', 'combined']).optional(),
    nostrNpub: short.optional(),
    // NIP-05 & Lightning
    nip05Name: z.string().min(3).max(30).regex(/^[a-z0-9._-]+$/, 'Only lowercase letters, numbers, dots, hyphens, underscores').optional(),
    lightningAddress: z.string().max(320).optional(),
    bolt12Offer: z.string().max(2000).regex(/^lno1[a-z0-9]+$/, 'Must be a valid Bolt12 offer (starts with lno1)').optional().or(z.literal('')),
    // Investor-specific
    investmentFocus: list().optional(),
    investmentStage: list().optional(),
    minTicket: z.number().positive().optional(),
    maxTicket: z.number().positive().optional(),
    // Builder-specific
    lookingFor: list().optional(),
    isPublic: z.boolean().optional(),
});

// Names@buildinelsalvador.com that would read as BIES itself speaking: kept
// for staff. Other Nostr clients show the name as verified by BIES's domain.
const RESERVED_NIP05 = new Set([
    'admin', 'administrator', 'root', 'support', 'help', 'info', 'contact', 'hello', 'team', 'staff',
    'mod', 'mods', 'moderator', 'moderators', 'official', 'bies', 'buildinelsalvador', 'security', 'abuse',
    'noreply', 'no-reply', 'postmaster', 'hostmaster', 'webmaster', 'billing', 'payments', 'press',
    'media', 'news', 'events', 'legal', 'privacy', 'verify', 'verified', 'system', 'app',
]);
// A name with one of these as a part ("bies.support", "admin_mike") is kept too.
const RESERVED_NIP05_PARTS = new Set(['admin', 'support', 'staff', 'mod', 'moderator', 'official', 'bies', 'security', 'verified']);

export function isReservedNip05(name: string): boolean {
    return RESERVED_NIP05.has(name) || name.split(/[._-]/).some((part) => RESERVED_NIP05_PARTS.has(part));
}

// ─── Controllers ─────────────────────────────────────────────────────────────

/** Who is looking at this profile: its member, another member, or anyone. */
const viewerOf = (req: Request, profileUserId: string): Viewer =>
    !req.user ? 'public' : req.user.id === profileUserId ? 'self' : 'member';

// Members' orders sorted in code (utils/listOrder.ts): A–Z as people read
// names, and the most followed first (then A–Z).
type MemberSortKeys = { id: string; name: string; user: { _count: { followers: number } } };
const byName = alphabetical<MemberSortKeys>((p) => p.name);
const MEMBER_ORDERS_IN_CODE: Record<string, (a: MemberSortKeys, b: MemberSortKeys) => number> = {
    name: inOrder(byName),
    followers: inOrder((a, b) => b.user._count.followers - a.user._count.followers, byName),
};

/**
 * GET /profiles
 * List profiles (cached), filterable by role, location, search; the most
 * viewed first, or ?sort=newest, name or followers. After the
 * cache, which all viewers share: members the viewer blocked are left out,
 * each profile shows only what this viewer may see (profilePrivacy.ts), and
 * a search or location only finds what the viewer can see.
 */
export async function listProfiles(req: Request, res: Response): Promise<void> {
    const respond = async (result: any) => {
        const hidden = new Set(await hiddenFromIds(req.user?.id, { staff: isStaffUser(req.user) }));
        const { search, location } = req.query;
        // ?fields=card: only what a member card shows, after the privacy
        // rules (profileForViewer) have been applied to the full profile.
        const asCard = req.query.fields === 'card';
        const shown = result.data
            .filter((p: any) => !hidden.has(p.userId))
            .filter((p: any) => typeof search !== 'string' || !search || matchesVisibly(p, search, viewerOf(req, p.userId)))
            .filter((p: any) => typeof location !== 'string' || !location
                || String(profileForViewer(p, viewerOf(req, p.userId)).location || '').toLowerCase().includes(location.toLowerCase()))
            .map((p: any) => profileForViewer(p, viewerOf(req, p.userId)));
        const data = asCard ? shown.map(memberCard) : shown;
        // Cards asked for with ?network=1 (the Cards layout) also carry the
        // network line, as this viewer may see it (services/memberNetwork.ts):
        // live, not from the shared cache, and for members only.
        const withNetwork = async (cards: any[]) => {
            if (!asCard || req.query.network !== '1' || !req.user) return cards;
            const full = new Map<string, any>(shown.map((p: any) => [p.userId, p]));
            const previews = await networkPreviews(req.user.id, cards.map((c) => ({
                userId: c.userId,
                networkHidden: !!full.get(c.userId)?.networkHidden,
                followers: full.get(c.userId)?.user?._count?.followers ?? 0,
            })), [...hidden]);
            return cards.map((c) => ({ ...c, network: previews.get(c.userId) }));
        };
        if (!result.searched) {
            res.json({ ...result, data: await withNetwork(data) });
            return;
        }
        // A search or location filter: every candidate was fetched, so the
        // page and the total come from what this viewer can see. A total
        // counted over hidden fields told them a hidden location matched.
        const { page, limit } = result.pagination;
        res.json({
            data: await withNetwork(data.slice((page - 1) * limit, page * limit)),
            pagination: { page, limit, total: data.length, totalPages: Math.ceil(data.length / limit) },
        });
    };
    try {
        // Numbers, in range, and short text: the cache key is built from
        // these, so made-up values can't each add an entry.
        const pageNumber = Math.min(Math.max(parseInt(String(req.query.page ?? '1'), 10) || 1, 1), 1000);
        const take = Math.min(Math.max(parseInt(String(req.query.limit ?? '20'), 10) || 20, 1), 50);
        const skip = (pageNumber - 1) * take;
        const text = (value: unknown) => (typeof value === 'string' ? value.slice(0, 100) : '');
        const location = text(req.query.location);
        const search = text(req.query.search);
        // What members do (builders, hosts, educators) anyone can filter by;
        // account roles (ADMIN, MOD, INVESTOR, MEMBER) only staff.
        const asked = text(req.query.role).toUpperCase();
        const role = ['BUILDER', 'EVENT_HOST', 'EDUCATOR'].includes(asked) ? asked
            : asked && isStaffUser(req.user) ? `STAFF:${asked}` : '';

        // ?sort=newest, name (A–Z) or followers (the most first); the most
        // viewed otherwise. A–Z and followers are sorted in code, over every
        // member (utils/listOrder.ts).
        const sort = ['newest', 'name', 'followers'].includes(text(req.query.sort)) ? text(req.query.sort) : '';
        const inCode = MEMBER_ORDERS_IN_CODE[sort];

        const cKey = cacheKey.profiles({ role, location, search, page: String(pageNumber), limit: String(take), ...(sort ? { sort } : {}) });

        const cached = await cache.getJson<any>(cKey);
        if (cached) { res.setHeader('X-Cache', 'HIT'); await respond(cached); return; }

        // Members who haven't finished their profile (no BIES name yet) stay
        // out of the list; the app asks them for one when they sign in.
        const where: any = { isPublic: true, AND: [{ name: { not: '' } }, { NOT: { name: { startsWith: 'nostr:' } } }] };

        // Suspended and deleted members aren't listed.
        where.user = { isBanned: false, deletedAt: null };
        if (role === 'BUILDER') {
            where.user.projects = { some: { isPublished: true } };
        } else if (role === 'EVENT_HOST') {
            where.user.hostedEvents = { some: { isPublished: true } };
        } else if (role === 'EDUCATOR') {
            where.user.role = 'EDUCATOR'; // Placeholder until courses are added
        } else if (role.startsWith('STAFF:')) {
            where.user.role = role.slice('STAFF:'.length); // ADMIN, MOD, INVESTOR, MEMBER
        }
        if (location) {
            where.location = { contains: location };
        }
        if (search) {
            where.OR = [
                { name: { contains: search } },
                { bio: { contains: search } },
                { company: { contains: search } },
                { location: { contains: search } },
                { title: { contains: search } },
            ];
        }

        // With a search or location, fetch every candidate (up to 500) and
        // let respond() page through what the viewer can see; with an order
        // sorted in code too, so the pages follow it.
        const searched = !!(search || location) || !!inCode;
        const [profiles, total] = await Promise.all([
            prisma.profile.findMany({
                where,
                include: {
                    user: {
                        select: {
                            id: true, nostrPubkey: true, role: true, isAdmin: true,
                            isVerified: true, createdAt: true,
                            _count: { select: { projects: true, followers: true, hostedEvents: true } },
                        },
                    },
                },
                skip: searched ? 0 : skip,
                take: searched ? 500 : take,
                // Most viewed first (or the newest); the id keeps members with
                // equal counts in one order, so the next page neither repeats
                // nor skips them.
                orderBy: sort === 'newest' ? [{ createdAt: 'desc' }, { id: 'asc' }] : [{ viewCount: 'desc' }, { id: 'asc' }],
            }),
            searched ? Promise.resolve(0) : prisma.profile.count({ where }),
        ]);
        if (inCode) profiles.sort(inCode);

        const parsed = profiles.map((p) => ({
            ...p,
            // Never expose encrypted wallet credentials
            coinosToken: undefined,
            skills: JSON.parse(p.skills || '[]'),
            tags: JSON.parse(p.tags || '[]'),
            investmentFocus: JSON.parse(p.investmentFocus || '[]'),
            investmentStage: JSON.parse(p.investmentStage || '[]'),
            lookingFor: JSON.parse(p.lookingFor || '[]'),
            experience: JSON.parse(p.experience || '[]'),
            biesProjects: JSON.parse(p.biesProjects || '[]'),
            customSections: JSON.parse(p.customSections || '[]'),
        }));

        const result = {
            data: parsed,
            pagination: {
                page: pageNumber,
                limit: take,
                total,
                totalPages: Math.ceil(total / take),
            },
            ...(searched ? { searched: true } : {}),
        };

        await cache.setJson(cKey, result, TTL.PROFILE_LIST);
        await respond(result);
    } catch (error) {
        console.error('List profiles error:', error);
        res.status(500).json({ error: 'Failed to list profiles' });
    }
}

/**
 * GET /profiles/:id
 * Get a single profile (cached, by userId or profileId), as this viewer may
 * see it (profilePrivacy.ts). A member who left the Members directory can
 * still be opened by members (from a post, say), not by anyone else. A
 * member the viewer blocked comes back as just a name, with `blocked: true`;
 * to a member they blocked, it isn't there at all (404), as on Facebook.
 */
export const lookupProfilesSchema = z.object({
    pubkeys: z.array(z.string().regex(/^[0-9a-f]{64}$/)).min(1).max(100),
});

/**
 * POST /profiles/lookup { pubkeys }
 * Members' BIES names and photos by Nostr key, for the Feed: the name a
 * member set here, not whatever their Nostr profile says elsewhere (or an old
 * copy of it). Members with a name only; not suspended or deleted ones, nor
 * anyone blocked either way. Name and photo are what any member sees on a
 * profile (profileForViewer).
 */
export async function lookupProfiles(req: Request, res: Response): Promise<void> {
    try {
        const { pubkeys } = req.body as z.infer<typeof lookupProfilesSchema>;
        const hidden = await hiddenFromIds(req.user!.id, { staff: isStaffUser(req.user) });
        const users = await prisma.user.findMany({
            where: {
                nostrPubkey: { in: [...new Set(pubkeys)] },
                isBanned: false,
                deletedAt: null,
                ...(hidden.length ? { id: { notIn: hidden } } : {}),
            },
            select: { nostrPubkey: true, profile: { select: { name: true, avatar: true } } },
        });
        const data: Record<string, { name: string; avatar: string }> = {};
        for (const user of users) {
            const name = user.profile?.name?.trim();
            // Unnamed: the app's own stand-in ("nostr:…"); their Nostr profile shows instead.
            if (!name || name.startsWith('nostr:')) continue;
            data[user.nostrPubkey] = { name, avatar: user.profile?.avatar || '' };
        }
        res.json({ data });
    } catch (error) {
        console.error('Lookup profiles error:', error);
        res.status(500).json({ error: 'Failed to look up profiles' });
    }
}

export async function getProfile(req: Request, res: Response): Promise<void> {
    const viewerBlocked = (ownerId: string) =>
        !!req.user && req.user.id !== ownerId ? hasBlocked(req.user.id, { id: ownerId }) : Promise.resolve(false);
    const respond = async (result: any) => {
        if (!req.user && !result.isPublic) {
            res.status(404).json({ error: 'Profile not found' });
            return;
        }
        // The viewer's own block first, so the way back (Unblock) stays even
        // when the other member blocked them too.
        if (await viewerBlocked(result.userId)) {
            res.json({
                id: result.id,
                userId: result.userId,
                name: result.name,
                avatar: result.avatar,
                user: { id: result.user?.id, nostrPubkey: result.user?.nostrPubkey },
                blocked: true,
            });
            return;
        }
        if (req.user && req.user.id !== result.userId && !isStaffUser(req.user) && await hasBlocked(result.userId, { id: req.user.id })) {
            res.status(404).json({ error: 'Profile not found' });
            return;
        }
        // A suspended or deleted member's page is gone, except to staff.
        const { isBanned, deletedAt, ...user } = result.user || {};
        if ((isBanned || deletedAt) && !isStaffUser(req.user)) {
            res.status(404).json({ error: 'Profile not found' });
            return;
        }
        recordView(result);
        // Their open opportunities, while Opportunities is on, and the public
        // events they're going to, while Events is on.
        // Whether the viewer follows them, for the Follow button (the viewer's
        // own, so outside the shared cache): the app needn't fetch who they follow.
        const [projectsOn, eventsOn, follow] = await Promise.all([
            isEnabled('projects'),
            isEnabled('events'),
            req.user && req.user.id !== result.userId
                ? prisma.follow.findUnique({
                    where: { followerId_followingId: { followerId: req.user.id, followingId: result.userId } },
                    select: { id: true },
                })
                : null,
        ]);
        const shown = {
            ...result,
            user: result.user && { ...user, projects: projectsOn ? user.projects : [], eventRSVPs: eventsOn ? user.eventRSVPs : [] },
        };
        res.json({ ...profileForViewer(shown, viewerOf(req, result.userId)), followedByMe: !!follow });
    };
    // Each view (cached or not): the count, and "X viewed your profile" once
    // an hour per viewer, unless they browse privately (Settings → Privacy).
    const recordView = (result: any) => {
        prisma.profile.update({ where: { id: result.id }, data: { viewCount: { increment: 1 } } }).catch(() => { });
        if (!req.user || req.user.id === result.userId) return;
        const viewerId = req.user.id;
        (async () => {
            const settings = await prisma.userSettings.findUnique({ where: { userId: viewerId }, select: { browsePrivately: true } });
            if (settings?.browsePrivately) return;
            const viewDedupKey = `profile_view:${result.userId}:${viewerId}`;
            if (await cache.get(viewDedupKey)) return;
            await cache.set(viewDedupKey, '1', 3600);
            const viewerProfile = await prisma.profile.findUnique({ where: { userId: viewerId }, select: { name: true } });
            await notifyProfileView({ profileOwnerId: result.userId, viewerName: viewerProfile?.name || 'Someone', viewerId });
        })().catch(() => { });
    };
    try {
        const cKey = cacheKey.profileDetail(req.params.id);
        const cached = await cache.getJson<any>(cKey);
        if (cached) { res.setHeader('X-Cache', 'HIT'); await respond(cached); return; }

        const profile = await prisma.profile.findFirst({
            where: {
                OR: [
                    { userId: req.params.id },
                    { id: req.params.id },
                    { user: { nostrPubkey: req.params.id } },
                ],
            },
            include: {
                user: {
                    select: {
                        id: true, nostrPubkey: true, role: true, isAdmin: true, isVerified: true,
                        isBanned: true, deletedAt: true,
                        // When they joined BIES ("Joined October 2026" in their Details).
                        createdAt: true,
                        projects: {
                            // Open ones, and none while their member is suspended or deleted (as on /opportunities).
                            where: { isPublished: true, ...openNow(), owner: { isBanned: false, deletedAt: null } },
                            select: {
                                id: true, title: true, category: true, stage: true,
                                thumbnail: true, viewCount: true, raisedAmount: true,
                                fundingGoal: true, createdAt: true,
                            },
                            orderBy: { createdAt: 'desc' },
                        },
                        eventRSVPs: {
                            // Only events anyone can see: not private, draft or invite-only ones.
                            where: { status: { in: ['GOING', 'INTERESTED'] }, event: { isPublished: true, visibility: { in: ['PUBLIC', 'LIMITED_SPACES'] } } },
                            include: {
                                event: {
                                    select: {
                                        id: true,
                                        title: true,
                                        startDate: true,
                                        thumbnail: true,
                                        locationName: true,
                                    },
                                },
                            },
                        },
                        _count: { select: { followers: true, following: true } },
                    },
                },
            },
        });

        if (!profile) {
            res.status(404).json({ error: 'Profile not found' });
            return;
        }

        const result = {
            ...profile,
            // Never expose encrypted wallet credentials
            coinosToken: undefined,
            skills: JSON.parse(profile.skills || '[]'),
            tags: JSON.parse(profile.tags || '[]'),
            investmentFocus: JSON.parse(profile.investmentFocus || '[]'),
            investmentStage: JSON.parse(profile.investmentStage || '[]'),
            lookingFor: JSON.parse(profile.lookingFor || '[]'),
            experience: JSON.parse(profile.experience || '[]'),
            biesProjects: JSON.parse(profile.biesProjects || '[]'),
            customSections: JSON.parse(profile.customSections || '[]'),
        };

        await cache.setJson(cKey, result, TTL.PROFILE_DETAIL);
        await respond(result);
    } catch (error) {
        console.error('Get profile error:', error);
        res.status(500).json({ error: 'Failed to get profile' });
    }
}

/**
 * PUT /profiles/me
 * Update your own profile. Busts cache, syncs to Nostr.
 */
export async function updateMyProfile(req: Request, res: Response): Promise<void> {
    try {
        // Explicitly pick allowed fields to prevent mass assignment
        const allowedFields = [
            'name', 'bio', 'avatar', 'banner', 'location', 'skills', 'website',
            'twitter', 'linkedin', 'github', 'company', 'title', 'tags',
            'investmentFocus', 'investmentStage', 'minTicket', 'maxTicket',
            'lookingFor', 'isPublic', 'nostrNpub', 'experience', 'biesProjects',
            'customSections', 'showExperience', 'nostrFeedMode', 'nip05Name', 'lightningAddress',
            'bolt12Offer',
        ];
        const data: any = {};
        for (const field of allowedFields) {
            if (req.body[field] !== undefined) data[field] = req.body[field];
        }

        // NIP-05 name uniqueness check
        if (data.nip05Name !== undefined) {
            if (data.nip05Name === '') {
                data.nip05Name = null;
            } else {
                data.nip05Name = data.nip05Name.toLowerCase().trim();
                // A staff-sounding name, unless it's already theirs.
                if (isReservedNip05(data.nip05Name) && !isStaffUser(req.user)) {
                    const mine = await prisma.profile.findUnique({ where: { userId: req.user!.id }, select: { nip05Name: true } });
                    if (mine?.nip05Name !== data.nip05Name) {
                        res.status(409).json({ error: `"${data.nip05Name}" is kept for BIES staff. Choose another name.`, reason: 'reserved' });
                        return;
                    }
                }
                const existing = await prisma.profile.findFirst({
                    where: { nip05Name: data.nip05Name, userId: { not: req.user!.id } },
                });
                if (existing) {
                    res.status(409).json({ error: `NIP-05 name "${data.nip05Name}" is already taken` });
                    return;
                }
            }
        }

        // Fetch old profile to detect lightning address / bolt12 offer changes,
        // and photos replaced
        const oldProfile = await prisma.profile.findUnique({ where: { userId: req.user!.id }, select: { lightningAddress: true, bolt12Offer: true, avatar: true, banner: true } });

        // Convert arrays/objects to JSON strings for SQLite
        const arrayFields = ['skills', 'tags', 'investmentFocus', 'investmentStage', 'lookingFor', 'experience', 'biesProjects', 'customSections'];
        for (const field of arrayFields) {
            if (data[field] !== undefined) data[field] = JSON.stringify(data[field]);
        }

        const profile = await prisma.profile.upsert({
            where: { userId: req.user!.id },
            update: data,
            create: { userId: req.user!.id, ...data },
        });

        // Bust caches
        await Promise.all([
            cache.del(cacheKey.profileDetail(req.user!.id)),
            cache.del(cacheKey.profileDetail(profile.id)),
            cache.delPattern('profiles:'),
        ]);

        // A profile photo or cover replaced: the old file goes, if it was theirs.
        const replaced = [oldProfile?.avatar, oldProfile?.banner].filter((url): url is string => !!url && url !== profile.avatar && url !== profile.banner);
        if (replaced.length) await discardUploads(replaced, { uploadedBy: [req.user!.id] });

        const arrayParsedFields = ['skills', 'tags', 'investmentFocus', 'investmentStage', 'lookingFor', 'experience', 'biesProjects', 'customSections'];
        const parsed: any = { ...profile, coinosToken: undefined };
        for (const f of arrayParsedFields) {
            parsed[f] = JSON.parse((profile as any)[f] || '[]');
        }

        // Sync to Nostr Kind 0 if identity-related fields changed
        // (as Settings → Privacy allows: "Links: Only me" leaves those out)
        const privacy = privacyOf(profile.privacy);
        if (req.body.nip05Name !== undefined || req.body.lightningAddress !== undefined || req.body.bolt12Offer !== undefined || req.body.name !== undefined) {
            publishProfileUpdate(req.user!.id, nostrProfileFor(profile, privacy))
                .catch((err) => console.error('[Nostr] Profile sync failed:', err));
        }

        // Announce lightning address addition on the BIES feed, unless the
        // member keeps their links to themselves.
        if (privacy.links !== 'ONLY_ME' && req.body.lightningAddress && req.body.lightningAddress !== oldProfile?.lightningAddress) {
            publishAnnouncement(req.user!.id, `${profile.name || 'A BIES member'} just added a Lightning address! They're ready to receive sats.`, [['t', 'lightning']]).catch((err) =>
                console.error('[Nostr] Lightning announcement failed:', err)
            );
        }

        // Announce Bolt12 offer addition on the BIES feed
        if (req.body.bolt12Offer && req.body.bolt12Offer !== oldProfile?.bolt12Offer) {
            publishAnnouncement(req.user!.id, `${profile.name || 'A BIES member'} just added a Bolt12 offer! They're ready to receive private zaps.`, [['t', 'bolt12'], ['t', 'lightning']]).catch((err) =>
                console.error('[Nostr] Bolt12 announcement failed:', err)
            );
        }

        res.json(parsed);
    } catch (error) {
        console.error('Update profile error:', error);
        res.status(500).json({ error: 'Failed to update profile' });
    }
}

/**
 * GET /profiles/check-nip05?name=alice
 * Check if a NIP-05 name is available.
 */
export async function checkNip05(req: Request, res: Response): Promise<void> {
    try {
        const name = (req.query.name as string || '').toLowerCase().trim();

        if (!name || name.length < 3 || name.length > 30 || !/^[a-z0-9._-]+$/.test(name)) {
            res.json({ available: false, reason: 'Invalid name format' });
            return;
        }

        if (isReservedNip05(name) && !isStaffUser(req.user)) {
            res.json({ available: false, name, reason: 'reserved' });
            return;
        }
        const existing = await prisma.profile.findFirst({
            where: {
                nip05Name: name,
                ...(req.user?.id ? { userId: { not: req.user.id } } : {}),
            },
            select: { id: true },
        });

        res.json({ available: !existing, name });
    } catch (error) {
        console.error('Check NIP-05 error:', error);
        res.status(500).json({ error: 'Failed to check availability' });
    }
}

/**
 * GET /profiles/me
 * Get current user's full profile (not cached — always fresh).
 */
export async function getMyProfile(req: Request, res: Response): Promise<void> {
    try {
        const profile = await prisma.profile.findUnique({
            where: { userId: req.user!.id },
            include: {
                user: {
                    select: {
                        id: true, email: true, nostrPubkey: true, role: true, isAdmin: true, isVerified: true,
                        createdAt: true,
                        projects: {
                            orderBy: { createdAt: 'desc' },
                            select: {
                                id: true, title: true, stage: true, category: true,
                                isPublished: true, viewCount: true, raisedAmount: true,
                                fundingGoal: true, createdAt: true,
                            },
                        },
                        eventRSVPs: {
                            where: { status: { in: ['GOING', 'INTERESTED'] } },
                            include: {
                                event: {
                                    select: {
                                        id: true,
                                        title: true,
                                        startDate: true,
                                        thumbnail: true,
                                        locationName: true,
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });

        if (!profile) {
            res.status(404).json({ error: 'Profile not found — please complete setup' });
            return;
        }

        const arrayFields = ['skills', 'tags', 'investmentFocus', 'investmentStage', 'lookingFor', 'experience', 'biesProjects', 'customSections'];
        const parsed: any = { ...profile, coinosToken: undefined };
        for (const f of arrayFields) {
            parsed[f] = JSON.parse((profile as any)[f] || '[]');
        }

        res.json(parsed);
    } catch (error) {
        console.error('Get my profile error:', error);
        res.status(500).json({ error: 'Failed to get profile' });
    }
}
