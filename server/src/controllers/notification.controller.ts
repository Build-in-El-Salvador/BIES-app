/**
 * Notification controller — list, read, and manage user notifications.
 */

import crypto from 'crypto';
import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { cache, cacheKey } from '../services/redis.service';
import { notifyFeedInteraction } from '../services/notification.service';
import { config } from '../config';
import { isPushServiceEndpoint } from '../services/webpush.service';

/**
 * Native push device token registration. APNs (and FCM) device tokens are
 * bounded hex strings; reject anything else so junk/oversized values can't be
 * persisted permanently in the unique-indexed `token` column.
 */
export const registerDeviceTokenSchema = z.object({
    token: z
        .string()
        .regex(/^[0-9a-fA-F]+$/, 'token must be a hex string')
        .min(32)
        .max(200),
    platform: z.enum(['ios', 'android']).optional().default('ios'),
});

/**
 * GET /notifications
 * List notifications for the current user (newest first, paginated).
 */
export async function listNotifications(req: Request, res: Response): Promise<void> {
    try {
        const userId = req.user!.id;
        const page = parseInt(req.query.page as string || '1', 10);
        const limit = Math.min(parseInt(req.query.limit as string || '20', 10), 50);
        const skip = (page - 1) * limit;
        const unreadOnly = req.query.unread === 'true';

        const where: any = { userId };
        if (unreadOnly) where.isRead = false;

        const [notifications, total, unreadCount] = await Promise.all([
            prisma.notification.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit,
            }),
            prisma.notification.count({ where }),
            prisma.notification.count({ where: { userId, isRead: false } }),
        ]);

        const parsed = notifications.map((n) => ({
            ...n,
            data: JSON.parse(n.data || '{}'),
        }));

        res.json({
            data: parsed,
            unreadCount,
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        });
    } catch (error) {
        console.error('List notifications error:', error);
        res.status(500).json({ error: 'Failed to list notifications' });
    }
}

/**
 * GET /notifications/count
 * Get unread notification count (fast, cached).
 */
export async function getUnreadCount(req: Request, res: Response): Promise<void> {
    try {
        const userId = req.user!.id;
        const cKey = cacheKey.notificationCount(userId);

        const cached = await cache.get(cKey);
        if (cached !== null) {
            res.json({ count: parseInt(cached, 10) });
            return;
        }

        const count = await prisma.notification.count({
            where: { userId, isRead: false },
        });

        await cache.set(cKey, String(count), 30);
        res.json({ count });
    } catch (error) {
        console.error('Notification count error:', error);
        res.status(500).json({ error: 'Failed to get notification count' });
    }
}

/**
 * PUT /notifications/:id/read
 * Mark a single notification as read.
 */
export async function markRead(req: Request, res: Response): Promise<void> {
    try {
        const userId = req.user!.id;
        const notification = await prisma.notification.findUnique({
            where: { id: req.params.id },
        });

        if (!notification || notification.userId !== userId) {
            res.status(404).json({ error: 'Notification not found' });
            return;
        }

        await prisma.notification.update({
            where: { id: req.params.id },
            data: { isRead: true, readAt: new Date() },
        });

        await cache.del(cacheKey.notificationCount(userId));

        res.json({ message: 'Notification marked as read' });
    } catch (error) {
        console.error('Mark read error:', error);
        res.status(500).json({ error: 'Failed to mark notification as read' });
    }
}

/**
 * PUT /notifications/read-all
 * Mark all notifications as read.
 */
export async function markAllRead(req: Request, res: Response): Promise<void> {
    try {
        const userId = req.user!.id;

        await prisma.notification.updateMany({
            where: { userId, isRead: false },
            data: { isRead: true, readAt: new Date() },
        });

        await cache.del(cacheKey.notificationCount(userId));

        res.json({ message: 'All notifications marked as read' });
    } catch (error) {
        console.error('Mark all read error:', error);
        res.status(500).json({ error: 'Failed to mark all notifications as read' });
    }
}

/**
 * DELETE /notifications/:id
 * Delete a specific notification.
 */
export async function deleteNotification(req: Request, res: Response): Promise<void> {
    try {
        const userId = req.user!.id;
        const notification = await prisma.notification.findUnique({
            where: { id: req.params.id },
        });

        if (!notification || notification.userId !== userId) {
            res.status(404).json({ error: 'Notification not found' });
            return;
        }

        await prisma.notification.delete({ where: { id: req.params.id } });
        await cache.del(cacheKey.notificationCount(userId));

        res.json({ message: 'Notification deleted' });
    } catch (error) {
        console.error('Delete notification error:', error);
        res.status(500).json({ error: 'Failed to delete notification' });
    }
}

/**
 * POST /notifications/feed-interaction
 * Create a notification for a feed interaction (comment, like, reply).
 * The authenticated user is the actor; targetPubkey is the recipient.
 */
const VALID_FEED_TYPES = ['POST_COMMENT', 'POST_LIKE', 'COMMENT_LIKE', 'COMMENT_REPLY'] as const;
const HEX_ID = /^[0-9a-f]{64}$/;

export async function feedInteraction(req: Request, res: Response): Promise<void> {
    try {
        const { type, targetPubkey, eventId, contentPreview } = req.body;
        const actorPubkey = req.user!.nostrPubkey;

        if (!type || !VALID_FEED_TYPES.includes(type)) {
            res.status(400).json({ error: 'Invalid interaction type' });
            return;
        }

        if (typeof targetPubkey !== 'string' || !HEX_ID.test(targetPubkey)) {
            res.status(400).json({ error: 'targetPubkey is required' });
            return;
        }
        // The post it's about must be a real event id. The same like, or the
        // same comment text, notifies once a day however often it's sent.
        if (typeof eventId !== 'string' || !HEX_ID.test(eventId)) {
            res.status(400).json({ error: 'eventId is required' });
            return;
        }
        const text = typeof contentPreview === 'string' && type !== 'POST_LIKE' && type !== 'COMMENT_LIKE'
            ? crypto.createHash('sha256').update(contentPreview).digest('hex').slice(0, 16)
            : '';
        const once = `feedInteraction:${req.user!.id}:${targetPubkey}:${type}:${eventId}:${text}`;
        if (await cache.get(once)) { res.json({ message: 'ok' }); return; }
        await cache.set(once, '1', 24 * 60 * 60);

        // The name is the actor's own, never what the request says.
        const actor = await prisma.profile.findUnique({ where: { userId: req.user!.id }, select: { name: true } });
        const name = actor?.name?.trim() && !actor.name.startsWith('nostr:') ? actor.name.trim().slice(0, 60) : 'A member';

        await notifyFeedInteraction({
            actorPubkey,
            targetPubkey,
            type,
            actorName: name,
            eventId,
            contentPreview: typeof contentPreview === 'string' ? contentPreview.slice(0, 120) : undefined,
        });

        res.json({ message: 'ok' });
    } catch (error) {
        console.error('Feed interaction notification error:', error);
        res.status(500).json({ error: 'Failed to create notification' });
    }
}

// ─── Push subscription endpoints ─────────────────────────────────────────────

/**
 * GET /notifications/push/vapid-key
 * Return the public VAPID key (needed by PushManager.subscribe on the client).
 */
export async function getVapidPublicKey(req: Request, res: Response): Promise<void> {
    const key = config.vapid.publicKey;
    if (!key) {
        res.status(503).json({ error: 'Push notifications are not configured' });
        return;
    }
    res.json({ publicKey: key });
}

/**
 * POST /notifications/push/subscribe
 * Store a push subscription for the authenticated user.
 */
export async function subscribePush(req: Request, res: Response): Promise<void> {
    try {
        const userId = req.user!.id;
        const { endpoint, keys } = req.body;

        if (!endpoint || !keys?.p256dh || !keys?.auth) {
            res.status(400).json({ error: 'endpoint and keys (p256dh, auth) are required' });
            return;
        }
        if (typeof endpoint !== 'string' || endpoint.length > 1000 || !isPushServiceEndpoint(endpoint)) {
            res.status(400).json({ error: "That isn't a browser push service" });
            return;
        }

        await prisma.pushSubscription.upsert({
            where: {
                userId_endpoint: { userId, endpoint },
            },
            update: {
                p256dh: keys.p256dh,
                auth: keys.auth,
                userAgent: req.headers['user-agent'] || null,
            },
            create: {
                userId,
                endpoint,
                p256dh: keys.p256dh,
                auth: keys.auth,
                userAgent: req.headers['user-agent'] || null,
            },
        });

        res.json({ message: 'Push subscription registered' });
    } catch (error) {
        console.error('Push subscribe error:', error);
        res.status(500).json({ error: 'Failed to register push subscription' });
    }
}

/**
 * DELETE /notifications/push/subscribe
 * Remove a push subscription (user disabled push or unsubscribed).
 */
export async function unsubscribePush(req: Request, res: Response): Promise<void> {
    try {
        const userId = req.user!.id;
        const { endpoint } = req.body;

        if (!endpoint) {
            res.status(400).json({ error: 'endpoint is required' });
            return;
        }

        await prisma.pushSubscription.deleteMany({
            where: { userId, endpoint },
        });

        res.json({ message: 'Push subscription removed' });
    } catch (error) {
        console.error('Push unsubscribe error:', error);
        res.status(500).json({ error: 'Failed to remove push subscription' });
    }
}

// ─── Native device token endpoints (APNs) ────────────────────────────────────

/**
 * POST /notifications/device-token
 * Register (or re-assign) a native push device token for the authenticated
 * user. Upserts on the globally-unique token so a device that re-logs-in as a
 * different user reassigns cleanly instead of duplicating.
 */
export async function registerDeviceToken(req: Request, res: Response): Promise<void> {
    try {
        const userId = req.user!.id;
        const { token, platform } = req.body;

        if (!token || typeof token !== 'string') {
            res.status(400).json({ error: 'token is required' });
            return;
        }

        await prisma.deviceToken.upsert({
            where: { token },
            update: { userId, platform: platform || 'ios' },
            create: { userId, token, platform: platform || 'ios' },
        });

        res.json({ message: 'Device token registered' });
    } catch (error) {
        console.error('Device token register error:', error);
        res.status(500).json({ error: 'Failed to register device token' });
    }
}

/**
 * DELETE /notifications/device-token
 * Remove a native push device token (user logged out or disabled push).
 */
export async function unregisterDeviceToken(req: Request, res: Response): Promise<void> {
    try {
        const userId = req.user!.id;
        const { token } = req.body;

        if (!token || typeof token !== 'string') {
            res.status(400).json({ error: 'token is required' });
            return;
        }

        await prisma.deviceToken.deleteMany({
            where: { userId, token },
        });

        res.json({ message: 'Device token removed' });
    } catch (error) {
        console.error('Device token unregister error:', error);
        res.status(500).json({ error: 'Failed to remove device token' });
    }
}
