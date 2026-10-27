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

/** Where a proposal stands; null for a usual event. Its proposer can call it off even once it's on. */
export function proposalStage(e: ProposalFields): ProposalStage | null {
    if (!e.minAttendees) return null;
    if (e.calledOffAt) return 'calledOff';
    if (e.confirmedAt) return 'on';
    return 'proposed';
}

/** A meetup's when and where in a notification: "Sat 7 Nov, 1:00 PM at Corte Argentino Parrilla". */
export function whenAndWhere(e: { startDate: Date; locationName?: string | null; location?: string | null }): string {
    const when = e.startDate.toLocaleString('en-US', {
        weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/El_Salvador',
    });
    const where = (e.locationName || e.location || '').trim();
    return where ? `${when} at ${where}` : when;
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
    const ownWaiting = listing.ownerId === userId && listing.status === 'pending-review';
    return live || ownWaiting ? listing : null;
}

/** How many proposals a member has open: not on yet, not called off. */
export function openProposals(hostId: string): Promise<number> {
    return prisma.event.count({ where: { hostId, minAttendees: { not: null }, confirmedAt: null, calledOffAt: null } });
}

/** Everyone going, and the member who proposed it (but not whoever's doing this). */
export async function peopleIn(eventId: string, hostId: string, except?: string): Promise<string[]> {
    const going = await prisma.eventAttendee.findMany({ where: { eventId, status: 'GOING' }, select: { userId: true } });
    return [...new Set([hostId, ...going.map((a) => a.userId)])].filter((id) => id !== except);
}

/** Tell everyone in about a meetup; failures are logged, never thrown. */
export async function tellPeopleIn(eventId: string, hostId: string, note: { title: string; body: string; status: string; link?: boolean }, except?: string) {
    const people = await peopleIn(eventId, hostId, except);
    await Promise.all(people.map((userId) => createNotification({
        userId,
        type: 'EVENT_RSVP',
        title: note.title,
        body: note.body,
        // A deleted meetup has no page to open.
        data: note.link === false ? { status: note.status } : { eventId, status: note.status },
    }).catch(() => {})));
}

/**
 * After someone says they're in: if that made the number, it's on, and
 * everyone in is told. Only one call wins the change (the update checks it
 * hasn't been confirmed or called off meanwhile).
 */
export async function confirmIfReached(eventId: string): Promise<boolean> {
    const event = await prisma.event.findUnique({
        where: { id: eventId },
        select: {
            id: true, title: true, hostId: true, minAttendees: true, confirmedAt: true, calledOffAt: true,
            startDate: true, locationName: true, location: true,
        },
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
    await tellPeopleIn(eventId, event.hostId, {
        title: `It's on: "${event.title}"`,
        body: `${going} people are in: ${whenAndWhere(event)}.`,
        status: 'CONFIRMED',
    });
    return true;
}

/**
 * Proposals past their decide-by time: on, if enough people are in after all
 * (someone joined but the check after it failed), else called off, and
 * everyone in is told.
 */
export async function sweepProposals(now = new Date()): Promise<number> {
    const due = await prisma.event.findMany({
        where: { minAttendees: { not: null }, confirmedAt: null, calledOffAt: null, decideBy: { lt: now } },
        select: { id: true, title: true, hostId: true },
        take: 200,
    });
    let calledOff = 0;
    for (const event of due) {
        if (await confirmIfReached(event.id)) continue;
        const won = await prisma.event.updateMany({
            where: { id: event.id, confirmedAt: null, calledOffAt: null },
            data: { calledOffAt: now },
        });
        if (won.count !== 1) continue;
        calledOff += 1;
        await cache.del(`preview:events:${event.id}`);
        await tellPeopleIn(event.id, event.hostId, {
            title: `Called off: "${event.title}"`,
            body: 'Not enough people joined in time.',
            status: 'CALLED_OFF',
        });
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
