import { bech32 } from '@scure/base';
import { nostrSigner } from './nostrSigner.js';
import { bolt11Msats } from '../utils/bolt11.js';

/**
 * Check if a string is a raw LNURL (bech32-encoded, lnurl1... prefix).
 * @param {string} value
 * @returns {boolean}
 */
export function isLnurl(value) {
    return typeof value === 'string' && /^lnurl1[a-z0-9]+$/i.test(value);
}

/**
 * Decode a bech32-encoded LNURL string to its underlying HTTPS URL.
 * @param {string} lnurl - bech32-encoded LNURL (lnurl1...)
 * @returns {string|null} - Decoded URL or null on failure
 */
export function decodeLnurl(lnurl) {
    try {
        const decoded = bech32.decode(lnurl.toLowerCase(), 2000);
        const bytes = bech32.fromWords(decoded.words);
        return new TextDecoder().decode(new Uint8Array(bytes));
    } catch {
        return null;
    }
}

/**
 * Resolve a Lightning address (user@domain) or raw LNURL (lnurl1...) to LNURL-pay metadata.
 * @param {string} addressOrLnurl - Lightning address or raw LNURL string
 * @returns {Promise<{callback: string, minSendable: number, maxSendable: number, metadata: string, allowsNostr?: boolean, nostrPubkey?: string}|null>}
 */
export async function resolveLud16(addressOrLnurl) {
    if (!addressOrLnurl) return null;

    let url;
    if (isLnurl(addressOrLnurl)) {
        // Raw LNURL — decode bech32 to get the HTTPS URL directly
        url = decodeLnurl(addressOrLnurl);
        if (!url) return null;
    } else if (addressOrLnurl.includes('@')) {
        // Standard LUD-16 Lightning address
        const [username, domain] = addressOrLnurl.split('@');
        if (!username || !domain) return null;
        url = `https://${domain}/.well-known/lnurlp/${username}`;
    } else {
        return null;
    }

    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = await res.json();
        if (data.status === 'ERROR') return null;
        return data;
    } catch {
        return null;
    }
}

/**
 * Request a Lightning invoice from an LNURL-pay callback.
 * @param {string} callback - LNURL-pay callback URL
 * @param {number} amountMsats - Amount in millisatoshis
 * @param {string} [zapRequestEvent] - Serialized NIP-57 zap request event (JSON string)
 * @returns {Promise<{pr: string, routes: any[]}|null>} - pr is the bolt11 invoice
 */
export async function requestInvoice(callback, amountMsats, zapRequestEvent) {
    try {
        const url = new URL(callback);
        url.searchParams.set('amount', String(amountMsats));
        if (zapRequestEvent) {
            url.searchParams.set('nostr', zapRequestEvent);
        }
        const res = await fetch(url.toString());
        if (!res.ok) return null;
        const data = await res.json();
        if (data.status === 'ERROR') return null;
        // LUD-06: the invoice must be for exactly the amount asked.
        if (typeof data.pr !== 'string' || bolt11Msats(data.pr) !== Number(amountMsats)) return null;
        return data;
    } catch {
        return null;
    }
}

/**
 * Pay a Lightning invoice via WebLN (browser extension like Alby).
 * @param {string} bolt11 - Lightning invoice
 * @returns {Promise<{success: boolean, preimage?: string, error?: string}>}
 */
export async function payWithWebLN(bolt11) {
    try {
        if (!window.webln) return { success: false, error: 'WebLN not available' };
        await window.webln.enable();
        const result = await window.webln.sendPayment(bolt11);
        return { success: true, preimage: result?.preimage };
    } catch (err) {
        return { success: false, error: err?.message || 'WebLN payment failed' };
    }
}

/**
 * Check if WebLN is available in the browser.
 */
export function hasWebLN() {
    return typeof window !== 'undefined' && !!window.webln;
}

/**
 * Build a NIP-57 zap request event (Kind 9734).
 * Signs via the nostrSigner (in-memory key or browser extension).
 * @param {Object} params
 * @param {string} params.recipientPubkey - Hex pubkey of the zap recipient
 * @param {number} params.amountMsats - Amount in millisatoshis
 * @param {string[]} params.relays - Relay URLs for the zap receipt
 * @param {string} [params.eventId] - Nostr event ID being zapped (optional)
 * @param {string} [params.aTag] - Addressable event coordinate (kind:pubkey:dTag) being zapped (optional, NIP-57)
 * @param {string} [params.content] - Zap comment (optional)
 * @returns {Promise<string|null>} - JSON-serialized signed event, or null if no extension
 */
export async function createZapRequest({ recipientPubkey, amountMsats, relays, eventId, aTag, content }) {
    const tags = [
        ['relays', ...relays],
        ['amount', String(amountMsats)],
        ['p', recipientPubkey],
    ];
    if (eventId) {
        tags.push(['e', eventId]);
    }
    if (aTag) {
        tags.push(['a', aTag]);
    }

    const event = {
        kind: 9734,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: content || '',
    };

    try {
        const signed = await nostrSigner.signEvent(event);
        return JSON.stringify(signed);
    } catch {
        return null;
    }
}

/**
 * Check if a string looks like a bolt11 Lightning invoice (HRP check only).
 * Format: ln<network><amount?><multiplier?>1<bech32 data>.
 * @param {string} value
 * @returns {boolean}
 */
export function isBolt11(value) {
    return typeof value === 'string'
        && /^ln(?:bc|tb|tbs|bcrt)\d*[munp]?1[ac-hj-np-z02-9]{6,}$/i.test(value.trim());
}

/**
 * Decode the amount from a bolt11 invoice's HRP (no full invoice decode).
 * Multipliers: m = milli-BTC, u = micro-BTC, n = nano-BTC, p = pico-BTC.
 * @param {string} bolt11
 * @returns {number|null} Amount in sats (may be fractional), or null for
 *   amountless/invalid invoices.
 */
export function decodeBolt11Amount(bolt11) {
    const msats = bolt11Msats(bolt11);
    return msats == null ? null : msats / 1000;
}


/**
 * Check if a string is a valid Bolt12 offer (starts with lno1).
 * @param {string} offer
 * @returns {boolean}
 */
export function isBolt12Offer(offer) {
    return typeof offer === 'string' && /^lno1[a-z0-9]+$/i.test(offer);
}

/**
 * Execute a full zap flow for one or more recipients.
 * Splits the amount equally among recipients with valid lud16 or bolt12Offer.
 *
 * @param {Object} params
 * @param {Array<{pubkey: string, lud16: string, bolt12Offer?: string, name: string}>} params.recipients - Recipients with resolved lud16 or bolt12Offer
 * @param {number} params.totalSats - Total amount in satoshis
 * @param {string[]} params.relays - Relay URLs for zap receipts
 * @param {string} [params.eventId] - Nostr event ID being zapped
 * @param {string} [params.content] - Zap comment
 * @param {function} [params.onProgress] - Callback for progress updates: (step, total, recipient)
 * @returns {Promise<{results: Array<{recipient: string, success: boolean, bolt11?: string, bolt12?: string, preimage?: string, error?: string}>, allPaidViaWebLN: boolean}>}
 */
export async function executeZapFlow({ recipients, totalSats, relays, eventId, aTag, content, onProgress }) {
    const validRecipients = recipients.filter(r => r.lud16 || r.bolt12Offer);
    if (validRecipients.length === 0) {
        return { results: [], allPaidViaWebLN: false };
    }

    const perRecipientSats = Math.floor(totalSats / validRecipients.length);
    const perRecipientMsats = perRecipientSats * 1000;
    const results = [];
    let allPaidViaWebLN = true;

    for (let i = 0; i < validRecipients.length; i++) {
        const recipient = validRecipients[i];
        onProgress?.(i + 1, validRecipients.length, recipient);

        // 1. Resolve LNURL-pay endpoint
        const lnurlData = await resolveLud16(recipient.lud16);
        if (!lnurlData) {
            results.push({ recipient: recipient.name, success: false, error: 'Could not resolve Lightning address' });
            allPaidViaWebLN = false;
            continue;
        }

        // Check amount bounds
        if (perRecipientMsats < lnurlData.minSendable || perRecipientMsats > lnurlData.maxSendable) {
            results.push({
                recipient: recipient.name,
                success: false,
                error: `Amount out of range (${lnurlData.minSendable / 1000}-${lnurlData.maxSendable / 1000} sats)`,
            });
            allPaidViaWebLN = false;
            continue;
        }

        // 2. Create NIP-57 zap request if possible
        let zapRequest = null;
        if (lnurlData.allowsNostr && lnurlData.nostrPubkey) {
            zapRequest = await createZapRequest({
                recipientPubkey: recipient.pubkey,
                amountMsats: perRecipientMsats,
                relays,
                eventId,
                aTag,
                content,
            });
        }

        // 3. Request invoice
        const invoiceData = await requestInvoice(lnurlData.callback, perRecipientMsats, zapRequest);
        if (!invoiceData?.pr) {
            results.push({ recipient: recipient.name, success: false, error: 'Failed to get invoice' });
            allPaidViaWebLN = false;
            continue;
        }

        // 4. Try WebLN payment
        const weblnResult = await payWithWebLN(invoiceData.pr);
        if (weblnResult.success) {
            results.push({ recipient: recipient.name, success: true, preimage: weblnResult.preimage });
        } else {
            // WebLN failed — return bolt11 for QR fallback
            results.push({ recipient: recipient.name, success: false, bolt11: invoiceData.pr, error: weblnResult.error });
            allPaidViaWebLN = false;
        }
    }

    return { results, allPaidViaWebLN };
}
