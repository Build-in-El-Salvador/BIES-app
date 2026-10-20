/**
 * keytrService — adapter for @sovit.xyz/keytr passkey-encrypted nsec.
 *
 * Replaces the custom passkeyService with keytr's NIP-K1 implementation:
 *   PRF → HKDF-SHA256 → AES-256-GCM → kind:31777 event → relay
 *
 * As of keytr 0.8.0 PRF is the only registration mode (the encryption key is
 * derived by the authenticator and never exposed to JS). Legacy KiH (v=3)
 * credentials remain decrypt-only so existing users can log in and migrate —
 * see migrateToPrf() and PasskeyMigratePrompt.
 *
 * Encrypted nsec lives on public Nostr relays (not localStorage).
 * A lightweight localStorage index tracks which pubkeys have credentials
 * so hasCredential() can answer synchronously.
 */

import {
    decodeNsec,
    encodeNsec,
    registerPasskey,
    encryptNsec,
    buildKeytrEvent,
    parseKeytrEvent,
    publishKeytrEvent,
    fetchKeytrEvents,
    loginWithKeytr,
    discover,
    migrateFromKih,
    checkPrfSupport,
    PrfNotSupportedError,
    KEYTR_VERSION,
    KEYTR_KIH_VERSION,
    KEYTR_GATEWAYS,
} from '@sovit.xyz/keytr';
import { NOSTR_RELAYS } from './nostrService.js';
import { orderGateways, discoverThroughGateways } from './gatewayOrder.js';
import { getPublicKey } from 'nostr-tools';
import { assertNsecMatches, buildDeletionTemplates, repairPubkey } from './keytrGuards.js';

// Override gateways: the serving domain first (WebAuthn requires the primary,
// registration rpId to equal the origin's domain — hardcoding one deployment's
// domain broke passkeys on every other deployment), then keytr.org and
// nostkey.org as backups. On localhost (dev/E2E) 'localhost' is the sole rpId —
// WebAuthn rejects cross-origin rpIds from a localhost origin, so passkeys
// would otherwise be untestable locally. See orderGateways() for the contract.
const BIES_GATEWAYS = orderGateways(
    typeof window !== 'undefined' ? window.location.hostname : undefined,
    KEYTR_GATEWAYS,
);

const STORAGE_KEY = 'bies_keytr_credentials';
const MIGRATED_KEY = 'bies_kih_migrated';

/**
 * Detect whether a keytr/WebAuthn error is a user-initiated cancellation
 * (e.g. dismissing the passkey picker or tapping "Cancel").
 *
 * keytr wraps the browser's NotAllowedError in a WebAuthnError whose `name`
 * is "WebAuthnError" (not "NotAllowedError") but whose message preserves the
 * "operation either timed out or was not allowed" text — so callers must
 * match on the message, not err.name. Exported for UI components.
 */
export function isUserCancellation(err) {
    if (!err) return false;
    const msg = (err.message || String(err)).toLowerCase();
    return msg.includes('notallowederror') || msg.includes('aborterror') ||
           msg.includes('the operation either timed out or was not allowed');
}

// ─── localStorage credential index ─────────────────────────────────────────

function getStored() {
    try {
        // Tier-2 login once stored the pubkey as a byte array (keytr's
        // nsecToPublicKey returns bytes, not hex): repair those entries, and
        // drop anything else that isn't a pubkey.
        const creds = JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
        if (!Array.isArray(creds)) return [];
        return creds
            .map(c => ({ ...c, pubkey: repairPubkey(c?.pubkey) }))
            .filter(c => c.pubkey);
    } catch {
        return [];
    }
}

function setStored(creds) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(creds));
}

// ─── Support detection cache ────────────────────────────────────────────────

let _webauthnAvailable = false;
let _prfSupport = { supported: false, platformAuthenticator: false, reason: 'not checked' };
let _checked = false;
let _checkPromise = null;

async function ensureChecked() {
    if (_checked) return;
    if (!_checkPromise) {
        _checkPromise = (async () => {
            _webauthnAvailable = typeof window !== 'undefined' && !!window.PublicKeyCredential;
            if (_webauthnAvailable) {
                // PRF gates *registration* only — login (incl. legacy KiH) needs
                // just WebAuthn. Note: without getClientCapabilities() this is
                // optimistic; PrfNotSupportedError at registration is authoritative.
                try {
                    _prfSupport = await checkPrfSupport();
                } catch {
                    _prfSupport = { supported: false, platformAuthenticator: false, reason: 'check failed' };
                }
            }
            _checked = true;
        })();
    }
    return _checkPromise;
}

// Kick off the check immediately on import (non-blocking).
ensureChecked();

// ─── KiH → PRF migration bookkeeping ────────────────────────────────────────

/**
 * dTags of KiH events already migrated, keyed by pubkey. Needed because a
 * kind:5 deletion can fail to publish (soft-fail in migrateFromKih): the stale
 * v=3 event would otherwise re-trigger the migration prompt forever, while its
 * credential has been signal-removed from the browser picker and can't be
 * re-migrated.
 */
function getMigratedDTags(pubkey) {
    try {
        const map = JSON.parse(localStorage.getItem(MIGRATED_KEY)) || {};
        return map[pubkey] || [];
    } catch {
        return [];
    }
}

function addMigratedDTag(pubkey, dTag) {
    let map;
    try {
        map = JSON.parse(localStorage.getItem(MIGRATED_KEY)) || {};
    } catch {
        map = {};
    }
    const list = map[pubkey] || [];
    if (!list.includes(dTag)) list.push(dTag);
    map[pubkey] = list;
    localStorage.setItem(MIGRATED_KEY, JSON.stringify(map));
}

/**
 * Extract legacy KiH credentials from a user's kind:31777 events.
 * Pure helper (exported for tests).
 *
 * @param {Array} events - kind:31777 events
 * @param {string[]} migratedDTags - dTags to exclude (already migrated)
 * @returns {Array<{rpId: string, dTag: string}>}
 */
export function extractKihInfo(events, migratedDTags = []) {
    const kih = [];
    for (const ev of events) {
        try {
            const parsed = parseKeytrEvent(ev);
            if (parsed.version === KEYTR_KIH_VERSION && !migratedDTags.includes(parsed.credentialIdBase64url)) {
                kih.push({ rpId: parsed.rpId, dTag: parsed.credentialIdBase64url });
            }
        } catch {
            // Skip unparseable events
        }
    }
    return kih;
}

/**
 * Set after a successful passkey login: { pubkey, kihCredentials, hasKih }.
 * Module state (not storage) by design — the migration prompt renders in the
 * same page session right after login; a reload clears it and the next
 * explicit passkey login re-detects.
 */
let _lastLoginInfo = null;

function setLastLoginInfo(pubkey, events) {
    const kihCredentials = extractKihInfo(events, getMigratedDTags(pubkey));
    _lastLoginInfo = { pubkey, kihCredentials, hasKih: kihCredentials.length > 0 };
}

// ─── Legacy migration ───────────────────────────────────────────────────────

(function migrateFromLegacy() {
    const old = localStorage.getItem('bies_passkey_credentials');
    if (old) {
        localStorage.removeItem('bies_passkey_credentials');
        localStorage.removeItem('bies_passkey_device_key');
    }
})();

// ─── Extension-interference detection ───────────────────────────────────────

/**
 * Detect whether a WebAuthn error was likely caused by a password manager
 * extension intercepting the credentials API without supporting Related
 * Origin Requests (cross-origin rpId like keytr.org / nostkey.org).
 */
export function isLikelyExtensionInterference(message) {
    if (typeof message !== 'string') return false;
    const lower = message.toLowerCase();
    return (
        lower.includes('relying party id') &&
        (lower.includes('registrable domain') || lower.includes('equal to the current domain'))
    );
}

/**
 * Detect keytr's PrfNotSupportedError (authenticator can't do PRF — e.g.
 * password-manager extensions, Firefox on Android, some older security keys).
 * Registration is impossible for these; login with existing credentials still works.
 */
export function isPrfUnsupportedError(err) {
    return err instanceof PrfNotSupportedError || err?.name === 'PrfNotSupportedError';
}

// ─── Public API ─────────────────────────────────────────────────────────────

export const keytrService = {
    /** Whether WebAuthn passkeys are available. */
    isSupported() {
        return _webauthnAvailable;
    },

    /** Await the async support check (for useEffect-based detection). */
    async checkSupport() {
        await ensureChecked();
        return _webauthnAvailable;
    },

    /**
     * PRF capability report ({ supported, platformAuthenticator, reason }).
     * Gates *registration* UI only — login must stay WebAuthn-gated so legacy
     * KiH credentials keep working on non-PRF browsers.
     */
    async checkPrfSupport() {
        await ensureChecked();
        return _prfSupport;
    },

    /** Whether a keytr credential exists for the given pubkey (or any). */
    hasCredential(pubkey) {
        const creds = getStored();
        if (pubkey) return creds.some(c => c.pubkey === pubkey);
        return creds.length > 0;
    },

    /** Get stored credential metadata. */
    getCredentials() {
        return getStored();
    },

    /**
     * Register on the primary gateway (the serving domain) only — one
     * biometric prompt. Use addBackupGateway() afterwards to add the public
     * keytr gateways (keytr.org, nostkey.org) as fallbacks.
     *
     * @param {string} nsec - bech32-encoded nsec
     * @param {string} pubkey - hex-encoded public key
     */
    async saveWithPasskey(nsec, pubkey) {
        return this._registerOnGateway(nsec, pubkey, BIES_GATEWAYS[0]);
    },

    /**
     * Register on all backup gateways (keytr.org, nostkey.org) — one biometric prompt each.
     * Call after saveWithPasskey() to add redundancy.
     *
     * @returns {Promise<Array<{ gateway: string }>>}
     */
    async addBackupGateway(nsec, pubkey) {
        const backups = BIES_GATEWAYS.slice(1);
        if (backups.length === 0) throw new Error('No backup gateway configured.');
        const results = [];
        for (const gw of backups) {
            await this._registerOnGateway(nsec, pubkey, gw);
            results.push({ gateway: gw });
        }
        return results;
    },

    /**
     * @private Register a passkey + publish kind:31777 for a single gateway.
     */
    async _registerOnGateway(nsec, pubkey, rpId) {
        const nsecBytes = decodeNsec(nsec);
        const { nostrSigner } = await import('./nostrSigner.js');

        const { credential, keyMaterial } = await registerPasskey({
            rpId,
            rpName: rpId.split('.')[0],
            userName: pubkey.slice(0, 16),
            userDisplayName: 'BIES Account',
            pubkey, // required in keytr 0.8.0 — stored as user.id for discoverable login
        });

        let encryptedBlob;
        try {
            encryptedBlob = encryptNsec({
                nsecBytes,
                keyMaterial,
                credentialId: credential.credentialId,
                version: KEYTR_VERSION,
            });
        } finally {
            keyMaterial.fill(0);
        }

        const eventTemplate = buildKeytrEvent({
            credential,
            encryptedBlob,
            clientName: 'bies',
            version: KEYTR_VERSION,
        });

        const signedEvent = await nostrSigner.signEvent({
            ...eventTemplate,
            pubkey,
        });

        await publishKeytrEvent(signedEvent, NOSTR_RELAYS);

        const creds = getStored().filter(c => c.pubkey !== pubkey);
        creds.push({ pubkey, createdAt: new Date().toISOString() });
        setStored(creds);
    },

    /**
     * Login with passkey.
     *
     * Tier 1: stored credentials — fetch events by pubkey, decrypt with
     * loginWithKeytr (targeted assertion, one prompt).
     *
     * Tier 2: cached BIES user — same as Tier 1 using cached pubkey.
     *
     * Tier 3: discoverable — browser shows available passkeys.
     *
     * @param {object} [opts]
     * @param {string} [opts.expectedPubkey] - when re-acquiring the key for an
     *   existing session: only that account's credentials are tried first, and
     *   a key for any other account is rejected (err.pubkeyMismatch).
     * @returns {Promise<string>} bech32-encoded nsec
     */
    async loginWithPasskey({ expectedPubkey } = {}) {
        const nsec = await this._loginWithPasskey(expectedPubkey);
        assertNsecMatches(nsec, expectedPubkey);
        return nsec;
    },

    /** @private The three login tiers; see loginWithPasskey(). */
    async _loginWithPasskey(expectedPubkey) {
        // Re-acquiring for a session: only that account's own events, one
        // prompt. A cancellation ends it, and it never falls through to the
        // discoverable picker, which could offer (and decrypt) any account.
        const creds = expectedPubkey ? [{ pubkey: expectedPubkey }] : getStored();

        if (creds.length > 0) {
            // Tier 1 — we know which pubkey to look up
            for (const { pubkey } of creds) {
                const events = await fetchKeytrEvents(pubkey, NOSTR_RELAYS);
                if (events.length === 0) continue;

                try {
                    const { nsecBytes } = await loginWithKeytr(events);
                    setLastLoginInfo(pubkey, events);
                    try { return encodeNsec(nsecBytes); } finally { nsecBytes.fill(0); }
                } catch (err) {
                    if (expectedPubkey) throw err;
                    // login failed — fall through to next tier
                }
            }
        }
        if (expectedPubkey) throw new Error('No passkey for this account could be used.');

        // Tier 2 — cached BIES user pubkey
        const raw = localStorage.getItem('bies_user');
        const cached = raw ? JSON.parse(raw) : null;
        if (cached?.nostrPubkey) {
            const events = await fetchKeytrEvents(cached.nostrPubkey, NOSTR_RELAYS);
            if (events.length > 0) {
                try {
                    const { nsecBytes } = await loginWithKeytr(events);
                    const recoveredPk = getPublicKey(nsecBytes); // hex
                    setLastLoginInfo(recoveredPk, events);
                    try {
                        const nsec = encodeNsec(nsecBytes);
                        if (!this.hasCredential(recoveredPk)) {
                            const stored = getStored();
                            stored.push({ pubkey: recoveredPk, createdAt: new Date().toISOString() });
                            setStored(stored);
                        }
                        return nsec;
                    } finally {
                        nsecBytes.fill(0);
                    }
                } catch {
                    // login failed — fall through to discoverable
                }
            }
        }

        // Tier 3 — discoverable: try each gateway rpId
        // The serving domain (primary gateway) is tried first so credentials
        // registered on this deployment succeed with a single prompt; the
        // public backup gateways follow. Invalid rpIds (e.g. a backup that
        // doesn't whitelist this origin) fail fast with no UI and fall
        // through. Cancellations fall through too: a valid rpId with no
        // matching credentials (e.g. this domain visited fresh while the
        // passkey lives on keytr.org) still shows a browser prompt, and
        // dismissing it is indistinguishable from cancelling a populated
        // picker — aborting there would hard-block users whose credentials
        // exist only under a backup gateway. Only after every gateway has
        // been tried does a cancellation classify the whole login as
        // cancelled (silent in the UI). See discoverThroughGateways().
        return discoverThroughGateways(BIES_GATEWAYS, async (rpId) => {
            const { nsecBytes, pubkey } = await discover(NOSTR_RELAYS, { rpId });
            try {
                const nsec = encodeNsec(nsecBytes);
                if (pubkey && !this.hasCredential(pubkey)) {
                    const stored = getStored();
                    stored.push({ pubkey, createdAt: new Date().toISOString() });
                    setStored(stored);
                }
                // discover() doesn't expose which event decrypted — re-fetch
                // for KiH detection. Best-effort: never blocks the login.
                if (pubkey) {
                    try {
                        const events = await fetchKeytrEvents(pubkey, NOSTR_RELAYS);
                        setLastLoginInfo(pubkey, events);
                    } catch {
                        _lastLoginInfo = null;
                    }
                }
                return nsec;
            } finally {
                nsecBytes.fill(0);
            }
        }, isUserCancellation);
    },

    /**
     * KiH info detected during the last successful passkey login, or null.
     * Shape: { pubkey, kihCredentials: [{rpId, dTag}], hasKih }.
     */
    getLastLoginKihInfo() {
        return _lastLoginInfo;
    },

    /**
     * Migrate a legacy KiH credential on one gateway to PRF.
     *
     * Runs two WebAuthn ceremonies (discover the old KiH passkey, register the
     * new PRF one), publishes the new v=1 event BEFORE the kind:5 deletion of
     * the old v=3 event, and signs both internally with the recovered nsec.
     * One rpId per call — loop over gateways for multi-gateway users.
     *
     * @param {object} opts
     * @param {string} opts.rpId - gateway of the old (and new) credential
     * @param {string} [opts.expectedPubkey] - pubkey we believe is migrating
     * @returns {Promise<{pubkey: string, deletionPublished: boolean, pubkeyMismatch: boolean, rpId: string}>}
     */
    async migrateToPrf({ rpId, expectedPubkey }) {
        const result = await migrateFromKih({
            relays: NOSTR_RELAYS,
            rpId,
            rpName: rpId.split('.')[0],
            userName: (expectedPubkey || '').slice(0, 16) || 'bies-user',
            userDisplayName: 'BIES Account',
            clientName: 'bies',
        });
        // The signer already holds the key in memory — we don't need the nsec.
        result.nsecBytes.fill(0);

        // Refresh the localStorage credential index
        const creds = getStored().filter(c => c.pubkey !== result.pubkey);
        creds.push({ pubkey: result.pubkey, createdAt: new Date().toISOString() });
        setStored(creds);

        // Record the migrated dTag so a failed kind:5 deletion can't re-trigger prompts
        addMigratedDTag(result.pubkey, result.oldDTag);
        if (!result.deletionPublished) {
            console.warn('[keytr] kind:5 deletion of the old KiH event failed to publish (non-fatal)');
        }

        // Prune this rpId from the in-memory KiH info
        if (_lastLoginInfo?.kihCredentials) {
            _lastLoginInfo.kihCredentials = _lastLoginInfo.kihCredentials.filter(c => c.rpId !== rpId);
            _lastLoginInfo.hasKih = _lastLoginInfo.kihCredentials.length > 0;
        }

        return {
            pubkey: result.pubkey,
            deletionPublished: result.deletionPublished,
            pubkeyMismatch: !!expectedPubkey && result.pubkey !== expectedPubkey,
            rpId,
        };
    },

    /** Remove credential metadata for a specific pubkey. */
    removeCredential(pubkey) {
        setStored(getStored().filter(c => c.pubkey !== pubkey));
    },

    /**
     * Remove this account's passkey backup: publish a NIP-09 kind:5 deletion
     * for each of its kind:31777 events (every gateway), then drop the local
     * index entry. The passkey itself lives on the user's authenticator and
     * can only be deleted there.
     *
     * @param {string} pubkey - hex pubkey of the logged-in account
     * @returns {Promise<{ deleted: number }>} number of events retracted
     */
    async removePasskey(pubkey) {
        const { nostrSigner } = await import('./nostrSigner.js');
        const events = await fetchKeytrEvents(pubkey, NOSTR_RELAYS);
        const templates = buildDeletionTemplates(events, pubkey);
        for (const template of templates) {
            const signed = await nostrSigner.signEvent({ ...template, pubkey });
            await publishKeytrEvent(signed, NOSTR_RELAYS);
        }
        this.removeCredential(pubkey);
        return { deleted: templates.length };
    },

    /** Remove all stored credential metadata. */
    removeAll() {
        localStorage.removeItem(STORAGE_KEY);
    },
};
