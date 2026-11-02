import prisma from '../lib/prisma';
import { createNotification } from './notification.service';
import { hiddenFromIds } from './moderation.service';
import { proposalStage, whenAndWhere } from './eventProposals.service';

/**
 * Members a proposed meetup's proposer invites ("Sunday hike, Ana?"), when
 * they post it, edit it, or from its page. Each one invited gets an INVITED
 * attendee row and one notification, pushed to their phone ("Edwin Rivas
 * invited you to ..."), and their card and page say "Edwin invited you"
 * until they're in (the row becomes GOING).
 *
 * Who's invited is for the proposer (and admins) only: other members never
 * see the list, and an invite never counts as being in. Only GOING rows
 * count towards a meetup's number, its faces and its capacity.
 */

/** Invites a meetup can have waiting at once. */
export const MAX_INVITES = 50;

/** Invites one member can send in a day, across all their meetups. */
export const MAX_INVITES_PER_DAY = 100;

// A meetup's invites go one request at a time: two at once could each count
// the same waiting invites and together pass MAX_INVITES. (One server
// process: an in-process queue per meetup is enough.)
const inviteQueues = new Map<string, Promise<unknown>>();
function oneAtATime<T>(eventId: string, task: () => Promise<T>): Promise<T> {
    const run = (inviteQueues.get(eventId) ?? Promise.resolve()).then(task, task);
    const tail = run.catch(() => undefined);
    inviteQueues.set(eventId, tail);
    tail.then(() => { if (inviteQueues.get(eventId) === tail) inviteQueues.delete(eventId); });
    return run;
}

// Invite notifications carry { eventId, inviterId, status: 'INVITED', ... },
// in that order (sendInvites): what was sent is read back from them.
const DAY_MS = 24 * 60 * 60 * 1000;

/** Invites this member sent in the last day, as notifications that went out. */
async function sentToday(actorId: string): Promise<number> {
    return prisma.notification.count({
        where: { type: 'EVENT_RSVP', createdAt: { gte: new Date(Date.now() - DAY_MS) }, data: { contains: `"inviterId":"${actorId}","status":"INVITED"` } },
    });
}

/** Of these members, those told about an invite to this meetup before. */
async function toldBefore(eventId: string, userIds: string[]): Promise<Set<string>> {
    if (!userIds.length) return new Set();
    const rows = await prisma.notification.findMany({
        where: { userId: { in: userIds }, type: 'EVENT_RSVP', data: { contains: `"eventId":"${eventId}","inviterId":` } },
        select: { userId: true },
    });
    return new Set(rows.map((r) => r.userId));
}

/** A meetup as inviting needs it. */
export const INVITE_EVENT_SELECT = {
    id: true, title: true, hostId: true, hostListingId: true, startDate: true, decideBy: true,
    minAttendees: true, confirmedAt: true, calledOffAt: true, locationName: true, location: true,
} as const;

export type InviteEvent = {
    id: string; title: string; hostId: string; startDate: Date; decideBy: Date | null;
    minAttendees: number | null; confirmedAt: Date | null; calledOffAt: Date | null;
    locationName?: string | null; location?: string | null;
};

/** Why invites were refused, for the app. */
export class InviteError extends Error {
    constructor(message: string, public reason: string, public extra: Record<string, unknown> = {}) {
        super(message);
    }
}

/** Why a meetup can't take more invites now (null: it can). */
export function invitesClosed(e: InviteEvent, now = Date.now()): string | null {
    const stage = proposalStage(e);
    if (!stage) return 'not_a_proposal';
    // Called off, or past its deadline without enough people (nobody can join).
    if (stage === 'calledOff' || (stage === 'proposed' && !!e.decideBy && e.decideBy.getTime() < now)) return 'called_off';
    if (e.startDate.getTime() <= now) return 'started';
    return null;
}

const CLOSED_TEXT: Record<string, string> = {
    not_a_proposal: 'Only a proposed meetup takes invites this way',
    called_off: 'This meetup was called off',
    started: 'It has started already',
};

/** A member's name as the app shows it, or '' for a placeholder ("nostr:1a2b3c4d"). */
const shownName = (name: string | null | undefined) => (name && !name.trim().startsWith('nostr:') ? name.trim() : '');

/**
 * Of the members picked, those who can be invited, in the order picked: on
 * BIES (not suspended or deleted), not its proposer or whoever is inviting,
 * in no block either way with either of them, and with no answer on it yet
 * (going, invited, interested or not going).
 */
export async function invitable(event: { id: string; hostId: string }, actorId: string, userIds: string[]): Promise<string[]> {
    const picked = [...new Set(userIds)].filter((id) => id && id !== event.hostId && id !== actorId);
    if (!picked.length) return [];
    const [hidden, active, answered] = await Promise.all([
        Promise.all([...new Set([event.hostId, actorId])].map((id) => hiddenFromIds(id))),
        prisma.user.findMany({ where: { id: { in: picked }, isBanned: false, deletedAt: null }, select: { id: true } }),
        prisma.eventAttendee.findMany({ where: { eventId: event.id, userId: { in: picked } }, select: { userId: true } }),
    ]);
    const blocked = new Set(hidden.flat());
    const real = new Set(active.map((u) => u.id));
    const has = new Set(answered.map((a) => a.userId));
    return picked.filter((id) => real.has(id) && !blocked.has(id) && !has.has(id));
}

/** The ids of the members invited who haven't answered yet. */
async function waitingIds(eventId: string): Promise<string[]> {
    const rows = await prisma.eventAttendee.findMany({ where: { eventId, status: 'INVITED' }, select: { userId: true } });
    return rows.map((r) => r.userId);
}

const tooMany = (waiting: number) => new InviteError(
    `A meetup can have up to ${MAX_INVITES} members invited`,
    'too_many_invites',
    { max: MAX_INVITES, room: Math.max(0, MAX_INVITES - waiting) },
);

const tooManyToday = (sent: number) => new InviteError(
    `You can invite up to ${MAX_INVITES_PER_DAY} members a day`,
    'too_many_today',
    { max: MAX_INVITES_PER_DAY, room: Math.max(0, MAX_INVITES_PER_DAY - sent) },
);

/**
 * Invite members (already checked by invitable): their rows, then a
 * notification each, in the name of whoever invites (the proposer, or an
 * admin). Within the most a meetup can have waiting and its sender can send
 * in a day, counted again here, one request at a time. Someone who answered
 * meanwhile is left as they are. A member is told about an invite to a
 * meetup once: invited again (taken back, or they left), they aren't
 * pushed again. Returns who was invited.
 */
export async function sendInvites(event: InviteEvent, userIds: string[], actorId: string = event.hostId): Promise<string[]> {
    return oneAtATime(event.id, async () => {
        const [waiting, sent] = await Promise.all([waitingIds(event.id), sentToday(actorId)]);
        const room = Math.max(0, Math.min(MAX_INVITES - waiting.length, MAX_INVITES_PER_DAY - sent));
        const invited: string[] = [];
        for (const userId of userIds.slice(0, room)) {
            try {
                await prisma.eventAttendee.create({ data: { eventId: event.id, userId, status: 'INVITED' } });
                invited.push(userId);
            } catch (err) {
                if ((err as { code?: string })?.code !== 'P2002') throw err;
            }
        }
        if (!invited.length) return invited;
        const [sender, told] = await Promise.all([
            prisma.profile.findUnique({ where: { userId: actorId }, select: { name: true } }),
            toldBefore(event.id, invited),
        ]);
        const name = shownName(sender?.name) || 'A BIES member';
        await Promise.all(invited.filter((userId) => !told.has(userId)).map((userId) => createNotification({
            userId,
            type: 'EVENT_RSVP',
            title: `${name} invited you to "${event.title}"`,
            body: `A meetup on ${whenAndWhere(event)}. Are you in?`,
            // inviterId: nothing reaches a member from someone in a block
            // with them. Keep the key order: toldBefore and sentToday read it.
            data: { eventId: event.id, inviterId: actorId, status: 'INVITED', link: `/events/${event.id}` },
        }).catch(() => {})));
        return invited;
    });
}

/**
 * Invite more members (from the meetup's page, or as it's posted): those who
 * can be, within the most a meetup can have waiting. Throws an InviteError
 * when it's too late, or too many.
 */
export async function inviteMore(event: InviteEvent, actorId: string, userIds: string[]): Promise<{ invited: string[]; skipped: number }> {
    const closed = invitesClosed(event);
    if (closed) throw new InviteError(CLOSED_TEXT[closed], closed);
    const fresh = await invitable(event, actorId, userIds);
    const [waiting, sent] = await Promise.all([waitingIds(event.id).then((w) => w.length), sentToday(actorId)]);
    if (waiting + fresh.length > MAX_INVITES) throw tooMany(waiting);
    if (sent + fresh.length > MAX_INVITES_PER_DAY) throw tooManyToday(sent);
    const invited = await sendInvites(event, fresh, actorId);
    return { invited, skipped: new Set(userIds).size - invited.length };
}

/**
 * An edit of a meetup with its invite list (everyone the proposer wants
 * invited): who to invite, and whose invite to take back (invited, not
 * answered, and left off). `shown`: the invites the form showed when it
 * opened. Only those can be taken back, so a form opened before an invite
 * was sent from the meetup's page doesn't take it back. Members who joined
 * are never touched. Checked before the edit saves; throws an InviteError
 * when it can't be.
 */
export async function planInviteList(event: InviteEvent, actorId: string, wanted: string[], shown?: string[]): Promise<{ add: string[]; remove: string[] }> {
    const waiting = await waitingIds(event.id);
    const keep = new Set(wanted);
    const couldRemove = shown ? new Set(shown) : null;
    const remove = waiting.filter((id) => !keep.has(id) && (!couldRemove || couldRemove.has(id)));
    const add = await invitable(event, actorId, wanted);
    if (add.length) {
        const closed = invitesClosed(event);
        if (closed) throw new InviteError(CLOSED_TEXT[closed], closed);
        if (waiting.length - remove.length + add.length > MAX_INVITES) throw tooMany(waiting.length - remove.length);
        const sent = await sentToday(actorId);
        if (sent + add.length > MAX_INVITES_PER_DAY) throw tooManyToday(sent);
    }
    return { add, remove };
}

/** Take back invites nobody answered: the rows go, and nobody is told. */
export async function withdrawInvites(eventId: string, userIds: string[]): Promise<number> {
    if (!userIds.length) return 0;
    const gone = await prisma.eventAttendee.deleteMany({ where: { eventId, status: 'INVITED', userId: { in: userIds } } });
    return gone.count;
}

/** A member as an invite shows them. */
export type InvitePerson = { id: string; name: string; avatar: string };
const person = (u: { id: string; profile: { name: string; avatar: string } | null }): InvitePerson => ({
    id: u.id, name: u.profile?.name || '', avatar: u.profile?.avatar || '',
});

/** Who's invited and hasn't answered yet, for its proposer (and admins); none hidden from them. */
export async function invitedMembers(eventId: string, hidden: Set<string>): Promise<InvitePerson[]> {
    const rows = await prisma.eventAttendee.findMany({
        where: { eventId, status: 'INVITED', user: { isBanned: false, deletedAt: null } },
        orderBy: { joinedAt: 'asc' },
        take: MAX_INVITES,
        select: { user: { select: { id: true, profile: { select: { name: true, avatar: true } } } } },
    });
    return rows.filter((r) => !hidden.has(r.user.id)).map((r) => person(r.user));
}

/**
 * What the member sees of their own invite to a proposed meetup: who
 * invited them (its proposer). Nothing once they've answered, or on a usual
 * event.
 */
export function myInvite(
    event: { minAttendees: number | null; host?: { id: string; profile: { name: string; avatar: string } | null } | null },
    myStatus: string | null | undefined,
): { by: InvitePerson } | null {
    if (myStatus !== 'INVITED' || !event.minAttendees || !event.host) return null;
    return { by: person(event.host) };
}
