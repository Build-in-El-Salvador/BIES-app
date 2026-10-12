/**
 * Message controller — handles DM threads between users.
 *
 * Messages are stored in the DB (optionally referencing a Nostr event ID)
 * and pushed in real-time via WebSocket to online recipients.
 *
 * The content field stores Nostr NIP-04 encrypted ciphertext (base64) so that
 * only the two parties can decrypt. The server never sees plaintext.
 */

import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { blockedEitherWay } from '../services/moderation.service';
import { z } from 'zod';
import { notifyNewMessage } from '../services/notification.service';
import { sendToUser } from '../services/websocket.service';

// ─── Validation ───────────────────────────────────────────────────────────────

export const sendMessageSchema = z.object({
    recipientId: z.string().min(1),
    content: z.string().min(1).max(10_000),
    isEncrypted: z.boolean().default(true),
    nostrEventId: z.string().optional(),
});

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * GET /messages/conversations
 * List all conversation partners with the latest message and unread count.
 */
export async function listConversations(req: Request, res: Response): Promise<void> {
    try {
        const userId = req.user!.id;

        // Get all messages involving this user, grouped by the other party
        const messages = await prisma.message.findMany({
            where: {
                OR: [{ senderId: userId }, { recipientId: userId }],
            },
            orderBy: { createdAt: 'desc' },
            include: {
                sender: {
                    select: {
                        id: true, nostrPubkey: true,
                        profile: { select: { name: true, avatar: true } },
                    },
                },
                recipient: {
                    select: {
                        id: true, nostrPubkey: true,
                        profile: { select: { name: true, avatar: true } },
                    },
                },
            },
        });

        // Build conversation map: other party ID → latest message + unread count
        const conversationMap = new Map<string, {
            partner: typeof messages[0]['sender'];
            latestMessage: typeof messages[0];
            unreadCount: number;
        }>();

        for (const msg of messages) {
            const partnerId = msg.senderId === userId ? msg.recipientId : msg.senderId;
            const partner = msg.senderId === userId ? msg.recipient : msg.sender;

            if (!conversationMap.has(partnerId)) {
                conversationMap.set(partnerId, {
                    partner,
                    latestMessage: msg,
                    unreadCount: 0,
                });
            }

            // Count unread (messages sent TO me, not read yet)
            if (msg.recipientId === userId && !msg.isRead) {
                conversationMap.get(partnerId)!.unreadCount++;
            }
        }

        const conversations = Array.from(conversationMap.values());

        res.json({ data: conversations });
    } catch (error) {
        console.error('List conversations error:', error);
        res.status(500).json({ error: 'Failed to list conversations' });
    }
}

/**
 * GET /messages/:partnerId
 * Get full message thread with a specific user, paginated.
 */
export async function getThread(req: Request, res: Response): Promise<void> {
    try {
        const userId = req.user!.id;
        const { partnerId } = req.params;
        const page = parseInt(req.query.page as string || '1', 10);
        const limit = Math.min(parseInt(req.query.limit as string || '50', 10), 100);
        const skip = (page - 1) * limit;

        const [messages, total] = await Promise.all([
            prisma.message.findMany({
                where: {
                    OR: [
                        { senderId: userId, recipientId: partnerId },
                        { senderId: partnerId, recipientId: userId },
                    ],
                },
                orderBy: { createdAt: 'asc' },
                skip,
                take: limit,
                include: {
                    sender: {
                        select: {
                            id: true, nostrPubkey: true,
                            profile: { select: { name: true, avatar: true } },
                        },
                    },
                },
            }),
            prisma.message.count({
                where: {
                    OR: [
                        { senderId: userId, recipientId: partnerId },
                        { senderId: partnerId, recipientId: userId },
                    ],
                },
            }),
        ]);

        // Mark unread messages as read
        await prisma.message.updateMany({
            where: {
                senderId: partnerId,
                recipientId: userId,
                isRead: false,
            },
            data: { isRead: true, readAt: new Date() },
        });

        // Notify sender their messages were read
        sendToUser(partnerId, { type: 'messages_read', byUserId: userId });

        res.json({
            data: messages,
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        });
    } catch (error) {
        console.error('Get thread error:', error);
        res.status(500).json({ error: 'Failed to get message thread' });
    }
}

/**
 * POST /messages
 * Send a message. Stores in DB and pushes via WebSocket.
 */
export async function sendMessage(req: Request, res: Response): Promise<void> {
    try {
        const senderId = req.user!.id;
        const { recipientId, content, isEncrypted, nostrEventId } = req.body;

        // Verify recipient exists
        const recipient = await prisma.user.findUnique({
            where: { id: recipientId },
            include: { profile: { select: { name: true } } },
        });

        if (!recipient) {
            res.status(404).json({ error: 'Recipient not found' });
            return;
        }
        if (await blockedEitherWay(senderId, recipientId)) {
            res.status(403).json({ error: "You can't message this member", reason: 'blocked' });
            return;
        }

        const sender = await prisma.user.findUnique({
            where: { id: senderId },
            include: { profile: { select: { name: true } } },
        });

        const message = await prisma.message.create({
            data: {
                senderId,
                recipientId,
                content,
                isEncrypted: isEncrypted ?? true,
                nostrEventId,
            },
            include: {
                sender: {
                    select: {
                        id: true, nostrPubkey: true,
                        profile: { select: { name: true, avatar: true } },
                    },
                },
            },
        });

        // Push message in real-time to recipient
        sendToUser(recipientId, {
            type: 'new_message',
            message,
        });

        // Always create a notification so it appears in the notification center
        await notifyNewMessage({
            recipientId,
            senderName: sender?.profile?.name || 'Someone',
            preview: isEncrypted ? '[Encrypted message]' : content.substring(0, 80),
            senderId,
        });

        res.status(201).json(message);
    } catch (error) {
        console.error('Send message error:', error);
        res.status(500).json({ error: 'Failed to send message' });
    }
}

/**
 * DELETE /messages/:id
 * Delete a message (sender only, within 5 minutes).
 */
export async function deleteMessage(req: Request, res: Response): Promise<void> {
    try {
        const userId = req.user!.id;
        const message = await prisma.message.findUnique({ where: { id: req.params.id } });

        if (!message) {
            res.status(404).json({ error: 'Message not found' });
            return;
        }
        if (message.senderId !== userId) {
            res.status(403).json({ error: 'Cannot delete another user\'s message' });
            return;
        }

        const ageMs = Date.now() - message.createdAt.getTime();
        if (ageMs > 5 * 60 * 1000) {
            res.status(403).json({ error: 'Messages can only be deleted within 5 minutes of sending' });
            return;
        }

        await prisma.message.delete({ where: { id: req.params.id } });

        // Notify recipient of deletion
        sendToUser(message.recipientId, { type: 'message_deleted', messageId: message.id });

        res.json({ message: 'Message deleted' });
    } catch (error) {
        console.error('Delete message error:', error);
        res.status(500).json({ error: 'Failed to delete message' });
    }
}

/**
 * GET /messages/unread-count
 * Get total unread message count for the current user.
 */
export async function getUnreadCount(req: Request, res: Response): Promise<void> {
    try {
        const count = await prisma.message.count({
            where: { recipientId: req.user!.id, isRead: false },
        });
        res.json({ count });
    } catch (error) {
        console.error('Unread count error:', error);
        res.status(500).json({ error: 'Failed to get unread count' });
    }
}
