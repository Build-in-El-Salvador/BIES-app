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
 * The hex form of a stored index pubkey, or null. Tier-2 login used to store
 * keytr's byte array, which JSON turns into {"0":171,"1":205,…}; those 32
 * bytes are the real pubkey, so convert them instead of dropping the entry.
 */
export function repairPubkey(value) {
    if (isHexPubkey(value)) return value;
    if (!value || typeof value !== 'object') return null;
    const bytes = Object.keys(value)
        .sort((a, b) => Number(a) - Number(b))
        .map(k => value[k]);
    if (bytes.length !== 32 || !bytes.every(n => Number.isInteger(n) && n >= 0 && n < 256)) return null;
    return bytes.map(n => n.toString(16).padStart(2, '0')).join('');
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
