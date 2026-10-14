/**
 * LNURL Service — server-side LNURL-pay toolkit for non-custodial payments.
 *
 * Resolves Lightning addresses (LUD-16) and raw LNURLs (LUD-06) to their
 * lnurlp params, requests bolt11 invoices from the recipient's callback,
 * decodes bolt11 invoices (payment_hash + expiry), and verifies settlement
 * via LUD-21 lnurl-pay verify. No external dependencies — node crypto + fetch.
 */

import crypto from 'crypto';
import { safeGet, OUTBOUND_HEADERS } from '../utils/safeFetch';

const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024; // 1MB cap on LNURL provider responses

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LnurlPayParams {
    callback: string;
    minSendable: number;
    maxSendable: number;
    metadata?: string;
    tag?: string;
    commentAllowed?: number;
    allowsNostr?: boolean;
    nostrPubkey?: string;
}

export interface LnurlInvoice {
    pr: string;
    verify?: string;
}

export interface Lud21Result {
    settled: boolean;
    preimage: string | null;
    pr: string;
}

export interface DecodedBolt11 {
    paymentHash: string;
    expirySeconds: number;
    amountMsats: bigint | null;
}

// ─── Bech32 helpers (self-contained, checksum not verified) ──────────────────

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

/** Convert a bech32 data string to its 5-bit words. Throws on invalid chars. */
function bech32Words(data: string): number[] {
    const words: number[] = [];
    for (const ch of data) {
        const idx = BECH32_CHARSET.indexOf(ch);
        if (idx === -1) throw new Error('Invalid bech32 character');
        words.push(idx);
    }
    return words;
}

/** Convert 5-bit words to 8-bit bytes, discarding incomplete trailing bits. */
function wordsToBytes(words: number[]): Buffer {
    let acc = 0;
    let bits = 0;
    const bytes: number[] = [];
    for (const word of words) {
        acc = (acc << 5) | word;
        bits += 5;
        if (bits >= 8) {
            bits -= 8;
            bytes.push((acc >> bits) & 0xff);
        }
    }
    return Buffer.from(bytes);
}

/** Decode a raw bech32 LNURL (LUD-06, lnurl1...) to its underlying URL. */
function decodeLnurl(lnurl: string): string {
    const lower = lnurl.toLowerCase().trim();
    const sep = lower.lastIndexOf('1');
    if (!lower.startsWith('lnurl1') || sep < 1) throw new Error('Malformed LNURL');
    // Last 6 words are the checksum
    const words = bech32Words(lower.slice(sep + 1));
    if (words.length <= 6) throw new Error('Malformed LNURL');
    const url = wordsToBytes(words.slice(0, -6)).toString('utf8');
    if (!/^https?:\/\//i.test(url)) throw new Error('LNURL does not decode to a URL');
    return url;
}

// ─── SSRF-guarded, size-bounded fetch ────────────────────────────────────────

/** True for localhost/private/link-local hosts (mirrors importEventFromUrl's guard). */
function isPrivateHost(hostname: string): boolean {
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0') return true;
    if (hostname.endsWith('.local') || hostname.endsWith('.internal')) return true;

    const parts = hostname.split('.').map(Number);
    if (parts.length === 4 && parts.every(p => !isNaN(p))) {
        if (parts[0] === 10) return true;                                      // 10.0.0.0/8
        if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16.0.0/12
        if (parts[0] === 192 && parts[1] === 168) return true;                 // 192.168.0.0/16
        if (parts[0] === 169 && parts[1] === 254) return true;                 // 169.254.0.0/16 (link-local)
        if (parts[0] === 127) return true;                                     // 127.0.0.0/8
        if (parts[0] === 0) return true;                                       // 0.0.0.0/8
    }

    if (hostname.startsWith('[::') || hostname.startsWith('[fe80:') || hostname.startsWith('[fd')) return true;
    if (hostname.startsWith('::') || hostname.startsWith('fe80:') || hostname.startsWith('fd')) return true;

    return false;
}

/** Reject URLs that are not http(s) or that point at private/internal hosts. */
function assertSafeUrl(rawUrl: string): URL {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new Error('Lightning endpoint URL is invalid');
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('Lightning endpoint must use HTTP(S)');
    }
    if (isPrivateHost(url.hostname.toLowerCase())) {
        throw new Error('Lightning endpoint host is not allowed');
    }
    return url;
}

/** Bounded upstream-provided error reason, safe to surface to clients. */
function upstreamReason(data: any, fallback: string): string {
    return typeof data?.reason === 'string' && data.reason ? data.reason.slice(0, 200) : fallback;
}

/**
 * Fetch JSON from an LNURL provider with SSRF protection: https only, and
 * every hop's resolved addresses checked and pinned to the connection
 * (utils/safeFetch.ts), so a name that resolves, or redirects, to an
 * internal address is refused. Size- and time-bounded.
 */
async function fetchLnurlJson(rawUrl: string, label: string): Promise<any> {
    assertSafeUrl(rawUrl); // quick refusal for bad schemes and literal internal hosts
    const res = await safeGet(rawUrl, { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: MAX_RESPONSE_BYTES, headers: OUTBOUND_HEADERS });
    if (!res) throw new Error(`${label} couldn't be reached`);
    try {
        return JSON.parse(res.body.toString('utf8'));
    } catch {
        throw new Error(`${label} returned invalid JSON`);
    }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** sha256 of raw bytes as lowercase hex — used for preimage vs payment_hash checks. */
export function sha256Hex(data: Buffer | string): string {
    return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Resolve a Lightning address (user@domain, LUD-16) or raw LNURL (lnurl1..., LUD-06)
 * to its lnurlp params ({ callback, minSendable, maxSendable, ... }).
 */
export async function resolveLightningAddress(addressOrLnurl: string): Promise<LnurlPayParams> {
    const input = (addressOrLnurl || '').trim();
    let url: string;

    if (/^lnurl1[a-z0-9]+$/i.test(input)) {
        url = decodeLnurl(input);
    } else if (input.includes('@')) {
        const [username, domain] = input.split('@');
        if (!username || !domain) throw new Error('Invalid Lightning address');
        url = `https://${domain}/.well-known/lnurlp/${username}`;
    } else {
        throw new Error('Invalid Lightning address');
    }

    const data: any = await fetchLnurlJson(url, 'LNURL endpoint');
    if (data?.status === 'ERROR') throw new Error(upstreamReason(data, 'LNURL endpoint returned an error'));
    if (!data?.callback || typeof data.callback !== 'string') {
        throw new Error('LNURL endpoint returned no callback');
    }
    return data as LnurlPayParams;
}

/**
 * Request a bolt11 invoice for `amountMsats` from an LNURL-pay callback.
 * Returns { pr, verify? } — verify is the LUD-21 settlement-check URL if supported.
 */
export async function requestInvoice(params: LnurlPayParams, amountMsats: number): Promise<LnurlInvoice> {
    const min = Number(params.minSendable) || 1;
    const max = Number(params.maxSendable) || Number.MAX_SAFE_INTEGER;
    if (amountMsats < min || amountMsats > max) {
        throw new Error(`Amount out of range for this Lightning address (${Math.ceil(min / 1000)}-${Math.floor(max / 1000)} sats)`);
    }

    const url = new URL(params.callback);
    url.searchParams.set('amount', String(amountMsats));

    const data: any = await fetchLnurlJson(url.toString(), 'LNURL callback');
    if (data?.status === 'ERROR') throw new Error(upstreamReason(data, 'LNURL callback returned an error'));
    if (!data?.pr || typeof data.pr !== 'string') throw new Error('LNURL callback returned no invoice');

    return { pr: data.pr, verify: typeof data.verify === 'string' ? data.verify : undefined };
}

/**
 * Decode a bolt11 invoice — extracts payment_hash (tagged field 'p'),
 * expiry seconds (tagged field 'x', default 3600) and the hrp amount.
 * Throws on malformed input. Checksum is not verified.
 */
export function decodeBolt11(pr: string): DecodedBolt11 {
    if (!pr || typeof pr !== 'string') throw new Error('Missing bolt11 invoice');
    const lower = pr.toLowerCase().trim();
    const sep = lower.lastIndexOf('1');
    if (sep < 1) throw new Error('Malformed bolt11 invoice');

    // hrp: ln + network (bc/tb/tbs/bcrt) + optional amount + multiplier
    const hrpMatch = lower.slice(0, sep).match(/^ln(?:bc|tb|tbs|bcrt)(\d*)([munp]?)$/);
    if (!hrpMatch) throw new Error('Malformed bolt11 invoice');

    let amountMsats: bigint | null = null;
    if (hrpMatch[1]) {
        const num = BigInt(hrpMatch[1]);
        const BTC_TO_MSATS = 100_000_000_000n;
        switch (hrpMatch[2]) {
            case 'm': amountMsats = num * (BTC_TO_MSATS / 1_000n); break;
            case 'u': amountMsats = num * (BTC_TO_MSATS / 1_000_000n); break;
            case 'n': amountMsats = num * (BTC_TO_MSATS / 1_000_000_000n); break;
            case 'p': amountMsats = num / 10n; break;
            default:  amountMsats = num * BTC_TO_MSATS;
        }
    }

    const words = bech32Words(lower.slice(sep + 1));
    // Layout: timestamp (7 words) + tagged fields + signature (104 words) + checksum (6 words)
    if (words.length < 7 + 104 + 6) throw new Error('Malformed bolt11 invoice');
    const tagged = words.slice(7, words.length - 104 - 6);

    let paymentHash = '';
    let expirySeconds = 3600;
    let i = 0;
    while (i + 3 <= tagged.length) {
        const type = tagged[i];
        const len = (tagged[i + 1] << 5) | tagged[i + 2];
        const fieldData = tagged.slice(i + 3, i + 3 + len);
        if (fieldData.length < len) throw new Error('Malformed bolt11 invoice');
        if (type === 1 && len === 52) {
            // 'p' — payment hash (52 words = 260 bits -> 32 bytes)
            paymentHash = wordsToBytes(fieldData).subarray(0, 32).toString('hex');
        } else if (type === 6) {
            // 'x' — expiry in seconds (big-endian over words)
            expirySeconds = fieldData.reduce((acc, w) => acc * 32 + w, 0);
        }
        i += 3 + len;
    }

    if (!paymentHash) throw new Error('Bolt11 invoice missing payment hash');
    return { paymentHash, expirySeconds, amountMsats };
}

/**
 * LUD-21 lnurl-pay verify — check whether an invoice has been settled.
 * Returns { settled, preimage, pr }. Throws when the endpoint is unreachable.
 */
export async function verifyLud21(verifyUrl: string): Promise<Lud21Result> {
    const data: any = await fetchLnurlJson(verifyUrl, 'LNURL verify');
    if (data?.status === 'ERROR') throw new Error(upstreamReason(data, 'LNURL verify returned an error'));
    return {
        settled: data?.settled === true,
        preimage: typeof data?.preimage === 'string' && data.preimage ? data.preimage : null,
        pr: typeof data?.pr === 'string' ? data.pr : '',
    };
}
