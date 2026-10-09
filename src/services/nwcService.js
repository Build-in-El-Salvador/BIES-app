/**
 * NIP-47 Nostr Wallet Connect (NWC) Service
 *
 * Manages NWC connections for one-click Lightning payments.
 * Parses nostr+walletconnect:// URIs, sends pay_invoice requests (kind:23194),
 * and listens for responses (kind:23195).
 *
 * Connection secrets are stored in localStorage only — never sent to the server.
 */

import { SimplePool, finalizeEvent, getPublicKey } from 'nostr-tools';
import { encrypt as nip04Encrypt, decrypt as nip04Decrypt } from 'nostr-tools/nip04';

const NWC_STORAGE_KEY = 'bies_nwc_uri';
const NWC_CAPABILITIES_KEY = 'bies_nwc_capabilities';
const REQUEST_TIMEOUT_MS = 15_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const RELAY_CONNECT_TIMEOUT_MS = 5_000;

const HEX_64 = /^[0-9a-f]{64}$/i;

// Fired on window whenever the NWC connection is established or torn down,
// so shared state (useWallet store) can stay in sync even when disconnect
// happens outside React (e.g. authService.logout()).
export const NWC_CHANGE_EVENT = 'bies:nwc-change';

/**
 * Parse a nostr+walletconnect:// URI into its components.
 *
 * Format: nostr+walletconnect://<walletPubkey>?relay=<url>&secret=<hex>
 * The slash-less variant (nostr+walletconnect:<pubkey>?...) exported by some
 * wallets is accepted too, as are multiple relay= parameters (NIP-47).
 *
 * @param {string} uri
 * @returns {{ walletPubkey: string, relays: string[], secret: Uint8Array, clientPubkey: string }}
 */
export function parseNwcUri(uri) {
    if (!uri || !uri.startsWith('nostr+walletconnect:')) {
        throw new Error('Invalid NWC URI: must start with nostr+walletconnect://');
    }

    // Extract pubkey and query string (scheme may appear with or without //)
    const withoutScheme = uri.replace(/^nostr\+walletconnect:(\/\/)?/, '');
    const questionIdx = withoutScheme.indexOf('?');
    if (questionIdx === -1) {
        throw new Error('Invalid NWC URI: missing query parameters');
    }

    let walletPubkey = withoutScheme.slice(0, questionIdx);
    const params = new URLSearchParams(withoutScheme.slice(questionIdx + 1));

    const relays = params.getAll('relay').filter(Boolean);
    const secretHex = params.get('secret');

    if (!walletPubkey || !HEX_64.test(walletPubkey)) {
        throw new Error('Invalid NWC URI: wallet pubkey must be 64 hex chars');
    }
    if (relays.length === 0) {
        throw new Error('Invalid NWC URI: missing relay parameter');
    }
    if (!secretHex || !HEX_64.test(secretHex)) {
        throw new Error('Invalid NWC URI: secret must be 64 hex chars');
    }

    // Relays normalize event pubkeys to lowercase — an uppercase pubkey would
    // silently break the response subscription filter.
    walletPubkey = walletPubkey.toLowerCase();

    const secret = hexToBytes(secretHex.toLowerCase());
    const clientPubkey = getPublicKey(secret);

    return { walletPubkey, relays, secret, clientPubkey };
}

/**
 * NWC Client — handles encrypted communication with a wallet service.
 */
class NwcClient {
    constructor() {
        this.pool = new SimplePool();
        this.connection = null; // { walletPubkey, relays, secret, clientPubkey }
        this.capabilities = null; // string[] of supported methods (from get_info), if known
    }

    /** @returns {boolean} Whether a wallet is currently connected */
    get connected() {
        return this.connection !== null;
    }

    /**
     * Whether the connected wallet supports a NIP-47 method, per the
     * capabilities cached from the get_info handshake.
     *
     * Tri-state: true / false / null (unknown — wallet never answered get_info).
     *
     * @param {string} method - NIP-47 method name (e.g. 'make_invoice')
     * @returns {boolean|null}
     */
    supports(method) {
        if (!this.connection) return false;
        if (this.capabilities == null) return null;
        return this.capabilities.includes(method);
    }

    /**
     * Connect to a wallet using an NWC URI — verified with a real roundtrip.
     *
     * Sends get_info (falling back to get_balance for wallets that don't
     * implement it) and only persists the URI once the wallet has actually
     * responded. Throws with a specific reason otherwise (bad URI, unreachable
     * relay, wallet timeout, wallet error).
     *
     * @param {string} uri - nostr+walletconnect:// URI
     * @returns {Promise<{ methods: string[]|null, balance: number|null }>}
     */
    async connect(uri) {
        const connection = parseNwcUri(uri);
        const previous = this.connection;
        this.connection = connection;

        try {
            let methods = null;
            let balance = null;

            try {
                const info = await this._request('get_info', {}, HANDSHAKE_TIMEOUT_MS);
                if (Array.isArray(info?.methods)) methods = info.methods;
            } catch (err) {
                if (isUnsupportedMethodError(err)) {
                    // Wallet doesn't implement get_info — verify with get_balance
                    try {
                        const res = await this._request('get_balance', {}, HANDSHAKE_TIMEOUT_MS);
                        balance = res?.balance ?? null;
                    } catch (balErr) {
                        // An "unsupported/restricted" error response still proves
                        // the wallet is reachable — treat it as a verified handshake.
                        if (!isUnsupportedMethodError(balErr)) throw balErr;
                    }
                } else {
                    throw err;
                }
            }

            // disconnect() may have run while the handshake was in flight
            // (e.g. logout on a shared browser) — never write the spend
            // secret back to localStorage after it was torn down.
            if (this.connection !== connection) {
                throw new Error('Wallet connection was cancelled');
            }

            this.capabilities = methods;
            localStorage.setItem(NWC_STORAGE_KEY, uri);
            if (methods) {
                localStorage.setItem(NWC_CAPABILITIES_KEY, JSON.stringify(methods));
            } else {
                localStorage.removeItem(NWC_CAPABILITIES_KEY);
            }
            this._emitChange();
            return { methods, balance };
        } catch (err) {
            // Handshake failed — do not persist, restore previous connection
            // (if any). If disconnect() replaced the connection mid-flight,
            // leave its state alone instead of resurrecting the old one.
            if (this.connection === connection) {
                this.connection = previous;
            }
            throw err;
        }
    }

    /**
     * Disconnect from the current wallet and remove the stored secret.
     */
    disconnect() {
        this.connection = null;
        this.capabilities = null;
        localStorage.removeItem(NWC_STORAGE_KEY);
        localStorage.removeItem(NWC_CAPABILITIES_KEY);
        this._emitChange();
    }

    /**
     * Restore connection from localStorage (if saved).
     * @returns {boolean} Whether a connection was restored
     */
    restore() {
        const uri = localStorage.getItem(NWC_STORAGE_KEY);
        if (!uri) return false;
        try {
            this.connection = parseNwcUri(uri);
            try {
                const raw = localStorage.getItem(NWC_CAPABILITIES_KEY);
                const methods = raw ? JSON.parse(raw) : null;
                this.capabilities = Array.isArray(methods) ? methods : null;
            } catch {
                this.capabilities = null;
            }
            return true;
        } catch (err) {
            console.warn('[NWC] Failed to restore connection:', err.message);
            localStorage.removeItem(NWC_STORAGE_KEY);
            localStorage.removeItem(NWC_CAPABILITIES_KEY);
            return false;
        }
    }

    /**
     * Pay a Lightning invoice via the connected wallet.
     *
     * @param {string} bolt11 - Lightning invoice (BOLT-11)
     * @returns {Promise<{ preimage: string }>}
     */
    async payInvoice(bolt11) {
        return this._request('pay_invoice', { invoice: bolt11 });
    }

    /**
     * Get the wallet balance (optional — not all wallets support this).
     * @returns {Promise<{ balance: number }>} Balance in msats
     */
    async getBalance() {
        return this._request('get_balance', {});
    }

    /**
     * Get wallet info / supported methods (optional — not all wallets support this).
     * @returns {Promise<{ methods?: string[] }>}
     */
    async getInfo() {
        return this._request('get_info', {});
    }

    /**
     * Create a Lightning invoice via the connected wallet (NIP-47 make_invoice).
     *
     * MSATS-native per the NIP-47 spec — sats conversion is the caller's job.
     *
     * @param {number} amountMsats - Amount in millisats
     * @param {string} [description] - Optional invoice description/memo
     * @returns {Promise<{ type: string, invoice: string, payment_hash: string, amount: number, created_at: number, expires_at?: number }>}
     */
    async makeInvoice(amountMsats, description) {
        return this._request('make_invoice', { amount: amountMsats, ...(description ? { description } : {}) });
    }

    /**
     * List recent transactions (NIP-47 list_transactions).
     *
     * Raw result: { transactions: [{ type, invoice?, description?, preimage?,
     * payment_hash, amount (msats), fees_paid?, created_at (unix s), settled_at?,
     * expires_at? }] } — normalization is the caller's job.
     *
     * @param {object} [params] - NIP-47 params (limit, offset, from, until, type, unpaid)
     * @returns {Promise<{ transactions: object[] }>}
     */
    async listTransactions(params = {}) {
        return this._request('list_transactions', { limit: 20, ...params });
    }

    /**
     * Look up an invoice by payment hash or bolt11 (NIP-47 lookup_invoice).
     *
     * @param {{ paymentHash?: string, invoice?: string }} [query]
     * @returns {Promise<object>} NIP-47 transaction object (settled_at set when paid)
     */
    async lookupInvoice({ paymentHash, invoice } = {}) {
        return this._request('lookup_invoice', {
            ...(paymentHash ? { payment_hash: paymentHash } : {}),
            ...(invoice ? { invoice } : {}),
        });
    }

    /**
     * Send a NIP-47 request and wait for the wallet's response.
     *
     * Flow:
     * 1. Create NIP-47 request (kind:23194) with encrypted payload
     * 2. Subscribe for the kind:23195 response BEFORE publishing (avoids a race)
     * 3. Publish to all NWC relays, failing fast if none are reachable
     * 4. Return the decrypted result
     *
     * @private
     * @param {string} method
     * @param {object} params
     * @param {number} [timeoutMs]
     */
    async _request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
        if (!this.connection) {
            throw new Error('No wallet connected');
        }

        const { walletPubkey, relays, secret, clientPubkey } = this.connection;

        // Build the NIP-47 request payload
        const requestPayload = JSON.stringify({ method, params: params ?? {} });

        // NIP-04 encrypt for the wallet service (NIP-47 spec)
        const encrypted = nip04Encrypt(secret, walletPubkey, requestPayload);

        // Create and sign the kind:23194 request event
        const requestEvent = finalizeEvent({
            kind: 23194,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['p', walletPubkey]],
            content: encrypted,
        }, secret);

        // Subscribe for the response BEFORE publishing (to avoid race condition)
        const responsePromise = this._waitForResponse(relays, walletPubkey, clientPubkey, requestEvent.id, secret, timeoutMs);

        // Publish to the NWC relays — success if any relay accepts it,
        // fast-fail if none are reachable within the connect timeout.
        try {
            await raceWithTimeout(
                Promise.any(this.pool.publish(relays, requestEvent)),
                RELAY_CONNECT_TIMEOUT_MS,
            );
        } catch {
            // If publish fails, cancel the response subscription
            responsePromise.catch(() => {}); // prevent unhandled rejection
            throw new Error('Could not reach the wallet relay. Check your connection and try again.');
        }

        // Wait for the wallet's response
        return responsePromise;
    }

    /**
     * Subscribe to the NWC relays for a kind:23195 response matching our request.
     * @private
     */
    _waitForResponse(relays, walletPubkey, clientPubkey, requestEventId, secret, timeoutMs = REQUEST_TIMEOUT_MS) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const settle = (fn, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                try { sub?.close(); } catch { /* already closed */ }
                fn(value);
            };

            const timeout = setTimeout(() => {
                // A timeout is NOT a definitive failure — the wallet may still
                // complete the payment (the response event was late/lost).
                // Callers use the code to render a "status unknown" state.
                const err = new Error('Wallet did not respond in time. Check your NWC connection.');
                err.code = 'TIMEOUT';
                settle(reject, err);
            }, timeoutMs);

            const sub = this.pool.subscribeMany(
                relays,
                {
                    kinds: [23195],
                    authors: [walletPubkey],
                    '#p': [clientPubkey],
                    '#e': [requestEventId],
                    since: Math.floor(Date.now() / 1000) - 10,
                },
                {
                    onevent: async (event) => {
                        try {
                            const decrypted = nip04Decrypt(secret, walletPubkey, event.content);
                            const response = JSON.parse(decrypted);

                            if (response.error) {
                                const err = new Error(response.error.message || 'Wallet returned an error');
                                err.code = response.error.code;
                                settle(reject, err);
                            } else {
                                settle(resolve, response.result || response);
                            }
                        } catch (err) {
                            settle(reject, new Error('Failed to decrypt wallet response: ' + err.message));
                        }
                    },
                    onclose: (reasons) => {
                        // nostr-tools 2.24+ passes [{ url, reason }]; older versions passed strings.
                        const reason = Array.isArray(reasons)
                            ? reasons.map((r) => (typeof r === 'string' ? r : `${r.url}: ${r.reason}`)).join(', ')
                            : String(reasons);
                        settle(reject, new Error('NWC relay connection closed: ' + reason));
                    },
                }
            );
        });
    }

    /** @private Notify listeners (useWallet store) that connection state changed */
    _emitChange() {
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new Event(NWC_CHANGE_EVENT));
        }
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
}

/** Race a promise against a timeout (timer is cleaned up either way). */
async function raceWithTimeout(promise, ms) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('Relay connection timed out')), ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/** NIP-47 "this wallet can't do that" errors (as opposed to unreachable/invalid). */
export function isUnsupportedMethodError(err) {
    if (!err) return false;
    if (err.code === 'NOT_IMPLEMENTED' || err.code === 'METHOD_NOT_FOUND' || err.code === 'RESTRICTED') {
        return true;
    }
    return /not[ _-]?(implemented|supported|found)/i.test(err.message || '');
}

// Singleton
export const nwcClient = new NwcClient();
