/**
 * Analytics controller — view tracking and dashboard statistics.
 *
 * Tracks:
 *  - Project page views (with dedup within 1 hour per IP/user)
 *  - Builder dashboard stats (projects, views, watchlist, investments)
 *  - Investor dashboard stats (portfolio value, watchlist activity)
 *  - Platform-wide stats (admin only)
 */

import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { cache, cacheKey, TTL } from '../services/redis.service';
import { createNotification } from '../services/notification.service';

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * POST /analytics/view/:projectId
 * Record a project page view (deduped per IP/user per hour).
 */
export async function recordProjectView(req: Request, res: Response): Promise<void> {
    try {
        const { projectId } = req.params;
        const userId = req.user?.id || null;
        const ipAddress = req.ip || req.socket.remoteAddress || '';

        // Dedup key: prevent spam views within 1 hour
        const dedupKey = `view:${projectId}:${userId || ipAddress}`;
        const alreadyViewed = await cache.get(dedupKey);

        if (!alreadyViewed) {
            const project = await prisma.project.findUnique({
                where: { id: projectId },
                select: { ownerId: true, title: true },
            });

            await Promise.all([
                prisma.projectView.create({
                    data: { projectId, userId, ipAddress },
                }),
                prisma.project.update({
                    where: { id: projectId },
                    data: { viewCount: { increment: 1 } },
                }),
                cache.set(dedupKey, '1', 3600), // 1 hour cooldown
            ]);

            // Notify project owner (don't notify yourself)
            if (project && userId && project.ownerId !== userId) {
                const viewer = await prisma.user.findUnique({
                    where: { id: userId },
                    select: { profile: { select: { name: true } } },
                });
                createNotification({
                    userId: project.ownerId,
                    type: 'PROJECT_VIEW',
                    title: `Someone viewed "${project.title}"`,
                    body: `${viewer?.profile?.name || 'A visitor'} checked out your project.`,
                    data: { projectId, viewerId: userId },
                }).catch(() => {});
            }
        }

        res.json({ recorded: !alreadyViewed });
    } catch (error) {
        // Don't fail the request if analytics recording fails
        res.json({ recorded: false });
    }
}

/**
 * GET /analytics/dashboard
 * Builder dashboard stats: projects, total views, watchlist count, investment interest.
 */
export async function getBuilderDashboard(req: Request, res: Response): Promise<void> {
    try {
        const userId = req.user!.id;
        const cKey = cacheKey.analytics(userId);
        const cached = await cache.getJson<any>(cKey);
        if (cached) { res.json(cached); return; }

        const [
            totalProjects,
            publishedProjects,
            totalViews,
            totalWatchlisted,
            totalInvestments,
            investmentsByStatus,
            recentProjects,
            viewsTrend,
        ] = await Promise.all([
            prisma.project.count({ where: { ownerId: userId } }),
            prisma.project.count({ where: { ownerId: userId, isPublished: true } }),
            prisma.project.aggregate({
                where: { ownerId: userId },
                _sum: { viewCount: true },
            }),
            prisma.watchlistItem.count({
                where: { project: { ownerId: userId } },
            }),
            prisma.investment.count({
                where: { project: { ownerId: userId } },
            }),
            prisma.investment.groupBy({
                by: ['status'],
                where: { project: { ownerId: userId } },
                _count: { id: true },
                _sum: { amount: true },
            }),
            prisma.project.findMany({
                where: { ownerId: userId },
                orderBy: { createdAt: 'desc' },
                take: 5,
                select: {
                    id: true, title: true, stage: true, category: true,
                    viewCount: true, raisedAmount: true, fundingGoal: true,
                    isPublished: true, createdAt: true,
                    _count: { select: { watchlisted: true, investments: true } },
                },
            }),
            // Views over last 30 days
            prisma.projectView.groupBy({
                by: ['viewedAt'],
                where: {
                    project: { ownerId: userId },
                    viewedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
                },
                _count: { id: true },
            }),
        ]);

        const investmentBreakdown = Object.fromEntries(
            investmentsByStatus.map((s) => [s.status, { count: s._count.id, total: s._sum.amount || 0 }])
        );

        const result = {
            projects: {
                total: totalProjects,
                published: publishedProjects,
                draft: totalProjects - publishedProjects,
            },
            engagement: {
                totalViews: totalViews._sum.viewCount || 0,
                totalWatchlisted,
                totalInvestments,
            },
            funding: investmentBreakdown,
            recentProjects,
            viewsTrend: viewsTrend.map((v) => ({
                date: v.viewedAt,
                count: v._count.id,
            })),
        };

        await cache.setJson(cKey, result, TTL.ANALYTICS_DASHBOARD);
        res.json(result);
    } catch (error) {
        console.error('Builder dashboard error:', error);
        res.status(500).json({ error: 'Failed to get dashboard stats' });
    }
}

/**
 * GET /analytics/investor-dashboard
 * Investor dashboard: portfolio overview, watchlist activity.
 */
export async function getInvestorDashboard(req: Request, res: Response): Promise<void> {
    try {
        const userId = req.user!.id;
        const cKey = `analytics_investor:${userId}`;
        const cached = await cache.getJson<any>(cKey);
        if (cached) { res.json(cached); return; }

        const [
            watchlistCount,
            investments,
            totalCommitted,
            recentWatchlist,
        ] = await Promise.all([
            prisma.watchlistItem.count({ where: { userId } }),
            prisma.investment.findMany({
                where: { investorId: userId },
                include: {
                    project: {
                        select: {
                            id: true, title: true, thumbnail: true, category: true,
                            stage: true, fundingGoal: true, raisedAmount: true,
                        },
                    },
                },
                orderBy: { createdAt: 'desc' },
                take: 10,
            }),
            prisma.investment.aggregate({
                where: { investorId: userId, status: { in: ['COMMITTED', 'COMPLETED'] } },
                _sum: { amount: true },
            }),
            prisma.watchlistItem.findMany({
                where: { userId },
                orderBy: { addedAt: 'desc' },
                take: 5,
                include: {
                    project: {
                        select: {
                            id: true, title: true, thumbnail: true, category: true,
                            stage: true, viewCount: true,
                        },
                    },
                },
            }),
        ]);

        const result = {
            watchlistCount,
            totalCommitted: totalCommitted._sum.amount || 0,
            investmentCount: investments.length,
            recentInvestments: investments,
            recentWatchlist,
        };

        await cache.setJson(cKey, result, TTL.ANALYTICS_DASHBOARD);
        res.json(result);
    } catch (error) {
        console.error('Investor dashboard error:', error);
        res.status(500).json({ error: 'Failed to get investor dashboard' });
    }
}

/**
 * GET /analytics/project/:id
 * Detailed analytics for a specific project (owner only).
 */
export async function getProjectAnalytics(req: Request, res: Response): Promise<void> {
    try {
        const { id } = req.params;
        const userId = req.user!.id;

        const project = await prisma.project.findUnique({
            where: { id },
            select: { ownerId: true, title: true },
        });

        if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
        if (project.ownerId !== userId && !req.user!.isAdmin) {
            res.status(403).json({ error: 'Not authorized' }); return;
        }

        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        const [viewsTotal, viewsLast30, watchlistCount, investments] = await Promise.all([
            prisma.project.findUnique({ where: { id }, select: { viewCount: true } }),
            prisma.projectView.count({ where: { projectId: id, viewedAt: { gte: thirtyDaysAgo } } }),
            prisma.watchlistItem.count({ where: { projectId: id } }),
            prisma.investment.findMany({
                where: { projectId: id },
                select: { status: true, amount: true, currency: true, createdAt: true },
            }),
        ]);

        res.json({
            viewsTotal: viewsTotal?.viewCount || 0,
            viewsLast30,
            watchlistCount,
            investments,
        });
    } catch (error) {
        console.error('Project analytics error:', error);
        res.status(500).json({ error: 'Failed to get project analytics' });
    }
}

/**
 * GET /analytics/platform
 * Platform-wide stats — admin only.
 */
export async function getPlatformStats(req: Request, res: Response): Promise<void> {
    try {
        const [
            totalUsers, totalBuilders, totalInvestors,
            totalProjects, publishedProjects,
            totalInvestments, totalFunded,
            newUsersLast30,
            totalEvents,
        ] = await Promise.all([
            prisma.user.count(),
            prisma.user.count({ where: { role: 'BUILDER' } }),
            prisma.user.count({ where: { role: 'INVESTOR' } }),
            prisma.project.count(),
            prisma.project.count({ where: { isPublished: true } }),
            prisma.investment.count(),
            prisma.investment.aggregate({ _sum: { amount: true } }),
            prisma.user.count({ where: { createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } } }),
            prisma.event.count({ where: { isPublished: true } }),
        ]);

        res.json({
            users: { total: totalUsers, builders: totalBuilders, investors: totalInvestors, newLast30: newUsersLast30 },
            projects: { total: totalProjects, published: publishedProjects },
            investments: { total: totalInvestments, totalFunded: totalFunded._sum.amount || 0 },
            events: { total: totalEvents },
        });
    } catch (error) {
        console.error('Platform stats error:', error);
        res.status(500).json({ error: 'Failed to get platform stats' });
    }
}
