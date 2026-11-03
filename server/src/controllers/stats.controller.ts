import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { cache, cacheKey, TTL } from '../services/redis.service';
import { isEnabled } from '../services/featureFlags.service';

/**
 * GET /stats
 * Public homepage statistics. Cached for 5 minutes.
 */
export async function getPublicStats(req: Request, res: Response): Promise<void> {
    try {
        const cKey = cacheKey.platformStats();
        const cached = await cache.getJson<any>(cKey);
        if (cached) { res.setHeader('X-Cache', 'HIT'); res.json(cached); return; }

        const [
            totalBuilders,
            totalInvestors,
            publishedProjects,
            verifiedProjects,
            totalFunded,
            totalEvents,
            featuredProjects,
        ] = await Promise.all([
            prisma.user.count({ where: { role: 'BUILDER' } }),
            prisma.user.count({ where: { role: 'INVESTOR' } }),
            prisma.project.count({ where: { isPublished: true } }),
            prisma.project.count({ where: { isPublished: true, owner: { isVerified: true } } }),
            prisma.investment.aggregate({
                where: { status: { in: ['COMMITTED', 'COMPLETED'] } },
                _sum: { amount: true },
            }),
            prisma.event.count({ where: { isPublished: true } }),
            prisma.project.count({ where: { isFeatured: true, isPublished: true } }),
        ]);

        // Investors and what they put in only while Investors is on.
        const investorsOn = await isEnabled('investors');
        const result = {
            activeBuilders: totalBuilders,
            ...(investorsOn ? { activeInvestors: totalInvestors, totalInvestment: totalFunded._sum.amount || 0 } : {}),
            publishedProjects,
            verifiedProjects,
            upcomingEvents: totalEvents,
            featuredProjects,
        };

        await cache.setJson(cKey, result, TTL.PLATFORM_STATS);
        res.json(result);
    } catch (error) {
        console.error('Public stats error:', error);
        res.status(500).json({ error: 'Failed to get platform stats' });
    }
}
