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

/**
 * Invite members (already checked by invitable): their rows, then one
 * notification each, in the proposer's name. Someone who answered
 * meanwhile is left as they are. Returns who was invited.
 */
export async function sendInvites(event: InviteEvent, userIds: string[]): Promise<string[]> {
    const invited: string[] = [];
    for (const userId of userIds) {
        try {
            await prisma.eventAttendee.create({ data: { eventId: event.id, userId, status: 'INVITED' } });
            invited.push(userId);
        } catch (err) {
            if ((err as { code?: string })?.code !== 'P2002') throw err;
        }
    }
    if (!invited.length) return invited;
    const host = await prisma.profile.findUnique({ where: { userId: event.hostId }, select: { name: true } });
    const name = shownName(host?.name) || 'A BIES member';
    await Promise.all(invited.map((userId) => createNotification({
        userId,
        type: 'EVENT_RSVP',
        title: `${name} invited you to "${event.title}"`,
        body: `A meetup on ${whenAndWhere(event)}. Are you in?`,
        // inviterId: nothing reaches a member from someone in a block with them.
        data: { eventId: event.id, inviterId: event.hostId, status: 'INVITED', link: `/events/${event.id}` },
    }).catch(() => {})));
    return invited;
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
    const waiting = (await waitingIds(event.id)).length;
    if (waiting + fresh.length > MAX_INVITES) throw tooMany(waiting);
    const invited = await sendInvites(event, fresh);
    return { invited, skipped: new Set(userIds).size - invited.length };
}

/**
 * An edit of a meetup with its invite list (everyone the proposer wants
 * invited): who to invite, and whose invite to take back (invited, not
 * answered, and left off). Members who joined are never touched. Checked
 * before the edit saves; throws an InviteError when it can't be.
 */
export async function planInviteList(event: InviteEvent, actorId: string, wanted: string[]): Promise<{ add: string[]; remove: string[] }> {
    const waiting = await waitingIds(event.id);
    const keep = new Set(wanted);
    const remove = waiting.filter((id) => !keep.has(id));
    const add = await invitable(event, actorId, wanted);
    if (add.length) {
        const closed = invitesClosed(event);
        if (closed) throw new InviteError(CLOSED_TEXT[closed], closed);
        if (waiting.length - remove.length + add.length > MAX_INVITES) throw tooMany(waiting.length - remove.length);
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
