import { describe, expect, it } from 'vitest';
import {
    dateChangeProblem, endOfDay, hasEnded, hasOverrides, inLastWeek, lastOccurrence, nextOccurrence, occurrenceFor, occurrences,
    repeatLabel, repeatProblem, shownOccurrence, weekOfMonth,
} from '../eventRepeat';

/** A moment in El Salvador time (UTC-6): sv('2026-11-07 09:00'). */
const sv = (text: string) => new Date(`${text.replace(' ', 'T')}:00-06:00`);
/** The El Salvador day and time of a moment: '2026-11-07 09:00'. */
const local = (d: Date) => new Date(d.getTime() - 6 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
const starts = (list: { startDate: Date }[]) => list.map((o) => local(o.startDate));

// The Bitcoin Farmers Market: Saturdays, 9 AM to 1 PM, from 7 November 2026.
const market = { startDate: sv('2026-11-07 09:00'), endDate: sv('2026-11-07 13:00') };

describe('eventRepeat', () => {
    it('a weekly event is on the same weekday and time every week', () => {
        const s = { ...market, repeat: 'WEEKLY' };
        expect(starts(occurrences(s, sv('2026-11-01 00:00'), 4))).toEqual(['2026-11-07 09:00', '2026-11-14 09:00', '2026-11-21 09:00', '2026-11-28 09:00']);
        // Each date lasts as long as the first.
        const [, second] = occurrences(s, sv('2026-11-01 00:00'), 2);
        expect(local(second.endDate!)).toBe('2026-11-14 13:00');
    });

    it('every other week skips a week', () => {
        const s = { ...market, repeat: 'BIWEEKLY' };
        expect(starts(occurrences(s, sv('2026-11-01 00:00'), 4))).toEqual(['2026-11-07 09:00', '2026-11-21 09:00', '2026-12-05 09:00', '2026-12-19 09:00']);
        expect(local(nextOccurrence(s, sv('2026-11-08 10:00'))!.startDate)).toBe('2026-11-21 09:00');
    });

    it('the next date is the first that has not ended: one going on now still counts', () => {
        const s = { ...market, repeat: 'BIWEEKLY' };
        expect(local(nextOccurrence(s, sv('2026-11-07 12:59'))!.startDate)).toBe('2026-11-07 09:00');
        expect(local(nextOccurrence(s, sv('2026-11-07 13:00'))!.startDate)).toBe('2026-11-07 09:00');
        expect(local(nextOccurrence(s, sv('2026-11-07 13:01'))!.startDate)).toBe('2026-11-21 09:00');
    });

    it('with no end time a date is on for six hours, as in the event list', () => {
        const s = { startDate: sv('2026-11-07 09:00'), endDate: null, repeat: 'WEEKLY' };
        expect(local(nextOccurrence(s, sv('2026-11-07 14:59'))!.startDate)).toBe('2026-11-07 09:00');
        expect(local(nextOccurrence(s, sv('2026-11-07 15:01'))!.startDate)).toBe('2026-11-14 09:00');
        expect(nextOccurrence(s, sv('2026-11-07 15:01'))!.endDate).toBeNull();
        expect(hasEnded({ startDate: sv('2026-11-07 09:00'), endDate: null }, sv('2026-11-07 15:00'))).toBe(false);
    });

    it('the first, second… Saturday of every month', () => {
        const first = { ...market, repeat: 'MONTHLY_NTH' };
        expect(starts(occurrences(first, sv('2026-11-01 00:00'), 4))).toEqual(['2026-11-07 09:00', '2026-12-05 09:00', '2027-01-02 09:00', '2027-02-06 09:00']);
        // The second Saturday: 14 November 2026.
        const second = { startDate: sv('2026-11-14 09:00'), endDate: null, repeat: 'MONTHLY_NTH' };
        expect(starts(occurrences(second, sv('2026-11-01 00:00'), 3))).toEqual(['2026-11-14 09:00', '2026-12-12 09:00', '2027-01-09 09:00']);
    });

    it('the fourth weekday falls as late as the 28th', () => {
        // The fourth Thursday of November 2026 is the 26th.
        const s = { startDate: sv('2026-11-26 18:00'), endDate: sv('2026-11-26 21:00'), repeat: 'MONTHLY_NTH' };
        expect(weekOfMonth(s.startDate)).toBe(4);
        expect(starts(occurrences(s, sv('2026-11-01 00:00'), 4))).toEqual(['2026-11-26 18:00', '2026-12-24 18:00', '2027-01-28 18:00', '2027-02-25 18:00']);
    });

    it('the last weekday of every month, in 31, 30, 28 and 29-day months', () => {
        // Last Saturday from 31 October 2026 (a 31-day month): 28 Nov (30 days), 26 Dec, 30 Jan, 27 Feb (28 days).
        const sat = { startDate: sv('2026-10-31 10:00'), endDate: null, repeat: 'MONTHLY_LAST' };
        expect(starts(occurrences(sat, sv('2026-10-01 00:00'), 5))).toEqual([
            '2026-10-31 10:00', '2026-11-28 10:00', '2026-12-26 10:00', '2027-01-30 10:00', '2027-02-27 10:00',
        ]);
        // Last Monday from 30 November 2026: the month's very last day.
        const mon = { startDate: sv('2026-11-30 19:00'), endDate: null, repeat: 'MONTHLY_LAST' };
        expect(starts(occurrences(mon, sv('2026-11-01 00:00'), 4))).toEqual(['2026-11-30 19:00', '2026-12-28 19:00', '2027-01-25 19:00', '2027-02-22 19:00']);
        // 2028 is a leap year: the last Tuesday of February is the 29th.
        const tue = { startDate: sv('2028-01-25 19:00'), endDate: null, repeat: 'MONTHLY_LAST' };
        expect(starts(occurrences(tue, sv('2028-01-01 00:00'), 4))).toEqual(['2028-01-25 19:00', '2028-02-29 19:00', '2028-03-28 19:00', '2028-04-25 19:00']);
        // And the last Thursday of a 31-day month can be the 31st.
        const thu = { startDate: sv('2026-12-31 18:00'), endDate: null, repeat: 'MONTHLY_LAST' };
        expect(starts(occurrences(thu, sv('2026-12-01 00:00'), 2))).toEqual(['2026-12-31 18:00', '2027-01-28 18:00']);
    });

    it('stops after the last day, which counts to its end', () => {
        const s = { ...market, repeat: 'WEEKLY', repeatUntil: endOfDay('2026-11-21') };
        expect(starts(occurrences(s, sv('2026-11-01 00:00'), 10))).toEqual(['2026-11-07 09:00', '2026-11-14 09:00', '2026-11-21 09:00']);
        expect(local(lastOccurrence(s)!.startDate)).toBe('2026-11-21 09:00');
        expect(local(nextOccurrence(s, sv('2026-11-21 12:00'))!.startDate)).toBe('2026-11-21 09:00');
        expect(nextOccurrence(s, sv('2026-11-21 13:01'))).toBeNull();
        // Over: it shows its last date.
        expect(local(shownOccurrence(s, sv('2026-12-01 00:00')).startDate)).toBe('2026-11-21 09:00');
        // A day earlier: the 14th is its last.
        expect(local(lastOccurrence({ ...s, repeatUntil: endOfDay('2026-11-20') })!.startDate)).toBe('2026-11-14 09:00');
        // With no last day it never ends.
        expect(lastOccurrence({ ...market, repeat: 'WEEKLY' })).toBeNull();
    });

    it('works in El Salvador time: 11 PM on a Saturday there is Sunday in UTC', () => {
        const late = sv('2026-11-07 23:00');
        expect(late.toISOString()).toBe('2026-11-08T05:00:00.000Z');
        expect(weekOfMonth(late)).toBe(1);
        expect(repeatLabel('WEEKLY', late)).toBe('Every Saturday');
        const weekly = { startDate: late, endDate: sv('2026-11-08 01:00'), repeat: 'WEEKLY' };
        expect(starts(occurrences(weekly, sv('2026-11-01 00:00'), 2))).toEqual(['2026-11-07 23:00', '2026-11-14 23:00']);
        // The first Saturday of December is the 5th, not the first Sunday (the 6th).
        const monthly = { startDate: late, endDate: null, repeat: 'MONTHLY_NTH' };
        expect(starts(occurrences(monthly, sv('2026-11-01 00:00'), 3))).toEqual(['2026-11-07 23:00', '2026-12-05 23:00', '2027-01-02 23:00']);
        // 31 October at 11 PM is 1 November in UTC, and still the last Saturday of October.
        const lastSat = sv('2026-10-31 23:00');
        expect(inLastWeek(lastSat)).toBe(true);
        expect(weekOfMonth(lastSat)).toBe(5);
        expect(starts(occurrences({ startDate: lastSat, endDate: null, repeat: 'MONTHLY_LAST' }, sv('2026-10-01 00:00'), 3)))
            .toEqual(['2026-10-31 23:00', '2026-11-28 23:00', '2026-12-26 23:00']);
        // Just after midnight there: early on 1 November is the first Sunday, not the last Saturday of October.
        const early = sv('2026-11-01 00:30');
        expect(early.toISOString()).toBe('2026-11-01T06:30:00.000Z');
        expect(inLastWeek(early)).toBe(false);
        expect(repeatLabel('MONTHLY_NTH', early)).toBe('First Sunday of every month');
    });

    it('a series running for years finds its next date without walking from the start', () => {
        const s = { ...market, repeat: 'BIWEEKLY' };
        const next = nextOccurrence(s, sv('2031-03-10 12:00'))!;
        expect(next.startDate.getTime()).toBeGreaterThan(sv('2031-03-10 12:00').getTime());
        expect(next.startDate.getTime() - sv('2031-03-10 12:00').getTime()).toBeLessThan(14 * 86400_000);
        expect(new Date(next.startDate.getTime() - 6 * 3600_000).getUTCDay()).toBe(6); // a Saturday
        expect((next.startDate.getTime() - market.startDate.getTime()) % (14 * 86400_000)).toBe(0);
        const monthly = nextOccurrence({ ...market, repeat: 'MONTHLY_NTH' }, sv('2031-03-10 12:00'))!;
        expect(local(monthly.startDate)).toBe('2031-04-05 09:00'); // March's first Saturday (the 1st) is over
    });

    it('a one-off event is its own only date, while it is on', () => {
        const only = { key: market.startDate, ...market, change: null, calledOff: false };
        expect(occurrences(market, sv('2026-11-07 12:00'), 4)).toEqual([only]);
        expect(nextOccurrence(market, sv('2026-11-07 13:01'))).toBeNull();
        expect(lastOccurrence(market)).toEqual(only);
        expect(shownOccurrence(market, sv('2027-01-01 00:00'))).toEqual(only);
        expect(occurrenceFor(market, market.startDate)).toEqual(only);
        expect(occurrenceFor(market, sv('2026-11-14 09:00'))).toBeNull();
        expect(occurrences({ ...market, repeat: 'WEEKLY' }, sv('2026-11-01 00:00'), 0)).toEqual([]);
    });

    it('the last day of a series is the end of that day in El Salvador', () => {
        expect(endOfDay('2026-12-19')!.toISOString()).toBe('2026-12-20T05:59:59.999Z');
        expect(endOfDay('2026-12-19T06:00:00.000Z')!.toISOString()).toBe('2026-12-20T05:59:59.999Z');
        expect(endOfDay(sv('2026-12-19 23:30'))!.toISOString()).toBe('2026-12-20T05:59:59.999Z');
        expect(endOfDay('2026-02-31')).toBeNull();
        expect(endOfDay('soon')).toBeNull();
    });

    it('says when a repeat does not fit its first date', () => {
        const at = (start: Date, repeat: string, extra = {}) => repeatProblem({ startDate: start, endDate: null, repeat, ...extra });
        expect(at(market.startDate, '')).toBeNull();
        expect(at(market.startDate, 'DAILY')).toBe('repeat_invalid');
        expect(at(market.startDate, 'WEEKLY')).toBeNull();
        expect(at(market.startDate, 'MONTHLY_NTH')).toBeNull();
        // The last Saturday only from the month's last seven days.
        expect(at(market.startDate, 'MONTHLY_LAST')).toBe('repeat_not_last_week');
        expect(at(sv('2026-11-28 09:00'), 'MONTHLY_LAST')).toBeNull();
        // 31 October 2026 is October's fifth Saturday: not every month has one.
        expect(at(sv('2026-10-31 09:00'), 'MONTHLY_NTH')).toBe('repeat_fifth_week');
        expect(at(sv('2026-10-31 09:00'), 'MONTHLY_LAST')).toBeNull();
        // The last day can be the first day, not before it.
        expect(at(market.startDate, 'WEEKLY', { repeatUntil: endOfDay('2026-11-07') })).toBeNull();
        expect(at(market.startDate, 'WEEKLY', { repeatUntil: endOfDay('2026-11-06') })).toBe('repeat_until_before_start');
        // Each date ends before the next one starts.
        expect(at(market.startDate, 'WEEKLY', { endDate: sv('2026-11-14 09:00') })).toBe('repeat_too_long');
        expect(at(market.startDate, 'BIWEEKLY', { endDate: sv('2026-11-14 09:00') })).toBeNull();
    });

    it('labels a repeat in words', () => {
        expect(repeatLabel('WEEKLY', market.startDate)).toBe('Every Saturday');
        expect(repeatLabel('BIWEEKLY', market.startDate)).toBe('Every other Saturday');
        expect(repeatLabel('MONTHLY_NTH', market.startDate)).toBe('First Saturday of every month');
        expect(repeatLabel('MONTHLY_NTH', sv('2026-11-26 18:00'))).toBe('Fourth Thursday of every month');
        expect(repeatLabel('MONTHLY_LAST', sv('2026-11-28 09:00'))).toBe('Last Saturday of every month');
        expect(repeatLabel('', market.startDate)).toBe('');
    });
});

describe('one date different, or called off', () => {
    const weekly = { ...market, repeat: 'WEEKLY' };
    /** The market with changes on some of its dates (by key). */
    const withChanges = (...dateChanges: object[]) => ({ ...weekly, dateChanges: dateChanges as any });
    const keys = (list: { key: Date }[]) => list.map((o) => local(o.key));

    it('a changed date shows at its own times and keeps its key', () => {
        // 14 November: 11 AM to 3 PM instead of 9 to 1.
        const s = withChanges({ occurrenceStart: sv('2026-11-14 09:00'), startDate: sv('2026-11-14 11:00'), endDate: sv('2026-11-14 15:00') });
        const list = occurrences(s, sv('2026-11-08 00:00'), 3);
        expect(keys(list)).toEqual(['2026-11-14 09:00', '2026-11-21 09:00', '2026-11-28 09:00']);
        expect(starts(list)).toEqual(['2026-11-14 11:00', '2026-11-21 09:00', '2026-11-28 09:00']);
        expect(local(list[0].endDate!)).toBe('2026-11-14 15:00');
        expect(list[0].change).not.toBeNull();
        expect(list[1].change).toBeNull();
    });

    it('a changed date ends at its own end: still the next date after the usual end', () => {
        const s = withChanges({ occurrenceStart: sv('2026-11-14 09:00'), startDate: sv('2026-11-14 11:00'), endDate: sv('2026-11-14 15:00') });
        // At 2 PM the usual 9-to-1 would be over; this one isn't.
        expect(local(nextOccurrence(s, sv('2026-11-14 14:00'))!.key)).toBe('2026-11-14 09:00');
        expect(local(nextOccurrence(s, sv('2026-11-14 15:01'))!.key)).toBe('2026-11-21 09:00');
        // Earlier instead: 7 AM to 8 AM, over by 8:30 though the usual would still be on.
        const early = withChanges({ occurrenceStart: sv('2026-11-14 09:00'), startDate: sv('2026-11-14 07:00'), endDate: sv('2026-11-14 08:00') });
        expect(local(nextOccurrence(early, sv('2026-11-14 08:30'))!.key)).toBe('2026-11-21 09:00');
    });

    it('a new start alone keeps the usual length', () => {
        const s = withChanges({ occurrenceStart: sv('2026-11-14 09:00'), startDate: sv('2026-11-14 16:00') });
        const date = occurrenceFor(s, sv('2026-11-14 09:00'))!;
        expect([local(date.startDate), local(date.endDate!)]).toEqual(['2026-11-14 16:00', '2026-11-14 20:00']);
        // A new end alone: from the usual start.
        const later = withChanges({ occurrenceStart: sv('2026-11-14 09:00'), endDate: sv('2026-11-14 17:00') });
        const longer = occurrenceFor(later, sv('2026-11-14 09:00'))!;
        expect([local(longer.startDate), local(longer.endDate!)]).toEqual(['2026-11-14 09:00', '2026-11-14 17:00']);
    });

    it('a date moved to another day keeps its place in order', () => {
        // 14 November moved to Friday the 13th, 6 PM: still between the 7th and the 21st.
        const s = withChanges({ occurrenceStart: sv('2026-11-14 09:00'), startDate: sv('2026-11-13 18:00'), endDate: sv('2026-11-13 21:00') });
        expect(starts(occurrences(s, sv('2026-11-01 00:00'), 3))).toEqual(['2026-11-07 09:00', '2026-11-13 18:00', '2026-11-21 09:00']);
        // Over on the Friday night, before its usual Saturday.
        expect(local(nextOccurrence(s, sv('2026-11-13 22:00'))!.key)).toBe('2026-11-21 09:00');
    });

    it('a called-off date is never the next one, and shows until it passes when asked for', () => {
        const s = withChanges({ occurrenceStart: sv('2026-11-14 09:00'), calledOffAt: sv('2026-11-10 08:00') });
        expect(local(nextOccurrence(s, sv('2026-11-08 00:00'))!.key)).toBe('2026-11-21 09:00');
        expect(keys(occurrences(s, sv('2026-11-08 00:00'), 3))).toEqual(['2026-11-21 09:00', '2026-11-28 09:00', '2026-12-05 09:00']);
        const all = occurrences(s, sv('2026-11-08 00:00'), 3, { calledOff: true });
        expect(keys(all)).toEqual(['2026-11-14 09:00', '2026-11-21 09:00', '2026-11-28 09:00']);
        expect(all.map((o) => o.calledOff)).toEqual([true, false, false]);
        // Once its time has passed it's gone from the list too.
        expect(keys(occurrences(s, sv('2026-11-14 13:01'), 1, { calledOff: true }))).toEqual(['2026-11-21 09:00']);
        // A change that's only a call-off has nothing of its own.
        expect(hasOverrides(s.dateChanges[0])).toBe(false);
        expect(hasOverrides({ occurrenceStart: sv('2026-11-14 09:00'), locationName: 'Beach field' })).toBe(true);
    });

    it('a series whose last date is called off ends on the one before; all called off, on the last', () => {
        const until = endOfDay('2026-11-21');
        const s = { ...weekly, repeatUntil: until, dateChanges: [{ occurrenceStart: sv('2026-11-21 09:00'), calledOffAt: sv('2026-11-20 08:00') }] };
        expect(local(lastOccurrence(s)!.key)).toBe('2026-11-14 09:00');
        expect(nextOccurrence(s, sv('2026-11-14 13:01'))).toBeNull();
        expect(local(shownOccurrence(s, sv('2026-11-14 13:01')).key)).toBe('2026-11-14 09:00');
        const allOff = { ...s, dateChanges: ['2026-11-07 09:00', '2026-11-14 09:00', '2026-11-21 09:00'].map((d) => ({ occurrenceStart: sv(d), calledOffAt: sv(d) })) };
        expect(local(lastOccurrence(allOff)!.key)).toBe('2026-11-21 09:00');
        expect(nextOccurrence(allOff, sv('2026-11-01 00:00'))).toBeNull();
    });

    it('a change works across El Salvador midnight', () => {
        // Saturdays at 11 PM (Sunday in UTC); one moved to 10 PM.
        const late = { startDate: sv('2026-11-07 23:00'), endDate: sv('2026-11-08 01:00'), repeat: 'WEEKLY',
            dateChanges: [{ occurrenceStart: sv('2026-11-14 23:00'), startDate: sv('2026-11-14 22:00'), endDate: sv('2026-11-15 00:30') }] };
        const list = occurrences(late, sv('2026-11-08 02:00'), 2);
        expect(keys(list)).toEqual(['2026-11-14 23:00', '2026-11-21 23:00']);
        expect(starts(list)).toEqual(['2026-11-14 22:00', '2026-11-21 23:00']);
        expect(dateChangeProblem(late, sv('2026-11-14 23:00'), sv('2026-11-14 22:00'), sv('2026-11-15 00:30'))).toBeNull();
    });

    it('finds a date by its key, as it is', () => {
        const s = withChanges({ occurrenceStart: sv('2026-11-21 09:00'), title: 'Market: harvest special' });
        expect(occurrenceFor(s, sv('2026-11-21 09:00'))!.change!.title).toBe('Market: harvest special');
        expect(local(occurrenceFor(s, sv('2026-11-28 09:00'))!.startDate)).toBe('2026-11-28 09:00');
        // Not a date of it: another time, or after its last day.
        expect(occurrenceFor(s, sv('2026-11-21 10:00'))).toBeNull();
        expect(occurrenceFor({ ...s, repeatUntil: endOfDay('2026-11-14') }, sv('2026-11-21 09:00'))).toBeNull();
        // Monthly: the first Saturday of December, the 5th.
        const monthly = { ...market, repeat: 'MONTHLY_NTH' };
        expect(occurrenceFor(monthly, sv('2026-12-05 09:00'))).not.toBeNull();
        expect(occurrenceFor(monthly, sv('2026-12-12 09:00'))).toBeNull();
    });

    it('a date moves only between the dates either side of it', () => {
        const key = sv('2026-11-14 09:00');
        expect(dateChangeProblem(weekly, key, sv('2026-11-14 11:00'), sv('2026-11-14 15:00'))).toBeNull();
        expect(dateChangeProblem(weekly, key, sv('2026-11-08 10:00'), null)).toBeNull();
        expect(dateChangeProblem(weekly, key, sv('2026-11-07 09:00'), null)).toBe('date_out_of_order');
        expect(dateChangeProblem(weekly, key, sv('2026-11-21 09:00'), null)).toBe('date_out_of_order');
        expect(dateChangeProblem(weekly, key, sv('2026-11-14 11:00'), sv('2026-11-14 10:00'))).toBe('date_end_before_start');
        expect(dateChangeProblem(weekly, key, sv('2026-11-14 11:00'), sv('2026-11-21 11:00'))).toBe('repeat_too_long');
        expect(dateChangeProblem(weekly, sv('2026-11-14 10:00'), sv('2026-11-14 11:00'), null)).toBe('date_not_found');
        expect(dateChangeProblem(market, market.startDate, market.startDate, null)).toBe('date_not_found');
        // The first date may move earlier, up to where the one before it would be.
        expect(dateChangeProblem(weekly, market.startDate, sv('2026-11-02 09:00'), null)).toBeNull();
    });
});
