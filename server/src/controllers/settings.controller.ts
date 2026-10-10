import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { z } from 'zod';

export const updateNotificationSettingsSchema = z.object({
    emailNotifications: z.boolean().optional(),
    pushNotifications: z.boolean().optional(),
    marketingEmails: z.boolean().optional(),
    notifyMessages: z.boolean().optional(),
    notifyInvestments: z.boolean().optional(),
    notifyFollows: z.boolean().optional(),
    notifyProjectUpdates: z.boolean().optional(),
});

export const updateRelaysSchema = z.object({
    relays: z.array(z.string().url()).min(0).max(20),
});

/**
 * GET /settings
 * Return current user's settings (auto-creates if not yet existing).
 */
export async function getSettings(req: Request, res: Response): Promise<void> {
    try {
        let settings = await prisma.userSettings.findUnique({
            where: { userId: req.user!.id },
        });

        if (!settings) {
            settings = await prisma.userSettings.create({
                data: { userId: req.user!.id },
            });
        }

        res.json({
            ...settings,
            relays: JSON.parse(settings.relays || '[]'),
            preferences: JSON.parse(settings.preferences || '{}'),
        });
    } catch (error) {
        console.error('Get settings error:', error);
        res.status(500).json({ error: 'Failed to get settings' });
    }
}

/**
 * PUT /settings/notifications
 * Update notification preferences.
 */
export async function updateNotificationSettings(req: Request, res: Response): Promise<void> {
    try {
        // Explicitly pick allowed fields to prevent mass assignment
        const allowedFields = ['emailNotifications', 'pushNotifications', 'marketingEmails', 'notifyMessages', 'notifyInvestments', 'notifyFollows', 'notifyProjectUpdates'];
        const data: any = {};
        for (const field of allowedFields) {
            if (req.body[field] !== undefined) data[field] = req.body[field];
        }

        const settings = await prisma.userSettings.upsert({
            where: { userId: req.user!.id },
            update: data,
            create: { userId: req.user!.id, ...data },
        });

        res.json({
            ...settings,
            relays: JSON.parse(settings.relays || '[]'),
        });
    } catch (error) {
        console.error('Update notification settings error:', error);
        res.status(500).json({ error: 'Failed to update notification settings' });
    }
}

/**
 * PUT /settings/relays
 * Update connected Nostr relay list.
 */
export async function updateRelays(req: Request, res: Response): Promise<void> {
    try {
        const { relays } = req.body;

        const settings = await prisma.userSettings.upsert({
            where: { userId: req.user!.id },
            update: { relays: JSON.stringify(relays) },
            create: { userId: req.user!.id, relays: JSON.stringify(relays) },
        });

        res.json({
            ...settings,
            relays: JSON.parse(settings.relays || '[]'),
        });
    } catch (error) {
        console.error('Update relays error:', error);
        res.status(500).json({ error: 'Failed to update relays' });
    }
}

const mediaItemId = z.string().min(1).max(500);

export const updateMediaReadSchema = z.object({
    watched: z.array(mediaItemId).max(5000).optional(),
    read: z.array(mediaItemId).max(5000).optional(),
});

export const toggleMediaReadSchema = z.object({
    itemId: mediaItemId,
    itemType: z.enum(['watched', 'read']),
    value: z.boolean(),
});

const mediaReadDeltaSchema = z.object({
    watched: z.array(mediaItemId).max(5000).optional().default([]),
    read: z.array(mediaItemId).max(5000).optional().default([]),
}).optional().default({});

export const bulkMediaReadSchema = z.object({
    add: mediaReadDeltaSchema,
    remove: mediaReadDeltaSchema,
}).refine(
    (body) =>
        body.add.watched.length + body.add.read.length +
        body.remove.watched.length + body.remove.read.length <= 5000,
    { message: 'Too many items (max 5000 per request)' }
);

/**
 * Run a read-modify-write of the mediaReadItems blob in a SERIALIZABLE
 * transaction, retrying on write conflicts (Prisma P2034: Postgres
 * serialization failures, SQLite busy/locked). Plain READ COMMITTED
 * transactions do not serialize concurrent read-modify-writes, so without
 * this two overlapping toggles silently lose one of the updates.
 */
async function mediaReadTransaction<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
    const MAX_RETRIES = 3;
    for (let attempt = 0; ; attempt++) {
        try {
            return await prisma.$transaction(fn, {
                isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            });
        } catch (error) {
            const isWriteConflict =
                error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
            if (!isWriteConflict || attempt >= MAX_RETRIES) throw error;
            await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
        }
    }
}

/** Safely parse the mediaReadItems JSON blob into { watched, read } arrays. */
function parseMediaRead(raw: string | null | undefined): { watched: string[]; read: string[] } {
    try {
        const data = JSON.parse(raw || '{}');
        return {
            watched: Array.isArray(data.watched) ? data.watched : [],
            read: Array.isArray(data.read) ? data.read : [],
        };
    } catch {
        return { watched: [], read: [] };
    }
}

/**
 * GET /settings/media-read
 */
export async function getMediaRead(req: Request, res: Response): Promise<void> {
    try {
        const settings = await prisma.userSettings.findUnique({ where: { userId: req.user!.id } });
        res.json(parseMediaRead(settings?.mediaReadItems));
    } catch (error) {
        console.error('Get media read error:', error);
        res.status(500).json({ error: 'Failed to get media read state' });
    }
}

/**
 * PUT /settings/media-read
 * Legacy full-array replace — kept for older clients. New clients should use
 * the atomic toggle/bulk endpoints below.
 */
export async function updateMediaRead(req: Request, res: Response): Promise<void> {
    try {
        const { watched, read } = req.body;
        const userId = req.user!.id;

        const updated = await mediaReadTransaction(async (tx) => {
            const settings = await tx.userSettings.findUnique({ where: { userId } });
            const current = parseMediaRead(settings?.mediaReadItems);

            const next = {
                watched: watched !== undefined ? watched : current.watched,
                read: read !== undefined ? read : current.read,
            };

            await tx.userSettings.upsert({
                where: { userId },
                update: { mediaReadItems: JSON.stringify(next) },
                create: { userId, mediaReadItems: JSON.stringify(next) },
            });

            return next;
        });

        res.json(updated);
    } catch (error) {
        console.error('Update media read error:', error);
        res.status(500).json({ error: 'Failed to update media read state' });
    }
}

/**
 * POST /settings/media-read/toggle
 * Atomically add or remove a single item. The read-modify-write of the JSON
 * blob runs inside a transaction so concurrent devices can't clobber each other.
 */
export async function toggleMediaRead(req: Request, res: Response): Promise<void> {
    try {
        const { itemId, itemType, value } = req.body as {
            itemId: string;
            itemType: 'watched' | 'read';
            value: boolean;
        };
        const userId = req.user!.id;

        const updated = await mediaReadTransaction(async (tx) => {
            const settings = await tx.userSettings.findUnique({ where: { userId } });
            const current = parseMediaRead(settings?.mediaReadItems);

            const items = new Set(current[itemType]);
            if (value) items.add(itemId); else items.delete(itemId);
            const next = { ...current, [itemType]: [...items] };

            await tx.userSettings.upsert({
                where: { userId },
                update: { mediaReadItems: JSON.stringify(next) },
                create: { userId, mediaReadItems: JSON.stringify(next) },
            });

            return next;
        });

        res.json(updated);
    } catch (error) {
        console.error('Toggle media read error:', error);
        res.status(500).json({ error: 'Failed to update media read state' });
    }
}

/**
 * POST /settings/media-read/bulk
 * Apply add/remove deltas as a server-side merge inside a transaction —
 * never a full replace, so items marked on other devices are preserved.
 */
export async function bulkMediaRead(req: Request, res: Response): Promise<void> {
    try {
        const { add, remove } = req.body as {
            add: { watched: string[]; read: string[] };
            remove: { watched: string[]; read: string[] };
        };
        const userId = req.user!.id;

        const updated = await mediaReadTransaction(async (tx) => {
            const settings = await tx.userSettings.findUnique({ where: { userId } });
            const current = parseMediaRead(settings?.mediaReadItems);

            const watched = new Set(current.watched);
            const read = new Set(current.read);
            add.watched.forEach((id) => watched.add(id));
            add.read.forEach((id) => read.add(id));
            remove.watched.forEach((id) => watched.delete(id));
            remove.read.forEach((id) => read.delete(id));
            const next = { watched: [...watched], read: [...read] };

            await tx.userSettings.upsert({
                where: { userId },
                update: { mediaReadItems: JSON.stringify(next) },
                create: { userId, mediaReadItems: JSON.stringify(next) },
            });

            return next;
        });

        res.json(updated);
    } catch (error) {
        console.error('Bulk media read error:', error);
        res.status(500).json({ error: 'Failed to update media read state' });
    }
}

export const updatePreferencesSchema = z.object({
    theme: z.string().optional(),
    language: z.string().optional(),
    projectsView: z.string().optional(),
    membersView: z.string().optional(),
    eventsView: z.string().optional(),
    mediaView: z.string().optional(),
    defaultView: z.string().optional(),
    bottomNavTabs: z.array(z.string().max(64)).max(12).optional(),
}).passthrough();

/**
 * GET /settings/preferences
 */
export async function getPreferences(req: Request, res: Response): Promise<void> {
    try {
        const settings = await prisma.userSettings.findUnique({ where: { userId: req.user!.id } });
        res.json(JSON.parse(settings?.preferences || '{}'));
    } catch (error) {
        console.error('Get preferences error:', error);
        res.status(500).json({ error: 'Failed to get preferences' });
    }
}

/**
 * PUT /settings/preferences
 */
export async function updatePreferences(req: Request, res: Response): Promise<void> {
    try {
        const settings = await prisma.userSettings.findUnique({ where: { userId: req.user!.id } });
        const current = JSON.parse(settings?.preferences || '{}');
        const merged = { ...current, ...req.body };

        await prisma.userSettings.upsert({
            where: { userId: req.user!.id },
            update: { preferences: JSON.stringify(merged) },
            create: { userId: req.user!.id, preferences: JSON.stringify(merged) },
        });

        res.json(merged);
    } catch (error) {
        console.error('Update preferences error:', error);
        res.status(500).json({ error: 'Failed to update preferences' });
    }
}
