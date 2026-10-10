/**
 * "Take your key" and "Delete account" helpers: reading back a key the
 * member saved, the backup file, and the signed confirmations the server
 * checks (server/src/services/account.service.ts).
 *
 * No network and no storage, so they can be tested on their own.
 */

import { nip19, getPublicKey, finalizeEvent } from 'nostr-tools';
import { keyfileService } from './keyfileService.js';

/** The kind of a confirmation; its challenge and purpose go in tags. */
export const CONFIRMATION_KIND = 27235;

export function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    return bytes;
}

/**
 * What the member pasted or opened, read as a key:
 * - `{ secretKey }` for an nsec, a 64-character hex key, or an old
 *   plain-text key file;
 * - `{ encrypted, npub }` for a password-protected backup (a .nostrkey file
 *   or an ncryptsec), which needs unlockBackup();
 * - null if it isn't a key.
 */
export function readKeyInput(text) {
    const value = String(text ?? '').trim();
    if (!value) return null;

    if (value.startsWith('{') || value.startsWith('ncryptsec1')) {
        let parsed = null;
        try {
            parsed = keyfileService.parseKeyfile(value);
        } catch {
            return null;
        }
        if (parsed?.ncryptsec) return { encrypted: parsed.ncryptsec, npub: parsed.npub ?? null };
        if (parsed?.legacyNsec) return readKeyInput(parsed.legacyNsec);
        return null;
    }
    if (value.startsWith('nsec1')) {
        try {
            const decoded = nip19.decode(value);
            return decoded.type === 'nsec' ? { secretKey: decoded.data } : null;
        } catch {
            return null;
        }
    }
    if (/^[0-9a-f]{64}$/i.test(value)) return { secretKey: hexToBytes(value.toLowerCase()) };
    return null;
}

/** The key inside a password-protected backup. Throws on a wrong password. */
export function unlockBackup(encrypted, password) {
    return keyfileService.decrypt(encrypted, password).secretKeyBytes;
}

/** Whether a secret key is the one for this hex pubkey. */
export function keyMatches(secretKey, pubkey) {
    try {
        return getPublicKey(secretKey) === pubkey;
    } catch {
        return false;
    }
}

/** A confirmation for the server to check, unsigned (for a signer app). */
export function confirmationTemplate(purpose, challenge, content) {
    return {
        kind: CONFIRMATION_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['challenge', challenge], ['purpose', purpose]],
        content,
    };
}

/** The same, signed with a key held here. */
export function signConfirmation(secretKey, purpose, challenge, content) {
    return finalizeEvent(confirmationTemplate(purpose, challenge, content), secretKey);
}

/**
 * A password-protected backup (.nostrkey, NIP-49) of a key BIES held. NIP-49
 * asks for keys a server has seen to be flagged as handled insecurely.
 */
export function buildBackup(secretKey, password) {
    return keyfileService.buildKeyfile(secretKey, password, 16, 0x00);
}
