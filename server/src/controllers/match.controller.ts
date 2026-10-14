import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { cache, TTL } from '../services/redis.service';
import { withoutDeckKey } from '../utils/projectFields';
import { privacyOf } from '../services/profilePrivacy';

/**
 * GET /match/projects/:id/matches
 * Return suggested investors for a project based on profile overlap.
 * Scoring: +2 for category match, +2 for stage match, +1 for ticket range fit.
 */
export async function getProjectMatches(req: Request, res: Response): Promise<void> {
    try {
        const projectId = req.params.id;

        // Who may see them first, then the cache (it's shared by everyone).
        const project = await prisma.project.findUnique({
            where: { id: projectId },
            select: { ownerId: true, category: true, stage: true, fundingGoal: true, title: true },
        });

        if (!project) { res.status(404).json({ error: 'Project not found' }); return; }

        if (project.ownerId !== req.user!.id && !req.user!.isAdmin) {
            res.status(403).json({ error: 'Not authorized' }); return;
        }

        const cKey = `matches:${projectId}`;
        const cached = await cache.getJson<any>(cKey);
        if (cached) { res.setHeader('X-Cache', 'HIT'); res.json(cached); return; }

        // Get all public investor profiles
        const investors = await prisma.profile.findMany({
            where: {
                user: { role: 'INVESTOR' },
                isPublic: true,
            },
            include: {
                user: {
                    select: { id: true, nostrPubkey: true, isVerified: true },
                },
            },
        });

        // Investors who keep their details (focus, stages, tickets) to
        // themselves aren't matched on them (Settings → Privacy).
        const open = investors.filter((investor) => privacyOf(investor.privacy).details !== 'ONLY_ME');

        // Score each investor
        const scored = open.map((investor) => {
            let score = 0;
            const reasons: string[] = [];

            const focus = JSON.parse(investor.investmentFocus || '[]') as string[];
            const stages = JSON.parse(investor.investmentStage || '[]') as string[];

            if (focus.includes(project.category)) {
                score += 2;
                reasons.push(`Invests in ${project.category}`);
            }

            if (stages.includes(project.stage)) {
                score += 2;
                reasons.push(`Targets ${project.stage} stage`);
            }

            if (project.fundingGoal) {
                if (investor.minTicket && investor.maxTicket &&
                    project.fundingGoal >= investor.minTicket && project.fundingGoal <= investor.maxTicket) {
                    score += 1;
                    reasons.push('Funding goal within ticket range');
                } else if (investor.minTicket && !investor.maxTicket &&
                    project.fundingGoal >= investor.minTicket) {
                    score += 1;
                    reasons.push('Funding goal meets minimum ticket');
                }
            }

            return {
                investor: {
                    id: investor.user.id,
                    nostrPubkey: investor.user.nostrPubkey,
                    isVerified: investor.user.isVerified,
                    name: investor.name,
                    avatar: investor.avatar,
                    company: investor.company,
                    title: investor.title,
                    investmentFocus: focus,
                    investmentStage: stages,
                    minTicket: investor.minTicket,
                    maxTicket: investor.maxTicket,
                    portfolioCount: investor.portfolioCount,
                },
                score,
                reasons,
            };
        });

        const matches = scored
            .filter((s) => s.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 20);

        const result = { data: matches, projectId, projectTitle: project.title };
        await cache.setJson(cKey, result, TTL.MATCH_RESULTS);
        res.json(result);
    } catch (error) {
        console.error('Project matches error:', error);
        res.status(500).json({ error: 'Failed to find investor matches' });
    }
}

/**
 * GET /match/investors/recommendations
 * Return recommended projects for the authenticated investor.
 * Reverse of getProjectMatches: match investor profile against all projects.
 */
export async function getInvestorRecommendations(req: Request, res: Response): Promise<void> {
    try {
        const userId = req.user!.id;

        const cKey = `investor_recs:${userId}`;
        const cached = await cache.getJson<any>(cKey);
        if (cached) { res.setHeader('X-Cache', 'HIT'); res.json(cached); return; }

        const profile = await prisma.profile.findUnique({
            where: { userId },
        });

        if (!profile) { res.status(404).json({ error: 'Profile not found' }); return; }

        const focus = JSON.parse(profile.investmentFocus || '[]') as string[];
        const stages = JSON.parse(profile.investmentStage || '[]') as string[];
        const { minTicket, maxTicket } = profile;

        // Exclude projects the investor already invested in
        const existingInvestments = await prisma.investment.findMany({
            where: { investorId: userId },
            select: { projectId: true },
        });
        const investedProjectIds = existingInvestments.map((i) => i.projectId);

        const whereClause: any = { isPublished: true };
        if (investedProjectIds.length > 0) {
            whereClause.id = { notIn: investedProjectIds };
        }

        const projects = await prisma.project.findMany({
            where: whereClause,
            include: {
                owner: {
                    select: {
                        id: true, nostrPubkey: true,
                        profile: { select: { name: true, avatar: true, company: true } },
                    },
                },
                _count: { select: { watchlisted: true, investments: true } },
            },
        });

        const scored = projects.map((project) => {
            let score = 0;
            const reasons: string[] = [];

            if (focus.includes(project.category)) {
                score += 2;
                reasons.push(`Matches your ${project.category} focus`);
            }

            if (stages.includes(project.stage)) {
                score += 2;
                reasons.push(`Matches your ${project.stage} stage preference`);
            }

            if (project.fundingGoal) {
                if (minTicket && maxTicket && project.fundingGoal >= minTicket && project.fundingGoal <= maxTicket) {
                    score += 1;
                    reasons.push('Funding goal within your ticket range');
                } else if (minTicket && !maxTicket && project.fundingGoal >= minTicket) {
                    score += 1;
                    reasons.push('Funding goal meets your minimum');
                }
            }

            return {
                project: { ...withoutDeckKey(project), tags: JSON.parse(project.tags || '[]') },
                score,
                reasons,
            };
        });

        const recommendations = scored
            .filter((s) => s.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 20);

        const result = { data: recommendations };
        await cache.setJson(cKey, result, TTL.MATCH_RESULTS);
        res.json(result);
    } catch (error) {
        console.error('Investor recommendations error:', error);
        res.status(500).json({ error: 'Failed to get recommendations' });
    }
}
