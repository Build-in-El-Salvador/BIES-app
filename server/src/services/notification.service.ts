/**
 * Notification service — creates DB records and pushes real-time events.
 * All notification creation goes through here to keep logic centralised.
 */

import prisma from '../lib/prisma';
import { sendToUser } from './websocket.service';
import { cache, cacheKey, TTL } from './redis.service';
import { sendPushToUser, isWebPushEnabled } from './webpush.service';
import { sendApnsToUser, isApnsEnabled } from './apns.service';

export type NotificationType =
    | 'NEW_MESSAGE'
    | 'INVESTMENT_INTEREST'
    | 'PROJECT_VIEW'
    | 'WATCHLIST_ADD'
    | 'FOLLOW'
    | 'PROJECT_UPDATE'
    | 'INVESTMENT_STATUS'
    | 'DECK_REQUEST'
    | 'DECK_APPROVED'
    | 'DECK_DENIED'
    | 'PROFILE_VIEW'
    | 'ZAP_RECEIVED'
    | 'EVENT_RSVP'
    | 'POST_COMMENT'
    | 'POST_LIKE'
    | 'COMMENT_LIKE'
    | 'COMMENT_REPLY'
    | 'LEVEL_UP'
    | 'BADGE_EARNED'
    | 'VOUCHER_REDEEMED'
    | 'BOUNTY_SUBMISSION'
    | 'BOUNTY_AWARDED'
    | 'BOUNTY_PAID'
    | 'BOUNTY_REFUNDED'
    | 'BOUNTY_CANCELLED'
    | 'SYSTEM';

interface CreateNotificationParams {
    userId: string;
    type: NotificationType;
    title: string;
    body: string;
    data?: Record<string, unknown>;
}

/**
 * Create a notification and push it via WebSocket (if user is online).
 */
/**
 * Stop push notifications to every device a member registered: on a ban, a
 * deletion or a merge. Their sessions are ended separately
 * (services/session.service.ts).
 */
export async function removePushTargets(userId: string): Promise<void> {
    await prisma.deviceToken.deleteMany({ where: { userId } });
    await prisma.pushSubscription.deleteMany({ where: { userId } });
}

export async function createNotification(params: CreateNotificationParams): Promise<void> {
    const { userId, type, title, body, data = {} } = params;

    try {
        const notification = await prisma.notification.create({
            data: {
                userId,
                type,
                title,
                body,
                data: JSON.stringify(data),
            },
        });

        // Invalidate notification count cache for this user
        await cache.del(cacheKey.notificationCount(userId));

        // Push to WebSocket if user is connected
        sendToUser(userId, {
            type: 'notification',
            notification: {
                id: notification.id,
                type,
                title,
                body,
                data,
                isRead: false,
                createdAt: notification.createdAt,
            },
        });

        // Always attempt web push. The service worker decides whether to
        // show a system notification based on whether a BIES window is
        // currently focused, so we don't double-notify an active user.
        // sendPushToUser no-ops for users without subscriptions or with
        // push disabled in their settings.
        if (isWebPushEnabled()) {
            sendPushToUser(userId, {
                title,
                body,
                tag: `bies-${type.toLowerCase()}-${notification.id}`,
                url: getNotificationUrl(type, data),
                data: { notificationId: notification.id, type },
            }).catch((err) => {
                console.error('[Notification] Web push failed:', err);
            });
        }

        // Parallel native push (APNs) for iOS devices. Additive and independent
        // of web push — no-ops when APNs is not configured.
        if (isApnsEnabled()) {
            sendApnsToUser(userId, {
                title,
                body,
                url: getNotificationUrl(type, data),
                data: { notificationId: notification.id, type },
            }).catch((err) => {
                console.error('[Notification] APNs push failed:', err);
            });
        }
    } catch (error) {
        console.error('[Notification] Failed to create notification:', error);
    }
}

// ─── Convenience wrappers ─────────────────────────────────────────────────────

export async function notifyNewMessage(params: {
    recipientId: string;
    senderName: string;
    preview: string;
    senderId: string;
}): Promise<void> {
    await createNotification({
        userId: params.recipientId,
        type: 'NEW_MESSAGE',
        title: `New message from ${params.senderName}`,
        body: params.preview.substring(0, 100),
        data: { senderId: params.senderId },
    });
}

export async function notifyInvestmentInterest(params: {
    builderId: string;
    investorName: string;
    projectTitle: string;
    projectId: string;
    investmentId?: string;
}): Promise<void> {
    await createNotification({
        userId: params.builderId,
        type: 'INVESTMENT_INTEREST',
        title: `${params.investorName} is interested in "${params.projectTitle}"`,
        body: 'An investor has expressed interest in your project.',
        data: { projectId: params.projectId, investmentId: params.investmentId },
    });
}

export async function notifyWatchlistAdd(params: {
    builderId: string;
    investorName: string;
    projectTitle: string;
    projectId: string;
}): Promise<void> {
    await createNotification({
        userId: params.builderId,
        type: 'WATCHLIST_ADD',
        title: `"${params.projectTitle}" was saved to a watchlist`,
        body: `${params.investorName} added your project to their watchlist.`,
        data: { projectId: params.projectId },
    });
}

export async function notifyFollow(params: {
    followedId: string;
    followerName: string;
    followerId: string;
}): Promise<void> {
    await createNotification({
        userId: params.followedId,
        type: 'FOLLOW',
        title: `${params.followerName} started following you`,
        body: 'You have a new follower on BIES.',
        data: { followerId: params.followerId },
    });
}

export async function notifyProjectUpdate(params: {
    projectId: string;
    projectTitle: string;
    updateTitle: string;
    watcherIds: string[];
}): Promise<void> {
    // Fan out to all watchers
    const promises = params.watcherIds.map((userId) =>
        createNotification({
            userId,
            type: 'PROJECT_UPDATE',
            title: `Update: "${params.projectTitle}"`,
            body: params.updateTitle,
            data: { projectId: params.projectId },
        })
    );
    await Promise.allSettled(promises);
}

export async function notifyDeckRequest(params: {
    builderId: string;
    investorName: string;
    projectTitle: string;
    projectId: string;
    requestId: string;
    message?: string;
}): Promise<void> {
    const defaultBody = `An investor wants to view the pitch deck for "${params.projectTitle}".`;
    const finalBody = params.message
        ? `${defaultBody} Message: "${params.message}"`
        : defaultBody;

    await createNotification({
        userId: params.builderId,
        type: 'DECK_REQUEST',
        title: `${params.investorName} requested your pitch deck`,
        body: finalBody,
        data: { projectId: params.projectId, requestId: params.requestId },
    });
}

export async function notifyDeckApproved(params: {
    investorId: string;
    projectTitle: string;
    projectId: string;
}): Promise<void> {
    await createNotification({
        userId: params.investorId,
        type: 'DECK_APPROVED',
        title: `Pitch deck access approved for "${params.projectTitle}"`,
        body: 'You can now download the pitch deck.',
        data: { projectId: params.projectId },
    });
}

export async function notifyDeckDenied(params: {
    investorId: string;
    projectTitle: string;
    projectId: string;
}): Promise<void> {
    await createNotification({
        userId: params.investorId,
        type: 'DECK_DENIED',
        title: `Pitch deck access denied for "${params.projectTitle}"`,
        body: 'The project builder declined your deck request.',
        data: { projectId: params.projectId },
    });
}

export async function notifyProfileView(params: {
    profileOwnerId: string;
    viewerName: string;
    viewerId: string;
}): Promise<void> {
    await createNotification({
        userId: params.profileOwnerId,
        type: 'PROFILE_VIEW',
        title: `${params.viewerName} viewed your profile`,
        body: 'Someone checked out your BIES profile.',
        data: { viewerId: params.viewerId },
    });
}

export async function notifyInvestmentStatus(params: {
    investorId: string;
    projectTitle: string;
    status: string;
    projectId: string;
}): Promise<void> {
    await createNotification({
        userId: params.investorId,
        type: 'INVESTMENT_STATUS',
        title: `Investment update for "${params.projectTitle}"`,
        body: `Your investment status changed to: ${params.status}`,
        data: { projectId: params.projectId, status: params.status },
    });
}

export async function notifyEventRsvp(params: {
    hostId: string;
    attendeeName: string;
    attendeeId: string;
    eventTitle: string;
    eventId: string;
    status: string;
}): Promise<void> {
    const statusText = params.status === 'GOING' ? 'is going to' : 'is interested in';
    await createNotification({
        userId: params.hostId,
        type: 'EVENT_RSVP',
        title: `${params.attendeeName} ${statusText} "${params.eventTitle}"`,
        body: `Someone RSVPed to your event.`,
        data: { eventId: params.eventId, attendeeId: params.attendeeId, status: params.status },
    });
}

export async function notifyZapReceived(params: {
    recipientUserId: string;
    senderPubkey: string;
    amountSats: number;
    comment?: string;
    projectId?: string;
    projectTitle?: string;
}): Promise<void> {
    const title = params.projectTitle
        ? `${params.amountSats} sats zapped to "${params.projectTitle}"`
        : `You received ${params.amountSats} sats`;

    await createNotification({
        userId: params.recipientUserId,
        type: 'ZAP_RECEIVED',
        title,
        body: params.comment || 'You received a Lightning zap!',
        data: {
            senderPubkey: params.senderPubkey,
            amountSats: params.amountSats,
            ...(params.projectId ? { projectId: params.projectId } : {}),
        },
    });
}

/**
 * Create a notification for a feed interaction (comment, like, reply, zap).
 * Looks up the target Nostr pubkey to find the BIES user. Silently skips if
 * the target is not a BIES user or if actor === target.
 */
export async function notifyFeedInteraction(params: {
    actorPubkey: string;
    targetPubkey: string;
    type: 'POST_COMMENT' | 'POST_LIKE' | 'COMMENT_LIKE' | 'COMMENT_REPLY';
    actorName: string;
    eventId?: string;
    contentPreview?: string;
}): Promise<void> {
    // Don't notify yourself
    if (params.actorPubkey === params.targetPubkey) return;

    // Look up target user by Nostr pubkey
    const targetUser = await prisma.user.findUnique({
        where: { nostrPubkey: params.targetPubkey },
        select: { id: true },
    });
    if (!targetUser) return; // Not a BIES user

    const typeConfig: Record<string, { title: string; body: string }> = {
        POST_COMMENT: {
            title: `${params.actorName} commented on your post`,
            body: params.contentPreview
                ? params.contentPreview.substring(0, 120)
                : 'Someone left a comment on your post.',
        },
        POST_LIKE: {
            title: `${params.actorName} liked your post`,
            body: 'Your post received a like.',
        },
        COMMENT_LIKE: {
            title: `${params.actorName} liked your comment`,
            body: 'Your comment received a like.',
        },
        COMMENT_REPLY: {
            title: `${params.actorName} replied to your comment`,
            body: params.contentPreview
                ? params.contentPreview.substring(0, 120)
                : 'Someone replied to your comment.',
        },
    };

    const cfg = typeConfig[params.type];
    if (!cfg) return;

    await createNotification({
        userId: targetUser.id,
        type: params.type,
        title: cfg.title,
        body: cfg.body,
        data: {
            actorPubkey: params.actorPubkey,
            eventId: params.eventId,
        },
    });
}

export async function notifyLevelUp(userId: string, level: number): Promise<void> {
    await createNotification({
        userId,
        type: 'LEVEL_UP',
        title: `Level up! You reached level ${level}`,
        body: 'Keep contributing to the community to climb the leaderboard.',
        data: { level },
    });
}

export async function notifyBadgeEarned(userId: string, badgeId: string): Promise<void> {
    await createNotification({
        userId,
        type: 'BADGE_EARNED',
        title: 'You earned a new badge!',
        body: 'Check your profile to see your new badge.',
        data: { badgeId },
    });
}

export async function notifyBountySubmission(params: {
    posterId: string;
    submitterName: string;
    bountyTitle: string;
    bountyId: string;
}): Promise<void> {
    await createNotification({
        userId: params.posterId,
        type: 'BOUNTY_SUBMISSION',
        title: `${params.submitterName} submitted to your bounty "${params.bountyTitle}"`,
        body: 'You have a new bounty submission to review.',
        data: { bountyId: params.bountyId },
    });
}

export async function notifyBountyAwarded(params: {
    winnerId: string;
    bountyTitle: string;
    bountyId: string;
    rewardType: string;
    amount: number;
}): Promise<void> {
    const unit = params.rewardType === 'SATS' ? 'sats' : 'points';
    await createNotification({
        userId: params.winnerId,
        type: 'BOUNTY_AWARDED',
        title: `You won the bounty "${params.bountyTitle}"!`,
        body: `Your submission was selected. Reward: ${params.amount} ${unit}.`,
        data: { bountyId: params.bountyId },
    });
}

export async function notifyBountyPaid(params: {
    winnerId: string;
    bountyTitle: string;
    bountyId: string;
    rewardType: string;
    amount: number;
}): Promise<void> {
    const unit = params.rewardType === 'SATS' ? 'sats' : 'points';
    await createNotification({
        userId: params.winnerId,
        type: 'BOUNTY_PAID',
        title: `Bounty reward paid for "${params.bountyTitle}"`,
        body: `You received ${params.amount} ${unit} for your winning submission.`,
        data: { bountyId: params.bountyId },
    });
}

export async function notifyBountyRefunded(params: {
    posterId: string;
    bountyTitle: string;
    /** Omit when the bounty row no longer exists (admin delete) so the
     *  click-through falls back to /bounties instead of deep-linking a 404. */
    bountyId?: string;
    amount: number;
}): Promise<void> {
    await createNotification({
        userId: params.posterId,
        type: 'BOUNTY_REFUNDED',
        title: `Bounty refunded: "${params.bountyTitle}"`,
        body: `${params.amount} points were returned to your balance.`,
        data: params.bountyId ? { bountyId: params.bountyId } : {},
    });
}

export async function notifyBountyCancelled(params: {
    submitterIds: string[];
    bountyTitle: string;
    bountyId: string;
}): Promise<void> {
    // Fan out to all submitters
    const promises = params.submitterIds.map((userId) =>
        createNotification({
            userId,
            type: 'BOUNTY_CANCELLED',
            title: `Bounty cancelled: "${params.bountyTitle}"`,
            body: 'A bounty you submitted to was cancelled by the poster.',
            data: { bountyId: params.bountyId },
        })
    );
    await Promise.allSettled(promises);
}

// ─── URL helper for push notification click-through ──────────────────────────

function getNotificationUrl(type: string, data: Record<string, unknown>): string {
    switch (type) {
        case 'NEW_MESSAGE':
            return '/messages';
        case 'INVESTMENT_INTEREST':
        case 'PROJECT_VIEW':
        case 'WATCHLIST_ADD':
        case 'PROJECT_UPDATE':
        case 'DECK_REQUEST':
        case 'DECK_APPROVED':
        case 'DECK_DENIED':
            return data.projectId ? `/projects/${data.projectId}` : '/projects';
        case 'FOLLOW':
        case 'PROFILE_VIEW':
            return data.followerId ? `/profile/${data.followerId}` :
                   data.viewerId ? `/profile/${data.viewerId}` : '/';
        case 'INVESTMENT_STATUS':
            return data.projectId ? `/projects/${data.projectId}` : '/notifications';
        case 'ZAP_RECEIVED':
            return data.projectId ? `/projects/${data.projectId}` : '/notifications';
        case 'EVENT_RSVP':
            return data.eventId ? `/events/${data.eventId}` : '/events';
        case 'POST_COMMENT':
        case 'POST_LIKE':
        case 'COMMENT_LIKE':
        case 'COMMENT_REPLY':
            return '/feed';
        case 'LEVEL_UP':
        case 'BADGE_EARNED':
            return '/leaderboard';
        case 'VOUCHER_REDEEMED':
            return '/admin/vouchers';
        case 'BOUNTY_SUBMISSION':
        case 'BOUNTY_AWARDED':
        case 'BOUNTY_PAID':
        case 'BOUNTY_REFUNDED':
        case 'BOUNTY_CANCELLED':
            return data.bountyId ? `/bounties/${data.bountyId}` : '/bounties';
        default:
            return '/notifications';
    }
}
