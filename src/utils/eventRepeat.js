import { EVENT_TIME_ZONE, dayTile } from './eventFormat.js';

/**
 * Events that repeat, in the app: which repeats a first date can have (as
 * Google Calendar offers them: every week, every other week, the same
 * weekday of every month) and how a repeating event reads. The server works
 * out its dates, with the same rules (server/src/utils/eventRepeat.ts). All
 * in El Salvador time (UTC-6, no daylight saving): 11 PM on a Saturday
 * there is a Saturday, whatever the device says.
 */

export const REPEATS = ['WEEKLY', 'BIWEEKLY', 'MONTHLY_NTH', 'MONTHLY_LAST'];

const SV_OFFSET = 6 * 3600_000;
/** A moment as El Salvador's wall clock reads it (read it with the getUTC… methods). */
const wall = (date) => new Date(new Date(date).getTime() - SV_OFFSET);
const valid = (date) => !!date && !Number.isNaN(new Date(date).getTime());
const localeOf = (lang) => (String(lang || 'en').startsWith('es') ? 'es-SV' : 'en-US');
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

/** Which of its weekday in its month a day is in El Salvador: 1 for the first Saturday, 5 for a fifth. */
export function weekOfMonth(date) {
    return Math.ceil(wall(date).getUTCDate() / 7);
}

/** Whether a day is in the last seven of its month in El Salvador: the last of its weekday there. */
export function inLastWeek(date) {
    const w = wall(date);
    const daysInMonth = new Date(Date.UTC(w.getUTCFullYear(), w.getUTCMonth() + 1, 0)).getUTCDate();
    return w.getUTCDate() > daysInMonth - 7;
}

/**
 * The repeats a first date can have: none, every week, every other week,
 * its weekday of every month (the first to fourth: not every month has a
 * fifth), and the last of it when the date is in its month's last week.
 * With no date yet, only none.
 */
export function repeatChoices(date) {
    if (!valid(date)) return [''];
    return [
        '', 'WEEKLY', 'BIWEEKLY',
        ...(weekOfMonth(date) <= 4 ? ['MONTHLY_NTH'] : []),
        ...(inLastWeek(date) ? ['MONTHLY_LAST'] : []),
    ];
}

/**
 * A repeat for a first date that changed: as it was while it fits, else the
 * nearest that does (the last Saturday becomes the second, a fifth becomes
 * the last). Kept as it is while there's no date.
 */
export function fitRepeat(repeat, date) {
    if (!repeat || !valid(date)) return repeat || '';
    const choices = repeatChoices(date);
    if (choices.includes(repeat)) return repeat;
    if (repeat === 'MONTHLY_LAST' && choices.includes('MONTHLY_NTH')) return 'MONTHLY_NTH';
    if (repeat === 'MONTHLY_NTH' && choices.includes('MONTHLY_LAST')) return 'MONTHLY_LAST';
    return '';
}

/** "Saturday" (English) or "sábado" (Spanish), in El Salvador. */
export function weekdayName(date, lang) {
    return new Intl.DateTimeFormat(localeOf(lang), { timeZone: EVENT_TIME_ZONE, weekday: 'long' }).format(new Date(date));
}

const words = (date, t, lang) => ({ day: weekdayName(date, lang), nth: t(`events.repeat.nth.${weekOfMonth(date)}`) });

/** A choice in the form: "Doesn't repeat", "Every week on Saturday", "Every month on the first Saturday"… */
export function repeatChoiceLabel(repeat, date, t, lang) {
    if (!repeat || !valid(date)) return t('events.repeat.none');
    return cap(t(`events.repeat.choices.${repeat}`, words(date, t, lang)));
}

/**
 * How a repeating event reads where it shows: "Every Saturday", "Every
 * other Saturday", "First Saturday of every month", "Last Saturday of every
 * month". '' for a one-off. Any of its dates gives the same words.
 */
export function repeatLabel(repeat, date, t, lang) {
    if (!REPEATS.includes(repeat) || !valid(date)) return '';
    return cap(t(`events.repeat.short.${repeat}`, words(date, t, lang)));
}

/** A date chip: "Sat 7 Nov", or without the weekday "21 Nov". */
export function dateChip(date, lang, { weekday = true } = {}) {
    const { month, day, weekday: wd } = dayTile(date, lang);
    return weekday ? `${wd} ${day} ${month}` : `${day} ${month}`;
}
