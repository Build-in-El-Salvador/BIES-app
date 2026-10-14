import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { notifyFollow } from '../services/notification.service';
import { cache, TTL } from '../services/redis.service';
import { publishAnnouncement } from '../services/nostr.service';
import { blockedEitherWay, hasBlocked, hiddenFromIds, isStaffUser } from '../services/moderation.service';
import { canSeeNetwork, privacyOf } from '../services/profilePrivacy';

/**
 * A member's followers and following are for members, or only for them
 * (Settings → Privacy: Network). Hidden: just the count, no one listed.
 */
async function networkHidden(req: Request, userId: string): Promise<boolean> {
    if (req.user?.id === userId) return false;
    const profile = await prisma.profile.findUnique({ where: { userId }, select: { privacy: true } });
    return !canSeeNetwork(privacyOf(profile?.privacy), req.user ? 'member' : 'public');
}

/**
 * A block between the viewer and this member hides their network too, both
 * ways, as their profile is (staff: only blocks they made themselves).
 */
async function blockedNetwork(req: Request, userId: string): Promise<boolean> {
    if (!req.user || req.user.id === userId) return false;
    return isStaffUser(req.user)
        ? hasBlocked(req.user.id, { id: userId })
        : blockedEitherWay(req.user.id, userId);
}

/**
 * POST /profiles/:id/follow
 * Follow a user.
 */
export async function followUser(req: Request, res: Response): Promise<void> {
    try {
        const followerId = req.user!.id;
        const followingId = req.params.id;

        if (followerId === followingId) {
            res.status(400).json({ error: 'You cannot follow yourself' });
            return;
        }

        // Verify target user exists
        const targetUser = await prisma.user.findUnique({
            where: { id: followingId },
        });
        if (!targetUser) {
            res.status(404).json({ error: 'User not found' });
            return;
        }
        if (await blockedEitherWay(followerId, followingId)) {
            res.status(403).json({ error: "You can't follow this member", reason: 'blocked' });
            return;
        }

        const follow = await prisma.follow.create({
            data: { followerId, followingId },
        });

        // Bust caches
        await Promise.all([
            cache.del(`followers:${followingId}`),
            cache.del(`following:${followerId}`),
            cache.delPattern(`followers:${followingId}:`),
            cache.delPattern(`following:${followerId}:`),
        ]);

        // Notify the followed user
        const follower = await prisma.user.findUnique({
            where: { id: followerId },
            include: { profile: { select: { name: true, privacy: true } } },
        });
        const followed = await prisma.user.findUnique({
            where: { id: followingId },
            include: { profile: { select: { name: true, privacy: true } } },
        });
        await notifyFollow({
            followedId: followingId,
            followerName: follower?.profile?.name || 'Someone',
            followerId,
        });

        // Announce follow on the BIES feed, unless either member keeps their
        // network to themselves (Settings → Privacy → Network).
        const networkPrivate = [follower, followed].some((u) => privacyOf(u?.profile?.privacy).network === 'ONLY_ME');
        if (!networkPrivate) {
            const followerName = follower?.profile?.name || 'A BIES member';
            const followedName = followed?.profile?.name || 'a builder';
            publishAnnouncement(followerId, `${followerName} started following ${followedName} on BIES.`, [['t', 'follow']]).catch((err) =>
                console.error('[Nostr] Follow announcement failed:', err)
            );
        }

        res.status(201).json({ message: 'Followed', follow });
    } catch (error: any) {
        if (error?.code === 'P2002') {
            res.status(409).json({ error: 'Already following this user' });
            return;
        }
        console.error('Follow error:', error);
        res.status(500).json({ error: 'Failed to follow user' });
    }
}

/**
 * DELETE /profiles/:id/follow
 * Unfollow a user.
 */
export async function unfollowUser(req: Request, res: Response): Promise<void> {
    try {
        const followerId = req.user!.id;
        const followingId = req.params.id;

        await prisma.follow.deleteMany({
            where: { followerId, followingId },
        });

        await Promise.all([
            cache.del(`followers:${followingId}`),
            cache.del(`following:${followerId}`),
            cache.delPattern(`followers:${followingId}:`),
            cache.delPattern(`following:${followerId}:`),
        ]);

        res.json({ message: 'Unfollowed' });
    } catch (error) {
        console.error('Unfollow error:', error);
        res.status(500).json({ error: 'Failed to unfollow user' });
    }
}

/**
 * GET /profiles/:id/followers
 * List a user's followers.
 */
export async function getFollowers(req: Request, res: Response): Promise<void> {
    try {
        const userId = req.params.id;
        const page = parseInt(req.query.page as string || '1', 10);
        const limit = Math.min(parseInt(req.query.limit as string || '20', 10), 50);
        const skip = (page - 1) * limit;

        if (await blockedNetwork(req, userId)) {
            res.status(404).json({ error: 'Profile not found' });
            return;
        }
        if (await networkHidden(req, userId)) {
            const total = await prisma.follow.count({ where: { followingId: userId } });
            res.json({ data: [], hidden: true, pagination: { page, limit, total, totalPages: 0 } });
            return;
        }

        // Members blocked either way are left out, from the page and the
        // total; the shared cache is only for viewers with no blocks.
        const hidden = await hiddenFromIds(req.user?.id, { staff: isStaffUser(req.user) });
        const cKey = `followers:${userId}:${page}:${limit}`;
        if (!hidden.length) {
            const cached = await cache.getJson<any>(cKey);
            if (cached) { res.setHeader('X-Cache', 'HIT'); res.json(cached); return; }
        }
        const where = { followingId: userId, ...(hidden.length ? { followerId: { notIn: hidden } } : {}) };

        const [followers, total] = await Promise.all([
            prisma.follow.findMany({
                where,
                skip,
                take: limit,
                orderBy: { createdAt: 'desc' },
                include: {
                    follower: {
                        select: {
                            id: true, nostrPubkey: true, role: true, isVerified: true,
                            profile: { select: { name: true, avatar: true, bio: true, company: true } },
                        },
                    },
                },
            }),
            prisma.follow.count({ where }),
        ]);

        const result = {
            data: followers.map((f) => f.follower),
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        };

        if (!hidden.length) await cache.setJson(cKey, result, TTL.FOLLOW_LIST);
        res.json(result);
    } catch (error) {
        console.error('Get followers error:', error);
        res.status(500).json({ error: 'Failed to get followers' });
    }
}

/**
 * GET /profiles/:id/following
 * List users this user is following.
 */
export async function getFollowing(req: Request, res: Response): Promise<void> {
    try {
        const userId = req.params.id;
        const page = parseInt(req.query.page as string || '1', 10);
        const limit = Math.min(parseInt(req.query.limit as string || '20', 10), 50);
        const skip = (page - 1) * limit;

        if (await blockedNetwork(req, userId)) {
            res.status(404).json({ error: 'Profile not found' });
            return;
        }
        if (await networkHidden(req, userId)) {
            const total = await prisma.follow.count({ where: { followerId: userId } });
            res.json({ data: [], hidden: true, pagination: { page, limit, total, totalPages: 0 } });
            return;
        }

        // Members blocked either way are left out, from the page and the
        // total; the shared cache is only for viewers with no blocks.
        const hidden = await hiddenFromIds(req.user?.id, { staff: isStaffUser(req.user) });
        const cKey = `following:${userId}:${page}:${limit}`;
        if (!hidden.length) {
            const cached = await cache.getJson<any>(cKey);
            if (cached) { res.setHeader('X-Cache', 'HIT'); res.json(cached); return; }
        }
        const where = { followerId: userId, ...(hidden.length ? { followingId: { notIn: hidden } } : {}) };

        const [following, total] = await Promise.all([
            prisma.follow.findMany({
                where,
                skip,
                take: limit,
                orderBy: { createdAt: 'desc' },
                include: {
                    following: {
                        select: {
                            id: true, nostrPubkey: true, role: true, isVerified: true,
                            profile: { select: { name: true, avatar: true, bio: true, company: true } },
                        },
                    },
                },
            }),
            prisma.follow.count({ where }),
        ]);

        const result = {
            data: following.map((f) => f.following),
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        };

        if (!hidden.length) await cache.setJson(cKey, result, TTL.FOLLOW_LIST);
        res.json(result);
    } catch (error) {
        console.error('Get following error:', error);
        res.status(500).json({ error: 'Failed to get following list' });
    }
}
