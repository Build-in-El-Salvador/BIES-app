/**
 * Admin controller — platform moderation and management.
 * All routes require isAdmin flag or role = MOD.
 */

import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { cache, cacheKey, invalidateLeaderboardCache } from '../services/redis.service';
import { broadcast } from '../services/websocket.service';
import { removeFromRelayWhitelist, addToRelayWhitelist } from '../services/relayWhitelist.service';
import { revokeUserSessions } from '../services/session.service';
import { publishDirectoryListing } from '../services/nostr.service';
import { isAdminPubkey } from '../middleware/auth';
import { recomputeListingScore, recomputeAllScores as recomputeAllDirectoryScores } from '../services/directoryReputation.service';
import {
    applyPoints,
    recomputeAllScores,
    monthOf,
    isUniqueViolation,
} from '../services/points.service';
import { BADGES } from '../services/badges.catalog';
import { publishCourseBadgeDefinition } from '../services/badges.publisher';
import { mirrorCourseToNostr, unpublishCourseFromNostr } from '../services/courses.service';

// ─── Users ────────────────────────────────────────────────────────────────────

/**
 * GET /admin/users
 * List all users with filtering and pagination.
 */
export async function listUsers(req: Request, res: Response): Promise<void> {
    try {
        const { role, search, banned, page = '1', limit = '20' } = req.query;
        const skip = (parseInt(page as string, 10) - 1) * parseInt(limit as string, 10);
        const take = Math.min(parseInt(limit as string, 10), 100);

        const where: any = { deletedAt: null };
        if (role && typeof role === 'string') where.role = role.toUpperCase();
        if (banned !== undefined) where.isBanned = banned === 'true';
        if (search && typeof search === 'string') {
            where.OR = [
                { email: { contains: search } },
                { profile: { name: { contains: search } } },
            ];
        }

        const [users, total] = await Promise.all([
            prisma.user.findMany({
                where,
                skip,
                take,
                orderBy: { createdAt: 'desc' },
                select: {
                    id: true, email: true, nostrPubkey: true, role: true, isAdmin: true,
                    isVerified: true, isBanned: true, createdAt: true,
                    profile: { select: { name: true, avatar: true, company: true } },
                    _count: { select: { projects: true, investments: true } },
                },
            }),
            prisma.user.count({ where }),
        ]);

        res.json({
            data: users,
            pagination: { page: parseInt(page as string, 10), limit: take, total, totalPages: Math.ceil(total / take) },
        });
    } catch (error) {
        console.error('Admin list users error:', error);
        res.status(500).json({ error: 'Failed to list users' });
    }
}

/**
 * PUT /admin/users/:id/ban
 * Ban or unban a user.
 */
export async function banUser(req: Request, res: Response): Promise<void> {
    try {
        const { banned } = req.body;
        if (typeof banned !== 'boolean') {
            res.status(400).json({ error: '"banned" must be a boolean' }); return;
        }

        // Banning is admin-only
        if (!req.user!.isAdmin) {
            res.status(403).json({ error: 'Only admins can ban or unban users' }); return;
        }

        const user = await prisma.user.update({
            where: { id: req.params.id },
            data: { isBanned: banned },
            select: { id: true, email: true, nostrPubkey: true, isBanned: true },
        });

        // Update relay whitelist: remove on ban, restore on unban. A ban also
        // signs the member out everywhere; unbanning doesn't sign them back in.
        if (banned) {
            removeFromRelayWhitelist(user.nostrPubkey);
            await revokeUserSessions(user.id, 'suspended');
        } else {
            addToRelayWhitelist(user.nostrPubkey);
        }

        // Log the action
        await prisma.auditLog.create({
            data: {
                userId: req.user!.id,
                action: banned ? 'USER_BANNED' : 'USER_UNBANNED',
                resource: `user:${req.params.id}`,
                metadata: JSON.stringify({ targetUserId: req.params.id }),
            },
        });

        res.json(user);
    } catch (error) {
        console.error('Ban user error:', error);
        res.status(500).json({ error: 'Failed to update user ban status' });
    }
}

/**
 * PUT /admin/users/:id/role
 * Change a user's role (including making admin).
 */
export async function setUserRole(req: Request, res: Response): Promise<void> {
    try {
        const { role } = req.body;
        if (!['MEMBER', 'BUILDER', 'INVESTOR', 'EVENT_HOST', 'EDUCATOR', 'MOD'].includes(role)) {
            res.status(400).json({ error: 'Invalid role' }); return;
        }

        // Only admins can promote/demote to MOD or ADMIN, or demote existing admins/mods
        const targetUser = await prisma.user.findUnique({
            where: { id: req.params.id },
            select: { role: true, isAdmin: true },
        });
        
        if ((role === 'MOD' || targetUser?.role === 'MOD') && !req.user!.isAdmin) {
            res.status(403).json({ error: 'Only admins can promote or demote admins and mods' }); return;
        }

        const user = await prisma.user.update({
            where: { id: req.params.id },
            data: { role },
            select: { id: true, email: true, role: true },
        });

        await prisma.auditLog.create({
            data: {
                userId: req.user!.id,
                action: 'USER_ROLE_CHANGED',
                resource: `user:${req.params.id}`,
                metadata: JSON.stringify({ newRole: role }),
            },
        });

        res.json(user);
    } catch (error) {
        console.error('Set role error:', error);
        res.status(500).json({ error: 'Failed to set user role' });
    }
}

/**
 * PUT /admin/users/:id/admin
 * Grant or revoke admin access. Only admins can do this.
 */
export async function setUserAdmin(req: Request, res: Response): Promise<void> {
    try {
        if (!req.user!.isAdmin) {
            res.status(403).json({ error: 'Only admins can grant or revoke admin access' });
            return;
        }

        const { isAdmin } = req.body;
        if (typeof isAdmin !== 'boolean') {
            res.status(400).json({ error: 'isAdmin must be a boolean' });
            return;
        }

        // Prevent admins from removing their own admin access
        if (req.params.id === req.user!.id && !isAdmin) {
            res.status(400).json({ error: 'You cannot remove your own admin access' });
            return;
        }

        const user = await prisma.user.update({
            where: { id: req.params.id },
            data: { isAdmin },
            select: { id: true, email: true, nostrPubkey: true, role: true, isAdmin: true },
        });

        await prisma.auditLog.create({
            data: {
                userId: req.user!.id,
                action: isAdmin ? 'ADMIN_GRANTED' : 'ADMIN_REVOKED',
                resource: `user:${req.params.id}`,
                metadata: JSON.stringify({ isAdmin }),
            },
        });

        res.json(user);
    } catch (error) {
        console.error('Set admin error:', error);
        res.status(500).json({ error: 'Failed to update admin status' });
    }
}

/**
 * PUT /admin/users/:id/verify
 * Mark a user as verified (KYC approved).
 */
export async function verifyUser(req: Request, res: Response): Promise<void> {
    try {
        const user = await prisma.user.update({
            where: { id: req.params.id },
            data: { isVerified: true },
        });

        await prisma.auditLog.create({
            data: {
                userId: req.user!.id,
                action: 'USER_VERIFIED',
                resource: `user:${req.params.id}`,
                metadata: '{}',
            },
        });

        res.json({ id: user.id, isVerified: user.isVerified });
    } catch (error) {
        console.error('Verify user error:', error);
        res.status(500).json({ error: 'Failed to verify user' });
    }
}

// ─── Projects ────────────────────────────────────────────────────────────────

/**
 * PUT /admin/projects/:id/feature
 * Feature or unfeature a project on the homepage.
 */
export async function featureProject(req: Request, res: Response): Promise<void> {
    try {
        const { featured } = req.body;
        if (typeof featured !== 'boolean') {
            res.status(400).json({ error: '"featured" must be a boolean' }); return;
        }

        const project = await prisma.project.update({
            where: { id: req.params.id },
            data: { isFeatured: featured },
        });

        await cache.delPattern('projects:');

        res.json({ id: project.id, isFeatured: project.isFeatured });
    } catch (error) {
        console.error('Feature project error:', error);
        res.status(500).json({ error: 'Failed to feature project' });
    }
}

/**
 * DELETE /admin/projects/:id
 * Hard delete a project (admin only).
 */
export async function hardDeleteProject(req: Request, res: Response): Promise<void> {
    try {
        await prisma.project.delete({ where: { id: req.params.id } });
        await cache.delPattern('projects:');

        await prisma.auditLog.create({
            data: {
                userId: req.user!.id,
                action: 'PROJECT_HARD_DELETED',
                resource: `project:${req.params.id}`,
                metadata: '{}',
            },
        });

        res.json({ message: 'Project permanently deleted' });
    } catch (error) {
        console.error('Hard delete project error:', error);
        res.status(500).json({ error: 'Failed to delete project' });
    }
}

/**
 * PUT /admin/projects/:id/owner
 * Transfer project ownership to a different user. ADMIN only.
 * Body: { newOwnerId: string }
 */
export async function moveProjectOwnership(req: Request, res: Response): Promise<void> {
    try {
        if (!req.user!.isAdmin) {
            res.status(403).json({ error: 'Only admins can transfer project ownership' }); return;
        }

        const { newOwnerId } = req.body;
        if (!newOwnerId || typeof newOwnerId !== 'string') {
            res.status(400).json({ error: 'newOwnerId is required' }); return;
        }

        const project = await prisma.project.findUnique({
            where: { id: req.params.id },
            select: {
                id: true, title: true, ownerId: true,
                owner: { select: { id: true, profile: { select: { name: true } } } },
            },
        });
        if (!project) {
            res.status(404).json({ error: 'Project not found' }); return;
        }
        if (project.ownerId === newOwnerId) {
            res.status(400).json({ error: 'New owner is already the current owner' }); return;
        }

        const newOwner = await prisma.user.findUnique({
            where: { id: newOwnerId, deletedAt: null },
            select: { id: true, profile: { select: { name: true } } },
        });
        if (!newOwner) {
            res.status(404).json({ error: 'New owner not found' }); return;
        }

        await prisma.project.update({
            where: { id: req.params.id },
            data: { ownerId: newOwnerId },
        });

        await cache.delPattern('projects:');
        await cache.del(`projectDetail:${req.params.id}`);

        await prisma.auditLog.create({
            data: {
                userId: req.user!.id,
                action: 'PROJECT_OWNERSHIP_TRANSFERRED',
                resource: `project:${req.params.id}`,
                metadata: JSON.stringify({
                    projectTitle: project.title,
                    previousOwnerId: project.ownerId,
                    previousOwnerName: project.owner?.profile?.name || '',
                    newOwnerId,
                    newOwnerName: newOwner.profile?.name || '',
                }),
            },
        });

        res.json({
            message: 'Project ownership transferred',
            projectId: project.id,
            previousOwnerId: project.ownerId,
            newOwnerId,
        });
    } catch (error) {
        console.error('Move project ownership error:', error);
        res.status(500).json({ error: 'Failed to transfer project ownership' });
    }
}

// ─── Audit Logs ───────────────────────────────────────────────────────────────

/**
 * GET /admin/audit-logs
 * View the audit log.
 */
export async function getAuditLogs(req: Request, res: Response): Promise<void> {
    try {
        const { userId, action, page = '1', limit = '50' } = req.query;
        const skip = (parseInt(page as string, 10) - 1) * parseInt(limit as string, 10);
        const take = Math.min(parseInt(limit as string, 10), 100);

        const where: any = {};
        if (userId) where.userId = userId;
        if (action && typeof action === 'string') where.action = { contains: action };

        const [logs, total] = await Promise.all([
            prisma.auditLog.findMany({
                where,
                skip,
                take,
                orderBy: { createdAt: 'desc' },
                include: {
                    user: {
                        select: {
                            id: true, email: true,
                            profile: { select: { name: true } },
                        },
                    },
                },
            }),
            prisma.auditLog.count({ where }),
        ]);

        res.json({
            data: logs.map((l) => ({ ...l, metadata: JSON.parse(l.metadata || '{}') })),
            pagination: { page: parseInt(page as string, 10), limit: take, total, totalPages: Math.ceil(total / take) },
        });
    } catch (error) {
        console.error('Audit logs error:', error);
        res.status(500).json({ error: 'Failed to get audit logs' });
    }
}

// ─── Delete User ─────────────────────────────────────────────────────────────

/**
 * DELETE /admin/users/:id
 * Soft-delete (trash) a user. ADMIN only.
 */
export async function deleteUser(req: Request, res: Response): Promise<void> {
    try {
        if (!req.user!.isAdmin) {
            res.status(403).json({ error: 'Only admins can delete users' }); return;
        }

        const targetUser = await prisma.user.findUnique({
            where: { id: req.params.id, deletedAt: null },
            select: { id: true, nostrPubkey: true, email: true, role: true, profile: { select: { name: true } } },
        });
        if (!targetUser) {
            res.status(404).json({ error: 'User not found' }); return;
        }

        // Remove from relay whitelist and end every session
        removeFromRelayWhitelist(targetUser.nostrPubkey);
        await revokeUserSessions(targetUser.id, 'deleted');

        // Soft-delete: move to trash
        await prisma.user.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } });

        // Clear caches
        await Promise.all([
            cache.delPattern('profiles:'),
            cache.delPattern('projects:'),
            cache.delPattern('events:'),
        ]);

        await prisma.auditLog.create({
            data: {
                userId: req.user!.id,
                action: 'USER_TRASHED',
                resource: `user:${req.params.id}`,
                metadata: JSON.stringify({
                    deletedUserName: targetUser.profile?.name || '',
                    deletedUserPubkey: targetUser.nostrPubkey,
                }),
            },
        });

        res.json({ message: 'User moved to trash' });
    } catch (error) {
        console.error('Delete user error:', error);
        res.status(500).json({ error: 'Failed to delete user' });
    }
}

// ─── Trash: List / Restore / Purge ───────────────────────────────────────────

/**
 * GET /admin/users/trash
 * List soft-deleted users. ADMIN only.
 */
export async function listTrashedUsers(req: Request, res: Response): Promise<void> {
    try {
        if (!req.user!.isAdmin) {
            res.status(403).json({ error: 'Only admins can view trash' }); return;
        }

        const { search, page = '1', limit = '20' } = req.query;
        const skip = (parseInt(page as string, 10) - 1) * parseInt(limit as string, 10);
        const take = Math.min(parseInt(limit as string, 10), 100);

        const where: any = { deletedAt: { not: null } };
        if (search && typeof search === 'string') {
            where.OR = [
                { email: { contains: search } },
                { profile: { name: { contains: search } } },
            ];
        }

        const [users, total] = await Promise.all([
            prisma.user.findMany({
                where,
                skip,
                take,
                orderBy: { deletedAt: 'desc' },
                select: {
                    id: true, email: true, nostrPubkey: true, role: true, isAdmin: true,
                    isVerified: true, isBanned: true, createdAt: true, deletedAt: true,
                    profile: { select: { name: true, avatar: true } },
                    _count: { select: { projects: true } },
                },
            }),
            prisma.user.count({ where }),
        ]);

        res.json({
            data: users,
            pagination: { page: parseInt(page as string, 10), limit: take, total, totalPages: Math.ceil(total / take) },
        });
    } catch (error) {
        console.error('List trashed users error:', error);
        res.status(500).json({ error: 'Failed to list trashed users' });
    }
}

/**
 * PUT /admin/users/:id/restore
 * Restore a soft-deleted user from trash. ADMIN only.
 */
export async function restoreUser(req: Request, res: Response): Promise<void> {
    try {
        if (!req.user!.isAdmin) {
            res.status(403).json({ error: 'Only admins can restore users' }); return;
        }

        const targetUser = await prisma.user.findUnique({
            where: { id: req.params.id },
            select: { id: true, nostrPubkey: true, deletedAt: true, profile: { select: { name: true } } },
        });
        if (!targetUser || !targetUser.deletedAt) {
            res.status(404).json({ error: 'Trashed user not found' }); return;
        }

        await prisma.user.update({ where: { id: req.params.id }, data: { deletedAt: null } });

        addToRelayWhitelist(targetUser.nostrPubkey);

        await Promise.all([
            cache.delPattern('profiles:'),
            cache.delPattern('projects:'),
        ]);

        await prisma.auditLog.create({
            data: {
                userId: req.user!.id,
                action: 'USER_RESTORED',
                resource: `user:${req.params.id}`,
                metadata: JSON.stringify({
                    restoredUserName: targetUser.profile?.name || '',
                    restoredUserPubkey: targetUser.nostrPubkey,
                }),
            },
        });

        res.json({ message: 'User restored from trash' });
    } catch (error) {
        console.error('Restore user error:', error);
        res.status(500).json({ error: 'Failed to restore user' });
    }
}

/**
 * DELETE /admin/users/:id/purge
 * Permanently hard-delete a trashed user and all their data. ADMIN only.
 */
export async function purgeUser(req: Request, res: Response): Promise<void> {
    try {
        if (!req.user!.isAdmin) {
            res.status(403).json({ error: 'Only admins can purge users' }); return;
        }

        const targetUser = await prisma.user.findUnique({
            where: { id: req.params.id },
            select: { id: true, nostrPubkey: true, deletedAt: true, profile: { select: { name: true } } },
        });
        if (!targetUser || !targetUser.deletedAt) {
            res.status(404).json({ error: 'Trashed user not found' }); return;
        }

        await prisma.user.delete({ where: { id: req.params.id } });

        await Promise.all([
            cache.delPattern('profiles:'),
            cache.delPattern('projects:'),
            cache.delPattern('events:'),
        ]);

        await prisma.auditLog.create({
            data: {
                userId: req.user!.id,
                action: 'USER_PURGED',
                resource: `user:${req.params.id}`,
                metadata: JSON.stringify({
                    purgedUserName: targetUser.profile?.name || '',
                    purgedUserPubkey: targetUser.nostrPubkey,
                }),
            },
        });

        res.json({ message: 'User permanently deleted' });
    } catch (error) {
        console.error('Purge user error:', error);
        res.status(500).json({ error: 'Failed to purge user' });
    }
}

// ─── Sync Accounts ───────────────────────────────────────────────────────────

/**
 * POST /admin/users/sync
 * Sync all data (profile, projects, events) from a source user to a target user.
 * Optionally delete the source account after sync. ADMIN only.
 *
 * Body: { sourceUserId, targetUserId, deleteSource: boolean }
 */
export async function syncAccounts(req: Request, res: Response): Promise<void> {
    try {
        if (!req.user!.isAdmin) {
            res.status(403).json({ error: 'Only admins can sync accounts' }); return;
        }

        const { sourceUserId, targetUserId, deleteSource } = req.body;

        if (!sourceUserId || !targetUserId || typeof sourceUserId !== 'string' || typeof targetUserId !== 'string') {
            res.status(400).json({ error: 'sourceUserId and targetUserId are required' }); return;
        }
        if (sourceUserId === targetUserId) {
            res.status(400).json({ error: 'Source and target must be different users' }); return;
        }

        // Fetch both users with all related data counts
        const [sourceUser, targetUser] = await Promise.all([
            prisma.user.findUnique({
                where: { id: sourceUserId },
                include: {
                    profile: true,
                    projects: { select: { id: true } },
                    hostedEvents: { select: { id: true } },
                    investments: { select: { id: true } },
                    watchlist: { select: { id: true } },
                    teamMemberships: { select: { id: true } },
                    following: { select: { id: true } },
                    followers: { select: { id: true } },
                    sentMessages: { select: { id: true } },
                    receivedMessages: { select: { id: true } },
                    deckRequests: { select: { id: true } },
                    eventRSVPs: { select: { id: true } },
                },
            }),
            prisma.user.findUnique({
                where: { id: targetUserId },
                include: { profile: true },
            }),
        ]);

        if (!sourceUser) {
            res.status(404).json({ error: 'Source user not found' }); return;
        }
        if (!targetUser) {
            res.status(404).json({ error: 'Target user not found' }); return;
        }

        const syncResults: string[] = [];

        // 1. Sync profile data (overwrite target profile with source profile fields)
        if (sourceUser.profile) {
            const profileData: any = {};
            const profileFields = [
                'name', 'bio', 'avatar', 'banner', 'location', 'skills', 'website',
                'twitter', 'linkedin', 'github', 'company', 'title', 'tags',
                'investmentFocus', 'investmentStage', 'minTicket', 'maxTicket',
                'portfolioCount', 'lookingFor', 'experience', 'biesProjects',
                'showExperience', 'nostrFeedMode', 'nostrNpub', 'lightningAddress', 'bolt12Offer', 'isPublic',
            ];

            for (const field of profileFields) {
                const val = (sourceUser.profile as any)[field];
                // Only copy non-empty values
                if (val !== '' && val !== '[]' && val !== null && val !== undefined && val !== 0 && val !== false) {
                    profileData[field] = val;
                }
            }

            // Don't copy nip05Name as it's unique — would cause conflict
            if (Object.keys(profileData).length > 0) {
                if (targetUser.profile) {
                    await prisma.profile.update({
                        where: { userId: targetUserId },
                        data: profileData,
                    });
                } else {
                    await prisma.profile.create({
                        data: { ...profileData, userId: targetUserId },
                    });
                }
                syncResults.push(`Profile synced (${Object.keys(profileData).length} fields)`);
            }
        }

        // 2. Transfer projects ownership
        if (sourceUser.projects.length > 0) {
            await prisma.project.updateMany({
                where: { ownerId: sourceUserId },
                data: { ownerId: targetUserId },
            });
            syncResults.push(`${sourceUser.projects.length} projects transferred`);
        }

        // 3. Transfer hosted events
        if (sourceUser.hostedEvents.length > 0) {
            await prisma.event.updateMany({
                where: { hostId: sourceUserId },
                data: { hostId: targetUserId },
            });
            syncResults.push(`${sourceUser.hostedEvents.length} events transferred`);
        }

        // 4. Transfer investments (skip duplicates)
        if (sourceUser.investments.length > 0) {
            const existingInvestments = await prisma.investment.findMany({
                where: { investorId: targetUserId },
                select: { projectId: true },
            });
            const existingProjectIds = new Set(existingInvestments.map(i => i.projectId));

            const toTransfer = await prisma.investment.findMany({
                where: { investorId: sourceUserId, projectId: { notIn: Array.from(existingProjectIds) } },
            });
            if (toTransfer.length > 0) {
                await prisma.investment.updateMany({
                    where: { investorId: sourceUserId, projectId: { notIn: Array.from(existingProjectIds) } },
                    data: { investorId: targetUserId },
                });
            }
            syncResults.push(`${toTransfer.length} investments transferred`);
        }

        // 5. Transfer team memberships (skip duplicates)
        if (sourceUser.teamMemberships.length > 0) {
            const existingMemberships = await prisma.projectTeamMember.findMany({
                where: { userId: targetUserId },
                select: { projectId: true },
            });
            const existingProjIds = new Set(existingMemberships.map(m => m.projectId));

            await prisma.projectTeamMember.updateMany({
                where: { userId: sourceUserId, projectId: { notIn: Array.from(existingProjIds) } },
                data: { userId: targetUserId },
            });
            syncResults.push('Team memberships transferred');
        }

        // 6. Transfer event RSVPs (skip duplicates)
        if (sourceUser.eventRSVPs.length > 0) {
            const existingRSVPs = await prisma.eventAttendee.findMany({
                where: { userId: targetUserId },
                select: { eventId: true },
            });
            const existingEventIds = new Set(existingRSVPs.map(r => r.eventId));

            await prisma.eventAttendee.updateMany({
                where: { userId: sourceUserId, eventId: { notIn: Array.from(existingEventIds) } },
                data: { userId: targetUserId },
            });
            syncResults.push('Event RSVPs transferred');
        }

        // 7. Transfer watchlist items (skip duplicates)
        if (sourceUser.watchlist.length > 0) {
            const existingWatch = await prisma.watchlistItem.findMany({
                where: { userId: targetUserId },
                select: { projectId: true },
            });
            const existingWatchProjIds = new Set(existingWatch.map(w => w.projectId));

            await prisma.watchlistItem.updateMany({
                where: { userId: sourceUserId, projectId: { notIn: Array.from(existingWatchProjIds) } },
                data: { userId: targetUserId },
            });
            syncResults.push('Watchlist items transferred');
        }

        // 8. Transfer follows (skip duplicates)
        if (sourceUser.following.length > 0) {
            const existingFollowing = await prisma.follow.findMany({
                where: { followerId: targetUserId },
                select: { followingId: true },
            });
            const existingFollowIds = new Set(existingFollowing.map(f => f.followingId));

            await prisma.follow.updateMany({
                where: { followerId: sourceUserId, followingId: { notIn: Array.from(existingFollowIds) } },
                data: { followerId: targetUserId },
            });
            syncResults.push('Following transferred');
        }

        // 9. Optionally soft-delete source account (moves to trash)
        if (deleteSource) {
            removeFromRelayWhitelist(sourceUser.nostrPubkey);
            await revokeUserSessions(sourceUserId, 'merged');
            await prisma.user.update({ where: { id: sourceUserId }, data: { deletedAt: new Date() } });
            syncResults.push('Source account moved to trash');
        }

        // Clear caches
        await Promise.all([
            cache.delPattern('profiles:'),
            cache.delPattern('projects:'),
            cache.delPattern('events:'),
        ]);

        await prisma.auditLog.create({
            data: {
                userId: req.user!.id,
                action: 'ACCOUNTS_SYNCED',
                resource: `user:${sourceUserId}->user:${targetUserId}`,
                metadata: JSON.stringify({
                    sourceUserId,
                    targetUserId,
                    deleteSource: !!deleteSource,
                    results: syncResults,
                }),
            },
        });

        res.json({
            message: 'Accounts synced successfully',
            results: syncResults,
        });
    } catch (error) {
        console.error('Sync accounts error:', error);
        res.status(500).json({ error: 'Failed to sync accounts' });
    }
}

// ─── System ───────────────────────────────────────────────────────────────────

/**
 * POST /admin/broadcast
 * Send a system-wide message to all connected WebSocket clients.
 */
export async function broadcastMessage(req: Request, res: Response): Promise<void> {
    try {
        const { message } = req.body;
        if (!message || typeof message !== 'string') {
            res.status(400).json({ error: 'Message required' }); return;
        }

        broadcast({ type: 'system_announcement', message });
        res.json({ message: 'Broadcast sent' });
    } catch (error) {
        console.error('Broadcast error:', error);
        res.status(500).json({ error: 'Failed to broadcast' });
    }
}

/**
 * POST /admin/cache/clear
 * Clear all caches (use after bulk data migrations).
 */
export async function clearCache(req: Request, res: Response): Promise<void> {
    try {
        const { pattern = '' } = req.body;
        if (pattern) {
            await cache.delPattern(pattern);
        } else {
            // Clear all common prefixes
            await Promise.all([
                cache.delPattern('projects:'),
                cache.delPattern('profiles:'),
                cache.delPattern('events:'),
                cache.delPattern('search:'),
                cache.delPattern('analytics:'),
                cache.delPattern('notif_count:'),
            ]);
        }
        res.json({ message: 'Cache cleared' });
    } catch (error) {
        console.error('Clear cache error:', error);
        res.status(500).json({ error: 'Failed to clear cache' });
    }
}

// ─── Admin Project Management ────────────────────────────────────────────────

/**
 * GET /admin/projects
 * List projects with optional status filter, search, and pagination.
 */
export async function listAdminProjects(req: Request, res: Response): Promise<void> {
    try {
        const { status, search, page = '1', limit = '20' } = req.query;
        const skip = (parseInt(page as string, 10) - 1) * parseInt(limit as string, 10);
        const take = Math.min(parseInt(limit as string, 10), 100);

        const where: any = {};
        if (status && typeof status === 'string') where.status = status;
        if (search && typeof search === 'string') {
            where.OR = [
                { title: { contains: search } },
                { description: { contains: search } },
            ];
        }

        const [projects, total] = await Promise.all([
            prisma.project.findMany({
                where,
                skip,
                take,
                orderBy: { createdAt: 'desc' },
                include: {
                    owner: {
                        select: {
                            id: true, email: true,
                            profile: { select: { name: true, avatar: true } },
                        },
                    },
                },
            }),
            prisma.project.count({ where }),
        ]);

        const parsed = projects.map((p) => ({
            ...p,
            tags: JSON.parse(p.tags || '[]'),
        }));

        res.json({
            data: parsed,
            pagination: { page: parseInt(page as string, 10), limit: take, total, totalPages: Math.ceil(total / take) },
        });
    } catch (error) {
        console.error('Admin list projects error:', error);
        res.status(500).json({ error: 'Failed to list projects' });
    }
}

// ─── Investor Requests ────────────────────────────────────────────────────────

/**
 * GET /admin/investor-requests
 * List pending investor requests.
 */
export async function listInvestorRequests(req: Request, res: Response): Promise<void> {
    try {
        if (!req.user!.isAdmin) {
            res.status(403).json({ error: 'Only admins can view investor requests' }); return;
        }
        const requests = await prisma.investorRequest.findMany({
            where: { status: 'PENDING' },
            include: {
                user: {
                    select: {
                        id: true, email: true,
                        profile: { select: { name: true, company: true } },
                    }
                }
            },
            orderBy: { createdAt: 'desc' }
        });
        res.json(requests);
    } catch (error) {
        console.error('List investor requests error:', error);
        res.status(500).json({ error: 'Failed to list investor requests' });
    }
}

/**
 * PUT /admin/investor-requests/:id
 * Approve or deny an investor request.
 */
export async function reviewInvestorRequest(req: Request, res: Response): Promise<void> {
    try {
        if (!req.user!.isAdmin) {
            res.status(403).json({ error: 'Only admins can review investor requests' }); return;
        }

        const { status } = req.body;
        if (!['APPROVED', 'DENIED'].includes(status)) {
            res.status(400).json({ error: 'Status must be APPROVED or DENIED' }); return;
        }

        const request = await prisma.investorRequest.findUnique({
            where: { id: req.params.id }
        });

        if (!request) {
            res.status(404).json({ error: 'Request not found' }); return;
        }

        if (request.status !== 'PENDING') {
            res.status(400).json({ error: 'Request is already processed' }); return;
        }

        if (status === 'APPROVED') {
            await prisma.$transaction([
                prisma.investorRequest.update({
                    where: { id: request.id },
                    data: { status: 'APPROVED', reviewedAt: new Date() }
                }),
                prisma.user.update({
                    where: { id: request.userId },
                    data: { role: 'INVESTOR' }
                }),
                prisma.auditLog.create({
                    data: {
                        userId: req.user!.id,
                        action: 'INVESTOR_REQUEST_APPROVED',
                        resource: `user:${request.userId}`,
                        metadata: JSON.stringify({ requestId: request.id }),
                    }
                })
            ]);
        } else {
            await prisma.$transaction([
                prisma.investorRequest.update({
                    where: { id: request.id },
                    data: { status: 'DENIED', reviewedAt: new Date() }
                }),
                prisma.auditLog.create({
                    data: {
                        userId: req.user!.id,
                        action: 'INVESTOR_REQUEST_DENIED',
                        resource: `user:${request.userId}`,
                        metadata: JSON.stringify({ requestId: request.id }),
                    }
                })
            ]);
        }

        res.json({ message: `Request ${status.toLowerCase()}` });
    } catch (error) {
        console.error('Review investor request error:', error);
        res.status(500).json({ error: 'Failed to review investor request' });
    }
}

/**
 * PUT /admin/projects/:id/review
 * Approve or reject a project submission.
 * Body: { action: 'approve' | 'reject' }
 */
export async function reviewProject(req: Request, res: Response): Promise<void> {
    try {
        const { action } = req.body;
        if (!['approve', 'reject'].includes(action)) {
            res.status(400).json({ error: 'action must be "approve" or "reject"' }); return;
        }

        const data: any = action === 'approve'
            ? { status: 'active', isPublished: true }
            : { status: 'draft', isPublished: false };

        const project = await prisma.project.update({
            where: { id: req.params.id },
            data,
            select: { id: true, title: true, status: true, ownerId: true },
        });

        await cache.delPattern('projects:');

        // Notify project owner
        await prisma.notification.create({
            data: {
                userId: project.ownerId,
                type: 'SYSTEM',
                title: action === 'approve' ? 'Project Approved' : 'Project Not Approved',
                body: action === 'approve'
                    ? `Your project "${project.title}" has been approved and is now live on the Discover page.`
                    : `Your project "${project.title}" was not approved for the Discover page. Please review and resubmit.`,
                data: JSON.stringify({ projectId: project.id }),
            },
        });

        await prisma.auditLog.create({
            data: {
                userId: req.user!.id,
                action: action === 'approve' ? 'PROJECT_APPROVED' : 'PROJECT_REJECTED',
                resource: `project:${req.params.id}`,
                metadata: JSON.stringify({ projectTitle: project.title }),
            },
        });

        res.json(project);
    } catch (error) {
        console.error('Review project error:', error);
        res.status(500).json({ error: 'Failed to review project' });
    }
}

// ─── Admin Event Management ─────────────────────────────────────────────────

/**
 * GET /admin/events
 * List all events (including unpublished) with pagination.
 */
export async function listAdminEvents(req: Request, res: Response): Promise<void> {
    try {
        const { search, category, page = '1', limit = '20' } = req.query;
        const skip = (parseInt(page as string, 10) - 1) * parseInt(limit as string, 10);
        const take = Math.min(parseInt(limit as string, 10), 100);

        const where: any = {};
        if (category && typeof category === 'string') where.category = category.toUpperCase();
        if (search && typeof search === 'string') {
            where.OR = [
                { title: { contains: search } },
                { description: { contains: search } },
            ];
        }

        const [events, total] = await Promise.all([
            prisma.event.findMany({
                where,
                skip,
                take,
                orderBy: { startDate: 'desc' },
                include: {
                    host: {
                        select: {
                            id: true, email: true,
                            profile: { select: { name: true } },
                        },
                    },
                    _count: { select: { attendees: true } },
                },
            }),
            prisma.event.count({ where }),
        ]);

        const parsed = events.map((e) => ({
            ...e,
            tags: JSON.parse(e.tags || '[]'),
        }));

        res.json({
            data: parsed,
            pagination: { page: parseInt(page as string, 10), limit: take, total, totalPages: Math.ceil(total / take) },
        });
    } catch (error) {
        console.error('Admin list events error:', error);
        res.status(500).json({ error: 'Failed to list events' });
    }
}

/**
 * PUT /admin/events/:id/feature
 * Feature or unfeature an event.
 */
export async function featureEvent(req: Request, res: Response): Promise<void> {
    try {
        const { featured } = req.body;
        if (typeof featured !== 'boolean') {
            res.status(400).json({ error: '"featured" must be a boolean' }); return;
        }

        const event = await prisma.event.update({
            where: { id: req.params.id },
            data: { isFeatured: featured },
        });

        await cache.delPattern('events:');

        res.json({ id: event.id, isFeatured: event.isFeatured });
    } catch (error) {
        console.error('Feature event error:', error);
        res.status(500).json({ error: 'Failed to feature event' });
    }
}

// ─── Points & badges (gamification) ──────────────────────────────────────────

const POINT_REASONS = [
    'POST',
    'REPLY',
    'REACTION_GIVEN',
    'REACTION_RECEIVED',
    'QUALITY_BONUS',
    'ADMIN_ADJUST',
] as const;

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export const adjustPointsSchema = z.object({
    userId: z.string().min(1),
    points: z
        .number()
        .int()
        .min(-1000)
        .max(1000)
        .refine((v) => v !== 0, { message: 'points must be nonzero' }),
    reason: z.string().min(1).max(200),
});

export const grantBadgeSchema = z.object({
    userId: z.string().min(1),
    badgeId: z.string().min(1),
    month: z.string().regex(MONTH_RE, 'month must be YYYY-MM').optional(),
});

// Leaderboard cache invalidation is shared with the live scoring path — see
// invalidateLeaderboardCache in redis.service.ts (imported above).

/**
 * POST /admin/points/adjust
 * Signed ADMIN_ADJUST ledger row — the ledger stays authoritative, counters
 * are never mutated directly (applyPoints rolls the entry into UserScore).
 */
export async function adjustPoints(req: Request, res: Response): Promise<void> {
    try {
        const { userId, points, reason } = req.body as z.infer<typeof adjustPointsSchema>;

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true },
        });
        if (!user) {
            res.status(404).json({ error: 'User not found' }); return;
        }

        const now = new Date();
        await applyPoints(userId, {
            nostrEventId: null,
            kind: null,
            reason: 'ADMIN_ADJUST',
            points,
            month: monthOf(now),
            targetEventId: null,
            meta: { adminId: req.user!.id, note: reason },
            eventCreatedAt: now,
        });

        await prisma.auditLog.create({
            data: {
                userId: req.user!.id,
                action: 'POINTS_ADJUSTED',
                resource: `user:${userId}`,
                metadata: JSON.stringify({ points, note: reason }),
            },
        });

        await invalidateLeaderboardCache();

        const score = await prisma.userScore.findUnique({ where: { userId } });
        res.json(score);
    } catch (error) {
        console.error('Adjust points error:', error);
        res.status(500).json({ error: 'Failed to adjust points' });
    }
}

/**
 * GET /admin/points/events
 * Browse the PointEvent ledger with optional userId/reason filters.
 */
export async function listPointEvents(req: Request, res: Response): Promise<void> {
    try {
        const { userId, reason, page = '1', limit = '50' } = req.query;
        const pageNum = Math.max(parseInt(page as string, 10) || 1, 1);
        const take = Math.min(Math.max(parseInt(limit as string, 10) || 50, 1), 100);
        const skip = (pageNum - 1) * take;

        const where: any = {};
        if (userId && typeof userId === 'string') where.userId = userId;
        if (reason && typeof reason === 'string') {
            if (!POINT_REASONS.includes(reason as any)) {
                res.status(400).json({ error: 'Invalid reason filter' }); return;
            }
            where.reason = reason;
        }

        const [events, total] = await Promise.all([
            prisma.pointEvent.findMany({
                where,
                skip,
                take,
                orderBy: { createdAt: 'desc' },
                include: {
                    user: {
                        select: {
                            nostrPubkey: true,
                            profile: { select: { name: true, avatar: true } },
                        },
                    },
                },
            }),
            prisma.pointEvent.count({ where }),
        ]);

        const parsed = events.map((e) => {
            let meta: unknown = {};
            try { meta = JSON.parse(e.meta || '{}'); } catch { /* keep {} */ }
            return { ...e, meta };
        });

        res.json({
            data: parsed,
            pagination: { page: pageNum, limit: take, total, totalPages: Math.ceil(total / take) },
        });
    } catch (error) {
        console.error('List point events error:', error);
        res.status(500).json({ error: 'Failed to list point events' });
    }
}

/**
 * POST /admin/points/recompute
 * Rebuild every UserScore from the PointEvent ledger.
 */
export async function recomputePoints(req: Request, res: Response): Promise<void> {
    try {
        await recomputeAllScores();

        await prisma.auditLog.create({
            data: {
                userId: req.user!.id,
                action: 'POINTS_RECOMPUTED',
                resource: 'points:all',
                metadata: '{}',
            },
        });

        await invalidateLeaderboardCache();

        res.json({ message: 'All scores recomputed from ledger' });
    } catch (error) {
        console.error('Recompute points error:', error);
        res.status(500).json({ error: 'Failed to recompute scores' });
    }
}

/**
 * POST /admin/points/badges/grant
 * Manually award a catalog badge (month omitted = permanent badge).
 */
export async function grantBadge(req: Request, res: Response): Promise<void> {
    try {
        const { userId, badgeId, month } = req.body as z.infer<typeof grantBadgeSchema>;

        const def = BADGES.find((b) => b.id === badgeId);
        if (!def) {
            res.status(400).json({ error: `Unknown badge "${badgeId}"` }); return;
        }

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true },
        });
        if (!user) {
            res.status(404).json({ error: 'User not found' }); return;
        }

        let badge;
        try {
            badge = await prisma.userBadge.create({
                data: { userId, badgeId, month: month ?? '' },
            });
        } catch (error) {
            if (isUniqueViolation(error)) {
                res.status(409).json({ error: 'User already has this badge' }); return;
            }
            throw error;
        }

        await prisma.auditLog.create({
            data: {
                userId: req.user!.id,
                action: 'BADGE_GRANTED',
                resource: `user:${userId}`,
                metadata: JSON.stringify({ badgeId, month: month ?? '' }),
            },
        });

        res.status(201).json({ ...badge, rarity: def.rarity, icon: def.icon });
    } catch (error) {
        console.error('Grant badge error:', error);
        res.status(500).json({ error: 'Failed to grant badge' });
    }
}

/**
 * DELETE /admin/points/badges/:userId/:badgeId
 * Revoke a permanent badge (month ''). Monthly badges are rollover-owned.
 */
export async function revokeBadge(req: Request, res: Response): Promise<void> {
    try {
        const { userId, badgeId } = req.params;

        const result = await prisma.userBadge.deleteMany({
            where: { userId, badgeId, month: '' },
        });
        if (result.count === 0) {
            res.status(404).json({ error: 'Badge not found for this user' }); return;
        }

        await prisma.auditLog.create({
            data: {
                userId: req.user!.id,
                action: 'BADGE_REVOKED',
                resource: `user:${userId}`,
                metadata: JSON.stringify({ badgeId }),
            },
        });

        res.json({ message: 'Badge revoked' });
    } catch (error) {
        console.error('Revoke badge error:', error);
        res.status(500).json({ error: 'Failed to revoke badge' });
    }
}


// ─── Directory Listings ──────────────────────────────────────────────────────

export const reviewDirectoryListingSchema = z.object({
    action: z.enum(['approve', 'reject']),
});

export const featureDirectoryListingSchema = z.object({
    featured: z.boolean(),
});

export const setDirectoryScoreSchema = z.object({
    baseScore: z.number().int().min(0).max(60),
});

function parseDirectoryListing(listing: any): any {
    return {
        ...listing,
        photos: JSON.parse(listing.photos || '[]'),
        languages: JSON.parse(listing.languages || '[]'),
        products: JSON.parse(listing.products || '[]'),
        practices: JSON.parse(listing.practices || '[]'),
        skills: JSON.parse(listing.skills || '[]'),
    };
}

/**
 * GET /admin/directory
 * List all directory listings (all statuses) with optional type/status
 * filters, search, and pagination.
 */
export async function listAdminDirectory(req: Request, res: Response): Promise<void> {
    try {
        const { type, status, search, page = '1', limit = '20' } = req.query;
        const skip = (parseInt(page as string, 10) - 1) * parseInt(limit as string, 10);
        const take = Math.min(parseInt(limit as string, 10), 100);

        const where: any = {};
        if (type && typeof type === 'string') where.type = type.toUpperCase();
        if (status && typeof status === 'string') where.status = status;
        if (search && typeof search === 'string') {
            where.OR = [
                { name: { contains: search } },
                { about: { contains: search } },
                { location: { contains: search } },
            ];
        }

        const [listings, total] = await Promise.all([
            prisma.directoryListing.findMany({
                where,
                skip,
                take,
                orderBy: { createdAt: 'desc' },
                include: {
                    owner: {
                        select: {
                            id: true, email: true,
                            profile: { select: { name: true, avatar: true } },
                        },
                    },
                    memberUser: {
                        select: {
                            id: true,
                            profile: { select: { name: true } },
                        },
                    },
                    _count: { select: { endorsements: true } },
                },
            }),
            prisma.directoryListing.count({ where }),
        ]);

        res.json({
            data: listings.map(parseDirectoryListing),
            pagination: { page: parseInt(page as string, 10), limit: take, total, totalPages: Math.ceil(total / take) },
        });
    } catch (error) {
        console.error('Admin list directory error:', error);
        res.status(500).json({ error: 'Failed to list directory listings' });
    }
}

/**
 * PUT /admin/directory/:id/review
 * Approve or reject a directory listing submission.
 * Body: { action: 'approve' | 'reject' }
 */
export async function reviewDirectoryListing(req: Request, res: Response): Promise<void> {
    try {
        const { action } = req.body;

        const data: any = action === 'approve'
            ? { status: 'active', isPublished: true }
            : { status: 'rejected' };

        const listing = await prisma.directoryListing.update({
            where: { id: req.params.id },
            data,
            select: {
                id: true, name: true, status: true, ownerId: true,
                memberUserId: true, type: true, about: true, photo: true,
                location: true, products: true, skills: true,
            },
        });

        if (action === 'approve') {
            // Mirror to Nostr as a NIP-99 classified listing (kind:30402),
            // signed by the linked member's key when set, else the owner's.
            publishDirectoryListing(listing.memberUserId ?? listing.ownerId, listing)
                .then(async (eventId) => {
                    if (eventId) {
                        await prisma.directoryListing.update({
                            where: { id: listing.id },
                            data: { nostrListingEventId: eventId },
                        });
                    }
                })
                .catch((err) => console.error('[Nostr] Directory listing sync failed:', err));

            recomputeListingScore(listing.id).catch((err) =>
                console.error('[Admin] Directory score recompute failed:', err)
            );
        }

        // Notify listing owner
        await prisma.notification.create({
            data: {
                userId: listing.ownerId,
                type: 'SYSTEM',
                title: action === 'approve' ? 'Directory Listing Approved' : 'Directory Listing Not Approved',
                body: action === 'approve'
                    ? `Your directory listing "${listing.name}" has been approved and is now live.`
                    : `Your directory listing "${listing.name}" was not approved. Please review and resubmit.`,
                data: JSON.stringify({ listingId: listing.id }),
            },
        });

        await prisma.auditLog.create({
            data: {
                userId: req.user!.id,
                action: action === 'approve' ? 'DIRECTORY_LISTING_APPROVED' : 'DIRECTORY_LISTING_REJECTED',
                resource: `directory:${req.params.id}`,
                metadata: JSON.stringify({ listingName: listing.name }),
            },
        });

        res.json({ id: listing.id, name: listing.name, status: listing.status, ownerId: listing.ownerId });
    } catch (error) {
        console.error('Review directory listing error:', error);
        res.status(500).json({ error: 'Failed to review directory listing' });
    }
}

/**
 * PUT /admin/directory/:id/feature
 * Feature or unfeature a directory listing.
 * Body: { featured: boolean }
 */
export async function featureDirectoryListing(req: Request, res: Response): Promise<void> {
    try {
        const { featured } = req.body;

        const listing = await prisma.directoryListing.update({
            where: { id: req.params.id },
            data: { isFeatured: featured },
        });

        res.json({ id: listing.id, isFeatured: listing.isFeatured });
    } catch (error) {
        console.error('Feature directory listing error:', error);
        res.status(500).json({ error: 'Failed to feature directory listing' });
    }
}

/**
 * PUT /admin/directory/:id/score
 * Set the admin base score (0–60) and recompute the reputation score.
 * Body: { baseScore: number }
 */
export async function setDirectoryScore(req: Request, res: Response): Promise<void> {
    try {
        const { baseScore } = req.body;

        await prisma.directoryListing.update({
            where: { id: req.params.id },
            data: { baseScore },
        });

        await recomputeListingScore(req.params.id);

        const listing = await prisma.directoryListing.findUnique({
            where: { id: req.params.id },
            select: { id: true, baseScore: true, reputationScore: true, isCertified: true, certifiedAt: true },
        });

        await prisma.auditLog.create({
            data: {
                userId: req.user!.id,
                action: 'DIRECTORY_SCORE_SET',
                resource: `directory:${req.params.id}`,
                metadata: JSON.stringify({ baseScore }),
            },
        });

        res.json(listing);
    } catch (error) {
        console.error('Set directory score error:', error);
        res.status(500).json({ error: 'Failed to set directory score' });
    }
}

/**
 * POST /admin/directory/recompute
 * Recompute reputation scores for all directory listings.
 */
export async function recomputeDirectoryScores(req: Request, res: Response): Promise<void> {
    try {
        await recomputeAllDirectoryScores();
        res.json({ message: 'Directory scores recomputed' });
    } catch (error) {
        console.error('Recompute directory scores error:', error);
        res.status(500).json({ error: 'Failed to recompute directory scores' });
    }
}

/**
 * DELETE /admin/directory/:id
 * Hard delete a directory listing.
 */
export async function deleteDirectoryListing(req: Request, res: Response): Promise<void> {
    try {
        await prisma.directoryListing.delete({ where: { id: req.params.id } });

        await prisma.auditLog.create({
            data: {
                userId: req.user!.id,
                action: 'DIRECTORY_LISTING_DELETED',
                resource: `directory:${req.params.id}`,
                metadata: '{}',
            },
        });

        res.json({ message: 'Listing permanently deleted' });
    } catch (error) {
        console.error('Delete directory listing error:', error);
        res.status(500).json({ error: 'Failed to delete directory listing' });
    }
}

// ─── Courses ─────────────────────────────────────────────────────────────────

export const reviewCourseSchema = z.object({
    action: z.enum(['approve', 'reject']),
    note: z.string().max(1000).optional(),
});

export const featureCourseSchema = z.object({
    featured: z.boolean(),
});

/**
 * GET /admin/courses
 * List all courses (all statuses) with status/search filters + pagination.
 */
export async function listAdminCourses(req: Request, res: Response): Promise<void> {
    try {
        const { status, search, page = '1', limit = '20' } = req.query;
        const skip = (parseInt(page as string, 10) - 1) * parseInt(limit as string, 10);
        const take = Math.min(parseInt(limit as string, 10), 100);

        const where: any = {};
        if (status && typeof status === 'string') where.status = status;
        if (search && typeof search === 'string') {
            where.OR = [
                { title: { contains: search } },
                { summary: { contains: search } },
            ];
        }

        const [courses, total] = await Promise.all([
            prisma.course.findMany({
                where,
                skip,
                take,
                orderBy: { createdAt: 'desc' },
                include: {
                    author: {
                        select: {
                            id: true, email: true, nostrPubkey: true,
                            profile: { select: { name: true, avatar: true, lightningAddress: true } },
                        },
                    },
                    _count: { select: { lessons: true, enrollments: true, purchases: true } },
                },
            }),
            prisma.course.count({ where }),
        ]);

        res.json({
            data: courses.map((c) => ({
                ...c,
                tags: JSON.parse(c.tags || '[]'),
                lessonCount: c._count.lessons,
                studentCount: c._count.enrollments,
                purchaseCount: c._count.purchases,
            })),
            pagination: { page: parseInt(page as string, 10), limit: take, total, totalPages: Math.ceil(total / take) },
        });
    } catch (error) {
        console.error('Admin list courses error:', error);
        res.status(500).json({ error: 'Failed to list courses' });
    }
}

/**
 * PUT /admin/courses/:id/review
 * Approve or reject a course submission. Reviewers can never approve their
 * own course. Approval publishes the NIP-58 completion-badge definition;
 * the Nostr course/lesson mirror is wired at the marked seam.
 * Body: { action: 'approve' | 'reject', note? }
 */
export async function reviewCourse(req: Request, res: Response): Promise<void> {
    try {
        const { action, note } = req.body;

        const existing = await prisma.course.findUnique({
            where: { id: req.params.id },
            select: { id: true, authorId: true, title: true, coverImage: true, status: true },
        });
        if (!existing) {
            res.status(404).json({ error: 'Course not found' }); return;
        }
        // Moderation integrity: no self-approval, even for full admins.
        if (existing.authorId === req.user!.id) {
            res.status(403).json({ error: 'You cannot review your own course' }); return;
        }

        const data: any = action === 'approve'
            ? { status: 'active', isPublished: true, reviewNote: '' }
            : { status: 'rejected', reviewNote: note ?? '' };

        const course = await prisma.course.update({
            where: { id: existing.id },
            data,
            select: { id: true, title: true, status: true, authorId: true, coverImage: true },
        });
        await cache.delPattern('courses:');

        if (action === 'approve') {
            publishCourseBadgeDefinition(course)
                .catch((err) => console.error('[Nostr] Course badge definition publish failed:', err));
            // Mirror to Nostr: lesson events (30023/30402 teaser) + the
            // kind-30004 course list, storing nostrEventId per row.
            mirrorCourseToNostr(course.id)
                .catch((err) => console.error('[Nostr] Course mirror failed:', err));
        }

        await prisma.notification.create({
            data: {
                userId: course.authorId,
                type: 'SYSTEM',
                title: action === 'approve' ? 'Course Approved' : 'Course Not Approved',
                body: action === 'approve'
                    ? `Your course "${course.title}" has been approved and is now live.`
                    : `Your course "${course.title}" was not approved.${note ? ` Reviewer note: ${note}` : ' Please review and resubmit.'}`,
                data: JSON.stringify({ courseId: course.id }),
            },
        });

        await prisma.auditLog.create({
            data: {
                userId: req.user!.id,
                action: action === 'approve' ? 'COURSE_APPROVED' : 'COURSE_REJECTED',
                resource: `course:${req.params.id}`,
                metadata: JSON.stringify({ courseTitle: course.title, note: note ?? '' }),
            },
        });

        res.json({ id: course.id, title: course.title, status: course.status, authorId: course.authorId });
    } catch (error) {
        console.error('Review course error:', error);
        res.status(500).json({ error: 'Failed to review course' });
    }
}

/**
 * PUT /admin/courses/:id/feature
 * Toggle the featured flag.
 */
export async function featureCourse(req: Request, res: Response): Promise<void> {
    try {
        const { featured } = req.body;
        const course = await prisma.course.update({
            where: { id: req.params.id },
            data: { isFeatured: Boolean(featured) },
            select: { id: true, title: true, isFeatured: true },
        });
        await cache.delPattern('courses:');
        res.json(course);
    } catch (error) {
        console.error('Feature course error:', error);
        res.status(500).json({ error: 'Failed to feature course' });
    }
}

/**
 * DELETE /admin/courses/:id
 * Hard delete a course.
 */
export async function deleteAdminCourse(req: Request, res: Response): Promise<void> {
    try {
        await unpublishCourseFromNostr(req.params.id);
        await prisma.course.delete({ where: { id: req.params.id } });
        await cache.delPattern('courses:');

        await prisma.auditLog.create({
            data: {
                userId: req.user!.id,
                action: 'COURSE_DELETED',
                resource: `course:${req.params.id}`,
                metadata: '{}',
            },
        });

        res.json({ message: 'Course permanently deleted' });
    } catch (error) {
        console.error('Delete admin course error:', error);
        res.status(500).json({ error: 'Failed to delete course' });
    }
}
