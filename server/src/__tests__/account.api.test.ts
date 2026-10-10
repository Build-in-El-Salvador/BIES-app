/**
 * Deleting an account and taking its key, end to end: real routes,
 * middleware and WebSockets against a real SQLite database built from the
 * repo's migrations, so the cascade is the one production runs. Relays and
 * email are stand-ins that record what was sent.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const env = vi.hoisted(() => {
    const dir = `${process.env.TMPDIR || '/tmp'}/bies-account-test-${process.pid}-${Date.now()}`;
    process.env.DATABASE_URL = `file:${dir}/test.db`;
    process.env.RELAY_WHITELIST_PATH = `${dir}/relay/whitelist.txt`;
    process.env.CORS_ORIGIN = 'https://app.example.test';
    process.env.CORS_NATIVE_ORIGIN = 'capacitor://localhost,https://localhost';
    process.env.NOSTR_PRIVATE_RELAY = 'ws://bies-relay.test:7777';
    process.env.NOSTR_RELAYS = 'wss://public-one.test,wss://public-two.test';
    process.env.EMAIL_SUPPORT_ADDRESS = 'help@example.test';
    // App Review signs in with a fixed code (APP-DEPLOY-RUNBOOK.md).
    process.env.REVIEW_LOGIN_EMAIL = 'appreview@example.test';
    process.env.REVIEW_LOGIN_CODE = '424242';
    // ADMIN_KEY_HEX's pubkey.
    process.env.ADMIN_PUBKEYS = '545c276d06c4c1ef35376e89217fbe8411e5acf1e9a794a0e2ea28f66774eff6';
    return { dir };
});

const ADMIN_KEY_HEX = '7f3c1e2d4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0';

// Relays: what each one holds, and everything published to any of them.
const relays = vi.hoisted(() => {
    type Ev = { id: string; pubkey: string; kind: number; created_at: number; tags: string[][] };
    const stored = new Map<string, Ev[]>();
    const published: { relay: string; event: Ev }[] = [];
    // Pubkeys whose events can't be looked up, or whose requests every relay refuses.
    const failQueriesFor = new Set<string>();
    const refusePublishFor = new Set<string>();
    class SimplePool {
        async querySync(urls: string[], filter: { authors?: string[]; until?: number; limit?: number }) {
            if (filter.authors?.some((a) => failQueriesFor.has(a))) throw new Error('relays unreachable');
            const found = urls.flatMap((url) => stored.get(url) ?? [])
                .filter((e) => !filter.authors || filter.authors.includes(e.pubkey))
                .filter((e) => filter.until === undefined || e.created_at <= filter.until)
                .sort((a, b) => b.created_at - a.created_at);
            return filter.limit ? found.slice(0, filter.limit) : found;
        }
        publish(urls: string[], event: Ev) {
            return urls.map((relay) => {
                if (refusePublishFor.has(event.pubkey)) return Promise.reject(new Error('blocked: rate-limited'));
                published.push({ relay, event });
                return Promise.resolve('');
            });
        }
        async get() {
            return null;
        }
    }
    return { stored, published, failQueriesFor, refusePublishFor, SimplePool };
});
vi.mock('nostr-tools/pool', () => ({ SimplePool: relays.SimplePool }));

const mail = vi.hoisted(() => ({ sent: [] as { to: string; subject: string; text: string; replyTo?: string }[] }));
vi.mock('../services/email.service', () => ({
    sendEmail: vi.fn(async (message: (typeof mail.sent)[number]) => { mail.sent.push(message); }),
}));

import { execSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import express from 'express';
import WebSocket from 'ws';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from 'nostr-tools/pure';
import prisma from '../lib/prisma';
import authRoutes from '../routes/auth.routes';
import accountRoutes from '../routes/account.routes';
import signerRoutes from '../routes/signer.routes';
import profileRoutes from '../routes/profile.routes';
import adminRoutes from '../routes/admin.routes';
import voucherRoutes from '../routes/voucher.routes';
import { auditLog } from '../middleware/audit';
import { sanitize } from '../middleware/sanitize';
import { attachWebSocketServer, WS_PROTOCOL } from '../services/websocket.service';
import { PURGE_DIR, WHITELIST_PATH } from '../services/relayWhitelist.service';
import { renderCodeEmail } from '../services/emailCode.service';
import { checkSignedChallenge, deleteAccount, issueChallenge } from '../services/account.service';
import { cache, cacheKey } from '../services/redis.service';
import { exportHostedKey } from '../services/hostedSigner.service';
import { createSession, signAccessToken } from '../services/session.service';

const NATIVE = 'capacitor://localhost';
const PRIVATE_RELAY = 'ws://bies-relay.test:7777';
const PUBLIC_ONE = 'wss://public-one.test';

let server: http.Server;
let base: string;

beforeAll(async () => {
    fs.mkdirSync(env.dir, { recursive: true });
    execSync('npx prisma migrate deploy', { cwd: path.resolve(__dirname, '../..'), env: process.env, stdio: 'pipe' });

    const app = express();
    app.set('trust proxy', 1);
    // index.ts's order: body parsing, sanitize, audit, routes.
    app.use(express.json());
    app.use(sanitize);
    app.use(auditLog);
    app.use('/api/auth', authRoutes);
    app.use('/api/account', accountRoutes);
    app.use('/api/signer', signerRoutes);
    app.use('/api/profiles', profileRoutes);
    app.use('/api/admin', adminRoutes);
    app.use('/api/vouchers', voucherRoutes);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    attachWebSocketServer(server);
}, 120_000);

afterAll(async () => {
    server?.close();
    await prisma.$disconnect();
    fs.rmSync(env.dir, { recursive: true, force: true });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const now = () => Math.floor(Date.now() / 1000);

async function call(
    method: string,
    url: string,
    { token, body, ip = '203.0.113.10' }: { token?: string; body?: unknown; ip?: string } = {},
) {
    const res = await fetch(`${base}${url}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            Origin: NATIVE,
            'X-Forwarded-For': ip,
            'User-Agent': 'account-test',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any, headers: res.headers };
}

/** The code in the last email to this address. */
function lastCode(to: string): string {
    const message = [...mail.sent].reverse().find((m) => m.to === to);
    return /(\d{6})$/.exec(message!.subject)![1];
}

/** Codes sent so far no longer hold back the next one (a minute passes). */
async function aMinuteLater() {
    await prisma.emailCode.updateMany({ data: { createdAt: new Date(Date.now() - 2 * 60 * 1000) } });
}

async function signInByEmail(email: string) {
    expect((await call('POST', '/api/auth/email/start', { body: { email } })).status).toBe(200);
    const r = await call('POST', '/api/auth/email/verify', { body: { email, code: lastCode(email) } });
    expect([200, 201]).toContain(r.status);
    return r.body as { token: string; user: { id: string; nostrPubkey: string; hostedKey: boolean } };
}

async function signInByNostr(secretKey: Uint8Array) {
    const pubkey = getPublicKey(secretKey);
    const { body } = await call('GET', `/api/auth/nostr-challenge?pubkey=${pubkey}`);
    const signedEvent = finalizeEvent({ kind: 27235, created_at: now(), tags: [], content: body.challenge }, secretKey);
    const r = await call('POST', '/api/auth/nostr-login', { body: { pubkey, signedEvent } });
    return r as { status: number; body: { token: string; user: { id: string; nostrPubkey: string; hostedKey: boolean } } };
}

/** Another device of the same member: a second session. */
async function secondDevice(userId: string) {
    const session = await createSession(userId, 'native');
    return signAccessToken({ id: userId, role: 'MEMBER', isAdmin: false }, session.sessionId);
}

function confirmation(secretKey: Uint8Array, purpose: string, challenge: string) {
    return finalizeEvent({
        kind: 27235,
        created_at: now(),
        tags: [['challenge', challenge], ['purpose', purpose]],
        content: 'Confirm',
    }, secretKey);
}

function openSocket(token: string) {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws', [WS_PROTOCOL, token]);
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    const connected = new Promise<void>((resolve) => ws.on('message', (data) => {
        if (JSON.parse(String(data)).type === 'connected') resolve();
    }));
    return { ws, closed, connected };
}

/** Events this member published, as relays would hold them. */
function publishedBy(secretKey: Uint8Array, relay: string, templates: { kind: number; tags?: string[][] }[]) {
    const events = templates.map((t, i) => finalizeEvent({ kind: t.kind, created_at: now() - 100 + i, tags: t.tags ?? [], content: `#${i}` }, secretKey));
    relays.stored.set(relay, [...(relays.stored.get(relay) ?? []), ...events]);
    return events;
}

/** Retraction requests (NIP-09 kind 5, NIP-62 kind 62) published for a pubkey since `since`. */
const retractions = (since: number, pubkey: string) =>
    relays.published.slice(since).filter((p) => p.event.pubkey === pubkey && (p.event.kind === 5 || p.event.kind === 62));

const whitelisted = (pubkey: string) =>
    fs.existsSync(WHITELIST_PATH) && fs.readFileSync(WHITELIST_PATH, 'utf8').split('\n').includes(pubkey);

// ─── Deleting an email account ────────────────────────────────────────────────

describe('deleting an email account', () => {
    it('erases it and its key, asks relays to forget it, and confirms by email', async () => {
        const email = 'alice@example.test';
        const alice = await signInByEmail(email);
        const row = await prisma.user.findUniqueOrThrow({ where: { id: alice.user.id } });
        const pubkey = row.nostrPubkey;
        expect(row.encryptedPrivkey).toBeTruthy();
        expect(whitelisted(pubkey)).toBe(true);

        // Bob, who must be left as he is.
        const bob = await signInByNostr(generateSecretKey());
        expect(bob.status).toBe(200);

        // What Alice has, and what ties her to Bob.
        await prisma.feedback.create({ data: { userId: alice.user.id, message: 'hi' } });
        await prisma.notification.create({ data: { userId: alice.user.id, type: 'SYSTEM', title: 't', body: 'b' } });
        await prisma.deviceToken.create({ data: { userId: alice.user.id, token: 'apns-alice' } });
        await prisma.pushSubscription.create({ data: { userId: alice.user.id, endpoint: 'https://push.test/a', p256dh: 'p', auth: 'a' } });
        await prisma.follow.create({ data: { followerId: bob.body.user.id, followingId: alice.user.id } });
        await prisma.message.create({ data: { senderId: alice.user.id, recipientId: bob.body.user.id, content: 'hello bob' } });
        await prisma.message.create({ data: { senderId: bob.body.user.id, recipientId: bob.body.user.id, content: 'note to self' } });

        // What she published: on BIES's relay, and one more only on a public relay.
        const secretKeyHex = await exportHostedKey(alice.user.id);
        const aliceKey = Uint8Array.from(Buffer.from(secretKeyHex!, 'hex'));
        const onBies = publishedBy(aliceKey, PRIVATE_RELAY, [{ kind: 1 }, { kind: 1 }, { kind: 0 }, { kind: 30402, tags: [['d', 'stall-1']] }]);
        const onPublic = publishedBy(aliceKey, PUBLIC_ONE, [{ kind: 1 }]);
        const before = relays.published.length;

        const socket = openSocket(alice.token);
        await socket.connected;

        const start = await call('POST', '/api/account/delete/start', { token: alice.token, body: { lang: 'en' } });
        expect(start.status).toBe(200);
        expect(start.body).toMatchObject({ method: 'email', email });
        expect(mail.sent.at(-1)!.subject).toMatch(/^Your code to delete your BIES account: \d{6}$/);

        // A wrong code does nothing.
        const wrong = await call('POST', '/api/account/delete', { token: alice.token, body: { code: lastCode(email) === '000000' ? '111111' : '000000' } });
        expect(wrong.status).toBe(400);
        expect(wrong.body.reason).toBe('invalid_code');
        expect(await prisma.user.findUnique({ where: { id: alice.user.id } })).not.toBeNull();

        const done = await call('POST', '/api/account/delete', { token: alice.token, body: { code: lastCode(email), lang: 'en' } });
        expect(done.status).toBe(200);
        expect(done.body).toEqual({ deleted: true, emailed: true });

        // Gone, with everything that hangs off the account.
        const id = alice.user.id;
        expect(await prisma.user.findUnique({ where: { id } })).toBeNull();
        expect(await prisma.profile.count({ where: { userId: id } })).toBe(0);
        expect(await prisma.session.count({ where: { userId: id } })).toBe(0);
        expect(await prisma.feedback.count({ where: { userId: id } })).toBe(0);
        expect(await prisma.notification.count({ where: { userId: id } })).toBe(0);
        expect(await prisma.deviceToken.count({ where: { userId: id } })).toBe(0);
        expect(await prisma.pushSubscription.count({ where: { userId: id } })).toBe(0);
        expect(await prisma.follow.count({ where: { followingId: id } })).toBe(0);
        expect(await prisma.message.count({ where: { senderId: id } })).toBe(0);
        expect(await prisma.hostedSignature.count({ where: { userId: id } })).toBe(0);

        // Bob keeps his account and his own message.
        expect(await prisma.user.findUnique({ where: { id: bob.body.user.id } })).not.toBeNull();
        expect(await prisma.message.count({ where: { senderId: bob.body.user.id } })).toBe(1);

        // The audit trail keeps what happened, but not where from.
        const trail = await prisma.auditLog.findMany();
        const hers = trail.filter((a) => a.action === 'AUTH_EMAIL_LOGIN' && a.userId === null);
        expect(hers.length).toBeGreaterThan(0);
        for (const a of hers) {
            expect(a.ipAddress).toBeNull();
            expect(a.userAgent).toBeNull();
        }
        const record = trail.find((a) => a.action === 'ACCOUNT_DELETED' && a.resource === `user:${id}`);
        expect(record).toMatchObject({ userId: null, ipAddress: null, userAgent: null });

        // Signed out everywhere, at once.
        expect(await socket.closed).toBe(4003);
        expect((await call('GET', '/api/auth/me', { token: alice.token })).status).toBe(401);

        // Relays: off the whitelist, BIES's relay asked to delete everything,
        // and the public relays asked to forget her, signed with her key.
        expect(whitelisted(pubkey)).toBe(false);
        expect(fs.existsSync(path.join(PURGE_DIR, pubkey))).toBe(true);
        const sent = relays.published.slice(before);
        expect(sent.length).toBeGreaterThan(0);
        expect(sent.every((s) => s.relay !== PRIVATE_RELAY)).toBe(true);
        for (const { event } of sent) {
            expect(event.pubkey).toBe(pubkey);
            expect(verifyEvent(event as Event)).toBe(true);
        }
        const vanish = sent.find((s) => s.event.kind === 62)!.event;
        expect(vanish.tags).toEqual([['relay', 'ALL_RELAYS']]);
        const deletions = [...new Map(sent.filter((s) => s.event.kind === 5).map((s) => [s.event.id, s.event])).values()];
        const retracted = new Set(deletions.flatMap((d) => d.tags.filter((t) => t[0] === 'e').map((t) => t[1])));
        for (const e of [...onBies, ...onPublic]) expect(retracted.has(e.id)).toBe(true);
        const addresses = deletions.flatMap((d) => d.tags.filter((t) => t[0] === 'a').map((t) => t[1]));
        expect(addresses).toContain(`0:${pubkey}:`);
        expect(addresses).toContain(`30402:${pubkey}:stall-1`);
        const relaysAsked = new Set(sent.map((s) => s.relay));
        expect(relaysAsked).toContain(PUBLIC_ONE);
        expect(relaysAsked).toContain('wss://relay.damus.io');

        // Confirmed by email, with somewhere to write back.
        const confirmationEmail = mail.sent.at(-1)!;
        expect(confirmationEmail).toMatchObject({ to: email, subject: 'Your BIES account has been deleted', replyTo: 'help@example.test' });
        expect(confirmationEmail.text).toContain('destroyed the Nostr key');
        expect(confirmationEmail.text).toContain('asked other Nostr relays');
        expect(confirmationEmail.text).toContain('your posts on the BIES relay');
        expect(confirmationEmail.text).toContain('within 90 days');

        // The address is free again: signing up makes a new account and key.
        await aMinuteLater();
        const again = await signInByEmail(email);
        expect(again.user.id).not.toBe(id);
        expect(again.user.nostrPubkey).not.toBe(pubkey);
    });

    it("can't be confirmed with a code sent for something else", async () => {
        const email = 'carol@example.test';
        const carol = await signInByEmail(email);
        const loginCode = lastCode(email);

        await call('POST', '/api/account/delete/start', { token: carol.token });
        const r = await call('POST', '/api/account/delete', { token: carol.token, body: { code: loginCode } });
        expect(r.status).toBe(400);
        expect(await prisma.user.findUnique({ where: { id: carol.user.id } })).not.toBeNull();

        // Nor does a deletion code sign anyone in.
        const signIn = await call('POST', '/api/auth/email/verify', { body: { email, code: lastCode(email) } });
        expect(signIn.status).toBe(400);
    });

    it('can be started straight after signing in', async () => {
        // App Review signs in and goes straight to Delete account.
        const email = 'reviewer@example.test';
        const reviewer = await signInByEmail(email);
        const start = await call('POST', '/api/account/delete/start', { token: reviewer.token });
        expect(start.status).toBe(200);
    });
});

// ─── An admin purging an account ─────────────────────────────────────────────

describe('an admin purge', () => {
    async function trashed(email: string) {
        const member = await signInByEmail(email);
        const id = member.user.id;
        await prisma.profile.update({ where: { userId: id }, data: { name: 'Frank Example' } });
        const admin = await signInByNostr(Uint8Array.from(Buffer.from(ADMIN_KEY_HEX, 'hex')));
        expect((await call('DELETE', `/api/admin/users/${id}`, { token: admin.body.token })).status).toBe(200);
        return { id, pubkey: member.user.nostrPubkey, adminToken: admin.body.token };
    }

    it('erases the account but leaves its events alone by default (a merged account’s events live on)', async () => {
        const { id, pubkey, adminToken } = await trashed('frank@example.test');
        const before = relays.published.length;
        const mailBefore = mail.sent.length;

        expect((await call('DELETE', `/api/admin/users/${id}/purge`, { token: adminToken })).status).toBe(200);

        expect(await prisma.user.findUnique({ where: { id } })).toBeNull();
        expect(retractions(before, pubkey)).toHaveLength(0);
        expect(fs.existsSync(path.join(PURGE_DIR, pubkey))).toBe(false);
        expect(mail.sent.length).toBe(mailBefore);
        // Trashing recorded the name; the purge keeps what happened, not who.
        const trashedRow = await prisma.auditLog.findFirstOrThrow({ where: { action: 'USER_TRASHED', resource: `user:${id}` } });
        expect(trashedRow.metadata).not.toContain('Frank');
        expect(trashedRow.metadata).not.toContain(pubkey);
    });

    it('also has relays forget it when carrying out a member’s request', async () => {
        const { id, pubkey, adminToken } = await trashed('grace@example.test');
        const before = relays.published.length;
        const mailBefore = mail.sent.length;

        expect((await call('DELETE', `/api/admin/users/${id}/purge?deletionRequest=true`, { token: adminToken })).status).toBe(200);

        expect(await prisma.user.findUnique({ where: { id } })).toBeNull();
        expect(relays.published.slice(before).some((p) => p.event.pubkey === pubkey && p.event.kind === 62)).toBe(true);
        expect(fs.existsSync(path.join(PURGE_DIR, pubkey))).toBe(true);
        expect(mail.sent.length).toBe(mailBefore); // the admin answers the person
    });
});

// ─── Deleting a Nostr account ─────────────────────────────────────────────────

describe('deleting a Nostr account', () => {
    it('is confirmed by a signature over the challenge, from its own key only', async () => {
        const secretKey = generateSecretKey();
        const dave = await signInByNostr(secretKey);
        expect(dave.status).toBe(200);
        const { token, user } = dave.body;
        const before = relays.published.length;
        const mailBefore = mail.sent.length;

        const start = await call('POST', '/api/account/delete/start', { token });
        expect(start.body.method).toBe('nostr');
        const { challenge } = start.body;

        const attempts: [string, Event][] = [
            // A sign-in event: the challenge as its content, no tags.
            ['a sign-in event', finalizeEvent({ kind: 27235, created_at: now(), tags: [], content: challenge }, secretKey)],
            ['another key', confirmation(generateSecretKey(), 'delete_account', challenge)],
            ['another purpose', confirmation(secretKey, 'take_key', challenge)],
            ['a tampered event', { ...confirmation(secretKey, 'delete_account', challenge), content: 'changed' }],
        ];
        for (const [, signedEvent] of attempts) {
            const r = await call('POST', '/api/account/delete', { token, body: { signedEvent } });
            expect(r.status).toBe(400);
            expect(r.body.reason).toBe('bad_signature');
        }
        // Signed over another (older) challenge: the app is told to start again.
        const stale = await call('POST', '/api/account/delete', { token, body: { signedEvent: confirmation(secretKey, 'delete_account', 'f'.repeat(64)) } });
        expect(stale.body.reason).toBe('challenge_expired');
        expect(await prisma.user.findUnique({ where: { id: user.id } })).not.toBeNull();

        // No code for an account BIES holds no key for.
        expect((await call('POST', '/api/account/delete', { token, body: { code: '123456' } })).body.reason).toBe('signature_required');

        const done = await call('POST', '/api/account/delete', { token, body: { signedEvent: confirmation(secretKey, 'delete_account', challenge) } });
        expect(done.status).toBe(200);
        expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeNull();

        // BIES can't sign for this key, so nothing goes to public relays;
        // its own relay still deletes the events. No address, no email.
        expect(relays.published.slice(before).filter((s) => s.event.kind === 5 || s.event.kind === 62)).toHaveLength(0);
        expect(fs.existsSync(path.join(PURGE_DIR, user.nostrPubkey))).toBe(true);
        expect(mail.sent.length).toBe(mailBefore);
    });

    it('uses each challenge once', async () => {
        const secretKey = generateSecretKey();
        const pubkey = getPublicKey(secretKey);
        const challenge = issueChallenge('u-once', 'delete_account');
        const signed = confirmation(secretKey, 'delete_account', challenge);
        const [a, b] = await Promise.all([
            checkSignedChallenge('u-once', pubkey, 'delete_account', signed),
            checkSignedChallenge('u-once', pubkey, 'delete_account', signed),
        ]);
        expect([a, b].sort()).toEqual(['challenge_expired', 'ok']);
        expect(await checkSignedChallenge('u-once', pubkey, 'delete_account', signed)).toBe('challenge_expired');
    });
});

// ─── Taking the key ───────────────────────────────────────────────────────────

describe('taking the key', () => {
    it('shows the key once, and deletes BIES’s copy when the member proves they saved it', async () => {
        const email = 'erin@example.test';
        const erin = await signInByEmail(email);
        const id = erin.user.id;
        const pubkey = erin.user.nostrPubkey;

        // Erin's other phone, signed in too.
        const otherToken = await secondDevice(id);
        const here = openSocket(erin.token);
        const other = openSocket(otherToken);
        await Promise.all([here.connected, other.connected]);

        const start = await call('POST', '/api/account/key/start', { token: erin.token, body: { lang: 'es' } });
        expect(start.status).toBe(200);
        expect(mail.sent.at(-1)!.subject).toMatch(/^Su código para llevarse su clave de Nostr: \d{6}$/);

        expect((await call('POST', '/api/account/key/export', { token: erin.token, body: { code: '000001' } })).body.reason).toBe('invalid_code');

        const exported = await call('POST', '/api/account/key/export', { token: erin.token, body: { code: lastCode(email) } });
        expect(exported.status).toBe(200);
        expect(exported.headers.get('cache-control')).toBe('no-store');
        const secretKey = Uint8Array.from(Buffer.from(exported.body.secretKey, 'hex'));
        expect(getPublicKey(secretKey)).toBe(pubkey);
        const { challenge } = exported.body;

        // Proof must come from this key, for this purpose.
        for (const signedEvent of [
            confirmation(generateSecretKey(), 'take_key', challenge),
            confirmation(secretKey, 'delete_account', challenge),
        ]) {
            const r = await call('POST', '/api/account/key/release', { token: erin.token, body: { signedEvent } });
            expect(r.body.reason).toBe('bad_signature');
        }
        expect((await prisma.user.findUniqueOrThrow({ where: { id } })).encryptedPrivkey).toBeTruthy();

        const released = await call('POST', '/api/account/key/release', {
            token: erin.token,
            body: { signedEvent: confirmation(secretKey, 'take_key', challenge), lang: 'es' },
        });
        expect(released.status).toBe(200);
        expect(released.body.user).toMatchObject({ id, nostrPubkey: pubkey, hostedKey: false });
        expect((await prisma.user.findUniqueOrThrow({ where: { id } })).encryptedPrivkey).toBeNull();

        // This device carries on; the other one must sign in with Nostr.
        expect(await other.closed).toBe(4003);
        expect((await call('GET', '/api/auth/me', { token: otherToken })).status).toBe(401);
        expect((await call('GET', '/api/auth/me', { token: erin.token })).status).toBe(200);
        expect(here.ws.readyState).toBe(WebSocket.OPEN);
        here.ws.close();

        // BIES can't sign for her any more.
        const sign = await call('POST', '/api/signer/sign', { token: erin.token, body: { event: { kind: 1, created_at: now(), tags: [], content: 'x' } } });
        expect(sign.status).toBe(409);
        expect((await call('POST', '/api/account/key/start', { token: erin.token })).body.reason).toBe('not_hosted');

        // Email sign-in says to use Nostr; Nostr sign-in with her key works.
        await aMinuteLater();
        await call('POST', '/api/auth/email/start', { body: { email } });
        const byEmail = await call('POST', '/api/auth/email/verify', { body: { email, code: lastCode(email) } });
        expect(byEmail.status).toBe(403);
        expect(byEmail.body.reason).toBe('nostr_account');
        const byNostr = await signInByNostr(secretKey);
        expect(byNostr.status).toBe(200);
        expect(byNostr.body.user.id).toBe(id);

        // Confirmed in her language, with somewhere to write back.
        const confirmationEmail = mail.sent.filter((m) => m.to === email && !/\d{6}$/.test(m.subject)).at(-1)!;
        expect(confirmationEmail.subject).toBe('Ahora usted guarda su clave de Nostr');
        expect(confirmationEmail.replyTo).toBe('help@example.test');

        // Deleting the account now takes a signature.
        const del = await call('POST', '/api/account/delete/start', { token: erin.token });
        expect(del.body.method).toBe('nostr');
    });
});

// ─── Found in review ──────────────────────────────────────────────────────────

describe('a deletion that fails', () => {
    it('changes nothing, so the member is still signed in and can try again', async () => {
        const email = 'retry@example.test';
        const member = await signInByEmail(email);
        const { id, nostrPubkey: pubkey } = member.user;
        const before = relays.published.length;

        await call('POST', '/api/account/delete/start', { token: member.token });
        const spy = vi.spyOn(prisma, '$transaction').mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
        const failed = await call('POST', '/api/account/delete', { token: member.token, body: { code: lastCode(email) } });
        spy.mockRestore();
        expect(failed.status).toBe(500);

        // Nothing irreversible went out, and nothing was taken away.
        expect(retractions(before, pubkey)).toHaveLength(0);
        expect(fs.existsSync(path.join(PURGE_DIR, pubkey))).toBe(false);
        expect(whitelisted(pubkey)).toBe(true);
        expect((await prisma.user.findUniqueOrThrow({ where: { id } })).encryptedPrivkey).toBeTruthy();
        expect((await call('GET', '/api/auth/me', { token: member.token })).status).toBe(200);

        // A minute later, with a new code, it goes through.
        await aMinuteLater();
        await call('POST', '/api/account/delete/start', { token: member.token });
        expect((await call('POST', '/api/account/delete', { token: member.token, body: { code: lastCode(email) } })).status).toBe(200);
        expect(await prisma.user.findUnique({ where: { id } })).toBeNull();
    });
});

describe('the deletion email', () => {
    it('says BIES-relay posts were deleted only when the relay was asked to, and the log says how to do it', async () => {
        const email = 'nopurge@example.test';
        const member = await signInByEmail(email);
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        // The purge folder can't be written (here, a file stands in its way).
        const saved = fs.existsSync(PURGE_DIR) ? fs.readdirSync(PURGE_DIR) : [];
        fs.rmSync(PURGE_DIR, { recursive: true, force: true });
        fs.writeFileSync(PURGE_DIR, '');
        let logged = '';
        try {
            await call('POST', '/api/account/delete/start', { token: member.token });
            expect((await call('POST', '/api/account/delete', { token: member.token, body: { code: lastCode(email) } })).status).toBe(200);
            logged = errors.mock.calls.flat().join(' ');
        } finally {
            errors.mockRestore();
            fs.rmSync(PURGE_DIR, { force: true });
            fs.mkdirSync(PURGE_DIR, { recursive: true });
            for (const name of saved) fs.writeFileSync(path.join(PURGE_DIR, name), 'restored\n');
        }
        expect(mail.sent.filter((m) => m.to === email).at(-1)!.text).not.toContain('your posts on the BIES relay');
        expect(logged).toContain(`"authors":["${member.user.nostrPubkey}"]`);
    });

    it('says other relays were asked only when one took the request', async () => {
        const email = 'refused@example.test';
        const member = await signInByEmail(email);
        relays.refusePublishFor.add(member.user.nostrPubkey);
        try {
            await call('POST', '/api/account/delete/start', { token: member.token });
            expect((await call('POST', '/api/account/delete', { token: member.token, body: { code: lastCode(email) } })).status).toBe(200);
        } finally {
            relays.refusePublishFor.delete(member.user.nostrPubkey);
        }
        const text = mail.sent.filter((m) => m.to === email).at(-1)!.text;
        expect(text).toContain('destroyed the Nostr key');
        expect(text).not.toContain('asked other Nostr relays');
    });

    it('follows a request to vanish that went out even when the events could not be looked up', async () => {
        const email = 'unreachable@example.test';
        const member = await signInByEmail(email);
        const pubkey = member.user.nostrPubkey;
        const before = relays.published.length;
        relays.failQueriesFor.add(pubkey);
        try {
            await call('POST', '/api/account/delete/start', { token: member.token });
            expect((await call('POST', '/api/account/delete', { token: member.token, body: { code: lastCode(email) } })).status).toBe(200);
        } finally {
            relays.failQueriesFor.delete(pubkey);
        }
        expect(relays.published.slice(before).some((p) => p.event.pubkey === pubkey && p.event.kind === 62)).toBe(true);
        expect(mail.sent.filter((m) => m.to === email).at(-1)!.text).toContain('asked other Nostr relays');
    });
});

describe('after a deletion', () => {
    it('leaves nothing of the person in caches, the audit trail, others’ notifications or zap receipts', async () => {
        const doraKey = generateSecretKey();
        const dora = (await signInByNostr(doraKey)).body;
        const { id: doraId, nostrPubkey: doraPk } = dora.user;
        await prisma.profile.update({ where: { userId: doraId }, data: { name: 'Dora Example' } });
        const bob = (await signInByNostr(generateSecretKey())).body;

        // Her public profile, cached for five minutes once seen.
        expect((await call('GET', `/api/profiles/${doraPk}`)).status).toBe(200);
        expect(await cache.getJson(cacheKey.profileDetail(doraPk))).not.toBeNull();

        // Admin work naming her, Bob's notifications about her, zaps both ways.
        await prisma.auditLog.create({
            data: {
                action: 'PROJECT_OWNERSHIP_TRANSFERRED',
                resource: 'project:p1',
                metadata: JSON.stringify({ previousOwnerId: doraId, previousOwnerName: 'Dora Example', newOwnerName: 'Bob' }),
            },
        });
        await prisma.notification.create({ data: { userId: bob.user.id, type: 'FOLLOW', title: 'Dora Example followed you', body: '', data: JSON.stringify({ followerId: doraId }) } });
        await prisma.notification.create({ data: { userId: bob.user.id, type: 'NEW_MESSAGE', title: 'New message', body: 'Meet at 5? +503 7000 0000', data: JSON.stringify({ senderId: doraId }) } });
        await prisma.notification.create({ data: { userId: bob.user.id, type: 'SYSTEM', title: 'Welcome', body: '', data: '{}' } });
        await prisma.zapReceipt.create({ data: { eventId: 'a'.repeat(64), senderPubkey: doraPk, recipientPubkey: bob.user.nostrPubkey, amountMsats: BigInt(21000), amountSats: 21, comment: 'Great talk! Dora' } });
        await prisma.zapReceipt.create({ data: { eventId: 'b'.repeat(64), senderPubkey: bob.user.nostrPubkey, recipientPubkey: doraPk, amountMsats: BigInt(1000), amountSats: 1, comment: 'thanks' } });

        const start = await call('POST', '/api/account/delete/start', { token: dora.token });
        const done = await call('POST', '/api/account/delete', { token: dora.token, body: { signedEvent: confirmation(doraKey, 'delete_account', start.body.challenge) } });
        expect(done.status).toBe(200);

        const profile = await call('GET', `/api/profiles/${doraPk}`);
        expect(profile.status).toBe(404);
        expect(profile.headers.get('x-cache')).toBeNull();
        expect(JSON.stringify(await prisma.auditLog.findMany())).not.toContain('Dora Example');
        const bobsNotes = await prisma.notification.findMany({ where: { userId: bob.user.id } });
        expect(bobsNotes.filter((n) => n.data.includes(doraId) || n.title.includes('Dora'))).toHaveLength(0);
        expect(bobsNotes.map((n) => n.title)).toContain('Welcome');
        expect(await prisma.zapReceipt.count({ where: { OR: [{ senderPubkey: doraPk }, { recipientPubkey: doraPk }] } })).toBe(0);
        expect((await prisma.zapReceipt.findUniqueOrThrow({ where: { eventId: 'a'.repeat(64) } })).comment).toBe('');
    });
});

describe("a deleted account's key", () => {
    it("can't get relay access back through a voucher, but its owner can rejoin by signing in", async () => {
        const host = (await signInByNostr(generateSecretKey())).body;
        await prisma.voucher.create({ data: { code: 'EVENT-QR-2026', type: 'RELAY_ACCESS', maxUses: 0, createdById: host.user.id } });

        const ginaKey = generateSecretKey();
        const gina = (await signInByNostr(ginaKey)).body;
        const pubkey = gina.user.nostrPubkey;
        const start = await call('POST', '/api/account/delete/start', { token: gina.token });
        await call('POST', '/api/account/delete', { token: gina.token, body: { signedEvent: confirmation(ginaKey, 'delete_account', start.body.challenge) } });
        expect(whitelisted(pubkey)).toBe(false);

        // Anyone with the voucher code could otherwise put her key back.
        const redeem = await call('POST', '/api/vouchers/code/EVENT-QR-2026/redeem', { body: { pubkey } });
        expect(redeem.status).toBe(403);
        expect(redeem.body.reason).toBe('deleted_account');
        expect(whitelisted(pubkey)).toBe(false);

        // She comes back with her key: a new account, and relay access again.
        const back = await signInByNostr(ginaKey);
        expect(back.status).toBe(200);
        expect(back.body.user.id).not.toBe(gina.user.id);
        expect(whitelisted(pubkey)).toBe(true);
    });
});

describe('a signed confirmation', () => {
    it('reaches the check exactly as signed (the input sanitizer leaves it alone)', async () => {
        const key = generateSecretKey();
        const ivan = (await signInByNostr(key)).body;
        const start = await call('POST', '/api/account/delete/start', { token: ivan.token });
        const signedEvent = finalizeEvent({
            kind: 27235,
            created_at: now(),
            tags: [['challenge', start.body.challenge], ['purpose', 'delete_account']],
            content: 'Delete my BIES account &#10003;\n',
        }, key);
        expect((await call('POST', '/api/account/delete', { token: ivan.token, body: { signedEvent } })).status).toBe(200);
    });
});

describe('the App Review account', () => {
    it('keeps its key, so the review sign-in keeps working', async () => {
        const email = 'appreview@example.test';
        expect((await call('POST', '/api/auth/email/start', { body: { email } })).status).toBe(200);
        const first = await call('POST', '/api/auth/email/verify', { body: { email, code: '424242' } });
        expect([200, 201]).toContain(first.status);
        const { token } = first.body;

        const start = await call('POST', '/api/account/key/start', { token });
        expect(start.status).toBe(409);
        expect(start.body.reason).toBe('review_account');
        expect((await call('POST', '/api/account/key/export', { token, body: { code: '424242' } })).body.reason).toBe('review_account');

        await aMinuteLater();
        expect((await call('POST', '/api/auth/email/start', { body: { email } })).status).toBe(200);
        expect((await call('POST', '/api/auth/email/verify', { body: { email, code: '424242' } })).status).toBe(200);
    });
});

// ─── Code emails ──────────────────────────────────────────────────────────────

describe('code emails', () => {
    it('say what the code is for', () => {
        expect(renderCodeEmail('a@example.test', '123456').subject).toBe('Your BIES sign-in code: 123456');
        expect(renderCodeEmail('a@example.test', '123456', 'en', 'delete_account').subject).toBe('Your code to delete your BIES account: 123456');
        expect(renderCodeEmail('a@example.test', '123456', 'es', 'export_key').subject).toBe('Su código para llevarse su clave de Nostr: 123456');
    });
});
