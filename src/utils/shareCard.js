/**
 * The picture a shared event's link shows in WhatsApp and the like. The
 * server draws it (server/src/services/shareCard.service.ts); the event form
 * shows the same (components/events/ShareCardPreview.jsx), so its host can
 * position the cover for it.
 *
 * - A BIES event: its cover as it is, square (the team's poster).
 * - Any other event, or a proposed meetup: a wide card, smaller in a chat.
 *   Its words sit on the dark left; the cover fills the right two thirds.
 *
 * Pure module (no browser globals) so it runs under `node --test`.
 */

/** The cover's outline when positioning it for the card (width / height). */
export const SHARE_ASPECT = {
    square: 1,
    // The wide card is 1200 × 630, the cover its right 792px.
    wide: 792 / 630,
};

/** The wide card's dark left, over the cover's side as positioning shows it. */
export const SHARE_SHADE = 'linear-gradient(90deg, rgba(11, 14, 24, 1) 0%, rgba(11, 14, 24, 0.62) 18.2%, rgba(11, 14, 24, 0.14) 48.5%, rgba(11, 14, 24, 0) 69.7%)';

/** Which card an event gets. */
export const shareFormat = (official) => (official ? 'square' : 'wide');

/** When it starts, in El Salvador, as the card says it: "Saturday, November 7 · 8 AM". */
export function cardDate(date) {
    if (!date) return '';
    const d = new Date(date);
    if (Number.isNaN(d.getTime())) return '';
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/El_Salvador', weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }).formatToParts(d).map((p) => [p.type, p.value]));
    const time = parts.minute === '00' ? `${parts.hour} ${parts.dayPeriod}` : `${parts.hour}:${parts.minute} ${parts.dayPeriod}`;
    return `${parts.weekday}, ${parts.month} ${parts.day} · ${time}`;
}

// Every letter the card's serif (DM Serif Display, the name and the place)
// has: the server draws nothing else (shareCard.service.ts drawable).
// server/src/__tests__/shareCard.api.test.ts checks it against the font.
export const SERIF_LETTERS = '\\u0020-\\u007E\\u00A0-\\u0107\\u010C-\\u0113\\u0116-\\u011B\\u011E-\\u011F\\u0122-\\u0123\\u012A-\\u012B\\u012E-\\u0131\\u0136-\\u0137\\u0139-\\u0148\\u014C-\\u014D\\u0150-\\u015B\\u015E-\\u0165\\u016A-\\u016B\\u016E-\\u0173\\u0178-\\u017E\\u0218-\\u021B\\u02C6-\\u02C7\\u02D8-\\u02DD\\u0300-\\u0304\\u0306-\\u0308\\u030A-\\u030C\\u0326-\\u0328\\u2013-\\u2014\\u2018-\\u201A\\u201C-\\u201E\\u2020-\\u2022\\u2026\\u2030\\u2039-\\u203A\\u2044\\u2074\\u20AC\\u20BD\\u2122\\u212E\\u2212\\u2215\\u2219\\u2248\\u2260\\u2264-\\u2265';
const NOT_SERIF = new RegExp(`[^${SERIF_LETTERS}]`, 'gu');

/**
 * A name or place as the card draws it: emoji, and any letter its font
 * hasn't got, left out (the server would draw a crossed box), spaces
 * collapsed. "🎉 Party 🇸🇻 time" is "Party time".
 */
export function cardText(text) {
    return String(text || '').normalize('NFC').replace(/\s+/g, ' ').replace(NOT_SERIF, '').replace(/ {2,}/g, ' ').trim();
}
