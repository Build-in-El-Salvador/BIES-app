/**
 * Events that repeat, as calendars do it: the Bitcoin Farmers Market every
 * other Saturday, a meetup on the first Thursday of every month. An event's
 * startDate and endDate are its first date; every later date keeps the same
 * time of day and length, until repeatUntil (the last day it may be on, to
 * the end of that day) or for good. The weekday and month are El Salvador's
 * (UTC-6 all year, no daylight saving): an event at 11 PM on a Saturday
 * there is a Sunday in UTC, and still repeats on Saturdays.
 *
 * The app has the same rules for its form and labels (src/utils/eventRepeat.js).
 */

export const REPEATS = ['WEEKLY', 'BIWEEKLY', 'MONTHLY_NTH', 'MONTHLY_LAST'] as const;
export type Repeat = typeof REPEATS[number];

/** An event, as far as its dates go. */
export type Series = {
    startDate: Date;
    endDate?: Date | null;
    repeat?: string | null;
    repeatUntil?: Date | null;
};
/** One date of an event: when it starts and ends (no end: on for six hours). */
export type Occurrence = { startDate: Date; endDate: Date | null };

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
/** El Salvador's clock, behind UTC. */
const SV_OFFSET = 6 * HOUR;
/** An event with no end counts as on for 6 hours after it starts (as the event list has it). */
export const SIX_HOURS = 6 * HOUR;
/** The longest a repeating event's dates are apart: its dates are never longer than this. */
export const LONGEST_GAP = 31 * DAY;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ORDINALS = ['First', 'Second', 'Third', 'Fourth'];

export const isRepeat = (value: unknown): value is Repeat => REPEATS.includes(value as Repeat);

/** A moment as El Salvador's wall clock reads it (read it with the getUTC… methods). */
const wall = (d: Date) => new Date(d.getTime() - SV_OFFSET);
/** The moment an El Salvador wall-clock reading (in UTC fields) is. */
const fromWall = (ms: number) => new Date(ms + SV_OFFSET);

/** Which of its weekday in its month a day is in El Salvador: 1 for the first Saturday, 5 for a fifth. */
export function weekOfMonth(date: Date): number {
    return Math.ceil(wall(date).getUTCDate() / 7);
}

/** Whether a day is in the last seven of its month in El Salvador: the last of its weekday there. */
export function inLastWeek(date: Date): boolean {
    const w = wall(date);
    const daysInMonth = new Date(Date.UTC(w.getUTCFullYear(), w.getUTCMonth() + 1, 0)).getUTCDate();
    return w.getUTCDate() > daysInMonth - 7;
}

/** How long each date lasts (null: no end time). */
const lengthOf = (s: Series): number | null => (s.endDate ? s.endDate.getTime() - s.startDate.getTime() : null);

/** Whether a date is over, by the event list's rule: past its end, or six hours after it starts when it has none. */
export function hasEnded(o: Occurrence, now: Date): boolean {
    return o.endDate ? o.endDate.getTime() < now.getTime() : o.startDate.getTime() < now.getTime() - SIX_HOURS;
}

/**
 * The start of a series' k-th date (0 is the first). A week or two weeks on
 * is the same wall-clock time (no daylight saving); a month on is the same
 * weekday of that month (its first to fourth, or its last) at the same time.
 */
function startOf(first: Date, repeat: Repeat, k: number): Date {
    if (repeat === 'WEEKLY') return new Date(first.getTime() + k * WEEK);
    if (repeat === 'BIWEEKLY') return new Date(first.getTime() + 2 * k * WEEK);
    const w = wall(first);
    const weekday = w.getUTCDay();
    const timeOfDay = w.getTime() - Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate());
    const year = w.getUTCFullYear();
    const month = w.getUTCMonth() + k; // Date.UTC carries months over into years
    let day: number;
    if (repeat === 'MONTHLY_NTH') {
        const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
        day = 1 + ((weekday - firstWeekday + 7) % 7) + (weekOfMonth(first) - 1) * 7;
    } else {
        const last = new Date(Date.UTC(year, month + 1, 0));
        day = last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7);
    }
    return fromWall(Date.UTC(year, month, day) + timeOfDay);
}

const occurrenceAt = (s: Series, repeat: Repeat, k: number, length: number | null): Occurrence => {
    const start = startOf(s.startDate, repeat, k);
    return { startDate: start, endDate: length === null ? null : new Date(start.getTime() + length) };
};

/** Months from one El Salvador month to another's. */
function monthsBetween(a: Date, b: Date): number {
    const x = wall(a);
    const y = wall(b);
    return (y.getUTCFullYear() - x.getUTCFullYear()) * 12 + (y.getUTCMonth() - x.getUTCMonth());
}

/**
 * A k no later than the first date still on at `at` (or the last date up to
 * it), so a series running for years isn't walked from its start.
 */
function lowerBound(s: Series, repeat: Repeat, at: Date, span: number): number {
    if (repeat === 'WEEKLY' || repeat === 'BIWEEKLY') {
        const gap = repeat === 'WEEKLY' ? WEEK : 2 * WEEK;
        return Math.max(0, Math.floor((at.getTime() - s.startDate.getTime() - span) / gap) - 1);
    }
    return Math.max(0, monthsBetween(s.startDate, at) - 2 - Math.ceil(span / (28 * DAY)));
}

/** At most this many steps from the bound: far more than any real series needs. */
const MAX_STEPS = 1000;

/**
 * Up to `count` dates of an event that haven't ended by `from`, soonest
 * first. A one-off event: itself, while it's on.
 */
export function occurrences(s: Series, from: Date, count: number): Occurrence[] {
    const first: Occurrence = { startDate: s.startDate, endDate: s.endDate ?? null };
    if (count < 1) return [];
    if (!isRepeat(s.repeat)) return hasEnded(first, from) ? [] : [first];
    const length = lengthOf(s);
    const out: Occurrence[] = [];
    const k0 = lowerBound(s, s.repeat, from, length ?? SIX_HOURS);
    for (let k = k0; out.length < count && k < k0 + MAX_STEPS; k++) {
        const o = occurrenceAt(s, s.repeat, k, length);
        if (s.repeatUntil && o.startDate.getTime() > s.repeatUntil.getTime()) break;
        if (!hasEnded(o, from)) out.push(o);
    }
    return out;
}

/** An event's next date: the first that hasn't ended by `now`; null once it's all over. */
export function nextOccurrence(s: Series, now: Date): Occurrence | null {
    return occurrences(s, now, 1)[0] ?? null;
}

/** A series' last date (null when it goes on for good); a one-off event's own. */
export function lastOccurrence(s: Series): Occurrence | null {
    if (!isRepeat(s.repeat)) return { startDate: s.startDate, endDate: s.endDate ?? null };
    if (!s.repeatUntil) return null;
    const length = lengthOf(s);
    const until = s.repeatUntil.getTime();
    let last: Occurrence | null = null;
    const k0 = lowerBound(s, s.repeat, s.repeatUntil, 0);
    for (let k = k0; k < k0 + MAX_STEPS; k++) {
        const o = occurrenceAt(s, s.repeat, k, length);
        if (o.startDate.getTime() > until) break;
        last = o;
    }
    return last ?? { startDate: s.startDate, endDate: s.endDate ?? null };
}

/** The date an event shows: its next one, or its last once it's all over. */
export function shownOccurrence(s: Series, now: Date): Occurrence {
    return nextOccurrence(s, now) ?? lastOccurrence(s) ?? { startDate: s.startDate, endDate: s.endDate ?? null };
}

/** The end of a day in El Salvador (23:59:59.999), from "2026-12-19" or any moment that day. */
export function endOfDay(value: string | Date): Date | null {
    let day: Date;
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
        day = new Date(`${value}T00:00:00Z`);
        // "2026-02-31" isn't a day (Date would make it 3 March).
        if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== value) return null;
    } else {
        const w = wall(new Date(value));
        if (Number.isNaN(w.getTime())) return null;
        day = new Date(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate()));
    }
    return fromWall(day.getTime() + DAY - 1);
}

/** The most a date may last, so it ends before the next one starts. */
const MAX_LENGTH: Record<Repeat, number> = { WEEKLY: WEEK, BIWEEKLY: 2 * WEEK, MONTHLY_NTH: 28 * DAY, MONTHLY_LAST: 28 * DAY };

/**
 * Why a repeat doesn't work for an event, if it doesn't: the last Saturday
 * only from a day in its month's last week, the first to fourth only (a
 * fifth Saturday isn't in every month), the last day on or after the first,
 * and each date over before the next one.
 */
export function repeatProblem(s: Series): string | null {
    if (!s.repeat) return null;
    if (!isRepeat(s.repeat)) return 'repeat_invalid';
    if (s.repeat === 'MONTHLY_LAST' && !inLastWeek(s.startDate)) return 'repeat_not_last_week';
    if (s.repeat === 'MONTHLY_NTH' && weekOfMonth(s.startDate) > 4) return 'repeat_fifth_week';
    if (s.repeatUntil && s.repeatUntil.getTime() < s.startDate.getTime()) return 'repeat_until_before_start';
    const length = lengthOf(s);
    if (length !== null && length >= MAX_LENGTH[s.repeat]) return 'repeat_too_long';
    return null;
}

/** "Every Saturday", "Every other Saturday", "First Saturday of every month", "Last Saturday of every month" ('' for a one-off). */
export function repeatLabel(repeat: string | null | undefined, first: Date): string {
    if (!isRepeat(repeat)) return '';
    const day = WEEKDAYS[wall(first).getUTCDay()];
    if (repeat === 'WEEKLY') return `Every ${day}`;
    if (repeat === 'BIWEEKLY') return `Every other ${day}`;
    if (repeat === 'MONTHLY_NTH') return `${ORDINALS[weekOfMonth(first) - 1] ?? 'Last'} ${day} of every month`;
    return `Last ${day} of every month`;
}
