/**
 * Answering "I'm going" on an event's page (pages/EventDetail.jsx): whether
 * the date it shows is over, and what to say when the answer didn't save.
 */

/** With no end given, an event is taken to be over six hours after it starts. */
export const OVER_AFTER_MS = 6 * 3600_000;

/**
 * Whether the date an event shows is over: its end has passed, or six hours
 * after its start when it has no end. A repeating event shows its next date
 * while it has one, so that is over only once the whole series is.
 * @param {{ startDate?: string, endDate?: string|null }} event
 * @param {number} [now] ms
 */
export function isOver(event, now = Date.now()) {
    const end = event?.endDate
        ? new Date(event.endDate).getTime()
        : new Date(event?.startDate).getTime() + OVER_AFTER_MS;
    return Number.isFinite(end) && end < now;
}

/**
 * Why "I'm going" didn't save: the server's words when it said why (full,
 * invite only…), else `fallback` (offline, no answer, the server's fault).
 * @param {Error & { status?: number, data?: { error?: string } }} err the API client's error
 * @param {string} fallback
 */
export function rsvpErrorText(err, fallback) {
    const said = err?.data?.error;
    const fromServer = typeof err?.status === 'number' && err.status >= 400 && err.status < 500;
    return fromServer && typeof said === 'string' && said.trim() ? said.trim() : fallback;
}
