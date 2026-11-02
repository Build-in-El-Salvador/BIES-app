import { EVENT_TIME_ZONE, dayKey, dayTile, timeOf } from './eventFormat.js';

/**
 * Events that repeat, in the app: which repeats a first date can have (as
 * Google Calendar offers them: every week, every other week, the same
 * weekday of every month) and how a repeating event reads. The server works
 * out its dates, with the same rules (server/src/utils/eventRepeat.ts). All
 * in El Salvador time (UTC-6, no daylight saving): 11 PM on a Saturday
 * there is a Saturday, whatever the device says.
 *
 * One date can be different or called off. A date is named by its usual
 * day (its key, "Sat 7 Nov") and shown at its own times; editing one asks
 * whether the change is for it only or for it and every date after.
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

/** A time without its ":00": "10 AM", "4:30 PM" ("10 a. m." in Spanish). */
export function shortTime(date, lang) {
    return timeOf(date, lang).replace(/:00(?=\D|$)/, '');
}

const lowerFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : '');

/** What a date's notice says of its time and place: "10:00 AM at Beach field", "Sun 8 Nov, 10:00 AM", "online". */
function timeAndPlace(view, key, { time, place }, t, lang) {
    const when = !time ? ''
        : dayKey(view.startDate) === dayKey(key) ? timeOf(view.startDate, lang) : `${dateChip(view.startDate, lang)}, ${timeOf(view.startDate, lang)}`;
    const where = !place ? ''
        : view.isOnline ? t('events.dates.online') : view.locationName ? t('events.dates.atPlace', { place: view.locationName }) : '';
    return [when, where].filter(Boolean).join(' ');
}

/**
 * The notice on a repeating event's page when its next date is different
 * (the API's dateChange): "Sat 7 Nov is different: 10:00 AM at Beach
 * field." and "Usually 4:00 PM at Usual field.", saying only the time and
 * place that differ. Another title or other words: "Sat 7 Nov is different
 * from usual." with no second line.
 */
export function dateChangeNotice(change, t, lang) {
    if (!change) return null;
    const date = dateChip(change.key, lang);
    const what = timeAndPlace(change.date, change.key, change, t, lang);
    if (!what) return { lead: t('events.dates.differentOther', { date }), usual: '' };
    return {
        lead: t('events.dates.different', { date, what }),
        usual: t('events.dates.usually', { what: timeAndPlace(change.usual, change.key, change, t, lang) }),
    };
}

/** The question an edit of a repeating event asks: "BIES Soccer repeats every Saturday". */
export function scopeTitle(title, repeat, date, t, lang) {
    return t('events.dates.scopeTitle', { title, rule: lowerFirst(repeatLabel(repeat, date, t, lang)) });
}

/** The form's fields one date can have its own of (its time, title, words and place). */
export const DATE_FORM_FIELDS = [
    'title', 'description', 'startDate', 'startTime', 'endDate', 'endTime',
    'online', 'locationName', 'locationAddress', 'locationMapUrl', 'onlineUrl',
];
/** How it repeats: always the event's, for every date. */
export const RULE_FORM_FIELDS = ['repeat', 'repeatUntil'];

/**
 * Whether saving an edit of a repeating event at one of its dates asks
 * "only this date, or this and every date after?": when what changed is
 * that date's (its time, title, words or place). A change to how it repeats
 * is for every date; so is one only to what's the event's anyway (its
 * photo, tickets, co-hosts…), and so is no change at all.
 */
export function editScope(before, after) {
    const changed = (f) => (before?.[f] ?? '') !== (after?.[f] ?? '');
    if (RULE_FORM_FIELDS.some(changed)) return 'series';
    return DATE_FORM_FIELDS.some(changed) ? 'ask' : 'series';
}
