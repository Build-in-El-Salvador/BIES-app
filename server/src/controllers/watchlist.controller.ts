/**
 * Watchlist controller: the opportunities a member saved (Save on an
 * opportunity's page). Saving is private: its member isn't told.
 */

import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { z } from 'zod';
import { withoutDeckKey } from '../utils/projectFields';
import { hiddenFromIds, isStaffUser } from '../services/moderation.service';

export const addToWatchlistSchema = z.object({
    projectId: z.string().min(1),
    note: z.string().max(500).optional(),
});

export const watchlistNoteSchema = z.object({
    note: z.string().max(500).optional(),
});

/**
 * GET /watchlist
 * What the member saved, closed ones too, as a list shows them: without its
 * member's WhatsApp and email. Not those staff took down, nor those of
 * suspended or deleted members or of members blocked either way.
 */
export async function getWatchlist(req: Request, res: Response): Promise<void> {
    try {
        const userId = req.user!.id;
        const hidden = await hiddenFromIds(userId, { staff: isStaffUser(req.user) });

        const items = await prisma.watchlistItem.findMany({
            where: {
                userId,
                project: {
                    isPublished: true,
                    owner: { isBanned: false, deletedAt: null },
                    ...(hidden.length ? { ownerId: { notIn: hidden } } : {}),
                },
            },
            orderBy: { addedAt: 'desc' },
            include: {
                project: {
                    include: {
                        owner: {
                            select: {
                                id: true, nostrPubkey: true,
                                profile: { select: { name: true, avatar: true, company: true } },
                            },
                        },
                    },
                },
            },
        });

        const parsed = items.map((item) => {
            const { whatsapp: _whatsapp, email: _email, ...project } = withoutDeckKey(item.project);
            return { ...item, project: { ...project, tags: JSON.parse(item.project.tags || '[]') } };
        });

        res.json({ data: parsed });
    } catch (error) {
        console.error('Get watchlist error:', error);
        res.status(500).json({ error: 'Failed to get watchlist' });
    }
}

/**
 * POST /watchlist
 * Add a project to the watchlist.
 */
export async function addToWatchlist(req: Request, res: Response): Promise<void> {
    try {
        const userId = req.user!.id;
        const { projectId, note } = req.body;

        // One that's up, of a member who is still one, and whom they haven't
        // blocked (or been blocked by).
        const project = await prisma.project.findUnique({
            where: { id: projectId },
            select: { isPublished: true, ownerId: true, owner: { select: { isBanned: true, deletedAt: true } } },
        });

        if (!project || !project.isPublished || project.owner.isBanned || project.owner.deletedAt || (await hiddenFromIds(userId)).includes(project.ownerId)) {
            res.status(404).json({ error: 'Project not found' });
            return;
        }

        const item = await prisma.watchlistItem.create({
            data: { userId, projectId, note: note || '' },
            include: {
                project: {
                    select: { id: true, title: true, thumbnail: true, category: true, stage: true },
                },
            },
        });

        res.status(201).json(item);
    } catch (error: any) {
        if (error?.code === 'P2002') {
            res.status(409).json({ error: 'Project already in watchlist' });
            return;
        }
        console.error('Add to watchlist error:', error);
        res.status(500).json({ error: 'Failed to add to watchlist' });
    }
}

/**
 * DELETE /watchlist/:projectId
 * Remove a project from the watchlist.
 */
export async function removeFromWatchlist(req: Request, res: Response): Promise<void> {
    try {
        const userId = req.user!.id;
        const { projectId } = req.params;

        await prisma.watchlistItem.deleteMany({
            where: { userId, projectId },
        });

        res.json({ message: 'Removed from watchlist' });
    } catch (error) {
        console.error('Remove from watchlist error:', error);
        res.status(500).json({ error: 'Failed to remove from watchlist' });
    }
}

/**
 * PUT /watchlist/:projectId/note
 * Update the note on a watchlist item.
 */
export async function updateWatchlistNote(req: Request, res: Response): Promise<void> {
    try {
        const userId = req.user!.id;
        const { projectId } = req.params;
        const { note } = req.body;

        const item = await prisma.watchlistItem.updateMany({
            where: { userId, projectId },
            data: { note: note || '' },
        });

        if (item.count === 0) {
            res.status(404).json({ error: 'Watchlist item not found' });
            return;
        }

        res.json({ message: 'Note updated' });
    } catch (error) {
        console.error('Update watchlist note error:', error);
        res.status(500).json({ error: 'Failed to update note' });
    }
}

/**
 * GET /watchlist/check/:projectId
 * Check if a specific project is in the user's watchlist.
 */
export async function checkWatchlist(req: Request, res: Response): Promise<void> {
    try {
        const item = await prisma.watchlistItem.findUnique({
            where: {
                userId_projectId: {
                    userId: req.user!.id,
                    projectId: req.params.projectId,
                },
            },
        });
        res.json({ isWatchlisted: !!item, item: item || null });
    } catch (error) {
        console.error('Check watchlist error:', error);
        res.status(500).json({ error: 'Failed to check watchlist' });
    }
}
