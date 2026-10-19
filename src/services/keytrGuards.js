/**
 * Pure keytr (NIP-K1) helpers with no browser or app dependencies, so the
 * Node test runner can exercise them (see keytrGuards.test.js). Used by
 * keytrService.
 */

import { getPublicKey } from 'nostr-tools';
import {
    decodeNsec,
    parseKeytrEvent,
    buildKeytrDeletionEvent,
} from '@sovit.xyz/keytr';

/** A 64-char lowercase hex pubkey (keytr's nsecToPublicKey returns bytes). */
export function isHexPubkey(value) {
    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Throw unless the passkey-recovered nsec belongs to `expectedPubkey`.
 * Re-acquiring a key for an existing session must never load a different
 * account's key under that session (e.g. a shared browser whose index holds
 * several pubkeys). No-op when `expectedPubkey` is not given.
 */
export function assertNsecMatches(nsec, expectedPubkey) {
    if (!expectedPubkey) return;
    const bytes = decodeNsec(nsec);
    let pubkey;
    try { pubkey = getPublicKey(bytes); } finally { bytes.fill(0); }
    if (pubkey !== expectedPubkey) {
        const err = new Error('This passkey belongs to a different account.');
        err.pubkeyMismatch = true;
        throw err;
    }
}

/**
 * NIP-09 kind:5 templates retracting every kind:31777 event of `pubkey` in
 * `events` (one per credential `d` tag, every gateway). Events by any other
 * author and unparseable events are skipped.
 */
export function buildDeletionTemplates(events, pubkey) {
    const templates = [];
    for (const ev of events) {
        if (ev.pubkey !== pubkey) continue;
        try {
            const { credentialIdBase64url } = parseKeytrEvent(ev);
            templates.push(buildKeytrDeletionEvent({
                pubkey,
                dTag: credentialIdBase64url,
                eventId: ev.id,
                reason: 'passkey removed',
            }));
        } catch {
            // Skip unparseable events
        }
    }
    return templates;
}
