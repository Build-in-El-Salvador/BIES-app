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
