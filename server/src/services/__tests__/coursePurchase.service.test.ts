/**
 * Unit tests for the zap-receipt purchase verification — the paywall trust
 * boundary. Fixtures are REAL signed events (nostr-tools) so signature and
 * identity checks are exercised for real; only the bolt11 decode is injected.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createHash } from 'crypto';
import {
    verifyZapReceiptForPurchase,
    courseCoordinates,
    DecodedInvoice,
    ReceiptVerifyContext,
} from '../coursePurchase.service';

let finalizeEvent: typeof import('nostr-tools/pure').finalizeEvent;
let generateSecretKey: typeof import('nostr-tools/pure').generateSecretKey;
let getPublicKey: typeof import('nostr-tools/pure').getPublicKey;

let authorSk: Uint8Array, buyerSk: Uint8Array, zapperSk: Uint8Array, attackerSk: Uint8Array;
let authorPk: string, buyerPk: string, zapperPk: string, attackerPk: string;

const COURSE_ID = 'clx0course000000000000000';
const PRICE_MSATS = 5_000_000n; // 5000 sats
const PAYMENT_HASH = 'ab'.repeat(32);

beforeAll(async () => {
    ({ finalizeEvent, generateSecretKey, getPublicKey } = await import('nostr-tools/pure'));
    authorSk = generateSecretKey();
    buyerSk = generateSecretKey();
    zapperSk = generateSecretKey();
    attackerSk = generateSecretKey();
    authorPk = getPublicKey(authorSk);
    buyerPk = getPublicKey(buyerSk);
    zapperPk = getPublicKey(zapperSk);
    attackerPk = getPublicKey(attackerSk);
});

function coordinate(): string {
    return `30004:${authorPk}:${COURSE_ID}`;
}

function makeZapRequest(opts: { sk?: Uint8Array; amount?: bigint; aTag?: string } = {}) {
    return finalizeEvent(
        {
            kind: 9734,
            created_at: Math.floor(1_700_000_000),
            tags: [
                ['relays', 'wss://relay.example.com'],
                ['amount', String(opts.amount ?? PRICE_MSATS)],
                ['p', authorPk],
                ['a', opts.aTag ?? coordinate()],
            ],
            content: '',
        },
        opts.sk ?? buyerSk
    );
}

function makeReceipt(
    request: ReturnType<typeof makeZapRequest>,
    opts: { sk?: Uint8Array; pTag?: string; bolt11?: string | null; description?: string } = {}
) {
    const description = opts.description ?? JSON.stringify(request);
    const tags: string[][] = [
        ['p', opts.pTag ?? authorPk],
        ['a', request.tags.find((t) => t[0] === 'a')?.[1] ?? coordinate()],
        ['description', description],
    ];
    if (opts.bolt11 !== null) tags.push(['bolt11', opts.bolt11 ?? 'lnbc50u1fixture']);
    return finalizeEvent(
        { kind: 9735, created_at: Math.floor(1_700_000_100), tags, content: '' },
        opts.sk ?? zapperSk
    );
}

/** Injected decoder: returns amount + hash committing to the description. */
function decodeFor(receipt: { tags: string[][] }, amountMsats = PRICE_MSATS) {
    const description = receipt.tags.find((t) => t[0] === 'description')?.[1] ?? '';
    const hash = createHash('sha256').update(description).digest('hex');
    return (): DecodedInvoice => ({ amountMsats, descriptionHashHex: hash, paymentHashHex: PAYMENT_HASH });
}

function ctx(overrides: Partial<ReceiptVerifyContext> = {}): ReceiptVerifyContext {
    return {
        authorPubkey: authorPk,
        buyerPubkey: buyerPk,
        zapperPubkey: zapperPk,
        coordinates: new Set([coordinate()]),
        ...overrides,
    };
}

describe('verifyZapReceiptForPurchase', () => {
    it('accepts a fully valid receipt and credits the bolt11 amount', async () => {
        const request = makeZapRequest();
        const receipt = makeReceipt(request);
        const sats = await verifyZapReceiptForPurchase(receipt, ctx(), decodeFor(receipt));
        expect(sats).toBe(5000);
    });

    it('rejects a self-signed receipt (signer is not the LNURL zapper key)', async () => {
        const request = makeZapRequest();
        const forged = makeReceipt(request, { sk: attackerSk });
        const sats = await verifyZapReceiptForPurchase(forged, ctx(), decodeFor(forged));
        expect(sats).toBe(0);
    });

    it('rejects a receipt whose signature is tampered', async () => {
        const request = makeZapRequest();
        const receipt = makeReceipt(request);
        const tampered = { ...receipt, content: 'tampered' };
        const sats = await verifyZapReceiptForPurchase(tampered, ctx(), decodeFor(tampered));
        expect(sats).toBe(0);
    });

    it('rejects when the zap request was signed by someone other than the buyer', async () => {
        const request = makeZapRequest({ sk: attackerSk });
        const receipt = makeReceipt(request);
        const sats = await verifyZapReceiptForPurchase(receipt, ctx(), decodeFor(receipt));
        expect(sats).toBe(0);
    });

    it('rejects when the coordinate targets a different course', async () => {
        const request = makeZapRequest({ aTag: `30004:${authorPk}:someothercourse` });
        const receipt = makeReceipt(request);
        const sats = await verifyZapReceiptForPurchase(receipt, ctx(), decodeFor(receipt));
        expect(sats).toBe(0);
    });

    it('rejects when the recipient p-tag is not the author', async () => {
        const request = makeZapRequest();
        const receipt = makeReceipt(request, { pTag: attackerPk });
        const sats = await verifyZapReceiptForPurchase(receipt, ctx(), decodeFor(receipt));
        expect(sats).toBe(0);
    });

    it('rejects a receipt without a bolt11 invoice (amount tag is never trusted)', async () => {
        const request = makeZapRequest();
        const receipt = makeReceipt(request, { bolt11: null });
        const sats = await verifyZapReceiptForPurchase(receipt, ctx(), decodeFor(receipt));
        expect(sats).toBe(0);
    });

    it('rejects when the bolt11 description-hash does not commit to the request', async () => {
        const request = makeZapRequest();
        const receipt = makeReceipt(request);
        const wrongHash = (): DecodedInvoice => ({
            amountMsats: PRICE_MSATS,
            descriptionHashHex: createHash('sha256').update('unrelated').digest('hex'),
            paymentHashHex: PAYMENT_HASH,
        });
        const sats = await verifyZapReceiptForPurchase(receipt, ctx(), wrongHash);
        expect(sats).toBe(0);
    });

    it('rejects when the invoice has no description-hash at all', async () => {
        const request = makeZapRequest();
        const receipt = makeReceipt(request);
        const noHash = (): DecodedInvoice => ({ amountMsats: PRICE_MSATS, descriptionHashHex: null, paymentHashHex: PAYMENT_HASH });
        const sats = await verifyZapReceiptForPurchase(receipt, ctx(), noHash);
        expect(sats).toBe(0);
    });

    it('rejects an invoice with no payment hash', async () => {
        const request = makeZapRequest();
        const receipt = makeReceipt(request);
        const bound = decodeFor(receipt)();
        const sats = await verifyZapReceiptForPurchase(receipt, ctx(), () => ({ ...bound, paymentHashHex: null }));
        expect(sats).toBe(0);
    });

    it('rejects amount inflation (request amount tag ≠ real invoice amount)', async () => {
        // Buyer claims 5000 sats in the request but the invoice only paid 10
        const request = makeZapRequest({ amount: PRICE_MSATS });
        const receipt = makeReceipt(request);
        const sats = await verifyZapReceiptForPurchase(receipt, ctx(), decodeFor(receipt, 10_000n));
        expect(sats).toBe(0);
    });

    it('rejects a replayed receipt claimed by a different buyer', async () => {
        // attacker tries to claim the buyer's legitimate receipt
        const request = makeZapRequest();
        const receipt = makeReceipt(request);
        const sats = await verifyZapReceiptForPurchase(
            receipt,
            ctx({ buyerPubkey: attackerPk }),
            decodeFor(receipt)
        );
        expect(sats).toBe(0);
    });

    it('rejects wrong-kind events outright', async () => {
        const request = makeZapRequest();
        const notAReceipt = finalizeEvent(
            { kind: 1, created_at: 1_700_000_100, tags: [['p', authorPk]], content: JSON.stringify(request) },
            zapperSk
        );
        const sats = await verifyZapReceiptForPurchase(notAReceipt as any, ctx(), decodeFor(notAReceipt as any));
        expect(sats).toBe(0);
    });
});

describe('courseCoordinates', () => {
    it('includes the 30004 course list and every 30402 lesson coordinate', () => {
        const set = courseCoordinates(authorPk, COURSE_ID, ['lsn1', 'lsn2']);
        expect(set.has(`30004:${authorPk}:${COURSE_ID}`)).toBe(true);
        expect(set.has(`30402:${authorPk}:lsn1`)).toBe(true);
        expect(set.has(`30402:${authorPk}:lsn2`)).toBe(true);
        expect(set.size).toBe(3);
    });
});
