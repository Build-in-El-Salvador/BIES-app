/**
 * Relay whitelist service — manages the flat-file pubkey whitelist the
 * strfry write-policy plugin reads to authorize publishers on the private
 * BIES relay (shared with the relay container via a docker volume).
 *
 * The same volume carries purge requests: a file per pubkey whose events the
 * relay must delete (relay/purge-loop.sh).
 */

import fs from 'fs';
import path from 'path';

export const HEX_PUBKEY_RE = /^[0-9a-f]{64}$/;

export const WHITELIST_PATH = process.env.RELAY_WHITELIST_PATH || '/app/relay-whitelist/whitelist.txt';

export const PURGE_DIR = path.join(path.dirname(WHITELIST_PATH), 'purge');

/**
 * Add a pubkey to the Nostr relay whitelist file.
 * The strfry write-policy plugin reads this file to authorize publishers.
 */
export function addToRelayWhitelist(pubkey: string): void {
    try {
        // Validate pubkey format to prevent injection into whitelist file
        if (!HEX_PUBKEY_RE.test(pubkey)) {
            console.error('[Relay] Invalid pubkey format, refusing to whitelist');
            return;
        }

        const dir = path.dirname(WHITELIST_PATH);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // Read existing whitelist
        let existing = '';
        if (fs.existsSync(WHITELIST_PATH)) {
            existing = fs.readFileSync(WHITELIST_PATH, 'utf8');
        }

        // Only add if not already present
        if (!existing.split('\n').includes(pubkey)) {
            fs.appendFileSync(WHITELIST_PATH, pubkey + '\n');
            console.log(`[Relay] Added ${pubkey.substring(0, 8)}... to whitelist`);
        }
    } catch (err) {
        console.error('[Relay] Failed to update whitelist:', err);
    }
}

/**
 * Remove a pubkey from the Nostr relay whitelist file.
 * Called when a user is banned to revoke relay access.
 */
export function removeFromRelayWhitelist(pubkey: string): void {
    try {
        if (!fs.existsSync(WHITELIST_PATH)) return;

        const existing = fs.readFileSync(WHITELIST_PATH, 'utf8');
        const lines = existing.split('\n').filter((line) => line !== pubkey && line.trim() !== '');
        fs.writeFileSync(WHITELIST_PATH, lines.join('\n') + (lines.length ? '\n' : ''));
        console.log(`[Relay] Removed ${pubkey.substring(0, 8)}... from whitelist`);
    } catch (err) {
        console.error('[Relay] Failed to remove from whitelist:', err);
    }
}

/**
 * Ask the relay to delete everything this pubkey published, and the gift
 * wraps addressed to it (what NIP-62 asks of a relay), when its account is
 * deleted. The relay container picks the request up within seconds. Remove
 * the pubkey from the whitelist first, so nobody can store its events again.
 * Returns false if the request couldn't be written.
 */
export function requestRelayPurge(pubkey: string): boolean {
    if (!HEX_PUBKEY_RE.test(pubkey)) return false;
    try {
        fs.mkdirSync(PURGE_DIR, { recursive: true });
        // Written under a dot-name, then renamed: the relay never sees half a file.
        const tmp = path.join(PURGE_DIR, `.${pubkey}.tmp`);
        fs.writeFileSync(tmp, `${new Date().toISOString()}\n`);
        fs.renameSync(tmp, path.join(PURGE_DIR, pubkey));
        console.log(`[Relay] Purge requested for ${pubkey.substring(0, 8)}...`);
        return true;
    } catch (err) {
        console.error('[Relay] Failed to request purge:', err);
        return false;
    }
}
