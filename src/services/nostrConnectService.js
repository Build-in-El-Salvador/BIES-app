/**
 * nostrConnectService — NIP-46 remote signer (Nostr Connect) support.
 *
 * Manages the connection lifecycle to a remote signer (Amber, nsecBunker, etc.)
 * via the BunkerSigner from nostr-tools/nip46. Two pairing flows:
 *
 *   - connect(bunkerInput): signer-initiated — paste a bunker:// URI or
 *     name@domain NIP-05 identifier.
 *   - createConnectSession() + connectViaURI(): client-initiated — we render
 *     a nostrconnect:// URI as QR/deep link, the signer scans/opens it.
 *
 * The ephemeral client keypair and bunker pointer are stored through
 * secureStore.js (the Keychain in the phone app; localStorage in a browser)
 * so the connection survives tab close and browser restarts. The client key
 * is an app-specific transport key, NOT the user's nsec — the nsec never
 * leaves the signer app.
 */

import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { parseBunkerInput, BunkerSigner, createNostrConnectURI } from 'nostr-tools/nip46';
import { secureGet, secureRemove, secureSet } from './secureStore.js';

const CLIENT_SK_KEY = 'bies_nip46_client_sk';
const BUNKER_POINTER_KEY = 'bies_nip46_bunker';

const CONNECT_TIMEOUT_MS = 30_000;
const NOSTRCONNECT_TIMEOUT_MS = 120_000;

/**
 * Rendezvous relays for NIP-46 traffic (kind 24133). The BIES relay is
 * deliberately excluded: it is NIP-42 gated, which is a chicken-and-egg
 * problem during login (we can't AUTH before we have a signer), and the
 * signer app couldn't AUTH to it either. relay.nsec.app is the de-facto
 * NIP-46 rendezvous relay (Amber's default); the others are public relays
 * BIES already uses.
 */
export const NIP46_RELAYS =
    (import.meta.env.VITE_NIP46_RELAYS?.split(',').map(s => s.trim()).filter(Boolean)) ||
    (typeof window !== 'undefined' && window.__TEST_NIP46_RELAYS) ||
    ['wss://relay.nsec.app', 'wss://relay.damus.io', 'wss://nos.lol'];

/**
 * Event kinds BIES signs with the user's key — requested as pre-authorized
 * permissions so the signer doesn't prompt for every action. Not 27235
 * (HTTP auth): BIES sign-ins and account deletion are asked for each time,
 * so a stolen client key can't sign them unseen.
 * (1059 gift-wraps and NWC events are signed with throwaway keys, not the
 * user key, so they're absent.)
 */
export const NIP46_PERMS = [
    ...[0, 1, 3, 5, 6, 7, 13, 1984, 9734, 10002, 22242, 24242, 30402, 31777, 31923, 31925]
        .map(kind => `sign_event:${kind}`),
    'nip44_encrypt',
    'nip44_decrypt',
];

function skToHex(sk) {
    return Array.from(sk, b => b.toString(16).padStart(2, '0')).join('');
}

function hexToSk(hex) {
    return new Uint8Array(hex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
}

/**
 * Surface a signer approval URL as a clickable toast (SignerToast.jsx).
 * onauth fires from a relay-subscription callback — never inside a user
 * gesture — so window.open() here is popup-blocked on mobile browsers and
 * desktop Chrome/Safari by default. A rendered link the user clicks is the
 * only reliable path.
 *
 * SECURITY: the auth_url is attacker-controlled — it arrives verbatim from
 * the (possibly rogue) remote signer's response. Reject anything that isn't a
 * plain http(s) URL so a `javascript:`/`data:` URI can't become a clickable
 * XSS sink in the BIES origin.
 */
export function isSafeAuthUrl(url) {
    if (typeof url !== 'string') return false;
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch {
        return false;
    }
}

function handleAuthUrl(url) {
    if (!isSafeAuthUrl(url)) {
        console.warn('[NIP-46] Ignoring non-http(s) auth_url from remote signer');
        return;
    }
    window.dispatchEvent(new CustomEvent('bies:nip46-auth-url', { detail: { url } }));
}

/**
 * One-time migration: sessions created before the localStorage move lived in
 * sessionStorage (lost on tab close). Copy them over so mid-session users
 * survive the deploy.
 */
function migrateLegacySession() {
    try {
        const legacySk = sessionStorage.getItem(CLIENT_SK_KEY);
        const legacyBp = sessionStorage.getItem(BUNKER_POINTER_KEY);
        if (legacySk && legacyBp && !secureGet('nip46Sk')) {
            secureSet('nip46Sk', legacySk);
            secureSet('nip46Bunker', legacyBp);
        }
        sessionStorage.removeItem(CLIENT_SK_KEY);
        sessionStorage.removeItem(BUNKER_POINTER_KEY);
    } catch { /* storage unavailable */ }
}
migrateLegacySession();

function withTimeout(promise, ms, message) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
    ]);
}

/**
 * Whether a reconnect failure is terminal (signer rejected us — revoked
 * connection, bad secret) vs transient (timeout, network blip, closed
 * socket). Terminal errors clear the stored session; transient ones keep it
 * for a later retry.
 *
 * nostr-tools rejects a NIP-46 *signer* error response with the raw string
 * payload (`handler.reject(error)`), while transport failures reject with an
 * Error object. So only a string rejection means the signer actually refused
 * us. Be conservative: never destroy a stored session on an Error (a network
 * outage must not log the user out of their signer).
 */
function isTerminalError(err) {
    return typeof err === 'string' && err.length > 0;
}

export const nostrConnectService = {
    _bunkerSigner: null,
    // The bunker:// / NIP-05 input _bunkerSigner was paired from (paste flow).
    _pairedInput: null,
    _reconnectPromise: null,
    // Bumped by disconnect() so an in-flight reconnect can detect that the
    // session it was reviving has since been torn down (logout) and avoid
    // resurrecting a stale signer.
    _generation: 0,

    /** Shared relay pool (avoids a second SimplePool per BunkerSigner).
     *  Dynamic import: nostrService statically imports nostrSigner, which
     *  dynamically imports this module — keep the back-edge dynamic too. */
    async _getPool() {
        const { nostrService } = await import('./nostrService.js');
        return nostrService.pool;
    },

    _persistSession(clientSk, bp) {
        secureSet('nip46Sk', skToHex(clientSk));
        secureSet('nip46Bunker', JSON.stringify(bp));
    },

    /**
     * Connect to a remote signer via bunker:// URI or name@domain NIP-05.
     * Returns the connected BunkerSigner instance.
     */
    async connect(bunkerInput) {
        const input = bunkerInput.trim();
        // Already paired with this exact input (a retry after the signer
        // refused to sign): reuse it — the URI's secret is spent.
        if (this._bunkerSigner && this._pairedInput === input) return this._bunkerSigner;

        const bp = await parseBunkerInput(input);
        if (!bp) throw new Error('Invalid bunker URI or NIP-05 identifier.');

        const clientSk = generateSecretKey();
        const pool = await this._getPool();

        const signer = BunkerSigner.fromBunker(clientSk, bp, {
            pool,
            onauth: handleAuthUrl,
        });

        // Race against timeout so the UI doesn't hang forever
        try {
            await withTimeout(
                signer.connect(),
                CONNECT_TIMEOUT_MS,
                'Connection timed out. Make sure your signer app is open and connected to the internet.'
            );
        } catch (err) {
            // Close the failed signer so its kind-24133 subscription doesn't
            // leak on the shared pool.
            signer.close().catch(() => {});
            throw err;
        }

        // Persist only after a successful handshake — a failed attempt must
        // not leave hasStoredConnection() truthy.
        this._persistSession(clientSk, bp);
        this._replaceSigner(signer);
        this._pairedInput = input;
        return signer;
    },

    /**
     * Client-initiated pairing (nostrconnect://): generate the client key,
     * secret and URI for the signer to scan / open.
     */
    createConnectSession() {
        const clientSk = generateSecretKey();
        const secret = skToHex(generateSecretKey()).slice(0, 32);
        const uri = createNostrConnectURI({
            clientPubkey: getPublicKey(clientSk),
            relays: [...NIP46_RELAYS],
            secret,
            name: 'BIES',
            url: typeof window !== 'undefined' ? window.location.origin : undefined,
            perms: NIP46_PERMS,
        });
        return { uri, clientSk };
    },

    /**
     * Await the signer's connect response for a createConnectSession() URI.
     * Resolves with the connected BunkerSigner; persists the session.
     *
     * @param {string} uri - the nostrconnect:// URI shown to the signer
     * @param {Uint8Array} clientSk - client key from createConnectSession()
     * @param {AbortSignal} [signal] - abort to tear down the relay subscription
     */
    async connectViaURI(uri, clientSk, signal) {
        const pool = await this._getPool();
        const signer = await BunkerSigner.fromURI(
            clientSk,
            uri,
            { pool, onauth: handleAuthUrl },
            signal ?? NOSTRCONNECT_TIMEOUT_MS
        );
        // If the caller aborted (cancel / unmount) while the signer was being
        // established, don't persist a stale session or leak the subscription.
        if (signal?.aborted) {
            signer.close().catch(() => {});
            const err = new Error('nostrconnect pairing aborted');
            err.name = 'AbortError';
            throw err;
        }
        // fromURI populates signer.bp ({pubkey, relays, secret}) on success —
        // the same shape parseBunkerInput returns, so reconnect() reuses it.
        this._persistSession(clientSk, signer.bp);
        this._replaceSigner(signer);
        return signer;
    },

    /**
     * Reconnect using stored session data (page refresh / browser restart).
     * Returns the BunkerSigner, or null if no stored connection exists or the
     * signer is unreachable. Terminal failures (signer rejected the session)
     * clear storage and dispatch 'bies:signer-disconnected'; transient ones
     * (timeout/network) keep storage so a later call can retry.
     */
    async reconnect() {
        // Dedup concurrent reconnects (background relay AUTH + a user action
        // can race here) — piggyback on the in-flight attempt.
        if (this._reconnectPromise) return this._reconnectPromise;
        this._reconnectPromise = this._doReconnect();
        try {
            return await this._reconnectPromise;
        } finally {
            this._reconnectPromise = null;
        }
    },

    async _doReconnect() {
        const generation = this._generation;
        const skHex = secureGet('nip46Sk');
        const bpJson = secureGet('nip46Bunker');
        if (!skHex || !bpJson) return null;

        let signer;
        try {
            const clientSk = hexToSk(skHex);
            const bp = JSON.parse(bpJson);
            const pool = await this._getPool();
            signer = BunkerSigner.fromBunker(clientSk, bp, {
                pool,
                onauth: handleAuthUrl,
            });
        } catch {
            // Corrupt stored session — unrecoverable
            this.clearSession();
            window.dispatchEvent(new CustomEvent('bies:signer-disconnected'));
            return null;
        }

        // Validate the session. ping() avoids re-sending connect with a
        // possibly single-use secret; fall back to connect() for signers
        // that don't implement ping.
        try {
            await withTimeout(signer.ping(), CONNECT_TIMEOUT_MS, 'Reconnection timed out.');
        } catch (pingErr) {
            if (!isTerminalError(pingErr)) {
                // Timeout / network — keep storage for a later retry
                signer.close().catch(() => {});
                return null;
            }
            try {
                await withTimeout(signer.connect(), CONNECT_TIMEOUT_MS, 'Reconnection timed out.');
            } catch (connectErr) {
                signer.close().catch(() => {});
                if (isTerminalError(connectErr)) {
                    // Signer explicitly rejected us — session is dead
                    this.clearSession();
                    window.dispatchEvent(new CustomEvent('bies:signer-disconnected'));
                } // else: transient — keep storage
                return null;
            }
        }

        // A disconnect()/logout (or a newer pairing) raced this revival — drop
        // the freshly-validated signer instead of clobbering the live state.
        if (generation !== this._generation) {
            signer.close().catch(() => {});
            return null;
        }
        this._bunkerSigner = signer;
        return signer;
    },

    /** Adopt a newly paired signer, closing any previous one's subscription. */
    _replaceSigner(signer) {
        if (this._bunkerSigner && this._bunkerSigner !== signer) {
            this._bunkerSigner.close().catch(() => {});
        }
        this._bunkerSigner = signer;
        this._pairedInput = null;
    },

    /** Get the current connected BunkerSigner, or null. */
    getSigner() {
        return this._bunkerSigner;
    },

    /** Whether session data exists for reconnection. */
    hasStoredConnection() {
        return !!(secureGet('nip46Sk') && secureGet('nip46Bunker'));
    },

    /** Disconnect and clean up. Closes only the NIP-46 subscription — the
     *  shared relay pool stays alive for the rest of the app. */
    disconnect() {
        this._generation++; // invalidate any in-flight reconnect
        if (this._bunkerSigner) {
            this._bunkerSigner.close().catch(() => {});
            this._bunkerSigner = null;
        }
        this._pairedInput = null;
        this.clearSession();
    },

    clearSession() {
        secureRemove('nip46Sk');
        secureRemove('nip46Bunker');
    },
};
