/**
 * Unified search controller — searches across projects, profiles, and events.
 */

import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { cache, cacheKey, TTL } from '../services/redis.service';

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
        if (cached) { res.json(cached); return; }

        const results: any = { query: q };

        const searchTerm = { contains: q };

        if (type === 'all' || type === 'projects') {
            const [projects, projectTotal] = await Promise.all([
                prisma.project.findMany({
                    where: {
                        isPublished: true,
                        OR: [
                            { title: searchTerm },
                            { description: searchTerm },
                            { category: searchTerm },
                        ],
                    },
                    take: limit,
                    skip,
                    orderBy: { viewCount: 'desc' },
                    select: {
                        id: true, title: true, description: true, category: true,
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
                        OR: [{ title: searchTerm }, { description: searchTerm }],
                    },
                }),
            ]);
            results.projects = projects;
            results.projectTotal = projectTotal;
        }

        if (type === 'all' || type === 'profiles') {
            const [profiles, profileTotal] = await Promise.all([
                prisma.profile.findMany({
                    where: {
                        isPublic: true,
                        OR: [
                            { name: searchTerm },
                            { bio: searchTerm },
                            { company: searchTerm },
                            { location: searchTerm },
                            { title: searchTerm },
                        ],
                    },
                    take: limit,
                    skip,
                    orderBy: { viewCount: 'desc' },
                    include: {
                        user: { select: { id: true, role: true, nostrPubkey: true } },
                    },
                }),
                prisma.profile.count({
                    where: {
                        isPublic: true,
                        OR: [{ name: searchTerm }, { bio: searchTerm }, { company: searchTerm }],
                    },
                }),
            ]);
            results.profiles = profiles.map((p) => ({
                ...p,
                // Never expose encrypted wallet credentials — this endpoint is
                // public (no authenticate middleware on the search routes).
                coinosToken: undefined,
                skills: JSON.parse(p.skills || '[]'),
                tags: JSON.parse(p.tags || '[]'),
            }));
            results.profileTotal = profileTotal;
        }

        if (type === 'all' || type === 'events') {
            const [events, eventTotal] = await Promise.all([
                prisma.event.findMany({
                    where: {
                        isPublished: true,
                        OR: [
                            { title: searchTerm },
                            { description: searchTerm },
                            { location: searchTerm },
                        ],
                    },
                    take: limit,
                    skip,
                    orderBy: { startDate: 'asc' },
                    include: {
                        host: {
                            select: {
                                id: true,
                                profile: { select: { name: true, avatar: true } },
                            },
                        },
                    },
                }),
                prisma.event.count({
                    where: {
                        isPublished: true,
                        OR: [{ title: searchTerm }, { description: searchTerm }],
                    },
                }),
            ]);
            results.events = events.map((e) => ({
                ...e,
                tags: JSON.parse(e.tags || '[]'),
            }));
            results.eventTotal = eventTotal;
        }

        await cache.setJson(cKey, results, TTL.SEARCH_RESULTS);
        res.json(results);
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
        if (cached) { res.json(cached); return; }

        const searchTerm = { contains: q };

        const [projects, profiles] = await Promise.all([
            prisma.project.findMany({
                where: { isPublished: true, title: searchTerm },
                take: 5,
                select: { id: true, title: true },
            }),
            prisma.profile.findMany({
                where: { isPublic: true, name: searchTerm },
                take: 5,
                select: { id: true, name: true, userId: true },
            }),
        ]);

        const suggestions = [
            ...projects.map((p) => ({ type: 'project', id: p.id, label: p.title })),
            ...profiles.map((p) => ({ type: 'profile', id: p.userId, label: p.name })),
        ].slice(0, 8);

        const result = { suggestions };
        await cache.setJson(cKey, result, 60);
        res.json(result);
    } catch (error) {
        console.error('Suggestions error:', error);
        res.status(500).json({ error: 'Failed to get suggestions' });
    }
}
