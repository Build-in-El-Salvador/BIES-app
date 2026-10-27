import prisma from '../lib/prisma';
import { cache } from './redis.service';
import { createNotification } from './notification.service';

/**
 * Meetups members propose ("steak lunch, anyone?"). A proposal is an event
 * with a minimum: it goes ahead the moment that many members are going
 * (counting the member who proposed it), and is called off if they aren't by
 * its decide-by time. Either way everyone who said they're in is told. Once
 * it's on it stays on, even if someone drops out.
 *
 * Where it is can be a business or farm on BIES (its venue): its name,
 * address and map link fill the event's. Tagging a place needs no say from
 * the business, as a place tag on Instagram; it isn't a host or partner.
 */

export const MIN_PROPOSAL = 2;
export const MAX_PROPOSAL = 50;
/** Proposals a member can have open (not yet on or called off) at once. */
export const MAX_OPEN_PROPOSALS = 5;
/** How often proposals past their decide-by time are called off. */
const SWEEP_MS = 5 * 60_000;

export type ProposalStage = 'proposed' | 'on' | 'calledOff';

type ProposalFields = { minAttendees: number | null; confirmedAt: Date | null; calledOffAt: Date | null };

/** Where a proposal stands; null for a usual event. */
export function proposalStage(e: ProposalFields): ProposalStage | null {
    if (!e.minAttendees) return null;
    if (e.confirmedAt) return 'on';
    if (e.calledOffAt) return 'calledOff';
    return 'proposed';
}

/** A venue as an event shows it. */
export const VENUE_SELECT = {
    id: true, name: true, type: true, category: true, logo: true, photo: true, coverFrame: true,
    location: true, mapUrl: true, pricing: true, status: true, isPublished: true,
};

/**
 * A business or farm a member may tag as where an event is: one that's up,
 * or their own that's waiting for review (just added from the event).
 */
export async function venueFor(listingId: string, userId: string) {
    const listing = await prisma.directoryListing.findUnique({ where: { id: listingId }, select: { ...VENUE_SELECT, ownerId: true } });
    if (!listing) return null;
    const live = listing.status === 'active' && listing.isPublished;
    return live || listing.ownerId === userId ? listing : null;
}

/** How many proposals a member has open: not on yet, not called off. */
export function openProposals(hostId: string): Promise<number> {
    return prisma.event.count({ where: { hostId, minAttendees: { not: null }, confirmedAt: null, calledOffAt: null } });
}

/** Everyone going, and the member who proposed it. */
async function peopleIn(eventId: string, hostId: string): Promise<string[]> {
    const going = await prisma.eventAttendee.findMany({ where: { eventId, status: 'GOING' }, select: { userId: true } });
    return [...new Set([hostId, ...going.map((a) => a.userId)])];
}

/**
 * After someone says they're in: if that made the number, it's on, and
 * everyone in is told. Only one call wins the change (the update checks it
 * hasn't been confirmed or called off meanwhile).
 */
export async function confirmIfReached(eventId: string): Promise<boolean> {
    const event = await prisma.event.findUnique({
        where: { id: eventId },
        select: { id: true, title: true, hostId: true, minAttendees: true, confirmedAt: true, calledOffAt: true },
    });
    if (!event || proposalStage(event) !== 'proposed') return false;
    const going = await prisma.eventAttendee.count({ where: { eventId, status: 'GOING' } });
    if (going < (event.minAttendees || 0)) return false;
    const won = await prisma.event.updateMany({
        where: { id: eventId, confirmedAt: null, calledOffAt: null },
        data: { confirmedAt: new Date() },
    });
    if (won.count !== 1) return false;
    await Promise.all([cache.delPattern('events:'), cache.del(`preview:events:${eventId}`)]);
    const people = await peopleIn(eventId, event.hostId);
    await Promise.all(people.map((userId) => createNotification({
        userId,
        type: 'EVENT_RSVP',
        title: `It's on: "${event.title}"`,
        body: `${going} people are in. See you there!`,
        data: { eventId, status: 'CONFIRMED' },
    }).catch(() => {})));
    return true;
}

/** Proposals past their decide-by time without enough people: called off, and everyone in is told. */
export async function sweepProposals(now = new Date()): Promise<number> {
    const due = await prisma.event.findMany({
        where: { minAttendees: { not: null }, confirmedAt: null, calledOffAt: null, decideBy: { lt: now } },
        select: { id: true, title: true, hostId: true },
        take: 200,
    });
    let calledOff = 0;
    for (const event of due) {
        const won = await prisma.event.updateMany({
            where: { id: event.id, confirmedAt: null, calledOffAt: null },
            data: { calledOffAt: now },
        });
        if (won.count !== 1) continue;
        calledOff += 1;
        const people = await peopleIn(event.id, event.hostId);
        await Promise.all(people.map((userId) => createNotification({
            userId,
            type: 'EVENT_RSVP',
            title: `Called off: "${event.title}"`,
            body: 'Not enough people were in by the deadline.',
            data: { eventId: event.id, status: 'CALLED_OFF' },
        }).catch(() => {})));
    }
    if (calledOff) await cache.delPattern('events:');
    return calledOff;
}

/** Calls off what's due now, then every few minutes. */
export function startProposalSweep(): void {
    const sweep = () => sweepProposals()
        .then((count) => { if (count) console.log(`[Events] Called off ${count} proposed meetup(s)`); })
        .catch((err) => console.error('[Events] Proposal sweep failed:', err));
    sweep();
    setInterval(sweep, SWEEP_MS).unref();
}
