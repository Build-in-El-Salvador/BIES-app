import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { cache, cacheKey, TTL } from '../services/redis.service';
import { notifyProfileView } from '../services/notification.service';
import { publishProfileUpdate, publishAnnouncement } from '../services/nostr.service';
import { blockedIds, hasBlocked } from '../services/moderation.service';
import { z } from 'zod';

// ─── Validation ───────────────────────────────────────────────────────────────

export const updateProfileSchema = z.object({
    name: z.string().optional(),
    bio: z.string().optional(),
    avatar: z.string().optional(),
    banner: z.string().optional(),
    location: z.string().optional(),
    skills: z.array(z.string()).optional(),
    website: z.string().url().optional().or(z.literal('')),
    twitter: z.string().optional(),
    linkedin: z.string().optional(),
    github: z.string().optional(),
    company: z.string().optional(),
    title: z.string().optional(),
    tags: z.array(z.string()).optional(),
    // Profile sections
    experience: z.array(z.object({
        title: z.string().optional(),
        company: z.string().optional(),
        date: z.string().optional(),
        description: z.string().optional(),
    })).optional(),
    biesProjects: z.array(z.object({
        id: z.string(),
        name: z.string(),
        role: z.string().optional(),
        status: z.string().optional(),
        image: z.string().optional(),
    })).optional(),
    customSections: z.array(z.object({
        title: z.string().default(''),
        type: z.enum(['TEXT', 'PHOTO', 'CAROUSEL', 'GRAPH']).default('TEXT'),
        placement: z.enum(['LEFT', 'RIGHT']).default('LEFT'),
        body: z.string().optional(),
        content: z.string().optional(),
        imageUrl: z.string().optional(),
        images: z.array(z.string()).optional(),
        graphType: z.string().optional(),
        xAxisLabel: z.string().optional(),
        yAxisLabel: z.string().optional(),
        dataPoints: z.array(z.object({ label: z.string(), value: z.union([z.string(), z.number()]) })).optional(),
    })).optional(),
    showExperience: z.boolean().optional(),
    nostrFeedMode: z.enum(['off', 'private', 'public', 'combined']).optional(),
    nostrNpub: z.string().optional(),
    // NIP-05 & Lightning
    nip05Name: z.string().min(3).max(30).regex(/^[a-z0-9._-]+$/, 'Only lowercase letters, numbers, dots, hyphens, underscores').optional(),
    lightningAddress: z.string().optional(),
    bolt12Offer: z.string().regex(/^lno1[a-z0-9]+$/, 'Must be a valid Bolt12 offer (starts with lno1)').optional().or(z.literal('')),
    // Investor-specific
    investmentFocus: z.array(z.string()).optional(),
    investmentStage: z.array(z.string()).optional(),
    minTicket: z.number().positive().optional(),
    maxTicket: z.number().positive().optional(),
    // Builder-specific
    lookingFor: z.array(z.string()).optional(),
    isPublic: z.boolean().optional(),
});

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * GET /profiles
 * List profiles (cached), filterable by role, location, search. Members the
 * viewer blocked are left out after the cache, which all viewers share.
 */
export async function listProfiles(req: Request, res: Response): Promise<void> {
    const respond = async (result: any) => {
        const hidden = new Set(await blockedIds(req.user?.id));
        res.json(hidden.size ? { ...result, data: result.data.filter((p: any) => !hidden.has(p.userId)) } : result);
    };
    try {
        const { role, location, search, page = '1', limit = '20' } = req.query;
        const skip = (parseInt(page as string, 10) - 1) * parseInt(limit as string, 10);
        const take = Math.min(parseInt(limit as string, 10), 50);

        const cKey = cacheKey.profiles({
            role: role as string || '',
            location: location as string || '',
            search: search as string || '',
            page: page as string,
            limit: limit as string,
        });

        const cached = await cache.getJson<any>(cKey);
        if (cached) { res.setHeader('X-Cache', 'HIT'); await respond(cached); return; }

        // Members who haven't finished their profile (no BIES name yet) stay
        // out of the list; the app asks them for one when they sign in.
        const where: any = { isPublic: true, AND: [{ name: { not: '' } }, { NOT: { name: { startsWith: 'nostr:' } } }] };

        if (role && typeof role === 'string') {
            const upRole = role.toUpperCase();
            if (upRole === 'BUILDER') {
                where.user = { projects: { some: { isPublished: true } } };
            } else if (upRole === 'EVENT_HOST') {
                where.user = { hostedEvents: { some: { isPublished: true } } };
            } else if (upRole === 'EDUCATOR') {
                where.user = { role: 'EDUCATOR' }; // Placeholder until courses are added
            } else {
                where.user = { role: upRole }; // ADMIN, MOD, INVESTOR, MEMBER
            }
        }
        if (location && typeof location === 'string') {
            where.location = { contains: location };
        }
        if (search && typeof search === 'string') {
            where.OR = [
                { name: { contains: search } },
                { bio: { contains: search } },
                { company: { contains: search } },
                { location: { contains: search } },
                { title: { contains: search } },
            ];
        }

        const [profiles, total] = await Promise.all([
            prisma.profile.findMany({
                where,
                include: {
                    user: {
                        select: {
                            id: true, nostrPubkey: true, role: true, isAdmin: true,
                            isVerified: true,
                            _count: { select: { projects: true, followers: true, hostedEvents: true } },
                        },
                    },
                },
                skip,
                take,
                orderBy: { viewCount: 'desc' },
            }),
            prisma.profile.count({ where }),
        ]);

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
                page: parseInt(page as string, 10),
                limit: take,
                total,
                totalPages: Math.ceil(total / take),
            },
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
 * Get a single profile (cached, by userId or profileId). A member the viewer
 * blocked comes back as just a name, with `blocked: true`.
 */
export async function getProfile(req: Request, res: Response): Promise<void> {
    const viewerBlocked = (ownerId: string) =>
        !!req.user && req.user.id !== ownerId ? hasBlocked(req.user.id, { id: ownerId }) : Promise.resolve(false);
    const respond = async (result: any) => {
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
        res.json(result);
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
                isPublic: true,
            },
            include: {
                user: {
                    select: {
                        id: true, nostrPubkey: true, role: true, isAdmin: true, isVerified: true,
                        projects: {
                            where: { isPublished: true },
                            select: {
                                id: true, title: true, category: true, stage: true,
                                thumbnail: true, viewCount: true, raisedAmount: true,
                                fundingGoal: true, createdAt: true,
                            },
                            orderBy: { createdAt: 'desc' },
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
                        _count: { select: { followers: true, following: true } },
                    },
                },
            },
        });

        if (!profile) {
            res.status(404).json({ error: 'Profile not found' });
            return;
        }

        // Increment view count (non-blocking)
        prisma.profile.update({
            where: { id: profile.id },
            data: { viewCount: { increment: 1 } },
        }).catch(() => { });

        // Notify profile owner of view (dedup: once per viewer per hour)
        if (req.user && req.user.id !== profile.userId && !(await viewerBlocked(profile.userId))) {
            const viewDedupKey = `profile_view:${profile.userId}:${req.user.id}`;
            const alreadyNotified = await cache.get(viewDedupKey);
            if (!alreadyNotified) {
                const viewerProfile = await prisma.profile.findUnique({
                    where: { userId: req.user.id },
                    select: { name: true },
                });
                notifyProfileView({
                    profileOwnerId: profile.userId,
                    viewerName: viewerProfile?.name || 'Someone',
                    viewerId: req.user.id,
                }).catch(() => { });
                cache.set(viewDedupKey, '1', 3600).catch(() => { }); // 1 hour dedup
            }
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
                const existing = await prisma.profile.findFirst({
                    where: { nip05Name: data.nip05Name, userId: { not: req.user!.id } },
                });
                if (existing) {
                    res.status(409).json({ error: `NIP-05 name "${data.nip05Name}" is already taken` });
                    return;
                }
            }
        }

        // Fetch old profile to detect lightning address / bolt12 offer changes
        const oldProfile = await prisma.profile.findUnique({ where: { userId: req.user!.id }, select: { lightningAddress: true, bolt12Offer: true } });

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

        const arrayParsedFields = ['skills', 'tags', 'investmentFocus', 'investmentStage', 'lookingFor', 'experience', 'biesProjects', 'customSections'];
        const parsed: any = { ...profile, coinosToken: undefined };
        for (const f of arrayParsedFields) {
            parsed[f] = JSON.parse((profile as any)[f] || '[]');
        }

        // Sync to Nostr Kind 0 if identity-related fields changed
        if (req.body.nip05Name !== undefined || req.body.lightningAddress !== undefined || req.body.bolt12Offer !== undefined || req.body.name !== undefined) {
            const nip05 = profile.nip05Name ? `${profile.nip05Name}@buildinelsalvador.com` : '';
            const isLnurl = profile.lightningAddress?.toLowerCase().startsWith('lnurl1');
            publishProfileUpdate(req.user!.id, {
                name: profile.name || '',
                about: profile.bio || '',
                picture: profile.avatar || '',
                banner: profile.banner || '',
                website: profile.website || '',
                nip05,
                lud16: isLnurl ? '' : (profile.lightningAddress || ''),
                lud06: isLnurl ? (profile.lightningAddress || '') : '',
                bolt12: profile.bolt12Offer || '',
            }).catch((err) => console.error('[Nostr] Profile sync failed:', err));
        }

        // Announce lightning address addition on the BIES feed
        if (req.body.lightningAddress && req.body.lightningAddress !== oldProfile?.lightningAddress) {
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
