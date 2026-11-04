/**
 * Events a member hosted as a business or farm, BIES's own page among them,
 * are that listing's. When the member goes (their account deleted, or
 * suspended), the events pass to whoever answers for the listing now (its
 * linked member, else whoever added it), so they stay up and keep their
 * answers. BIES's own page, with nobody else to answer for it, passes to an
 * admin. Events a member hosted as themselves go with them, as before.
 */
import prisma from '../lib/prisma';

const ACTIVE = { isBanned: false, deletedAt: null };

/** Moves `userId`'s listing-hosted events on. Returns how many moved. */
export async function handOverListingEvents(userId: string): Promise<number> {
    const events = await prisma.event.findMany({
        where: { hostId: userId, hostListingId: { not: null } },
        select: { id: true, hostListing: { select: { ownerId: true, memberUserId: true, isOfficial: true } } },
    });
    let moved = 0;
    for (const event of events) {
        const listing = event.hostListing;
        if (!listing) continue;
        const candidates = [listing.memberUserId, listing.ownerId].filter((id): id is string => !!id && id !== userId);
        let to: string | null = null;
        for (const id of candidates) {
            if (await prisma.user.findFirst({ where: { id, ...ACTIVE }, select: { id: true } })) { to = id; break; }
        }
        if (!to && listing.isOfficial) {
            to = (await prisma.user.findFirst({
                where: { isAdmin: true, ...ACTIVE, id: { not: userId } },
                orderBy: { createdAt: 'asc' },
                select: { id: true },
            }))?.id ?? null;
        }
        if (!to) continue;
        await prisma.event.update({ where: { id: event.id }, data: { hostId: to } });
        moved += 1;
    }
    return moved;
}
