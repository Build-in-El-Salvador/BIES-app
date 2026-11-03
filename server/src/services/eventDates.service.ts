import prisma from '../lib/prisma';
import { createNotification } from './notification.service';
import { DATE_FIELDS, type DateChange, type Occurrence, type Series } from '../utils/eventRepeat';

/**
 * One date of a repeating event that's different or called off ("BIES
 * Soccer" at the beach field on 7 November, no game on the 14th): what the
 * event is on that date, what changed, how that reads in a notification,
 * and who's told: the members going to that date, no one else.
 */

/** What an event is on one date: its times, and its words and place. */
export type DayView = {
    startDate: Date; endDate: Date | null;
    title: string; description: string;
    locationName: string; locationAddress: string; locationMapUrl: string; isOnline: boolean; onlineUrl: string;
};
/** An event's own values, which a date may have its own of. */
export type EventValues = Series & Omit<DayView, 'startDate' | 'endDate'> & { location: string };

/** A date's place: where it has one of its own, the event's otherwise. */
const PLACE_FIELDS = ['locationName', 'locationAddress', 'locationMapUrl', 'isOnline', 'onlineUrl'] as const;

/** The event on one of its dates: that date's own values where it has them. */
export function dayView(e: EventValues, o: Occurrence): DayView & { location: string } {
    const c: DateChange | null = o.change;
    const own = <K extends typeof DATE_FIELDS[number]>(f: K) => (c?.[f] ?? e[f]) as EventValues[K];
    const view = {
        startDate: o.startDate, endDate: o.endDate,
        title: own('title'), description: own('description'),
        locationName: own('locationName'), locationAddress: own('locationAddress'), locationMapUrl: own('locationMapUrl'),
        isOnline: own('isOnline'), onlineUrl: own('onlineUrl'),
    };
    // The one-line place the lists search and show: from the date's own name and address.
    const placeOwn = c?.locationName != null || c?.locationAddress != null;
    return { ...view, location: placeOwn ? [view.locationName, view.locationAddress].filter(Boolean).join(', ') : e.location };
}

/** A date as it usually is: at its key, for its usual length, with the event's values. */
export function usualView(e: EventValues, key: Date): DayView {
    const length = e.endDate ? e.endDate.getTime() - e.startDate.getTime() : null;
    return dayView(e, { key, startDate: key, endDate: length === null ? null : new Date(key.getTime() + length), change: null, calledOff: false });
}

export type Changed = { time: boolean; place: boolean; title: boolean; details: boolean };
const sameMoment = (a: Date | null, b: Date | null) => (a ? a.getTime() : null) === (b ? b.getTime() : null);

/** What's different between two views of a date. */
export function differences(a: DayView, b: DayView): Changed {
    return {
        time: !sameMoment(a.startDate, b.startDate) || !sameMoment(a.endDate, b.endDate),
        place: PLACE_FIELDS.some((f) => a[f] !== b[f]),
        title: a.title !== b.title,
        details: a.description !== b.description,
    };
}
export const anyChange = (c: Changed) => c.time || c.place || c.title || c.details;

const SV = 'America/El_Salvador';
const partsOf = (d: Date, options: Intl.DateTimeFormatOptions) => Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: SV, ...options }).formatToParts(d).map((p) => [p.type, p.value]),
);
/** A date as notifications name it, in El Salvador: "Sat 7 Nov". */
export function dayName(d: Date): string {
    const p = partsOf(d, { weekday: 'short', day: 'numeric', month: 'short' });
    return `${p.weekday} ${p.day} ${p.month}`;
}
/** A time of day in El Salvador: "4:00 PM". */
export function timeText(d: Date): string {
    const p = partsOf(d, { hour: 'numeric', minute: '2-digit' });
    return `${p.hour}:${p.minute} ${p.dayPeriod}`;
}

/** Where a date is, in words: "Beach field", "online", or '' when it doesn't say. */
const placeText = (v: DayView) => (v.isOnline ? 'online' : (v.locationName || v.locationAddress || '').trim());
const atPlace = (place: string) => (!place ? '' : place === 'online' ? 'online' : `at ${place}`);
/** Its time, with its day when it moved to another: "10:00 AM", "Sun 8 Nov, 10:00 AM". */
const whenText = (v: DayView, key: Date) => (dayName(v.startDate) === dayName(key) ? timeText(v.startDate) : `${dayName(v.startDate)}, ${timeText(v.startDate)}`);
const words = (...parts: string[]) => parts.filter(Boolean).join(' ');
const capFirst = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * What a date's change says, only what changed in it: "10:00 AM at Beach
 * field (usually 4:00 PM at Usual field)", "10:00 AM (usually 4:00 PM)",
 * "At Beach field (usually at Usual field)", "Back to the usual time,
 * 4:00 PM". Anything else: "Details changed".
 */
export function changeNote(key: Date, now: DayView, usual: DayView, changed: Changed): string {
    const fromUsual = differences(now, usual);
    const time = changed.time && fromUsual.time;
    const place = changed.place && fromUsual.place;
    if (time && place) {
        return `${words(whenText(now, key), atPlace(placeText(now)))} (usually ${words(timeText(usual.startDate), atPlace(placeText(usual)))})`;
    }
    const parts: string[] = [];
    if (changed.time) parts.push(time ? `${whenText(now, key)} (usually ${timeText(usual.startDate)})` : `Back to the usual time, ${timeText(usual.startDate)}`);
    if (changed.place) {
        parts.push(place
            ? words(capFirst(atPlace(placeText(now)) || 'No place given'), placeText(usual) ? `(usually ${atPlace(placeText(usual))})` : '')
            : capFirst(words('back', atPlace(placeText(usual)) || 'at the usual place')));
    }
    return parts.length ? parts.join('. ') : 'Details changed';
}

/**
 * A date that moved with every date after it, in words: "Now 5:00 PM (was
 * 4:00 PM)", with its days when it's on another day ("Now Sun 8 Nov, 5:00
 * PM (was Sat 7 Nov, 4:00 PM)"); a new end only: "Now until 7:00 PM (was
 * until 6:00 PM)".
 */
export function movedNote(was: { startDate: Date; endDate: Date | null }, now: { startDate: Date; endDate: Date | null }): string {
    if (was.startDate.getTime() === now.startDate.getTime()) {
        const until = (d: Date | null) => (d ? `until ${timeText(d)}` : 'with no end time');
        return `Now ${until(now.endDate)} (was ${until(was.endDate)})`;
    }
    const sameDay = dayName(was.startDate) === dayName(now.startDate);
    const at = (d: Date) => (sameDay ? timeText(d) : `${dayName(d)}, ${timeText(d)}`);
    return `Now ${at(now.startDate)} (was ${at(was.startDate)})`;
}

/** The members going to one date of an event (by its key), but not whoever's doing this. */
export async function goingTo(eventId: string, key: Date, except?: string): Promise<string[]> {
    const rows = await prisma.eventAttendee.findMany({
        where: { eventId, status: 'GOING', occurrenceStart: key, user: { isBanned: false, deletedAt: null } },
        select: { userId: true },
    });
    return rows.map((r) => r.userId).filter((id) => id !== except);
}

/** Tell the members going to one date; tapping it opens the event. Failures are logged, never thrown. */
export async function tellGoingTo(eventId: string, key: Date, note: { title: string; body: string; status: string }, except?: string): Promise<number> {
    const people = await goingTo(eventId, key, except);
    await Promise.all(people.map((userId) => createNotification({
        userId,
        type: 'EVENT_RSVP',
        title: note.title,
        body: note.body,
        // Whoever changed it is the actor: a member who blocked them isn't told.
        data: { eventId, status: note.status, occurrence: key.toISOString(), ...(except ? { actorId: except } : {}) },
    }).catch((err) => console.error('[Events] Date notification failed:', err))));
    return people.length;
}
