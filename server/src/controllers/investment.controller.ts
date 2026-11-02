/**
 * Investment controller — investors express and track funding interest.
 *
 * Flow:
 *   1. Investor submits interest (PENDING)
 *   2. Builder acknowledges / responds
 *   3. Both parties coordinate off-platform or via Messages
 *   4. Builder marks as COMMITTED / COMPLETED
 *   5. raisedAmount on Project is updated accordingly
 */

import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { z } from 'zod';
import { notifyInvestmentInterest, notifyInvestmentStatus } from '../services/notification.service';
import { publishAnnouncement } from '../services/nostr.service';

// ─── Validation ───────────────────────────────────────────────────────────────

export const createInvestmentSchema = z.object({
    projectId: z.string().min(1),
    amount: z.number().positive('Amount must be positive'),
    currency: z.enum(['USD', 'BTC', 'SATS']).default('USD'),
    terms: z.string().max(2000).optional(),
    notes: z.string().max(1000).optional(),
});

export const updateInvestmentSchema = z.object({
    status: z.enum(['PENDING', 'COMMITTED', 'COMPLETED', 'WITHDRAWN']),
    terms: z.string().max(2000).optional(),
    notes: z.string().max(1000).optional(),
});

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * GET /investments
 * List investments — investors see their portfolio, builders see their funding.
 */
export async function listInvestments(req: Request, res: Response): Promise<void> {
    try {
        const userId = req.user!.id;
        const { status, projectId } = req.query;
        const page = parseInt(req.query.page as string || '1', 10);
        const limit = Math.min(parseInt(req.query.limit as string || '20', 10), 50);
        const skip = (page - 1) * limit;

        const where: any = {};

        if (req.user!.isAdmin) {
            // Admin can filter by projectId
            if (projectId) where.projectId = projectId;
        } else {
            // Everyone else: the investments they made, and those in projects
            // they own, whatever their role (a member used to see everyone's).
            where.OR = [{ investorId: userId }, { project: { ownerId: userId } }];
        }

        if (status && typeof status === 'string') {
            where.status = status.toUpperCase();
        }

        const [investments, total] = await Promise.all([
            prisma.investment.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit,
                include: {
                    project: {
                        select: {
                            id: true, title: true, thumbnail: true,
                            fundingGoal: true, raisedAmount: true, category: true, stage: true,
                        },
                    },
                    investor: {
                        select: {
                            id: true, nostrPubkey: true,
                            profile: { select: { name: true, avatar: true, company: true } },
                        },
                    },
                },
            }),
            prisma.investment.count({ where }),
        ]);

        res.json({
            data: investments,
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        });
    } catch (error) {
        console.error('List investments error:', error);
        res.status(500).json({ error: 'Failed to list investments' });
    }
}

/**
 * GET /investments/:id
 * Get a single investment by ID (investor or project owner only).
 */
export async function getInvestment(req: Request, res: Response): Promise<void> {
    try {
        const userId = req.user!.id;
        const investment = await prisma.investment.findUnique({
            where: { id: req.params.id },
            include: {
                project: {
                    select: {
                        id: true, title: true, thumbnail: true,
                        fundingGoal: true, raisedAmount: true, ownerId: true,
                    },
                },
                investor: {
                    select: {
                        id: true, nostrPubkey: true,
                        profile: { select: { name: true, avatar: true, company: true } },
                    },
                },
            },
        });

        if (!investment) {
            res.status(404).json({ error: 'Investment not found' });
            return;
        }

        const isParty = investment.investorId === userId || investment.project.ownerId === userId;
        if (!isParty && !req.user!.isAdmin) {
            res.status(403).json({ error: 'Not authorized' });
            return;
        }

        res.json(investment);
    } catch (error) {
        console.error('Get investment error:', error);
        res.status(500).json({ error: 'Failed to get investment' });
    }
}

/**
 * POST /investments
 * Express investment interest in a project (investors only).
 */
export async function createInvestment(req: Request, res: Response): Promise<void> {
    try {
        const investorId = req.user!.id;
        const { projectId, amount, currency, terms, notes } = req.body;

        const project = await prisma.project.findUnique({
            where: { id: projectId },
            include: {
                owner: {
                    include: { profile: { select: { name: true } } },
                },
            },
        });

        if (!project || !project.isPublished) {
            res.status(404).json({ error: 'Project not found' });
            return;
        }
        if (project.ownerId === investorId) {
            res.status(400).json({ error: 'You cannot invest in your own project' });
            return;
        }

        const investor = await prisma.user.findUnique({
            where: { id: investorId },
            include: { profile: { select: { name: true } } },
        });

        const investment = await prisma.investment.create({
            data: {
                projectId,
                investorId,
                amount,
                currency: currency || 'USD',
                terms: terms || '',
                notes: notes || '',
                status: 'PENDING',
            },
        });

        // Notify builder
        const investorName = investor?.profile?.name || 'An investor';
        await notifyInvestmentInterest({
            builderId: project.ownerId,
            investorName,
            projectTitle: project.title,
            projectId: project.id,
            investmentId: investment.id,
        });

        // Announce investment interest on the BIES feed
        publishAnnouncement(investorId, `${investorName} expressed investment interest in "${project.title}".`, [['t', 'investment']]).catch((err) =>
            console.error('[Nostr] Investment announcement failed:', err)
        );

        res.status(201).json(investment);
    } catch (error: any) {
        if (error?.code === 'P2002') {
            res.status(409).json({ error: 'You have already expressed interest in this project' });
            return;
        }
        console.error('Create investment error:', error);
        res.status(500).json({ error: 'Failed to submit investment interest' });
    }
}

/**
 * PUT /investments/:id
 * Update investment status/terms.
 * Builders can update status; investors can update notes/terms while PENDING.
 */
export async function updateInvestment(req: Request, res: Response): Promise<void> {
    try {
        const userId = req.user!.id;
        const investment = await prisma.investment.findUnique({
            where: { id: req.params.id },
            include: {
                project: { select: { ownerId: true, title: true } },
            },
        });

        if (!investment) {
            res.status(404).json({ error: 'Investment not found' });
            return;
        }

        const isBuilder = investment.project.ownerId === userId;
        const isInvestor = investment.investorId === userId;
        const isAdmin = req.user!.isAdmin;

        if (!isBuilder && !isInvestor && !isAdmin) {
            res.status(403).json({ error: 'Not authorized' });
            return;
        }

        const { status, terms, notes } = req.body;
        const updateData: any = {};
        // The same status sent back (an investor editing notes or terms) is no change.
        const statusChange = status && status !== investment.status ? status : null;

        if (statusChange) {
            // Only builders and admins can change status
            if (!isBuilder && !isAdmin) {
                res.status(403).json({ error: 'Only the project builder can update investment status' });
                return;
            }
            updateData.status = statusChange;
        }
        if (terms !== undefined) updateData.terms = terms;
        if (notes !== undefined) updateData.notes = notes;

        // The project's raised total follows the investment into COMPLETED and
        // back out of it, once each way: the edit saves only if the status is
        // still the one it was decided on, in the same transaction.
        const wasCompleted = investment.status === 'COMPLETED';
        const isCompleted = (statusChange ?? investment.status) === 'COMPLETED';
        const updated = await prisma.$transaction(async (tx) => {
            if (Object.keys(updateData).length > 0) {
                const saved = await tx.investment.updateMany({
                    where: { id: investment.id, status: investment.status },
                    data: updateData,
                });
                if (saved.count !== 1) return null;
            }
            if (wasCompleted !== isCompleted) {
                await tx.project.update({
                    where: { id: investment.projectId },
                    data: { raisedAmount: isCompleted ? { increment: investment.amount } : { decrement: investment.amount } },
                });
            }
            return tx.investment.findUnique({ where: { id: investment.id } });
        });
        if (!updated) {
            res.status(409).json({ error: 'This investment was changed meanwhile. Reload it and try again.' });
            return;
        }

        // Notify investor of status change
        if (statusChange && isBuilder) {
            await notifyInvestmentStatus({
                investorId: investment.investorId,
                projectTitle: investment.project.title,
                status: statusChange,
                projectId: investment.projectId,
            });
        }

        res.json(updated);
    } catch (error) {
        console.error('Update investment error:', error);
        res.status(500).json({ error: 'Failed to update investment' });
    }
}

/**
 * GET /investments/stats/:projectId
 * Get aggregate funding stats for a project.
 */
export async function getProjectFundingStats(req: Request, res: Response): Promise<void> {
    try {
        const { projectId } = req.params;

        const [project, stats] = await Promise.all([
            prisma.project.findUnique({
                where: { id: projectId },
                select: { fundingGoal: true, raisedAmount: true },
            }),
            prisma.investment.groupBy({
                by: ['status'],
                where: { projectId },
                _count: { id: true },
                _sum: { amount: true },
            }),
        ]);

        if (!project) {
            res.status(404).json({ error: 'Project not found' });
            return;
        }

        const breakdown = Object.fromEntries(
            stats.map((s) => [s.status, { count: s._count.id, total: s._sum.amount || 0 }])
        );

        res.json({
            fundingGoal: project.fundingGoal,
            raisedAmount: project.raisedAmount,
            percentRaised: project.fundingGoal
                ? Math.round((project.raisedAmount / project.fundingGoal) * 100)
                : null,
            breakdown,
        });
    } catch (error) {
        console.error('Funding stats error:', error);
        res.status(500).json({ error: 'Failed to get funding stats' });
    }
}
