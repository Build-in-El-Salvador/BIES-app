/**
 * amberSignerService — NIP-55 Android-intent signing via Amber.
 *
 * Amber (greenart7c3/Amber) registers the `nostrsigner:` URI scheme on
 * Android. Navigating to such a URI opens Amber, which performs the
 * operation and redirects back to our `callbackUrl` with the result
 * appended. Every operation is therefore a full app-switch round trip and
 * the page may be reloaded (or a NEW tab opened) when the callback lands —
 * so pending operations are persisted in localStorage and results are
 * handed back across tabs via `storage` events.
 *
 * Storage model:
 *   localStorage  bies_amber_pubkey        hex pubkey of the Amber user
 *   localStorage  bies_amber_ops           { v:1, ops: { [opId]: OpRecord } }
 *   localStorage  bies_amber_result_<id>   completion signal (callback route writes)
 *   localStorage  bies_amber_login         LoginState for the 2-round-trip login
 *   sessionStorage bies_amber_my_op        opId THIS tab is awaiting (per-tab)
 *
 * OpRecord: { id, type, createdAt, status, request, result, error,
 *             resume: { kind: 'login-pubkey'|'login-challenge'|'generic', returnPath } }
 *
 * UX constraint (documented, by design): signEvent/nip44* must be called
 * from a user gesture — Android Chrome blocks external-scheme navigation
 * without one. Background flows must check nostrSigner.canSignSilently
 * (false in amber mode) before signing.
 */

import { nip19, verifyEvent } from 'nostr-tools';
// Vendored: nostr-tools ships nip55 but omits it from its exports map.
import { getPublicKeyUri, signEventUri, encryptNip44Uri, decryptNip44Uri } from '../utils/nip55.js';

const PUBKEY_KEY = 'bies_amber_pubkey';
const OPS_KEY = 'bies_amber_ops';
const RESULT_KEY_PREFIX = 'bies_amber_result_';
const LOGIN_STATE_KEY = 'bies_amber_login';
const MY_OP_KEY = 'bies_amber_my_op';

const OP_TTL_MS = 10 * 60 * 1000;      // ops older than this are swept
const NOT_INSTALLED_MS = 3_000;         // visibility watchdog window
const RESULT_TIMEOUT_MS = 120_000;      // overall wait for a result
const POLL_INTERVAL_MS = 1_000;         // belt-and-braces polling

/**
 * Permissions requested at login so Amber pre-authorizes everything BIES
 * signs with the user key and later ops auto-approve. Gift-wraps (1059) and
 * NWC events use throwaway keys — deliberately absent. So are sign-ins and
 * account confirmations (27235): Amber asks each time, and its prompt naming
 * BIES is what stops another page getting one signed.
 */
export const AMBER_PERMISSIONS = [
    ...[0, 1, 3, 5, 6, 7, 13, 1984, 9734, 10002, 22242, 24242, 30402, 31777, 31923, 31925]
        .map(kind => ({ type: 'sign_event', kind })),
    { type: 'nip44_encrypt' },
    { type: 'nip44_decrypt' },
];

// ─── ops store helpers ───────────────────────────────────────────────────────

function readOps() {
    try {
        const raw = JSON.parse(localStorage.getItem(OPS_KEY));
        if (raw?.v === 1 && raw.ops) return raw.ops;
    } catch { /* corrupt — reset */ }
    return {};
}

function writeOps(ops) {
    localStorage.setItem(OPS_KEY, JSON.stringify({ v: 1, ops }));
}

/** Remove expired ops and their result keys. Idempotent — safe concurrently. */
function sweepOps() {
    try {
        const ops = readOps();
        const now = Date.now();
        let changed = false;
        for (const [id, op] of Object.entries(ops)) {
            if (now - (op.createdAt || 0) > OP_TTL_MS) {
                delete ops[id];
                localStorage.removeItem(RESULT_KEY_PREFIX + id);
                changed = true;
            }
        }
        if (changed) writeOps(ops);
    } catch { /* storage unavailable */ }
}
sweepOps();

// ─── result normalization ────────────────────────────────────────────────────

function normalizePubkey(value) {
    const v = (value || '').trim();
    if (v.startsWith('npub1')) {
        const decoded = nip19.decode(v);
        if (decoded.type !== 'npub') throw new Error('Amber returned an invalid npub.');
        return decoded.data;
    }
    if (/^[0-9a-f]{64}$/i.test(v)) return v.toLowerCase();
    throw new Error('Amber returned an unrecognized public key format.');
}

function normalizeSignedEvent(value) {
    let text = (value || '').trim();
    // Amber may return the JSON percent-encoded depending on version/path.
    if (!text.startsWith('{')) {
        try { text = decodeURIComponent(text); } catch { /* keep as-is */ }
    }
    const event = JSON.parse(text);
    if (!verifyEvent(event)) throw new Error('Amber returned an event with an invalid signature.');
    return event;
}

function normalizeResult(type, value) {
    switch (type) {
        case 'get_public_key': return normalizePubkey(value);
        case 'sign_event': return normalizeSignedEvent(value);
        default: return value; // nip44_encrypt / nip44_decrypt — raw string
    }
}

export const amberSignerService = {
    /**
     * Navigation seam — overridable in tests via window.__TEST_NIP55_NAVIGATE
     * (Playwright can't follow Android intent schemes).
     */
    _navigate(uri) {
        if (typeof window !== 'undefined' && window.__TEST_NIP55_NAVIGATE) {
            window.__TEST_NIP55_NAVIGATE(uri);
            return;
        }
        window.location.href = uri;
    },

    getStoredPubkey() {
        return localStorage.getItem(PUBKEY_KEY);
    },

    setStoredPubkey(pubkey) {
        localStorage.setItem(PUBKEY_KEY, pubkey);
    },

    // ─── login state ─────────────────────────────────────────────────────────

    setLoginState(state) {
        localStorage.setItem(LOGIN_STATE_KEY, JSON.stringify(state));
    },

    getPendingLoginState() {
        try {
            const state = JSON.parse(localStorage.getItem(LOGIN_STATE_KEY));
            if (state && Date.now() - (state.startedAt || 0) < OP_TTL_MS) return state;
        } catch { /* corrupt */ }
        return null;
    },

    clearLoginState() {
        localStorage.removeItem(LOGIN_STATE_KEY);
    },

    clearAll() {
        localStorage.removeItem(PUBKEY_KEY);
        localStorage.removeItem(LOGIN_STATE_KEY);
        const ops = readOps();
        for (const id of Object.keys(ops)) localStorage.removeItem(RESULT_KEY_PREFIX + id);
        localStorage.removeItem(OPS_KEY);
        try { sessionStorage.removeItem(MY_OP_KEY); } catch { /* ignore */ }
    },

    // ─── op dispatch ─────────────────────────────────────────────────────────

    _callbackUrl(opId) {
        // Amber appends the raw result to the end of this string.
        return `${window.location.origin}/amber-callback?op=${opId}&result=`;
    },

    /**
     * Create an OpRecord, navigate to Amber, and await the result.
     *
     * Resolution paths:
     *  - callback lands in ANOTHER tab → it writes bies_amber_result_<id> →
     *    our `storage` listener fires → resolve.
     *  - callback reuses THIS tab → the page unloads; this promise dies with
     *    it. The callback route resumes from the persisted OpRecord instead.
     *  - Amber not installed → the page never loses visibility → reject fast.
     */
    _dispatch(type, request, resume, buildUriFn, { skipWatchdog = false } = {}) {
        sweepOps();
        const id = crypto.randomUUID();
        const op = {
            id, type, createdAt: Date.now(), status: 'pending',
            request, result: null, error: null,
            resume: resume || { kind: 'generic', returnPath: window.location.pathname },
        };
        const ops = readOps();
        ops[id] = op;
        writeOps(ops);
        try { sessionStorage.setItem(MY_OP_KEY, id); } catch { /* ignore */ }

        const uri = buildUriFn(id);

        return new Promise((resolve, reject) => {
            let settled = false;
            let pollTimer = null;
            let watchdogTimer = null;
            let timeoutTimer = null;

            const cleanup = () => {
                settled = true;
                window.removeEventListener('storage', onStorage);
                document.removeEventListener('visibilitychange', onVisibility);
                clearInterval(pollTimer);
                clearTimeout(watchdogTimer);
                clearTimeout(timeoutTimer);
            };

            const settleFromRecord = (record) => {
                if (settled) return;
                cleanup();
                localStorage.removeItem(RESULT_KEY_PREFIX + id);
                const remaining = readOps();
                delete remaining[id];
                writeOps(remaining);
                try {
                    if (sessionStorage.getItem(MY_OP_KEY) === id) sessionStorage.removeItem(MY_OP_KEY);
                } catch { /* ignore */ }
                if (record.status === 'done') resolve(record.result);
                else reject(new Error(record.error || 'Amber operation failed.'));
            };

            const checkResult = () => {
                try {
                    const raw = localStorage.getItem(RESULT_KEY_PREFIX + id);
                    if (raw) settleFromRecord(JSON.parse(raw));
                } catch { /* keep waiting */ }
            };

            const onStorage = (e) => {
                if (e.key === RESULT_KEY_PREFIX + id && e.newValue) {
                    try { settleFromRecord(JSON.parse(e.newValue)); } catch { /* ignore */ }
                }
            };
            const onVisibility = () => {
                if (document.visibilityState === 'hidden') clearTimeout(watchdogTimer);
            };

            window.addEventListener('storage', onStorage);
            document.addEventListener('visibilitychange', onVisibility);
            pollTimer = setInterval(checkResult, POLL_INTERVAL_MS);

            // Not-installed watchdog: navigating to an unhandled intent scheme
            // is a silent no-op on Android Chrome — the page stays visible.
            // Skipped for resume navigations (callback-driven, gestureless):
            // there the page is EXPECTED to stay visible while the user taps
            // the manual "Continue in Amber" button, so the watchdog would
            // false-positive and kill a working flow. Also disarmed in E2E
            // (stubbed _navigate never hides the page).
            if (!skipWatchdog && !window.__TEST_NIP55_DISABLE_WATCHDOG) {
                watchdogTimer = setTimeout(() => {
                    if (document.visibilityState !== 'hidden' && !settled) {
                        cleanup();
                        const remaining = readOps();
                        delete remaining[id];
                        writeOps(remaining);
                        reject(new Error('Amber app not found. Install Amber or use the QR option.'));
                    }
                }, NOT_INSTALLED_MS);
            }

            timeoutTimer = setTimeout(() => {
                if (!settled) {
                    cleanup();
                    reject(new Error('Timed out waiting for Amber.'));
                }
            }, RESULT_TIMEOUT_MS);

            this._navigate(uri);
        });
    },

    // ─── window.nostr-like interface ─────────────────────────────────────────

    /**
     * Request the user's pubkey from Amber (login round trip 1).
     * MUST be called from a user gesture.
     */
    requestPublicKey(permissions, resume) {
        return this._dispatch('get_public_key', {}, resume, (id) =>
            getPublicKeyUri({
                permissions,
                callbackUrl: this._callbackUrl(id),
                compressionType: 'none',
                appName: 'BIES',
            })
        );
    },

    /** Stored-pubkey accessor for the signer interface (no round trip). */
    getPublicKey() {
        const pubkey = this.getStoredPubkey();
        if (!pubkey) throw new Error('Amber session not established. Please log in again.');
        return pubkey;
    },

    /**
     * Sign an event via Amber. MUST be called from a user gesture.
     * If the callback reuses this tab, the returned promise never resolves —
     * the callback route navigates back and the user retries (instant:
     * permission was pre-granted at login).
     */
    signEvent(event, opts = {}) {
        const currentUser = this.getStoredPubkey() || undefined;
        const eventJson = { ...event };
        if (!eventJson.pubkey && currentUser) eventJson.pubkey = currentUser;
        return this._dispatch('sign_event', eventJson, opts.resume, (id) =>
            signEventUri({
                eventJson,
                id,
                currentUser,
                callbackUrl: this._callbackUrl(id),
                compressionType: 'none',
                returnType: 'event',
                appName: 'BIES',
            }),
            { skipWatchdog: opts.skipWatchdog }
        );
    },

    /** NIP-44 encrypt via Amber. MUST be called from a user gesture. */
    nip44Encrypt(pubkey, plaintext, opts = {}) {
        return this._dispatch('nip44_encrypt', { pubkey, content: plaintext }, opts.resume, (id) =>
            encryptNip44Uri({
                pubKey: pubkey,
                content: plaintext,
                id,
                currentUser: this.getStoredPubkey() || undefined,
                callbackUrl: this._callbackUrl(id),
                compressionType: 'none',
                appName: 'BIES',
            })
        );
    },

    /** NIP-44 decrypt via Amber. MUST be called from a user gesture. */
    nip44Decrypt(pubkey, ciphertext, opts = {}) {
        return this._dispatch('nip44_decrypt', { pubkey, content: ciphertext }, opts.resume, (id) =>
            decryptNip44Uri({
                pubKey: pubkey,
                content: ciphertext,
                id,
                currentUser: this.getStoredPubkey() || undefined,
                callbackUrl: this._callbackUrl(id),
                compressionType: 'none',
                appName: 'BIES',
            })
        );
    },

    // ─── callback handling (AmberCallback route) ─────────────────────────────

    /**
     * Process an /amber-callback landing. `rawSearch` is location.search.
     * Returns a directive for the route component:
     *   { kind: 'continue-login', pubkey }
     *   { kind: 'finish-login', signedEvent }
     *   { kind: 'resume-same-tab', returnPath }
     *   { kind: 'close-me', returnPath }
     *   { kind: 'stale' } | { kind: 'error', message }
     */
    handleCallback(rawSearch) {
        sweepOps();
        const params = new URLSearchParams(rawSearch);
        const opId = params.get('op');

        // Defensive result extraction: Amber concatenates the raw result onto
        // the callback URL. If it contains '&' or '=' (signed-event JSON),
        // URLSearchParams would truncate it — slice after the literal marker.
        let value = null;
        const marker = 'result=';
        const idx = rawSearch.indexOf(marker);
        if (idx !== -1) {
            value = rawSearch.slice(idx + marker.length);
            try { value = decodeURIComponent(value); } catch { /* raw */ }
        }
        if (value == null || value === '') {
            const fromParams = params.get('result');
            if (fromParams) value = fromParams;
        }

        if (!opId) return { kind: 'error', message: 'Missing operation id in callback.' };

        const ops = readOps();
        const op = ops[opId];
        if (!op || Date.now() - (op.createdAt || 0) > OP_TTL_MS) {
            return { kind: 'stale' };
        }

        if (!value) {
            op.status = 'error';
            op.error = 'Amber returned no result.';
            writeOps(ops);
            localStorage.setItem(RESULT_KEY_PREFIX + opId, JSON.stringify({
                id: opId, status: 'error', result: null, error: op.error, ts: Date.now(),
            }));
            return { kind: 'error', message: op.error };
        }

        let result;
        try {
            result = normalizeResult(op.type, value);
        } catch (err) {
            op.status = 'error';
            op.error = err.message || 'Failed to parse Amber result.';
            writeOps(ops);
            localStorage.setItem(RESULT_KEY_PREFIX + opId, JSON.stringify({
                id: opId, status: 'error', result: null, error: op.error, ts: Date.now(),
            }));
            return { kind: 'error', message: op.error };
        }

        // Publish the result — a still-alive initiating tab resolves via the
        // storage event; the record in bies_amber_ops covers same-tab resume.
        op.status = 'done';
        op.result = result;
        writeOps(ops);
        localStorage.setItem(RESULT_KEY_PREFIX + opId, JSON.stringify({
            id: opId, status: 'done', result, error: null, ts: Date.now(),
        }));

        if (op.resume?.kind === 'login-pubkey') {
            return { kind: 'continue-login', pubkey: result };
        }
        if (op.resume?.kind === 'login-challenge') {
            return { kind: 'finish-login', signedEvent: result };
        }

        // Generic op — did Amber reuse the initiating tab (page reloaded, its
        // promise is dead) or open a new one (original tab resolves itself)?
        let myOp = null;
        try { myOp = sessionStorage.getItem(MY_OP_KEY); } catch { /* ignore */ }
        const returnPath = op.resume?.returnPath || '/feed';
        if (myOp === opId) {
            // Same tab: nothing is waiting anymore. The action is NOT
            // auto-replayed (accepted limitation) — the user retries it and
            // Amber auto-approves thanks to the login-time permissions.
            return { kind: 'resume-same-tab', returnPath };
        }
        return { kind: 'close-me', returnPath };
    },
};
