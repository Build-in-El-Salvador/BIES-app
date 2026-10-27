/**
 * Unified search controller — searches across projects (opportunities),
 * profiles, and events. Opportunities are for members: only signed-in
 * searches find them, and only open ones.
 */

import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { cache, cacheKey, TTL } from '../services/redis.service';
import { hiddenFromIds, isStaffUser } from '../services/moderation.service';
import { matchesVisibly, profileForViewer, type Viewer } from '../services/profilePrivacy';
import { openNow } from './project.controller';
import { isEnabled } from '../services/featureFlags.service';

const viewerOf = (req: Request, userId: string): Viewer =>
    !req.user ? 'public' : req.user.id === userId ? 'self' : 'member';

/**
 * Results are cached for all viewers; then, for this one: leave out what
 * members the viewer blocked published (their profiles, their projects and
 * the events they host), and show each profile as this viewer may see it
 * (Settings → Privacy), found only by what the viewer can see of it.
 */
async function withoutBlocked(req: Request, results: any): Promise<any> {
    const hidden = new Set(await hiddenFromIds(req.user?.id, { staff: isStaffUser(req.user) }));
    const out = { ...results };
    // Opportunities are for members (the cache is shared with signed-in
    // searches), and only while they're switched on.
    if (!req.user || !(await isEnabled('projects'))) {
        if (Array.isArray(out.projects)) { out.projects = []; out.projectTotal = 0; }
        if (Array.isArray(out.suggestions)) out.suggestions = out.suggestions.filter((s: any) => s.type !== 'project');
    }
    if (Array.isArray(out.profiles)) {
        const q = String(out.query ?? req.query.q ?? '');
        const visible = out.profiles
            .filter((p: any) => !hidden.has(p.userId))
            .filter((p: any) => !q || matchesVisibly(p, q, viewerOf(req, p.userId)))
            .map((p: any) => profileForViewer(p, viewerOf(req, p.userId)));
        // Every candidate was fetched: page and count what this viewer can
        // see (a count over hidden fields told them a hidden bio matched).
        const page = Math.max(1, parseInt(req.query.page as string || '1', 10) || 1);
        const limit = Math.min(parseInt(req.query.limit as string || '10', 10) || 10, 30);
        out.profiles = visible.slice((page - 1) * limit, page * limit);
        out.profileTotal = visible.length;
    }
    if (!hidden.size) return out;
    // The selects carry the owner and host as objects (owner.id, host.id).
    if (Array.isArray(out.projects)) out.projects = out.projects.filter((p: any) => !hidden.has(p.owner?.id ?? p.ownerId));
    if (Array.isArray(out.events)) out.events = out.events.filter((e: any) => !hidden.has(e.host?.id ?? e.hostId));
    if (Array.isArray(out.suggestions)) {
        out.suggestions = out.suggestions.filter((s: any) => !hidden.has(s.type === 'project' ? s.ownerId : s.id));
    }
    return out;
}

/**
 * GET /search?q=...&type=all|projects|profiles|events&page=1&limit=10
 * Unified cross-entity search.
 */
export async function search(req: Request, res: Response): Promise<void> {
    try {
        const q = (req.query.q as string || '').trim();
        const type = (req.query.type as string || 'all').toLowerCase();
        const page = parseInt(req.query.page as string || '1', 10);
        const limit = Math.min(parseInt(req.query.limit as string || '10', 10), 30);
        const skip = (page - 1) * limit;

        if (!q || q.length < 2) {
            res.json({ projects: [], profiles: [], events: [], total: 0 });
            return;
        }

        const cKey = cacheKey.search(`${q}:${type}:${page}`);
        const cached = await cache.getJson<any>(cKey);
        if (cached) { res.json(await withoutBlocked(req, cached)); return; }

        const results: any = { query: q };

        const searchTerm = { contains: q };

        if (type === 'all' || type === 'projects') {
            const [projects, projectTotal] = await Promise.all([
                prisma.project.findMany({
                    where: {
                        isPublished: true,
                        owner: { isBanned: false, deletedAt: null },
                        AND: [openNow(), { OR: [
                            { title: searchTerm },
                            { description: searchTerm },
                            { category: searchTerm },
                        ] }],
                    },
                    take: limit,
                    skip,
                    orderBy: { viewCount: 'desc' },
                    select: {
                        id: true, type: true, kind: true, title: true, description: true, category: true,
                        stage: true, thumbnail: true, viewCount: true,
                        fundingGoal: true, raisedAmount: true,
                        owner: {
                            select: {
                                id: true,
                                profile: { select: { name: true, avatar: true } },
                            },
                        },
                    },
                }),
                prisma.project.count({
                    where: {
                        isPublished: true,
                        owner: { isBanned: false, deletedAt: null },
                        AND: [openNow(), { OR: [{ title: searchTerm }, { description: searchTerm }, { category: searchTerm }] }],
                    },
                }),
            ]);
            results.projects = projects;
            results.projectTotal = projectTotal;
        }

        if (type === 'all' || type === 'profiles') {
            // Every candidate (up to 200): withoutBlocked pages and counts
            // what each viewer can see.
            const profiles = await prisma.profile.findMany({
                where: {
                    isPublic: true,
                    // Not suspended or deleted members.
                    user: { isBanned: false, deletedAt: null },
                    OR: [
                        { name: searchTerm },
                        { bio: searchTerm },
                        { company: searchTerm },
                        { location: searchTerm },
                        { title: searchTerm },
                    ],
                },
                take: 200,
                orderBy: { viewCount: 'desc' },
                include: {
                    user: { select: { id: true, role: true, nostrPubkey: true } },
                },
            });
            const profileTotal = profiles.length;
            // Cached whole; withoutBlocked shows each viewer what they may see.
            results.profiles = profiles.map((p) => ({
                ...p,
                coinosToken: undefined, // never expose encrypted wallet credentials
                skills: JSON.parse(p.skills || '[]'),
                tags: JSON.parse(p.tags || '[]'),
            }));
            results.profileTotal = profileTotal;
        }

        // Events only while Events is on, only public ones, and only what an
        // event's card shows (not its online link, payout address or guests).
        if ((type === 'all' || type === 'events') && await isEnabled('events')) {
            const eventWhere = {
                isPublished: true,
                visibility: { in: ['PUBLIC', 'LIMITED_SPACES'] },
                calledOffAt: null, // a proposed meetup that didn't happen
                host: { isBanned: false, deletedAt: null },
                OR: [
                    { title: searchTerm },
                    { description: searchTerm },
                    { location: searchTerm },
                ],
            };
            const [events, eventTotal] = await Promise.all([
                prisma.event.findMany({
                    where: eventWhere,
                    take: limit,
                    skip,
                    orderBy: { startDate: 'asc' },
                    select: {
                        id: true, title: true, description: true, category: true, startDate: true, endDate: true,
                        thumbnail: true, location: true, locationName: true, isOnline: true, tags: true,
                        host: {
                            select: {
                                id: true,
                                profile: { select: { name: true, avatar: true } },
                            },
                        },
                    },
                }),
                prisma.event.count({ where: eventWhere }),
            ]);
            results.events = events.map((e) => ({
                ...e,
                tags: JSON.parse(e.tags || '[]'),
            }));
            results.eventTotal = eventTotal;
        }

        await cache.setJson(cKey, results, TTL.SEARCH_RESULTS);
        res.json(await withoutBlocked(req, results));
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ error: 'Search failed' });
    }
}

/**
 * GET /search/suggestions?q=...
 * Quick autocomplete suggestions (names/titles only).
 */
export async function getSuggestions(req: Request, res: Response): Promise<void> {
    try {
        const q = (req.query.q as string || '').trim();
        if (!q || q.length < 2) { res.json({ suggestions: [] }); return; }

        const cKey = `suggestions:${q.toLowerCase()}`;
        const cached = await cache.getJson<any>(cKey);
        if (cached) { res.json(await withoutBlocked(req, cached)); return; }

        const searchTerm = { contains: q };

        const [projects, profiles] = await Promise.all([
            prisma.project.findMany({
                where: { isPublished: true, title: searchTerm, owner: { isBanned: false, deletedAt: null }, ...openNow() },
                take: 5,
                select: { id: true, title: true, ownerId: true },
            }),
            prisma.profile.findMany({
                where: { isPublic: true, name: searchTerm, user: { isBanned: false, deletedAt: null } },
                take: 5,
                select: { id: true, name: true, userId: true },
            }),
        ]);

        const suggestions = [
            ...projects.map((p) => ({ type: 'project', id: p.id, label: p.title, ownerId: p.ownerId })),
            ...profiles.map((p) => ({ type: 'profile', id: p.userId, label: p.name })),
        ].slice(0, 8);

        const result = { suggestions };
        await cache.setJson(cKey, result, 60);
        res.json(await withoutBlocked(req, result));
    } catch (error) {
        console.error('Suggestions error:', error);
        res.status(500).json({ error: 'Failed to get suggestions' });
    }
}
