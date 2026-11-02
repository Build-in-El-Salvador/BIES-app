/**
 * The zap receipt indexer (zap.service.ts) stores a receipt, and counts it
 * towards a project's raised total, only when it verifies (zapReceipt.ts):
 * signed by the recipient's Lightning provider, with an invoice bound to the
 * zap request inside it, for the invoice's amount. Real signed events
 * (nostr-tools); only the bolt11 decode is injected. Real SQLite database
 * built from the repo's migrations.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const env = vi.hoisted(() => {
    const dir = `${process.env.TMPDIR || '/tmp'}/bies-zap-indexer-test-${process.pid}-${Date.now()}`;
    process.env.DATABASE_URL = `file:${dir}/test.db`;
    process.env.RELAY_WHITELIST_PATH = `${dir}/relay/whitelist.txt`;
    process.env.UPLOAD_DIR = `${dir}/uploads`;
    process.env.APP_PUBLIC_URL = 'https://app.example.test';
    process.env.TERMS_VERSION = '2026-10';
    return { dir, zapper: '', signsZaps: true };
});

// The recipient's Lightning provider: signs zaps with `env.zapper`.
vi.mock('../services/zapReceipt', async (original) => ({
    ...(await original<typeof import('../services/zapReceipt')>()),
    getLnurlPayMetadata: vi.fn(async () => ({
        callback: 'https://ln.example.test/cb', allowsNostr: env.signsZaps, nostrPubkey: env.zapper, minSendable: 1000, maxSendable: 1e11,
    })),
}));
vi.mock('nostr-tools/pool', () => ({
    SimplePool: class {
        publish(urls: string[]) { return urls.map(() => Promise.resolve('')); }
        async querySync() { return []; }
        subscribeMany() { return { close() {} }; }
    },
}));
vi.mock('../services/email.service', () => ({ sendEmail: vi.fn(async () => {}) }));

import { execSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import prisma from '../lib/prisma';
import { processZapReceipt } from '../services/zap.service';
import type { DecodedInvoice } from '../services/zapReceipt';

let pure: typeof import('nostr-tools/pure');
let recipientSk: Uint8Array, senderSk: Uint8Array, zapperSk: Uint8Array, otherSk: Uint8Array;
let recipientPk: string;
let projectId: string;
const NOTE_ID = 'f'.repeat(64);
const AMOUNT = 2_100_000n; // 2,100 sats

beforeAll(async () => {
    fs.mkdirSync(env.dir, { recursive: true });
    execSync('npx prisma migrate deploy', { cwd: path.resolve(__dirname, '../..'), env: process.env, stdio: 'pipe' });
    pure = await import('nostr-tools/pure');
    [recipientSk, senderSk, zapperSk, otherSk] = [0, 1, 2, 3].map(() => pure.generateSecretKey());
    recipientPk = pure.getPublicKey(recipientSk);
    env.zapper = pure.getPublicKey(zapperSk);
    const owner = await prisma.user.create({
        data: {
            nostrPubkey: recipientPk, termsVersion: '2026-10', termsAcceptedAt: new Date(),
            profile: { create: { name: 'Builder', lightningAddress: 'builder@ln.example.test' } },
        },
    });
    projectId = (await prisma.project.create({
        data: { ownerId: owner.id, title: 'A project', description: 'What it is.', nostrEventId: NOTE_ID },
    })).id;
}, 120_000);

afterAll(async () => {
    await prisma.$disconnect();
    fs.rmSync(env.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

let seq = 0;
function zapRequest({ sk = senderSk, amount = AMOUNT }: { sk?: Uint8Array; amount?: bigint } = {}) {
    return pure.finalizeEvent({
        kind: 9734, created_at: 1_700_000_000 + ++seq,
        tags: [['relays', 'wss://relay.example.test'], ['amount', String(amount)], ['p', recipientPk], ['e', NOTE_ID]],
        content: 'Go team',
    }, sk);
}

function receipt(request: ReturnType<typeof zapRequest>, { sk = zapperSk }: { sk?: Uint8Array } = {}) {
    return pure.finalizeEvent({
        kind: 9735, created_at: 1_700_000_100 + ++seq,
        tags: [['p', recipientPk], ['e', NOTE_ID], ['bolt11', 'lnbc21u1fixture'], ['description', JSON.stringify(request)]],
        content: '',
    }, sk);
}

/** An invoice for `amount`, committing to the receipt's own request (or to other words). */
const invoice = (r: { tags: string[][] }, { amount = AMOUNT, boundTo }: { amount?: bigint; boundTo?: string } = {}) => (): DecodedInvoice => ({
    amountMsats: amount,
    descriptionHashHex: createHash('sha256').update(boundTo ?? r.tags.find((t) => t[0] === 'description')![1]).digest('hex'),
});

const raised = async () => (await prisma.project.findUnique({ where: { id: projectId } }))!.raisedAmount;
const stored = (id: string) => prisma.zapReceipt.findUnique({ where: { eventId: id } });

describe('the zap receipt indexer', () => {
    it('stores a receipt from the recipient\'s Lightning provider and counts the invoice\'s amount', async () => {
        const before = await raised();
        const r = receipt(zapRequest());
        await processZapReceipt(r, invoice(r));
        const row = await stored(r.id);
        expect(row).toMatchObject({ amountSats: 2100, senderPubkey: pure.getPublicKey(senderSk), projectId, comment: 'Go team' });
        expect(await raised()).toBe(before + 2100);

        // The same receipt again counts once.
        await processZapReceipt(r, invoice(r));
        expect(await raised()).toBe(before + 2100);
    });

    it('leaves out a receipt signed by anyone but that provider', async () => {
        const before = await raised();
        const r = receipt(zapRequest(), { sk: otherSk });
        await processZapReceipt(r, invoice(r));
        expect(await stored(r.id)).toBeNull();
        expect(await raised()).toBe(before);
    });

    it('leaves out a receipt whose invoice is for another request, or for no amount', async () => {
        const before = await raised();
        const a = receipt(zapRequest());
        await processZapReceipt(a, invoice(a, { boundTo: 'another request' }));
        const b = receipt(zapRequest());
        await processZapReceipt(b, invoice(b, { amount: 0n }));
        expect(await stored(a.id)).toBeNull();
        expect(await stored(b.id)).toBeNull();
        expect(await raised()).toBe(before);
    });

    it('counts only what the invoice is for: a request naming another amount is left out', async () => {
        const before = await raised();
        const r = receipt(zapRequest({ amount: AMOUNT * 100n }));
        await processZapReceipt(r, invoice(r));
        expect(await stored(r.id)).toBeNull();
        expect(await raised()).toBe(before);
    });

    it('counts nothing for someone whose Lightning address doesn\'t sign zaps', async () => {
        env.signsZaps = false;
        try {
            const r = receipt(zapRequest());
            await processZapReceipt(r, invoice(r));
            expect(await stored(r.id)).toBeNull();
        } finally {
            env.signsZaps = true;
        }
    });
});
