import { findObjectionable } from './contentFilter.js';

// What members write on the Feed: posts and replies (kind 1).
const SCREENED_KINDS = new Set([1]);

export const REFUSED = 'blocked: objectionable content';

/**
 * Whether the relay takes a client's message. A post or reply whose text
 * holds words the community rules don't allow (contentFilter.js, the
 * server's list) is refused: the answer to send back instead of forwarding
 * it, a NIP-01 ["OK", <id>, false, <reason>]. Null for anything else, which
 * goes on to the relay as before.
 *
 * @param {unknown} msg - the client's message, parsed
 * @returns {[string, string, boolean, string] | null}
 */
export function refusal(msg) {
    if (!Array.isArray(msg) || msg[0] !== 'EVENT') return null;
    const event = msg[1];
    if (!event || typeof event !== 'object' || !SCREENED_KINDS.has(event.kind)) return null;
    if (typeof event.content !== 'string' || !findObjectionable(event.content)) return null;
    return ['OK', typeof event.id === 'string' ? event.id : '', false, REFUSED];
}
