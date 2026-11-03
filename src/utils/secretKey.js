import { nip19 } from 'nostr-tools';

/**
 * The secret key in a typed or pasted nsec, or an error that says so in
 * fixed words. The decoder's own errors repeat what was typed ("Invalid
 * checksum in nsec1…"), and an nsec with one typo is still the key: it would
 * show under the sign-in field, in the console, or in a screenshot sent to
 * ask for help.
 */
export function decodeNsec(text) {
    let decoded = null;
    try { decoded = nip19.decode(String(text ?? '').trim()); } catch { decoded = null; }
    if (decoded?.type !== 'nsec') {
        throw new Error("That isn't a valid secret key. Check it starts with nsec1 and has no missing or extra characters.");
    }
    return decoded.data;
}
