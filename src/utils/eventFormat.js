/**
 * Events in words: when (always in El Salvador time, where BIES events
 * happen, so a member abroad sees the time on the ticket), where tickets
 * are sold, and who's behind one. The form saves in El Salvador time too.
 */

export const EVENT_TIME_ZONE = 'America/El_Salvador';
// El Salvador keeps UTC-6 all year (no daylight saving).
const SV_OFFSET = '-06:00';

const localeOf = (lang) => (String(lang || 'en').startsWith('es') ? 'es-SV' : 'en-US');

function parts(date, lang, options) {
    return Object.fromEntries(new Intl.DateTimeFormat(localeOf(lang), { timeZone: EVENT_TIME_ZONE, ...options })
        .formatToParts(new Date(date)).map((p) => [p.type, p.value]));
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1).replace(/\.$/, '') : '');

/** The calendar tile: { month: 'Nov', day: '14', weekday: 'Sat' }. */
export function dayTile(date, lang) {
    const p = parts(date, lang, { weekday: 'short', day: 'numeric', month: 'short' });
    return { month: cap(p.month), day: p.day, weekday: cap(p.weekday) };
}

/** "7:00 PM" (English) or "7:00 p. m." (Spanish). */
export function timeOf(date, lang) {
    return new Intl.DateTimeFormat(localeOf(lang), { timeZone: EVENT_TIME_ZONE, hour: 'numeric', minute: '2-digit' }).format(new Date(date));
}

/** "Sat 14 Nov · 7:00 PM". */
export function whenShort(date, lang) {
    const { month, day, weekday } = dayTile(date, lang);
    return `${weekday} ${day} ${month} · ${timeOf(date, lang)}`;
}

/** "Saturday 14 November". */
export function fullDay(date, lang) {
    const p = parts(date, lang, { weekday: 'long', day: 'numeric', month: 'long' });
    return `${cap(p.weekday)} ${p.day} ${cap(p.month)}`;
}

/** "7:00 – 11:00 PM", "7:00 PM", or across days "Sat 14 Nov, 7:00 PM – Sun 15 Nov, 2:00 AM". */
export function timeRange(start, end, lang) {
    if (!end) return timeOf(start, lang);
    const sameDay = dayKey(start) === dayKey(end);
    if (!sameDay) return `${whenShort(start, lang).replace(' · ', ', ')} – ${whenShort(end, lang).replace(' · ', ', ')}`;
    return `${timeOf(start, lang)} – ${timeOf(end, lang)}`;
}

/** "2026-11-14": the day in El Salvador. */
export function dayKey(date) {
    const p = parts(date, 'en', { year: 'numeric', month: '2-digit', day: '2-digit' });
    return `${p.year}-${p.month}-${p.day}`;
}

/** "2026-11": the month in El Salvador, for grouping by month. */
export const monthKey = (date) => dayKey(date).slice(0, 7);

/** A month's heading: "November", or "November 2027" when not this year. */
export function monthHeading(date, lang, now = new Date()) {
    const p = parts(date, lang, { month: 'long', year: 'numeric' });
    const thisYear = parts(now, lang, { year: 'numeric' }).year;
    return p.year === thisYear ? cap(p.month) : `${cap(p.month)} ${p.year}`;
}

/** The form's date and time fields for a moment: { date: '2026-11-14', time: '19:00' }, in El Salvador time. */
export function toFormFields(date) {
    if (!date) return { date: '', time: '' };
    const p = parts(date, 'en', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** The moment the form's fields mean, as ISO (El Salvador time); null when the date is missing. */
export function fromFormFields(date, time) {
    if (!date) return null;
    const d = new Date(`${date}T${time || '00:00'}:00${SV_OFFSET}`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const PROVIDERS = [
    [/(^|\.)lu\.ma$|(^|\.)luma\.com$/, 'Luma'],
    [/(^|\.)pretix\.(eu|com)$|^pretix\./, 'pretix'],
    [/(^|\.)eventbrite\.[a-z.]+$/, 'Eventbrite'],
    [/(^|\.)meetup\.com$/, 'Meetup'],
];

/** Where tickets are sold, by the link: "Luma", "pretix", "Eventbrite", "Meetup", or the site's address. */
export function ticketProvider(url) {
    let host = '';
    try { host = new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
    const known = PROVIDERS.find(([re]) => re.test(host));
    return known ? known[1] : host;
}

/** An event's host as the app shows it: its business, or the member who created it. */
export function hostOf(event) {
    if (event.hostListing) {
        const l = event.hostListing;
        return { kind: 'listing', name: l.name, image: l.logo || l.photo || '', path: `${l.type === 'FARM' ? '/farms' : '/trusted'}/${l.id}`, isOfficial: !!l.isOfficial };
    }
    const h = event.host || {};
    return { kind: 'member', name: h.profile?.name || '', image: h.profile?.avatar || '', path: `/builder/${h.nostrPubkey || h.id}` };
}

/** Where a co-host or sponsor's page is in the app ('' for someone not on BIES). */
export function partnerPath(p) {
    if (p.kind === 'member') return `/builder/${p.nostrPubkey || p.userId}`;
    if (p.kind === 'listing') return `${p.listingType === 'FARM' ? '/farms' : '/trusted'}/${p.listingId}`;
    return '';
}

/** Whether an event is free to go to, as its host put it. */
export const isFree = (event) => /^(free|gratis)$/i.test((event.priceLabel || '').trim()) || (!event.priceLabel && !event.ticketUrl && !event.bitcoinUrl);
