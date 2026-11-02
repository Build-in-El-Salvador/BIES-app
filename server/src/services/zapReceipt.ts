/**
 * Zap receipts (NIP-57) a payment can be trusted on. A kind-9735 receipt is
 * anyone's to sign, so one counts only when:
 *
 *   1. it is signed by the zapper key the recipient's LNURL provider
 *      advertises (NIP-57 Appendix F), and is for that recipient
 *   2. the kind-9734 zap request inside it is validly signed and for the same
 *      recipient
 *   3. it carries a bolt11 invoice whose description_hash commits to that
 *      exact request; the amount is the invoice's (a request's `amount` tag
 *      must agree, and is never used on its own)
 *
 * Course purchases (coursePurchase.service.ts) check this and more; the
 * receipt indexer (zap.service.ts) stores and counts only receipts that pass.
 */

import { createHash } from 'crypto';
import { decode as decodeBolt11 } from 'light-bolt11-decoder';
import type { Event } from 'nostr-tools/pure';
import { cache } from './redis.service';
import { safeGetJson } from '../utils/safeFetch';

const LNURL_CACHE_TTL = 3600; // 1h
const LNURL_TIMEOUT_MS = 8000;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LnurlPayMetadata {
    callback: string;
    allowsNostr: boolean;
    nostrPubkey: string | null;
    minSendable: number;
    maxSendable: number;
}

/** Decoded bolt11 fields relevant to zap verification. */
export interface DecodedInvoice {
    amountMsats: bigint;
    /** hex sha256 the invoice commits to (description_hash), or null. */
    descriptionHashHex: string | null;
}

/** A receipt that passed: the invoice's amount and the zap request inside it. */
export interface VerifiedZap {
    amountMsats: bigint;
    /** The kind-9734 request: its pubkey is who paid, its content their comment. */
    request: Event;
    /** The exact request JSON the invoice commits to. */
    description: string;
}

// ─── LNURL metadata (cached) ─────────────────────────────────────────────────

/**
 * Fetch and cache the LNURL-pay metadata for a lud16 address. The
 * `nostrPubkey` field is the trust anchor for receipt verification.
 */
export async function getLnurlPayMetadata(
    lightningAddress: string
): Promise<LnurlPayMetadata | null> {
    const match = /^([a-z0-9._%+-]+)@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(
        (lightningAddress || '').trim()
    );
    if (!match) return null;
    const [, name, domain] = match;

    const cKey = `lnurlp:${name.toLowerCase()}@${domain.toLowerCase()}`;
    const cached = await cache.getJson<LnurlPayMetadata>(cKey);
    if (cached) return cached;

    try {
        // SSRF-hardened: `domain` comes from a user-controlled lightningAddress,
        // so this fetch validates every resolved IP against private/reserved
        // ranges and pins it to the socket (see safeGetJson). https-only.
        const data: any = await safeGetJson(
            `https://${domain}/.well-known/lnurlp/${encodeURIComponent(name)}`,
            LNURL_TIMEOUT_MS
        );
        if (!data?.callback) return null;

        const meta: LnurlPayMetadata = {
            callback: String(data.callback),
            allowsNostr: Boolean(data.allowsNostr),
            nostrPubkey:
                typeof data.nostrPubkey === 'string' && /^[0-9a-f]{64}$/i.test(data.nostrPubkey)
                    ? data.nostrPubkey.toLowerCase()
                    : null,
            minSendable: Number(data.minSendable) || 1000,
            maxSendable: Number(data.maxSendable) || 100_000_000_000,
        };
        await cache.setJson(cKey, meta, LNURL_CACHE_TTL);
        return meta;
    } catch {
        return null;
    }
}

// ─── Invoice decoding ────────────────────────────────────────────────────────

/** Decode a bolt11 invoice's amount + description_hash (null on failure). */
export function decodeInvoice(bolt11: string): DecodedInvoice | null {
    try {
        const decoded = decodeBolt11(bolt11);
        let amountMsats = 0n;
        let descriptionHashHex: string | null = null;
        // The lib's d.ts section union omits description_hash; the JS emits it.
        for (const section of (decoded.sections ?? []) as Array<{ name: string; value?: unknown }>) {
            if (section.name === 'amount') amountMsats = BigInt(String(section.value));
            if (section.name === 'description_hash' && section.value) {
                descriptionHashHex = String(section.value).toLowerCase();
            }
        }
        return { amountMsats, descriptionHashHex };
    } catch {
        return null;
    }
}

// ─── Verification ────────────────────────────────────────────────────────────

export function firstTag(event: Event, name: string): string | null {
    const tag = event.tags.find((t) => t[0] === name);
    return tag?.[1] ?? null;
}

/**
 * Check a kind-9735 receipt (1–3 above) for a recipient whose LNURL provider
 * signs with `zapperPubkey`. The verified zap, or null if ANY check fails.
 */
export async function verifyZapReceipt(
    receipt: Event,
    { zapperPubkey, recipientPubkey }: { zapperPubkey: string; recipientPubkey: string },
    decode: (bolt11: string) => DecodedInvoice | null = decodeInvoice
): Promise<VerifiedZap | null> {
    try {
        // Plain-JSON clone: strips nostr-tools' cached-verification symbol so
        // signature checks below are always real, regardless of the source.
        receipt = JSON.parse(JSON.stringify(receipt)) as Event;
        if (receipt.kind !== 9735) return null;

        // 1. Signed by the recipient's LNURL provider's zapper key, for them.
        if (!zapperPubkey || receipt.pubkey.toLowerCase() !== zapperPubkey.toLowerCase()) return null;
        const { verifyEvent } = await import('nostr-tools/pure');
        if (!verifyEvent(receipt)) return null;
        if (firstTag(receipt, 'p') !== recipientPubkey) return null;

        // 2. The zap request inside it: validly signed, for the same recipient.
        const description = firstTag(receipt, 'description');
        if (!description) return null;
        let request: Event;
        try {
            request = JSON.parse(description) as Event;
        } catch {
            return null;
        }
        if (request.kind !== 9734) return null;
        if (!verifyEvent(request)) return null;
        if (firstTag(request, 'p') !== recipientPubkey) return null;

        // 3. bolt11 binding: description_hash commits to this exact request,
        //    amount comes from the invoice — never from client-supplied tags.
        const bolt11 = firstTag(receipt, 'bolt11');
        if (!bolt11) return null;
        const decoded = decode(bolt11);
        if (!decoded || decoded.amountMsats <= 0n) return null;
        if (!decoded.descriptionHashHex) return null;
        const expectedHash = createHash('sha256').update(description).digest('hex');
        if (decoded.descriptionHashHex !== expectedHash) return null;

        // Cross-check the request's declared amount when present.
        const requestAmount = firstTag(request, 'amount');
        if (requestAmount && BigInt(requestAmount) !== decoded.amountMsats) return null;

        return { amountMsats: decoded.amountMsats, request, description };
    } catch {
        return null;
    }
}
