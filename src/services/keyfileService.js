/**
 * keyfileService — NIP-49 encrypted .nostrkey file management.
 *
 * Handles:
 *  - Encrypting nsec → ncryptsec (NIP-49)
 *  - Decrypting ncryptsec → nsec
 *  - Building .nostrkey JSON payload
 *  - Triggering browser file download
 *  - Parsing uploaded .nostrkey files
 *
 * Uses nostr-tools v2 nip49 module (scrypt + XChaCha20-Poly1305).
 * All operations are client-side only — no secrets leave the browser.
 */

import { encrypt as nip49Encrypt, decrypt as nip49Decrypt } from 'nostr-tools/nip49';
import { nip19, getPublicKey } from 'nostr-tools';

const APP_CLIENT = 'BIES v1.0';

export const keyfileService = {
    /**
     * Encrypt a secret key and build a .nostrkey JSON payload.
     * @param {Uint8Array} secretKeyBytes - 32-byte secret key
     * @param {string} password - user-chosen encryption password
     * @param {number} [logn=16] - scrypt cost parameter (16, 18, or 20)
     * @param {0|1|2} [ksb=2] - NIP-49 key security byte: 0 = the key has been
     *   handled insecurely (e.g. a server held it), 1 = it hasn't, 2 = unknown
     * @returns {object} { json: string, filename: string, npub: string }
     */
    buildKeyfile(secretKeyBytes, password, logn = 16, ksb = 0x02) {
        const ncryptsec = nip49Encrypt(secretKeyBytes, password, logn, ksb);
        const pubkeyHex = getPublicKey(secretKeyBytes);
        const npub = nip19.npubEncode(pubkeyHex);

        const payload = {
            format: 'nostrkey',
            version: 1,
            npub,
            ncryptsec,
            created_at: new Date().toISOString(),
            client: APP_CLIENT,
        };

        const json = JSON.stringify(payload, null, 2);
        const filename = `nostr-${npub.slice(5, 13)}.nostrkey`;

        return { json, filename, npub };
    },

    /**
     * Trigger a browser download of the .nostrkey file.
     * @param {string} jsonString - the JSON content
     * @param {string} filename - download filename
     */
    triggerDownload(jsonString, filename) {
        const blob = new Blob([jsonString], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    },

    /**
     * Parse a .nostrkey file or raw ncryptsec string.
     * @param {string} text - file contents or raw ncryptsec string
     * @returns {{ ncryptsec: string, npub?: string, filename?: string } | null}
     */
    parseKeyfile(text) {
        const trimmed = text.trim();

        // Try JSON parse first
        try {
            const payload = JSON.parse(trimmed);
            if (payload.format === 'nostrkey' && payload.ncryptsec?.startsWith('ncryptsec1')) {
                if (payload.version && payload.version !== 1) {
                    throw new Error('This key file was created with a newer version. Please update your app.');
                }
                return {
                    ncryptsec: payload.ncryptsec,
                    npub: payload.npub || null,
                };
            }
        } catch (e) {
            // If it was a version error, re-throw
            if (e.message.includes('newer version')) throw e;
        }

        // Fallback: raw ncryptsec string
        if (trimmed.startsWith('ncryptsec1')) {
            return { ncryptsec: trimmed, npub: null };
        }

        // Legacy: try to extract nsec from old plaintext key files
        const nsecMatch = trimmed.match(/nsec1[a-z0-9]+/);
        if (nsecMatch) {
            return { legacyNsec: nsecMatch[0] };
        }

        return null;
    },

    /**
     * Decrypt an ncryptsec string with a password.
     * @param {string} ncryptsec - NIP-49 encrypted key
     * @param {string} password - user password
     * @param {string|null} expectedNpub - npub to verify against (optional)
     * @returns {{ secretKeyBytes: Uint8Array, nsec: string, npub: string }}
     */
    decrypt(ncryptsec, password, expectedNpub = null) {
        let secretKeyBytes;
        try {
            secretKeyBytes = nip49Decrypt(ncryptsec, password);
        } catch {
            throw new Error('Wrong password or corrupted file. Please try again.');
        }

        const nsec = nip19.nsecEncode(secretKeyBytes);
        const pubkeyHex = getPublicKey(secretKeyBytes);
        const npub = nip19.npubEncode(pubkeyHex);

        if (expectedNpub && npub !== expectedNpub) {
            secretKeyBytes.fill(0);
            throw new Error('Decryption succeeded but key does not match expected identity. File may be corrupted.');
        }

        return { secretKeyBytes, nsec, npub };
    },

    /**
     * Encrypt an nsec string with a password and trigger download.
     * Convenience method combining buildKeyfile + triggerDownload.
     * @param {string} nsecString - bech32 nsec
     * @param {string} password - user password
     * @param {number} [logn=16] - scrypt cost parameter
     * @returns {{ npub: string, filename: string }}
     */
    encryptAndDownload(nsecString, password, logn = 16) {
        const decoded = nip19.decode(nsecString.trim());
        if (decoded.type !== 'nsec') throw new Error('Invalid nsec key.');
        const sk = decoded.data;

        const { json, filename, npub } = this.buildKeyfile(sk, password, logn);
        this.triggerDownload(json, filename);

        return { npub, filename };
    },
};
