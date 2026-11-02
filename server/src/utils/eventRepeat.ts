/**
 * Events that repeat, as calendars do it: the Bitcoin Farmers Market every
 * other Saturday, a meetup on the first Thursday of every month. An event's
 * startDate and endDate are its first date; every later date keeps the same
 * time of day and length, until repeatUntil (the last day it may be on, to
 * the end of that day) or for good. The weekday and month are El Salvador's
 * (UTC-6 all year, no daylight saving): an event at 11 PM on a Saturday
 * there is a Sunday in UTC, and still repeats on Saturdays.
 *
 * One date can be different (another time, another field) or called off:
 * a date change, kept by the date's key, its start as the rule makes it.
 * Answers ("going") are kept by that key too. A date shows, and ends, at
 * its own times; a called-off date is never the next one.
 *
 * The app has the same rules for its form and labels (src/utils/eventRepeat.js).
 */

export const REPEATS = ['WEEKLY', 'BIWEEKLY', 'MONTHLY_NTH', 'MONTHLY_LAST'] as const;
export type Repeat = typeof REPEATS[number];

/** What one date of a repeating event has of its own (null: as usual), by its key. */
export type DateChange = {
    occurrenceStart: Date;
    startDate?: Date | null;
    endDate?: Date | null;
    title?: string | null;
    description?: string | null;
    locationName?: string | null;
    locationAddress?: string | null;
    locationMapUrl?: string | null;
    isOnline?: boolean | null;
    onlineUrl?: string | null;
    calledOffAt?: Date | null;
};

/** What a date can have of its own, besides its time. */
export const DATE_FIELDS = ['title', 'description', 'locationName', 'locationAddress', 'locationMapUrl', 'isOnline', 'onlineUrl'] as const;
export type DateField = typeof DATE_FIELDS[number];

/** An event, as far as its dates go. */
export type Series = {
    startDate: Date;
    endDate?: Date | null;
    repeat?: string | null;
    repeatUntil?: Date | null;
    dateChanges?: DateChange[] | null;
};
/**
 * One date of an event: its key (its start as the rule makes it: which date
 * it is), when it starts and ends as it is (no end: on for six hours), what
 * it has of its own, and whether it's called off.
 */
export type Occurrence = { key: Date; startDate: Date; endDate: Date | null; change: DateChange | null; calledOff: boolean };

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
/** El Salvador's clock, behind UTC. */
const SV_OFFSET = 6 * HOUR;
/** An event with no end counts as on for 6 hours after it starts (as the event list has it). */
export const SIX_HOURS = 6 * HOUR;
/**
 * Longer than a repeating event's dates are ever apart (a month's first
 * Saturday to the next month's can be five weeks: 35 days), with a day to
 * spare, and longer than any one date lasts.
 */
export const LONGEST_GAP = 36 * DAY;
/**
 * How long after its last day a series may still be on: its last date may be
 * moved to just before the one after it would be, and last up to a month.
 */
export const SERIES_REACH = 2 * LONGEST_GAP;

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
export function hasEnded(o: { startDate: Date; endDate: Date | null }, now: Date): boolean {
    return o.endDate ? o.endDate.getTime() < now.getTime() : o.startDate.getTime() < now.getTime() - SIX_HOURS;
}

/** Whether a date change has anything of its own (more than being called off). */
export function hasOverrides(c: DateChange | null | undefined): boolean {
    return !!c && (c.startDate != null || c.endDate != null || DATE_FIELDS.some((f) => c[f] != null));
}

/**
 * The start of a series' k-th date by its rule (0 is the first; -1 the one
 * before it would be). A week or two weeks on is the same wall-clock time
 * (no daylight saving); a month on is the same weekday of that month (its
 * first to fourth, or its last) at the same time.
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

/** A series' date changes by key. */
const changesOf = (s: Series) => new Map((s.dateChanges || []).map((c) => [c.occurrenceStart.getTime(), c]));

/** The k-th date as it is: at its own times when it has them (an end of its own, or its own start and the usual length). */
function occurrenceAt(s: Series, repeat: Repeat, k: number, length: number | null, changes: Map<number, DateChange>): Occurrence {
    const key = startOf(s.startDate, repeat, k);
    const change = changes.get(key.getTime()) ?? null;
    const start = change?.startDate ?? key;
    const end = change?.endDate ?? (length === null ? null : new Date(start.getTime() + length));
    return { key, startDate: start, endDate: end, change, calledOff: !!change?.calledOffAt };
}

/** A one-off event as its only date. */
const onlyDate = (s: Series): Occurrence => ({ key: s.startDate, startDate: s.startDate, endDate: s.endDate ?? null, change: null, calledOff: false });

/** Months from one El Salvador month to another's. */
function monthsBetween(a: Date, b: Date): number {
    const x = wall(a);
    const y = wall(b);
    return (y.getUTCFullYear() - x.getUTCFullYear()) * 12 + (y.getUTCMonth() - x.getUTCMonth());
}

/**
 * A k no later than the first date still on at `at` (or the last date up to
 * it), so a series running for years isn't walked from its start. Two steps
 * back: a changed date may be moved up to the next one's key.
 */
function lowerBound(s: Series, repeat: Repeat, at: Date, span: number): number {
    if (repeat === 'WEEKLY' || repeat === 'BIWEEKLY') {
        const gap = repeat === 'WEEKLY' ? WEEK : 2 * WEEK;
        return Math.max(0, Math.floor((at.getTime() - s.startDate.getTime() - span) / gap) - 2);
    }
    return Math.max(0, monthsBetween(s.startDate, at) - 3 - Math.ceil(span / (28 * DAY)));
}

/** At most this many steps from the bound: far more than any real series needs. */
const MAX_STEPS = 1000;

/**
 * Up to `count` dates of an event that haven't ended by `from` (at their own
 * times), soonest first. Called-off dates are left out, unless `calledOff`.
 * A one-off event: itself, while it's on.
 */
export function occurrences(s: Series, from: Date, count: number, { calledOff = false } = {}): Occurrence[] {
    if (count < 1) return [];
    if (!isRepeat(s.repeat)) return hasEnded(onlyDate(s), from) ? [] : [onlyDate(s)];
    const length = lengthOf(s);
    const changes = changesOf(s);
    const out: Occurrence[] = [];
    const k0 = lowerBound(s, s.repeat, from, length ?? SIX_HOURS);
    for (let k = k0; out.length < count && k < k0 + MAX_STEPS; k++) {
        const o = occurrenceAt(s, s.repeat, k, length, changes);
        if (s.repeatUntil && o.key.getTime() > s.repeatUntil.getTime()) break;
        if (!hasEnded(o, from) && (calledOff || !o.calledOff)) out.push(o);
    }
    return out;
}

/** An event's next date: the first that hasn't ended by `now` and isn't called off; null once it's all over. */
export function nextOccurrence(s: Series, now: Date): Occurrence | null {
    return occurrences(s, now, 1)[0] ?? null;
}

/**
 * A series' last date (null when it goes on for good): its last one that
 * wasn't called off, or its very last if they all were. A one-off event's own.
 */
export function lastOccurrence(s: Series): Occurrence | null {
    if (!isRepeat(s.repeat)) return onlyDate(s);
    if (!s.repeatUntil) return null;
    const length = lengthOf(s);
    const changes = changesOf(s);
    const until = s.repeatUntil.getTime();
    let last: Occurrence | null = null;
    let lastOn: Occurrence | null = null;
    const k0 = lowerBound(s, s.repeat, s.repeatUntil, 0);
    for (let k = k0; k < k0 + MAX_STEPS; k++) {
        const o = occurrenceAt(s, s.repeat, k, length, changes);
        if (o.key.getTime() > until) break;
        last = o;
        if (!o.calledOff) lastOn = o;
    }
    // Its last dates all called off: back to the last one that wasn't.
    for (let k = k0 - 1; !lastOn && last && k >= 0 && k > k0 - MAX_STEPS; k--) {
        const o = occurrenceAt(s, s.repeat, k, length, changes);
        if (!o.calledOff) lastOn = o;
    }
    return lastOn ?? last ?? onlyDate(s);
}

/** The date an event shows: its next one, or its last once it's all over. */
export function shownOccurrence(s: Series, now: Date): Occurrence {
    return nextOccurrence(s, now) ?? lastOccurrence(s) ?? onlyDate(s);
}

/** Where a key falls in a series: its k, or null when the rule makes no date there. */
function indexOf(s: Series, repeat: Repeat, key: Date): number | null {
    const k0 = lowerBound(s, repeat, key, 0);
    for (let k = k0; k < k0 + MAX_STEPS; k++) {
        const start = startOf(s.startDate, repeat, k).getTime();
        if (start === key.getTime()) return k;
        if (start > key.getTime()) return null;
    }
    return null;
}

/** The date of a series with this key, as it is (with its change); null when it has none there. */
export function occurrenceFor(s: Series, key: Date): Occurrence | null {
    if (!isRepeat(s.repeat)) return key.getTime() === s.startDate.getTime() ? onlyDate(s) : null;
    if (s.repeatUntil && key.getTime() > s.repeatUntil.getTime()) return null;
    const k = indexOf(s, s.repeat, key);
    return k === null ? null : occurrenceAt(s, s.repeat, k, lengthOf(s), changesOf(s));
}

/** Which of a series' dates a key is (0 for the first), or null when it isn't one of them. */
export function dateIndex(s: Series, key: Date): number | null {
    if (!isRepeat(s.repeat) || (s.repeatUntil && key.getTime() > s.repeatUntil.getTime())) return null;
    return indexOf(s, s.repeat, key);
}

/** The key of a series' k-th date (0 for the first), or null when there's none: before its first, or after its last day. */
export function keyAt(s: Series, k: number): Date | null {
    if (!isRepeat(s.repeat) || k < 0) return null;
    const key = startOf(s.startDate, s.repeat, k);
    return s.repeatUntil && key.getTime() > s.repeatUntil.getTime() ? null : key;
}

/**
 * How far ahead one date can be changed or called off: a year. Further on,
 * it's for the event as a whole (and a date there isn't loaded with it).
 */
export const DATES_AHEAD = 366 * DAY;

/** The most a date may last, so it ends before the next one starts. */
const MAX_LENGTH: Record<Repeat, number> = { WEEKLY: WEEK, BIWEEKLY: 2 * WEEK, MONTHLY_NTH: 28 * DAY, MONTHLY_LAST: 28 * DAY };

/**
 * Why one date's own times don't work, if they don't: it must be a date of
 * the series, start after the date before it and before the date after it,
 * as those are (moved, if they were; as the rule makes them, where there's
 * none), so the dates keep their order, start after the one before has
 * ended, and end after it starts and before the next one starts.
 */
export function dateChangeProblem(s: Series, key: Date, start: Date, end: Date | null): string | null {
    if (!isRepeat(s.repeat)) return 'date_not_found';
    const k = s.repeatUntil && key.getTime() > s.repeatUntil.getTime() ? null : indexOf(s, s.repeat, key);
    if (k === null) return 'date_not_found';
    const length = lengthOf(s);
    const changes = changesOf(s);
    const prev = k > 0 ? occurrenceAt(s, s.repeat, k - 1, length, changes) : null;
    const nextKey = startOf(s.startDate, s.repeat, k + 1);
    const next = s.repeatUntil && nextKey.getTime() > s.repeatUntil.getTime() ? null : occurrenceAt(s, s.repeat, k + 1, length, changes);
    const before = (prev?.startDate ?? startOf(s.startDate, s.repeat, k - 1)).getTime();
    const after = (next?.startDate ?? nextKey).getTime();
    if (start.getTime() <= before || start.getTime() >= after) return 'date_out_of_order';
    if (end && end.getTime() <= start.getTime()) return 'date_end_before_start';
    if (end && end.getTime() - start.getTime() >= MAX_LENGTH[s.repeat]) return 'repeat_too_long';
    if ((end && end.getTime() >= after) || (prev?.endDate && prev.endDate.getTime() >= start.getTime())) return 'date_overlaps';
    return null;
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
