import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { recomputeListingScore } from '../services/directoryReputation.service';
import { createNotification } from '../services/notification.service';
import { blockedEitherWay } from '../services/moderation.service';
import { mirrorToNostr } from './directory.controller';
import { z } from 'zod';

/**
 * Handing a farm or business listing to the member who runs it (Google
 * Maps' "Own this business?"). Three ways in:
 *
 * - a claim: the member who runs it asks; the listing's owner hands it over,
 *   or, when the owner can't or won't, staff decide;
 * - an offer: the owner picks the member who runs it, who accepts;
 * - staff move it outright (POST /admin/directory/:id/owner).
 *
 * Once moved, it's the new owner's own business: they can edit it, and
 * their own review of it goes, since it can't count.
 */

export const claimSchema = z.object({
    message: z.string().max(500).optional(),
});

export const offerSchema = z.object({
    toUserId: z.string().min(1),
    message: z.string().max(500).optional(),
});

export const staffMoveSchema = z.object({
    userId: z.string().min(1),
});

const isStaff = (req: Request) => !!req.user && (req.user.isAdmin || req.user.role === 'MOD');

const personSelect = {
    select: { id: true, nostrPubkey: true, profile: { select: { name: true, avatar: true } } },
};

/** Where a listing lives in the app; notifications open it. */
const listingLink = (listing: { id: string; type: string }) =>
    `${listing.type === 'FARM' ? '/farms' : '/trusted'}/${listing.id}`;

const nameOf = async (userId: string): Promise<string> => {
    const profile = await prisma.profile.findUnique({ where: { userId }, select: { name: true } });
    const name = (profile?.name || '').trim();
    return name && !name.startsWith('nostr:') ? name : 'A member';
};

/** A member who can own a listing: signed up, not banned, not deleted. */
const activeMember = (userId: string) =>
    prisma.user.findFirst({ where: { id: userId, isBanned: false, deletedAt: null }, select: { id: true } });

/**
 * Give the listing to `toUserId`: it's their own business from now on. Any
 * other open request on it closes; `transferId` is the one this grants.
 */
async function moveListing(listingId: string, toUserId: string, decidedById: string, transferId?: string): Promise<void> {
    const now = new Date();
    await prisma.$transaction([
        prisma.directoryListing.update({
            where: { id: listingId },
            data: { ownerId: toUserId, isOwnBusiness: true, memberUserId: null },
        }),
        prisma.directoryEndorsement.deleteMany({ where: { listingId, userId: toUserId } }),
        prisma.listingTransfer.updateMany({
            where: { listingId, status: 'pending', ...(transferId ? { id: { not: transferId } } : {}) },
            data: { status: 'cancelled', decidedById, decidedAt: now },
        }),
        ...(transferId
            ? [prisma.listingTransfer.update({ where: { id: transferId }, data: { status: 'accepted', decidedById, decidedAt: now } })]
            : []),
    ]);
    await recomputeListingScore(listingId).catch((err) =>
        console.error('[Directory] Score recompute failed:', err)
    );
    const listing = await prisma.directoryListing.findUnique({ where: { id: listingId } });
    if (listing) mirrorToNostr(listing);
}

/** Staff who should hear about claims (not the two members involved). */
async function staffIds(except: string[]): Promise<string[]> {
    const staff = await prisma.user.findMany({
        where: { OR: [{ isAdmin: true }, { role: 'MOD' }], isBanned: false, deletedAt: null, id: { notIn: except } },
        select: { id: true },
    });
    return staff.map((s) => s.id);
}

/**
 * The open requests on a listing that the viewer can see or answer: staff
 * see all of them; the owner, those about their listing; anyone else, their
 * own. For GET /directory/:id.
 */
export async function transfersFor(listing: { id: string; ownerId: string }, req: Request) {
    if (!req.user) return [];
    const me = req.user.id;
    const where: any = { listingId: listing.id, status: 'pending' };
    if (!isStaff(req)) {
        where.OR = listing.ownerId === me ? [{ fromUserId: me }] : [{ toUserId: me }];
    }
    return prisma.listingTransfer.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        include: { fromUser: personSelect, toUser: personSelect },
    });
}

/**
 * POST /directory/:id/claim { message? }
 * "I run this": ask the listing's owner to hand it over. Staff hear about it
 * too, and decide if the owner doesn't.
 */
export async function claimListing(req: Request, res: Response): Promise<void> {
    try {
        const me = req.user!.id;
        const listing = await prisma.directoryListing.findUnique({
            where: { id: req.params.id },
            select: { id: true, name: true, type: true, status: true, ownerId: true },
        });
        if (!listing || listing.status !== 'active') { res.status(404).json({ error: 'Listing not found' }); return; }
        if (listing.ownerId === me) { res.status(400).json({ error: 'This listing is already yours', reason: 'already_owner' }); return; }

        const open = await prisma.listingTransfer.findFirst({
            where: { listingId: listing.id, toUserId: me, status: 'pending' },
            include: { fromUser: personSelect, toUser: personSelect },
        });
        if (open) { res.json(open); return; }

        const transfer = await prisma.listingTransfer.create({
            data: {
                listingId: listing.id, fromUserId: listing.ownerId, toUserId: me,
                kind: 'claim', message: (req.body.message || '').trim(),
            },
            include: { fromUser: personSelect, toUser: personSelect },
        });

        const name = await nameOf(me);
        const data = { link: listingLink(listing), listingId: listing.id, transferId: transfer.id, actorId: me };
        await createNotification({
            userId: listing.ownerId,
            type: 'SYSTEM',
            title: `${name} says they run ${listing.name}`,
            body: 'Open the listing to hand it over to them, or say no.',
            data,
        });
        for (const id of await staffIds([me, listing.ownerId])) {
            await createNotification({
                userId: id,
                type: 'SYSTEM',
                title: `Ownership request: ${listing.name}`,
                body: `${name} asked to take over this listing. Its owner has been asked first.`,
                data,
            });
        }

        res.status(201).json(transfer);
    } catch (error) {
        console.error('Claim directory listing error:', error);
        res.status(500).json({ error: 'Failed to send the request' });
    }
}

/**
 * POST /directory/:id/transfer { toUserId, message? }
 * The owner offers the listing to the member who runs it, who accepts it.
 * If that member already asked for it, it moves at once.
 */
export async function offerListing(req: Request, res: Response): Promise<void> {
    try {
        const me = req.user!.id;
        const { toUserId } = req.body;
        const listing = await prisma.directoryListing.findUnique({
            where: { id: req.params.id },
            select: { id: true, name: true, type: true, ownerId: true },
        });
        if (!listing) { res.status(404).json({ error: 'Listing not found' }); return; }
        if (listing.ownerId !== me) { res.status(403).json({ error: 'Only the listing\'s owner can hand it over' }); return; }
        if (toUserId === me) { res.status(400).json({ error: 'This listing is already yours', reason: 'already_owner' }); return; }
        if (!(await activeMember(toUserId))) { res.status(400).json({ error: 'Member not found', reason: 'no_member' }); return; }
        if (await blockedEitherWay(me, toUserId)) { res.status(403).json({ error: 'You can\'t hand it to this member', reason: 'blocked' }); return; }

        const myName = await nameOf(me);
        const asked = await prisma.listingTransfer.findFirst({
            where: { listingId: listing.id, toUserId, kind: 'claim', status: 'pending' },
        });
        if (asked) {
            await moveListing(listing.id, toUserId, me, asked.id);
            await createNotification({
                userId: toUserId,
                type: 'SYSTEM',
                title: `${listing.name} is yours now`,
                body: `${myName} handed it over. You can edit it now.`,
                data: { link: listingLink(listing), listingId: listing.id, actorId: me },
            });
            res.json({ moved: true, ownerId: toUserId });
            return;
        }

        const now = new Date();
        await prisma.listingTransfer.updateMany({
            where: { listingId: listing.id, kind: 'offer', status: 'pending' },
            data: { status: 'cancelled', decidedById: me, decidedAt: now },
        });
        const transfer = await prisma.listingTransfer.create({
            data: {
                listingId: listing.id, fromUserId: me, toUserId,
                kind: 'offer', message: (req.body.message || '').trim(),
            },
            include: { fromUser: personSelect, toUser: personSelect },
        });
        await createNotification({
            userId: toUserId,
            type: 'SYSTEM',
            title: `${myName} wants to hand ${listing.name} over to you`,
            body: 'Open the listing to accept it, or say no.',
            data: { link: listingLink(listing), listingId: listing.id, transferId: transfer.id, actorId: me },
        });

        res.status(201).json(transfer);
    } catch (error) {
        console.error('Offer directory listing error:', error);
        res.status(500).json({ error: 'Failed to hand the listing over' });
    }
}

/** A pending request and its listing, or an answer already sent. */
async function openTransfer(req: Request, res: Response) {
    const transfer = await prisma.listingTransfer.findUnique({
        where: { id: req.params.transferId },
        include: { listing: { select: { id: true, name: true, type: true, ownerId: true } } },
    });
    if (!transfer) { res.status(404).json({ error: 'Request not found' }); return null; }
    if (transfer.status !== 'pending') {
        res.status(409).json({ error: 'This request was already answered', reason: 'answered', status: transfer.status });
        return null;
    }
    // The listing changed hands since: the request no longer applies.
    if (transfer.listing.ownerId !== transfer.fromUserId) {
        await prisma.listingTransfer.update({
            where: { id: transfer.id },
            data: { status: 'cancelled', decidedAt: new Date() },
        });
        res.status(409).json({ error: 'This listing has a new owner since', reason: 'stale' });
        return null;
    }
    return transfer;
}

/**
 * POST /directory/transfers/:transferId/accept
 * A claim: the owner, or staff, hand the listing over. An offer: the member
 * it's for takes it.
 */
export async function acceptTransfer(req: Request, res: Response): Promise<void> {
    try {
        const me = req.user!.id;
        const transfer = await openTransfer(req, res);
        if (!transfer) return;
        const { listing } = transfer;
        const byOwner = transfer.kind === 'claim' && transfer.fromUserId === me;
        const byStaff = transfer.kind === 'claim' && !byOwner && isStaff(req);
        const byRecipient = transfer.kind === 'offer' && transfer.toUserId === me;
        if (!byOwner && !byStaff && !byRecipient) { res.status(403).json({ error: 'Not your request to answer' }); return; }
        if (!(await activeMember(transfer.toUserId))) { res.status(400).json({ error: 'Member not found', reason: 'no_member' }); return; }

        await moveListing(listing.id, transfer.toUserId, me, transfer.id);

        const data = { link: listingLink(listing), listingId: listing.id, actorId: me };
        if (byRecipient) {
            await createNotification({
                userId: transfer.fromUserId,
                type: 'SYSTEM',
                title: `${await nameOf(me)} took over ${listing.name}`,
                body: 'The listing is theirs now.',
                data,
            });
        } else {
            await createNotification({
                userId: transfer.toUserId,
                type: 'SYSTEM',
                title: `${listing.name} is yours now`,
                body: byStaff ? 'BIES staff handed it over to you. You can edit it now.' : `${await nameOf(me)} handed it over. You can edit it now.`,
                data,
            });
            if (byStaff) {
                await createNotification({
                    userId: transfer.fromUserId,
                    type: 'SYSTEM',
                    title: `${listing.name} has a new owner`,
                    body: `BIES staff handed it over to ${await nameOf(transfer.toUserId)}, who runs it.`,
                    data: { link: listingLink(listing), listingId: listing.id },
                });
                await prisma.auditLog.create({
                    data: {
                        userId: me,
                        action: 'DIRECTORY_LISTING_TRANSFERRED',
                        resource: `directory:${listing.id}`,
                        metadata: JSON.stringify({ listingName: listing.name, from: transfer.fromUserId, to: transfer.toUserId, transferId: transfer.id }),
                    },
                });
            }
        }

        res.json({ moved: true, ownerId: transfer.toUserId });
    } catch (error) {
        console.error('Accept listing transfer error:', error);
        res.status(500).json({ error: 'Failed to hand the listing over' });
    }
}

/**
 * POST /directory/transfers/:transferId/decline
 * An offer: the member it's for says no, and that's the end of it. A claim:
 * staff close it; the owner saying no leaves it open for staff to decide.
 */
export async function declineTransfer(req: Request, res: Response): Promise<void> {
    try {
        const me = req.user!.id;
        const transfer = await openTransfer(req, res);
        if (!transfer) return;
        const { listing } = transfer;
        const data = { link: listingLink(listing), listingId: listing.id };

        if (transfer.kind === 'offer') {
            if (transfer.toUserId !== me) { res.status(403).json({ error: 'Not your request to answer' }); return; }
            await prisma.listingTransfer.update({
                where: { id: transfer.id },
                data: { status: 'declined', decidedById: me, decidedAt: new Date() },
            });
            await createNotification({
                userId: transfer.fromUserId,
                type: 'SYSTEM',
                title: `${await nameOf(me)} said no to ${listing.name}`,
                body: 'The listing stays yours.',
                data: { ...data, actorId: me },
            });
            res.json({ status: 'declined' });
            return;
        }

        // A claim. Staff decide it for good.
        if (isStaff(req) && transfer.fromUserId !== me) {
            await prisma.listingTransfer.update({
                where: { id: transfer.id },
                data: { status: 'declined', decidedById: me, decidedAt: new Date() },
            });
            await createNotification({
                userId: transfer.toUserId,
                type: 'SYSTEM',
                title: `Your request for ${listing.name} was declined`,
                body: 'BIES staff looked into it and the listing stays with its owner.',
                data,
            });
            res.json({ status: 'declined' });
            return;
        }
        if (transfer.fromUserId !== me) { res.status(403).json({ error: 'Not your request to answer' }); return; }

        // The owner says no: staff decide.
        await prisma.listingTransfer.update({ where: { id: transfer.id }, data: { ownerDeclinedAt: new Date() } });
        for (const id of await staffIds([transfer.fromUserId, transfer.toUserId])) {
            await createNotification({
                userId: id,
                type: 'SYSTEM',
                title: `Ownership request needs you: ${listing.name}`,
                body: `The listing's owner said no to ${await nameOf(transfer.toUserId)}'s request.`,
                data: { ...data, transferId: transfer.id },
            });
        }
        res.json({ status: 'pending', ownerDeclined: true });
    } catch (error) {
        console.error('Decline listing transfer error:', error);
        res.status(500).json({ error: 'Failed to answer the request' });
    }
}

/**
 * POST /directory/transfers/:transferId/cancel
 * Whoever asked takes it back: the claimant, or the owner who offered.
 */
export async function cancelTransfer(req: Request, res: Response): Promise<void> {
    try {
        const me = req.user!.id;
        const transfer = await prisma.listingTransfer.findUnique({ where: { id: req.params.transferId } });
        if (!transfer) { res.status(404).json({ error: 'Request not found' }); return; }
        const asker = transfer.kind === 'claim' ? transfer.toUserId : transfer.fromUserId;
        if (asker !== me) { res.status(403).json({ error: 'Not your request' }); return; }
        if (transfer.status === 'pending') {
            await prisma.listingTransfer.update({
                where: { id: transfer.id },
                data: { status: 'cancelled', decidedById: me, decidedAt: new Date() },
            });
        }
        res.json({ status: 'cancelled' });
    } catch (error) {
        console.error('Cancel listing transfer error:', error);
        res.status(500).json({ error: 'Failed to cancel the request' });
    }
}

/**
 * GET /admin/directory/transfers
 * Open ownership requests, oldest first: the ones staff may need to decide.
 */
export async function listOpenTransfers(_req: Request, res: Response): Promise<void> {
    try {
        const transfers = await prisma.listingTransfer.findMany({
            where: { status: 'pending', kind: 'claim' },
            orderBy: { createdAt: 'asc' },
            include: {
                listing: { select: { id: true, name: true, type: true } },
                fromUser: personSelect,
                toUser: personSelect,
            },
        });
        res.json({ data: transfers });
    } catch (error) {
        console.error('List listing transfers error:', error);
        res.status(500).json({ error: 'Failed to list ownership requests' });
    }
}

/**
 * POST /admin/directory/:id/owner { userId }
 * Staff move a listing to the member who runs it, at once.
 */
export async function staffMoveListing(req: Request, res: Response): Promise<void> {
    try {
        const me = req.user!.id;
        const { userId } = req.body;
        const listing = await prisma.directoryListing.findUnique({
            where: { id: req.params.id },
            select: { id: true, name: true, type: true, ownerId: true },
        });
        if (!listing) { res.status(404).json({ error: 'Listing not found' }); return; }
        if (listing.ownerId === userId) { res.status(400).json({ error: 'They already own it', reason: 'already_owner' }); return; }
        if (!(await activeMember(userId))) { res.status(400).json({ error: 'Member not found', reason: 'no_member' }); return; }

        const record = await prisma.listingTransfer.create({
            data: { listingId: listing.id, fromUserId: listing.ownerId, toUserId: userId, kind: 'staff' },
        });
        await moveListing(listing.id, userId, me, record.id);

        const data = { link: listingLink(listing), listingId: listing.id };
        await createNotification({
            userId,
            type: 'SYSTEM',
            title: `${listing.name} is yours now`,
            body: 'BIES staff handed it over to you. You can edit it now.',
            data,
        });
        await createNotification({
            userId: listing.ownerId,
            type: 'SYSTEM',
            title: `${listing.name} has a new owner`,
            body: `BIES staff handed it over to ${await nameOf(userId)}, who runs it.`,
            data,
        });
        await prisma.auditLog.create({
            data: {
                userId: me,
                action: 'DIRECTORY_LISTING_TRANSFERRED',
                resource: `directory:${listing.id}`,
                metadata: JSON.stringify({ listingName: listing.name, from: listing.ownerId, to: userId, transferId: record.id }),
            },
        });

        res.json({ moved: true, ownerId: userId });
    } catch (error) {
        console.error('Staff move directory listing error:', error);
        res.status(500).json({ error: 'Failed to move the listing' });
    }
}
