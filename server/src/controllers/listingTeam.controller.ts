import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { createNotification } from '../services/notification.service';
import { cache } from '../services/redis.service';
import { blockedEitherWay } from '../services/moderation.service';
import { z } from 'zod';

/**
 * A business's team (Facebook Pages' "people with access"): members who
 * represent a farm or business listing beside the member who runs it, and
 * host events as it. The member who runs it adds and removes them; anyone
 * on the team can leave. Editing the listing stays with the member who runs
 * it.
 *
 * Who runs a listing: the member staff linked to it when there is one;
 * otherwise its owner when it's their own business (they added it as
 * theirs, or it was handed to them).
 * A member who only recommended a business (added it as a customer) doesn't
 * run it, and can't put people on its team or host as it.
 */

export const addTeamMemberSchema = z.object({
    userId: z.string().min(1).max(64),
});

/** Big enough for a company's staff; a bound all the same. */
export const MAX_TEAM = 25;

type Runnable = { ownerId: string; memberUserId: string | null; isOwnBusiness: boolean };

/** Whether `userId` runs the listing (and so manages its team). */
export function runsListing(listing: Runnable, userId: string): boolean {
    if (listing.memberUserId) return listing.memberUserId === userId;
    return listing.isOwnBusiness && listing.ownerId === userId;
}

const ACTIVE = { isBanned: false, deletedAt: null };
const LIVE = { status: 'active', isPublished: true };

/**
 * The listings `userId` speaks for: ones they run, and ones whose team
 * they're on. Live ones only, run by an active member.
 */
export async function listingsActedFor(userId: string) {
    return prisma.directoryListing.findMany({
        where: {
            ...LIVE,
            OR: [
                { memberUserId: userId },
                { memberUserId: null, isOwnBusiness: true, ownerId: userId },
                { team: { some: { userId } } },
            ],
            AND: [{ OR: [{ memberUserId: null, owner: ACTIVE }, { memberUser: ACTIVE }] }],
        },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, type: true, category: true, logo: true, photo: true, isOfficial: true, ownerId: true, memberUserId: true, isOwnBusiness: true },
    });
}

/** Whether `userId` can act for the listing (host its events). */
export async function actsFor(listingId: string, userId: string): Promise<boolean> {
    return (await listingsActedFor(userId)).some((l) => l.id === listingId);
}

const listingLink = (listing: { id: string; type: string }) =>
    `${listing.type === 'FARM' ? '/farms' : '/trusted'}/${listing.id}`;

const nameOf = async (userId: string): Promise<string> => {
    const profile = await prisma.profile.findUnique({ where: { userId }, select: { name: true } });
    const name = (profile?.name || '').trim();
    return name && !name.startsWith('nostr:') ? name : 'A member';
};

/**
 * GET /directory/represented
 * The businesses and farms I can act for, for "Host as" on an event.
 */
export async function listRepresented(req: Request, res: Response): Promise<void> {
    try {
        const me = req.user!.id;
        const listings = await listingsActedFor(me);
        res.json({
            data: listings.map(({ ownerId, memberUserId, isOwnBusiness, ...l }) => ({
                ...l,
                role: runsListing({ ownerId, memberUserId, isOwnBusiness }, me) ? 'runs' : 'team',
            })),
        });
    } catch (error) {
        console.error('List represented listings error:', error);
        res.status(500).json({ error: 'Failed to list your businesses' });
    }
}

/**
 * POST /directory/:id/team { userId }
 * Put a member on the team: the member who runs it, or an admin.
 */
export async function addTeamMember(req: Request, res: Response): Promise<void> {
    try {
        const me = req.user!.id;
        const { userId } = req.body as z.infer<typeof addTeamMemberSchema>;
        const listing = await prisma.directoryListing.findUnique({
            where: { id: req.params.id },
            select: { id: true, name: true, type: true, ownerId: true, memberUserId: true, isOwnBusiness: true, _count: { select: { team: true } } },
        });
        if (!listing) { res.status(404).json({ error: 'Listing not found' }); return; }
        if (!runsListing(listing, me) && !req.user!.isAdmin) {
            res.status(403).json({ error: 'Only the member who runs it can change its team', reason: 'not_runner' });
            return;
        }
        if (runsListing(listing, userId)) {
            res.status(400).json({ error: 'They already run it', reason: 'runs_it' });
            return;
        }
        const member = await prisma.user.findFirst({ where: { id: userId, ...ACTIVE }, select: { id: true } });
        if (!member) { res.status(400).json({ error: 'Member not found', reason: 'no_member' }); return; }
        if (await blockedEitherWay(me, userId)) {
            res.status(403).json({ error: 'You can\'t add this member', reason: 'blocked' });
            return;
        }
        if (listing._count.team >= MAX_TEAM) {
            res.status(400).json({ error: `A team has at most ${MAX_TEAM} members`, reason: 'team_full' });
            return;
        }
        const existing = await prisma.listingTeamMember.findUnique({ where: { listingId_userId: { listingId: listing.id, userId } } });
        if (existing) { res.status(409).json({ error: 'Already on the team', reason: 'already_on_team' }); return; }

        const row = await prisma.listingTeamMember.create({
            data: { listingId: listing.id, userId, addedById: me },
            include: { user: { select: { id: true, nostrPubkey: true, profile: { select: { name: true, avatar: true } } } } },
        });
        await createNotification({
            userId,
            type: 'SYSTEM',
            title: `${await nameOf(me)} added you to ${listing.name}'s team`,
            body: `You can host events as ${listing.name} now. You can leave the team from its page.`,
            data: { link: listingLink(listing), listingId: listing.id, actorId: me },
        });
        res.status(201).json(row);
    } catch (error) {
        console.error('Add team member error:', error);
        res.status(500).json({ error: 'Failed to add them to the team' });
    }
}

/**
 * DELETE /directory/:id/team/:userId
 * Take a member off the team: the member who runs it or an admin, or the
 * member themselves (leaving).
 */
export async function removeTeamMember(req: Request, res: Response): Promise<void> {
    try {
        const me = req.user!.id;
        const { userId } = req.params;
        const listing = await prisma.directoryListing.findUnique({
            where: { id: req.params.id },
            select: { id: true, ownerId: true, memberUserId: true, isOwnBusiness: true },
        });
        if (!listing) { res.status(404).json({ error: 'Listing not found' }); return; }
        if (userId !== me && !runsListing(listing, me) && !req.user!.isAdmin) {
            res.status(403).json({ error: 'Only the member who runs it can change its team', reason: 'not_runner' });
            return;
        }
        const { count } = await prisma.listingTeamMember.deleteMany({ where: { listingId: listing.id, userId } });
        if (!count) { res.status(404).json({ error: 'Not on the team' }); return; }
        res.json({ removed: true });
    } catch (error) {
        console.error('Remove team member error:', error);
        res.status(500).json({ error: 'Failed to change the team' });
    }
}

export const officialSchema = z.object({ official: z.boolean() });

/**
 * PUT /admin/directory/:id/official { official }
 * Mark a listing as BIES's own page, or not (admins). Events hosted as it
 * are BIES events, its past ones too.
 */
export async function setListingOfficial(req: Request, res: Response): Promise<void> {
    try {
        const { official } = req.body as z.infer<typeof officialSchema>;
        const listing = await prisma.directoryListing.findUnique({ where: { id: req.params.id }, select: { id: true } });
        if (!listing) { res.status(404).json({ error: 'Listing not found' }); return; }
        await prisma.$transaction([
            prisma.directoryListing.update({ where: { id: listing.id }, data: { isOfficial: official } }),
            prisma.event.updateMany({ where: { hostListingId: listing.id }, data: { isOfficial: official } }),
            prisma.auditLog.create({
                data: {
                    userId: req.user!.id,
                    action: official ? 'DIRECTORY_LISTING_MARKED_BIES' : 'DIRECTORY_LISTING_UNMARKED_BIES',
                    resource: `directory:${listing.id}`,
                },
            }),
        ]);
        await Promise.all([cache.delPattern('events:'), cache.delPattern('preview:events:')]);
        res.json({ id: listing.id, isOfficial: official });
    } catch (error) {
        console.error('Set listing official error:', error);
        res.status(500).json({ error: 'Failed to change it' });
    }
}
