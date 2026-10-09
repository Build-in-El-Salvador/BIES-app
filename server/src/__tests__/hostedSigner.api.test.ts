/**
 * Integration tests for the hosted signer: POST /api/signer/sign and
 * GET /api/signer/log through the real middleware chain (sanitize,
 * authenticate, rate limit, validate), with real key encryption and
 * signature checks, against a mocked Prisma client.
 *
 * Covers: the key never leaving the server, the content signed exactly as
 * sent, the allowed kinds and their rules (relay sign-in only for the BIES
 * relay, short-lived Blossom tokens, no future-dated events), refusal for
 * Nostr-native, banned and other-pubkey requests, every signature logged
 * (failing closed), and the per-account rate limit.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';

vi.hoisted(() => {
    process.env.SIGNER_AUTH_RELAYS = 'wss://app.example.test/relay';
});

vi.mock('../lib/prisma', () => ({
    default: {
        user: { findUnique: vi.fn() },
        hostedSignature: { create: vi.fn(), findMany: vi.fn() },
    },
}));

import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import prisma from '../lib/prisma';
import { generateToken } from '../middleware/auth';
import { sanitize } from '../middleware/sanitize';
import { encryptPrivateKey } from '../services/crypto.service';
import { signAsHostedUser } from '../services/hostedSigner.service';
import signerRoutes from '../routes/signer.routes';

const mockedUserFind = prisma.user.findUnique as ReturnType<typeof vi.fn>;
const mockedLogCreate = prisma.hostedSignature.create as ReturnType<typeof vi.fn>;
const mockedLogFind = prisma.hostedSignature.findMany as ReturnType<typeof vi.fn>;

// ─── Fixtures ────────────────────────────────────────────────────────────────

const secret = generateSecretKey();
const hostedPubkey = getPublicKey(secret);

const USERS: Record<string, Record<string, unknown>> = {
    hosted: {
        id: 'u-hosted', email: 'h@example.com', nostrPubkey: hostedPubkey, role: 'MEMBER', isAdmin: false,
        encryptedPrivkey: encryptPrivateKey(Buffer.from(secret).toString('hex')), isBanned: false, deletedAt: null,
    },
    native: {
        id: 'u-native', email: null, nostrPubkey: 'e'.repeat(64), role: 'MEMBER', isAdmin: false,
        encryptedPrivkey: null, isBanned: false, deletedAt: null,
    },
    // Used only by the rate-limit test, whose limiter counts per account.
    busy: {
        id: 'u-busy', email: 'busy@example.com', nostrPubkey: hostedPubkey, role: 'MEMBER', isAdmin: false,
        encryptedPrivkey: encryptPrivateKey(Buffer.from(secret).toString('hex')), isBanned: false, deletedAt: null,
    },
    banned: {
        id: 'u-banned', email: 'b@example.com', nostrPubkey: hostedPubkey, role: 'MEMBER', isAdmin: false,
        encryptedPrivkey: encryptPrivateKey(Buffer.from(secret).toString('hex')), isBanned: true, deletedAt: null,
    },
};

const tokenFor = (key: string) => generateToken(USERS[key].id as string, 'MEMBER', false);
const now = () => Math.floor(Date.now() / 1000);

// ─── Ephemeral app (same chain as index.ts) ──────────────────────────────────

let server: Server;
let base: string;

beforeAll(async () => {
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use(sanitize);
    app.use('/api/signer', signerRoutes);
    await new Promise<void>((resolve) => {
        server = app.listen(0, resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
    server?.close();
});

beforeEach(() => {
    vi.clearAllMocks();
    mockedUserFind.mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve(Object.values(USERS).find((u) => u.id === where.id) ?? null));
    mockedLogCreate.mockResolvedValue({});
});

async function sign(event: Record<string, unknown>, who = 'hosted') {
    const res = await fetch(`${base}/api/signer/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(who)}` },
        body: JSON.stringify({ event }),
    });
    return { status: res.status, body: (await res.json()) as any };
}

const note = (overrides: Record<string, unknown> = {}) => ({
    kind: 1, created_at: now(), tags: [['t', 'bies']], content: 'hello', ...overrides,
});

// ─── Signing ─────────────────────────────────────────────────────────────────

describe('POST /api/signer/sign', () => {
    it('signs with the hosted key and logs it, without revealing the key', async () => {
        const res = await sign(note());

        expect(res.status).toBe(200);
        expect(res.body.event.pubkey).toBe(hostedPubkey);
        expect(verifyEvent(res.body.event)).toBe(true);
        expect(JSON.stringify(res.body)).not.toContain(Buffer.from(secret).toString('hex'));
        expect(mockedLogCreate).toHaveBeenCalledWith({
            data: { userId: 'u-hosted', kind: 1, eventId: res.body.event.id, source: 'app' },
        });
    });

    it('signs the content exactly as sent', async () => {
        const content = '  a <b>bold</b> claim: x < y > z  ';
        const res = await sign(note({ content, tags: [['subject', ' <i>spaced</i> ']] }));

        expect(res.status).toBe(200);
        expect(res.body.event.content).toBe(content);
        expect(res.body.event.tags).toEqual([['subject', ' <i>spaced</i> ']]);
    });

    it('needs a session', async () => {
        const res = await fetch(`${base}/api/signer/sign`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event: note() }),
        });
        expect(res.status).toBe(401);
    });

    it('refuses accounts whose key BIES does not hold', async () => {
        const res = await sign(note(), 'native');
        expect(res.status).toBe(409);
        expect(res.body.reason).toBe('not_hosted');
    });

    it('refuses banned accounts', async () => {
        const res = await sign(note(), 'banned');
        expect(res.status).toBe(403);
        expect(mockedLogCreate).not.toHaveBeenCalled();
    });

    it('refuses an event for another pubkey', async () => {
        const res = await sign(note({ pubkey: 'f'.repeat(64) }));
        expect(res.status).toBe(400);
        expect(res.body.reason).toBe('wrong_pubkey');
    });

    it.each([
        [13, 'DM seals'],
        [27235, 'HTTP auth, which could sign in to other services'],
        [31777, 'passkey key backups'],
        [4, 'old-style DMs'],
        [1059, 'gift wraps'],
    ])('refuses kind %i (%s)', async (kind) => {
        const res = await sign(note({ kind }));
        expect(res.status).toBe(400);
        expect(res.body.reason).toBe('kind_not_allowed');
    });

    it('refuses events dated over an hour ago or over 10 minutes ahead', async () => {
        expect((await sign(note({ created_at: now() - 2 * 60 * 60 }))).body.reason).toBe('bad_time');
        // A future-dated profile would block every later update until then.
        expect((await sign(note({ kind: 0, created_at: now() + 20 * 60 }))).body.reason).toBe('bad_time');
        expect((await sign(note({ created_at: now() + 60 }))).status).toBe(200);
    });

    it('refuses oversized content', async () => {
        const res = await sign(note({ content: 'x'.repeat(64 * 1024 + 1) }));
        expect(res.status).toBe(400);
        expect(res.body.reason).toBe('too_large');
    });

    it('signs relay sign-ins only for the BIES relay, and does not log them', async () => {
        const auth = (relay: string, extra: Record<string, unknown> = {}) => ({
            kind: 22242, created_at: now(), content: '',
            tags: [['relay', relay], ['challenge', 'abc123']],
            ...extra,
        });

        const ok = await sign(auth('wss://app.example.test/relay/'));
        expect(ok.status).toBe(200);
        expect(mockedLogCreate).not.toHaveBeenCalled();

        const refused = async (event: Record<string, unknown>) => (await sign(event)).body.reason;
        expect(await refused(auth('wss://relay.elsewhere.test'))).toBe('bad_relay');
        // No challenge
        expect(await refused(auth('', { tags: [['relay', 'wss://app.example.test/relay']] }))).toBe('bad_relay');
        // A second relay tag: strfry accepts any match, nostr-rs-relay takes the last.
        expect(await refused(auth('', { tags: [['relay', 'wss://app.example.test/relay'], ['relay', 'wss://victim.test'], ['challenge', 'abc']] }))).toBe('bad_relay');
        expect(await refused(auth('', { tags: [['relay', 'wss://victim.test'], ['relay', 'wss://app.example.test/relay'], ['challenge', 'abc']] }))).toBe('bad_relay');
        // Extra tags, content, or a URL with a query, fragment or credentials
        expect(await refused(auth('', { tags: [['relay', 'wss://app.example.test/relay'], ['challenge', 'abc'], ['p', 'x']] }))).toBe('bad_relay');
        expect(await refused(auth('wss://app.example.test/relay', { content: 'I authorise…' }))).toBe('bad_relay');
        expect(await refused(auth('wss://app.example.test/relay?x=1'))).toBe('bad_relay');
        expect(await refused(auth('wss://app.example.test/relay#x'))).toBe('bad_relay');
        expect(await refused(auth('wss://user:pw@app.example.test/relay'))).toBe('bad_relay');
        expect(await refused(auth('', { tags: [['relay', 'wss://app.example.test/relay'], ['challenge', 'c'.repeat(257)]] }))).toBe('bad_relay');
    });

    it('signs Blossom permissions only to upload one file, expiring within a day', async () => {
        const hash = 'ab'.repeat(32);
        const blossom = (tags: string[][]) => ({ kind: 24242, created_at: now(), content: 'Upload photo.jpg', tags });
        const upload = (expiration: string) => blossom([['t', 'upload'], ['x', hash], ['expiration', expiration]]);

        expect((await sign(upload(String(now() + 300)))).status).toBe(200);

        const refused = async (event: Record<string, unknown>) => (await sign(event)).body.reason;
        expect(await refused(upload(String(now() + 2 * 24 * 60 * 60)))).toBe('bad_upload_token');
        expect(await refused(upload(String(now() - 1)))).toBe('bad_upload_token');
        expect(await refused(upload('0x7fffffff'))).toBe('bad_upload_token');
        expect(await refused(upload('1e10'))).toBe('bad_upload_token');
        expect(await refused(blossom([['t', 'delete'], ['x', hash], ['expiration', String(now() + 300)]]))).toBe('bad_upload_token');
        expect(await refused(blossom([['t', 'upload'], ['expiration', String(now() + 300)]]))).toBe('bad_upload_token');
        expect(await refused(blossom([['t', 'upload'], ['x', hash], ['expiration', String(now() + 300)], ['expiration', String(now() + 9e6)]]))).toBe('bad_upload_token');
    });

    it('releases nothing if the signature cannot be logged', async () => {
        mockedLogCreate.mockRejectedValueOnce(new Error('disk full'));
        const res = await sign(note());
        expect(res.status).toBe(500);
        expect(res.body.event).toBeUndefined();
    });

    it('validates the event shape', async () => {
        for (const event of [{ kind: 1 }, note({ tags: [[1]] }), note({ kind: 1.5 }), note({ content: 5 })]) {
            expect((await sign(event)).status).toBe(400);
        }
    });
});

// ─── Log ─────────────────────────────────────────────────────────────────────

describe('GET /api/signer/log', () => {
    const log = async (query: string) => {
        const res = await fetch(`${base}/api/signer/log${query}`, {
            headers: { Authorization: `Bearer ${tokenFor('hosted')}` },
        });
        return { status: res.status, body: (await res.json()) as any };
    };

    it('returns only this account’s signatures, newest first, capped', async () => {
        mockedLogFind.mockResolvedValue([{ id: 'c1', kind: 1, eventId: 'abc', source: 'app', createdAt: new Date() }]);

        const res = await log('?limit=5000');

        expect(res.status).toBe(200);
        expect(res.body.signatures).toHaveLength(1);
        expect(res.body.next).toBeNull();
        expect(mockedLogFind).toHaveBeenCalledWith(expect.objectContaining({
            where: { userId: 'u-hosted' },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 200,
        }));
    });

    it('pages back and filters by kind, so a burst of signatures cannot hide one', async () => {
        mockedLogFind.mockResolvedValue([
            { id: 'clxpage00000000000000001', kind: 0, eventId: 'a', source: 'app', createdAt: new Date() },
            { id: 'clxpage00000000000000002', kind: 0, eventId: 'b', source: 'app', createdAt: new Date() },
        ]);

        const res = await log('?limit=2&kind=0&before=clxpage00000000000000000');

        expect(res.body.next).toBe('clxpage00000000000000002');
        expect(mockedLogFind).toHaveBeenCalledWith(expect.objectContaining({
            where: { userId: 'u-hosted', kind: 0 },
            cursor: { id: 'clxpage00000000000000000' },
            skip: 1,
            take: 2,
        }));

        await log('?before=not-an-id;drop');
        expect(mockedLogFind).toHaveBeenLastCalledWith(expect.not.objectContaining({ cursor: expect.anything() }));
    });
});

// ─── Server-side signing for suspended accounts ──────────────────────────────

describe('signAsHostedUser', () => {
    const deletion = { kind: 5, created_at: now(), tags: [['e', 'f'.repeat(64)]], content: 'Event deleted from BIES' };

    it('still lets the server retract a banned member’s events, and logs it', async () => {
        const signed = await signAsHostedUser('u-banned', deletion, 'server');

        expect(signed && verifyEvent(signed)).toBe(true);
        expect(mockedLogCreate).toHaveBeenCalledWith({
            data: { userId: 'u-banned', kind: 5, eventId: signed!.id, source: 'server' },
        });
    });

    it('signs nothing else for them, and nothing at all for their app', async () => {
        expect(await signAsHostedUser('u-banned', { ...deletion, kind: 1 }, 'server')).toBeNull();
        expect(await signAsHostedUser('u-banned', deletion, 'app')).toBeNull();
        expect(mockedLogCreate).not.toHaveBeenCalled();
    });
});

// ─── Rate limit ──────────────────────────────────────────────────────────────

describe('rate limit', () => {
    it('allows 120 signing requests a minute per account', async () => {
        // Refused kinds are cheap and still count.
        const results = await Promise.all(Array.from({ length: 120 }, () => sign(note({ kind: 4 }), 'busy')));
        expect(results.every((r) => r.status === 400)).toBe(true);
        expect((await sign(note(), 'busy')).status).toBe(429);
        // Another account is unaffected.
        expect((await sign(note())).status).toBe(200);
    });
});
