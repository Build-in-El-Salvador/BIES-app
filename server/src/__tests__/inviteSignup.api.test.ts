/**
 * Invite-only sign-up, against a real database (services/invite.service.ts):
 * the switch (off by default, admins only), email and Nostr sign-up with and
 * without a code, one code for one account even at the same moment, codes
 * that stop working (used, expired, revoked, made by someone no longer an
 * admin), the signup ticket, the guessing limits, the admin list, and codes
 * never stored or logged as they are.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const env = vi.hoisted(() => {
    const dir = `${process.env.TMPDIR || '/tmp'}/bies-invites-test-${process.pid}-${Date.now()}`;
    process.env.DATABASE_URL = `file:${dir}/test.db`;
    process.env.RELAY_WHITELIST_PATH = `${dir}/relay/whitelist.txt`;
    process.env.CORS_ORIGIN = 'https://app.example.test';
    process.env.APP_PUBLIC_URL = 'https://app.example.test';
    process.env.TERMS_VERSION = '2026-10';
    process.env.EMAIL_CODES_MAX_PER_DAY = '100000';
    process.env.NEW_ACCOUNTS_PER_IP_PER_DAY = '100000';
    // App Review's address signs in with a fixed code, and never needs an invite.
    process.env.REVIEW_LOGIN_EMAIL = 'review@example.test';
    process.env.REVIEW_LOGIN_CODE = '424242';
    // An admin listed in ADMIN_PUBKEYS, who never needs a code: the key is
    // 32 bytes of 7, and this its public key.
    process.env.ADMIN_PUBKEYS = '989c0b76cb563971fdc9bef31ec06c3560f3249d6ee9e5d83c57625596e05f6f';
    const adminSecret = new Uint8Array(32).fill(7);
    return { dir, adminSecret };
});

const mail = vi.hoisted(() => ({ sent: [] as { to: string; subject: string; text: string }[] }));
vi.mock('../services/email.service', () => ({
    sendEmail: vi.fn(async (message: (typeof mail.sent)[number]) => { mail.sent.push(message); }),
}));
vi.mock('../services/nostr.service', () => ({ publishRelayList: vi.fn().mockResolvedValue(null) }));

import { execSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import crypto from 'crypto';
import express from 'express';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';

import prisma from '../lib/prisma';
import authRoutes from '../routes/auth.routes';
import inviteRoutes from '../routes/invite.routes';
import adminRoutes from '../routes/admin.routes';
import { auditLog } from '../middleware/audit';
import { createSession, signAccessToken } from '../services/session.service';
import { encryptPrivateKey } from '../services/crypto.service';
import {
    CODE_ALPHABET,
    hashInviteCode,
    issueSignupTicket,
    limitKey,
    normalizeInviteCode,
    recordInviteFailure,
    resetInviteLimits,
    signupTicketValid,
} from '../services/invite.service';
import { resetSignupLimits } from '../services/signupLimit.service';

const ORIGIN = 'https://app.example.test';
let server: http.Server;
let base: string;

beforeAll(async () => {
    fs.mkdirSync(env.dir, { recursive: true });
    execSync('npx prisma migrate deploy', { cwd: path.resolve(__dirname, '../..'), env: process.env, stdio: 'pipe' });
    const app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use(auditLog);
    app.use('/api/auth', authRoutes);
    app.use('/api/invites', inviteRoutes);
    app.use('/api/admin', adminRoutes);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 120_000);

afterAll(async () => {
    server?.close();
    await prisma.$disconnect();
    fs.rmSync(env.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

let ipCounter = 0;
/** A fresh address per test, so the guessing limit of one doesn't reach another. */
const freshIp = () => `10.1.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;
let ip = freshIp();

beforeEach(() => {
    resetInviteLimits();
    resetSignupLimits();
    ip = freshIp();
});

async function call(method: string, url: string, { token, body, from = ip }: { token?: string; body?: unknown; from?: string } = {}) {
    const res = await fetch(`${base}${url}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            Origin: ORIGIN,
            'X-Forwarded-For': from,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: any = {};
    try { json = JSON.parse(text); } catch { json = {}; }
    return { status: res.status, body: json, text, headers: res.headers };
}

let counter = 0;
async function account({ admin = false, role = 'MEMBER', email }: { admin?: boolean; role?: string; email?: string } = {}) {
    const name = `Person ${++counter}`;
    const user = await prisma.user.create({
        data: {
            nostrPubkey: getPublicKey(generateSecretKey()),
            email: email ?? null,
            encryptedPrivkey: email ? encryptPrivateKey('11'.repeat(32)) : null,
            isAdmin: admin, role: admin ? 'ADMIN' : role,
            termsVersion: '2026-10', termsAcceptedAt: new Date(),
            profile: { create: { name } },
        },
    });
    const session = await createSession(user.id, 'native');
    return { id: user.id, name, token: signAccessToken({ id: user.id, role: user.role, isAdmin: admin }, session.sessionId) };
}

let mike: Awaited<ReturnType<typeof account>>;
beforeAll(async () => { mike = await account({ admin: true }); });

async function setInviteOnly(on: boolean) {
    const res = await call('PUT', '/api/admin/invites/settings', { token: mike.token, body: { inviteOnly: on } });
    expect(res.status).toBe(200);
}

async function newInvite(by = mike, note?: string): Promise<{ id: string; code: string }> {
    const res = await call('POST', '/api/admin/invites', { token: by.token, body: note ? { note } : {} });
    expect(res.status).toBe(201);
    return { id: res.body.invite.id, code: res.body.invite.code };
}

let emailCounter = 0;
const newEmail = () => `newcomer${++emailCounter}@example.test`;

async function emailCode(email: string): Promise<string> {
    const start = await call('POST', '/api/auth/email/start', { body: { email } });
    expect(start.status).toBe(200);
    const message = mail.sent.filter((m) => m.to === email).at(-1)!;
    return /(\d{6})$/.exec(message.subject)![1];
}

async function emailSignUp(email: string, inviteCode?: string) {
    const code = await emailCode(email);
    return call('POST', '/api/auth/email/verify', { body: { email, code, ...(inviteCode !== undefined ? { inviteCode } : {}) } });
}

async function nostrSignIn(secret: Uint8Array, inviteCode?: string) {
    const pubkey = getPublicKey(secret);
    const { body: { challenge } } = await call('GET', `/api/auth/nostr-challenge?pubkey=${pubkey}`);
    const signedEvent = finalizeEvent({
        kind: 27235,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['u', `${ORIGIN}/api/auth/nostr-login`], ['method', 'POST']],
        content: challenge,
    }, secret);
    return call('POST', '/api/auth/nostr-login', { body: { pubkey, signedEvent, ...(inviteCode !== undefined ? { inviteCode } : {}) } });
}

const userByEmail = (email: string) => prisma.user.findUnique({ where: { email } });
const inviteRow = (id: string) => prisma.inviteCode.findUnique({ where: { id } });
const relayAllows = (pubkey: string) => {
    try { return fs.readFileSync(process.env.RELAY_WHITELIST_PATH!, 'utf8').includes(pubkey); } catch { return false; }
};

describe('the codes', () => {
    it('are BIES-XXXX-XXXX from 31 characters with no look-alikes, all different', async () => {
        const pattern = new RegExp(`^BIES-[${CODE_ALPHABET}]{4}-[${CODE_ALPHABET}]{4}$`);
        expect(CODE_ALPHABET).toHaveLength(31);
        expect(CODE_ALPHABET).not.toMatch(/[01ILO]/);
        const codes = new Set<string>();
        for (let i = 0; i < 40; i++) {
            const { code, id } = await newInvite();
            expect(code).toMatch(pattern);
            codes.add(code);
            await call('POST', `/api/admin/invites/${id}/revoke`, { token: mike.token });
        }
        expect(codes.size).toBe(40);
    });

    it('are never stored as they are, and the stored hash needs a key the database lacks', async () => {
        const { id, code } = await newInvite(mike, 'Juan, Nov meetup');
        const body = normalizeInviteCode(code)!;
        const row = await inviteRow(id);
        const stored = JSON.stringify(row);
        expect(stored).not.toContain(body);
        expect(stored).not.toContain(code);
        expect(row!.codeHash).toBe(hashInviteCode(body));
        expect(row!.codeHash).not.toBe(crypto.createHash('sha256').update(body).digest('hex'));
        expect(row!.codeSealed).toBeTruthy();
    });

    it('can be typed in lower case, with spaces, with or without BIES-, but not with look-alikes', () => {
        expect(normalizeInviteCode('bies-k7m4-q9tx')).toBe('K7M4Q9TX');
        expect(normalizeInviteCode(' K7M4 Q9TX ')).toBe('K7M4Q9TX');
        expect(normalizeInviteCode('BIESK7M4Q9TX')).toBe('K7M4Q9TX');
        expect(normalizeInviteCode('BIES-K7M4-Q9T0')).toBeNull();
        expect(normalizeInviteCode('BIES-K7M4-Q9TI')).toBeNull();
        expect(normalizeInviteCode('BIES-K7M4-Q9T')).toBeNull();
        expect(normalizeInviteCode('x'.repeat(65))).toBeNull();
        expect(normalizeInviteCode(12345678)).toBeNull();
    });
});

describe('the switch', () => {
    it('is off by default, and only admins can change it', async () => {
        expect((await call('GET', '/api/invites/status')).body).toEqual({ inviteOnly: false });
        const member = await account();
        const moderator = await account({ role: 'MOD' });
        for (const who of [member, moderator]) {
            expect((await call('PUT', '/api/admin/invites/settings', { token: who.token, body: { inviteOnly: true } })).status).toBe(403);
            expect((await call('POST', '/api/admin/invites', { token: who.token, body: {} })).status).toBe(403);
            expect((await call('GET', '/api/admin/invites', { token: who.token })).status).toBe(403);
        }
        expect((await call('PUT', '/api/admin/invites/settings', { body: { inviteOnly: true } })).status).toBe(401);
        expect((await call('GET', '/api/invites/status')).body).toEqual({ inviteOnly: false });

        await setInviteOnly(true);
        expect((await call('GET', '/api/invites/status')).body).toEqual({ inviteOnly: true });
        const list = await call('GET', '/api/admin/invites', { token: mike.token });
        expect(list.body.inviteOnly).toBe(true);
        expect(list.body.changedBy).toEqual({ id: mike.id, name: mike.name });
        await setInviteOnly(false);
    });

    it('while off, sign-up needs no code; a code given is still used, to record who invited whom', async () => {
        await setInviteOnly(false);
        const plain = newEmail();
        expect((await emailSignUp(plain)).status).toBe(201);

        const { id, code } = await newInvite();
        const invited = newEmail();
        expect((await emailSignUp(invited, code)).status).toBe(201);
        const user = await userByEmail(invited);
        expect((await inviteRow(id))!.usedById).toBe(user!.id);

        // A wrong code doesn't stop anyone while the switch is off.
        expect((await emailSignUp(newEmail(), 'BIES-2222-2222')).status).toBe(201);
    });
});

describe('with the switch on', () => {
    beforeAll(async () => { await setInviteOnly(true); });
    afterAll(async () => { await setInviteOnly(false); });

    it('email: no account without a code, then the ticket and a code make one, once', async () => {
        const email = newEmail();
        const first = await emailSignUp(email);
        expect(first.status).toBe(403);
        expect(first.body.reason).toBe('invite_required');
        expect(first.body.signupTicket).toEqual(expect.any(String));
        expect(first.body.accessToken).toBeUndefined();
        expect(await userByEmail(email)).toBeNull();

        const { id, code } = await newInvite();
        const done = await call('POST', '/api/auth/email/verify', { body: { email, signupTicket: first.body.signupTicket, inviteCode: code } });
        expect(done.status).toBe(201);
        expect(done.body.isNewUser).toBe(true);
        const user = await userByEmail(email);
        const row = await inviteRow(id);
        expect(row!.usedById).toBe(user!.id);
        expect(row!.usedAt).toBeTruthy();
        expect(row!.codeSealed).toBeNull();
        expect(relayAllows(user!.nostrPubkey)).toBe(true);

        // The ticket never signs in an account, even the one it made.
        const again = await call('POST', '/api/auth/email/verify', { body: { email, signupTicket: first.body.signupTicket, inviteCode: code } });
        expect(again.status).toBe(400);
        expect(again.body.reason).toBe('ticket_expired');
        expect(again.body.accessToken).toBeUndefined();
    });

    it('email: a code that works, sent with the email code, makes the account at once', async () => {
        const { code } = await newInvite();
        const email = newEmail();
        const res = await emailSignUp(email, code.toLowerCase().replace(/-/g, ' '));
        expect(res.status).toBe(201);
        expect(await userByEmail(email)).toBeTruthy();
    });

    it('email: a wrong code makes nothing, and the ticket lets them try another', async () => {
        const email = newEmail();
        const wrong = await emailSignUp(email, 'BIES-2222-2222');
        expect(wrong.status).toBe(403);
        expect(wrong.body.reason).toBe('invite_invalid');
        expect(await userByEmail(email)).toBeNull();
        const { code } = await newInvite();
        const right = await call('POST', '/api/auth/email/verify', { body: { email, signupTicket: wrong.body.signupTicket, inviteCode: code } });
        expect(right.status).toBe(201);
    });

    it('a ticket only works for its own address, unaltered and in time', async () => {
        const email = newEmail();
        const ticket = issueSignupTicket(email);
        expect(signupTicketValid(email, ticket)).toBe(true);
        expect(signupTicketValid(newEmail(), ticket)).toBe(false);
        expect(signupTicketValid(email, ticket.slice(0, -2) + (ticket.endsWith('AA') ? 'BB' : 'AA'))).toBe(false);
        expect(signupTicketValid(email, ticket, Date.now() + 16 * 60 * 1000)).toBe(false);
        expect(signupTicketValid(email, `${Date.now() + 60 * 60 * 1000}.${ticket.split('.')[1]}`)).toBe(false);
        const { code } = await newInvite();
        const forged = await call('POST', '/api/auth/email/verify', { body: { email: newEmail(), signupTicket: ticket, inviteCode: code } });
        expect(forged.status).toBe(400);
        expect(forged.body.reason).toBe('ticket_expired');
    });

    it('one code makes one account, even when two people use it at the same moment', async () => {
        const { id, code } = await newInvite();
        const [a, b] = [newEmail(), newEmail()];
        const [codeA, codeB] = [await emailCode(a), await emailCode(b)];
        const results = await Promise.all([
            call('POST', '/api/auth/email/verify', { body: { email: a, code: codeA, inviteCode: code } }),
            call('POST', '/api/auth/email/verify', { body: { email: b, code: codeB, inviteCode: code } }),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([201, 403]);
        const made = (await Promise.all([userByEmail(a), userByEmail(b)])).filter(Boolean);
        expect(made).toHaveLength(1);
        expect((await inviteRow(id))!.usedById).toBe(made[0]!.id);

        // And used once, it's used.
        expect((await emailSignUp(newEmail(), code)).body.reason).toBe('invite_invalid');
    });

    it('codes stop working when expired, revoked, or made by someone no longer an admin', async () => {
        const expired = await newInvite();
        await prisma.inviteCode.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
        expect((await emailSignUp(newEmail(), expired.code)).body.reason).toBe('invite_invalid');

        const revoked = await newInvite();
        expect((await call('POST', `/api/admin/invites/${revoked.id}/revoke`, { token: mike.token })).status).toBe(200);
        expect((await emailSignUp(newEmail(), revoked.code)).body.reason).toBe('invite_invalid');
        expect((await inviteRow(revoked.id))!.codeSealed).toBeNull();

        const former = await account({ admin: true });
        const theirs = await newInvite(former);
        await prisma.user.update({ where: { id: former.id }, data: { isAdmin: false } });
        expect((await emailSignUp(newEmail(), theirs.code)).body.reason).toBe('invite_invalid');
    });

    it('members who already have an account sign in without a code, and a code they send stays unused', async () => {
        const [plain, withCode] = [newEmail(), newEmail()];
        await account({ email: plain });
        await account({ email: withCode });
        expect((await emailSignUp(plain)).status).toBe(200);
        const { id, code } = await newInvite();
        expect((await emailSignUp(withCode, code)).status).toBe(200);
        expect((await inviteRow(id))!.usedAt).toBeNull();
    });

    it('Nostr: a new key gets no account and no relay access without a code; with one it does', async () => {
        const secret = generateSecretKey();
        const pubkey = getPublicKey(secret);
        const refused = await nostrSignIn(secret);
        expect(refused.status).toBe(403);
        expect(refused.body.reason).toBe('invite_required');
        expect(refused.body.accessToken).toBeUndefined();
        expect(await prisma.user.findUnique({ where: { nostrPubkey: pubkey } })).toBeNull();
        expect(relayAllows(pubkey)).toBe(false);

        expect((await nostrSignIn(secret, 'BIES-2222-2222')).body.reason).toBe('invite_invalid');
        expect(await prisma.user.findUnique({ where: { nostrPubkey: pubkey } })).toBeNull();

        const { id, code } = await newInvite();
        const ok = await nostrSignIn(secret, code);
        expect(ok.status).toBe(200);
        const user = await prisma.user.findUnique({ where: { nostrPubkey: pubkey } });
        expect((await inviteRow(id))!.usedById).toBe(user!.id);
        expect(relayAllows(pubkey)).toBe(true);
        // From then on, no code.
        expect((await nostrSignIn(secret)).status).toBe(200);
    });

    it('Nostr: the admins in ADMIN_PUBKEYS never need a code', async () => {
        expect((await nostrSignIn(env.adminSecret)).status).toBe(200);
    });

    it("App Review's address never needs a code", async () => {
        expect((await call('POST', '/api/auth/email/start', { body: { email: 'review@example.test' } })).status).toBe(200);
        const res = await call('POST', '/api/auth/email/verify', { body: { email: 'review@example.test', code: '424242' } });
        expect(res.status).toBe(201);
    });
});

describe('checking a code', () => {
    it("says when it works without using it up, and the same thing for every code that doesn't", async () => {
        const open = await newInvite();
        const ok = await call('POST', '/api/invites/check', { body: { code: open.code } });
        expect(ok.status).toBe(200);
        expect(ok.body).toEqual({ valid: true, expiresAt: expect.any(String) });
        expect(ok.headers.get('cache-control')).toBe('no-store');
        expect((await inviteRow(open.id))!.usedAt).toBeNull();

        const used = await newInvite();
        await emailSignUp(newEmail(), used.code);
        const revoked = await newInvite();
        await call('POST', `/api/admin/invites/${revoked.id}/revoke`, { token: mike.token });
        const expired = await newInvite();
        await prisma.inviteCode.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

        const answers = [];
        for (const code of ['BIES-2222-2222', used.code, revoked.code, expired.code, 'nonsense']) {
            answers.push(await call('POST', '/api/invites/check', { body: { code } }));
        }
        for (const a of answers) {
            expect(a.status).toBe(400);
            expect(a.text).toBe(answers[0].text);
        }
    });

    it('refuses other sites', async () => {
        const res = await fetch(`${base}/api/invites/check`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ code: 'BIES-2222-2222' }),
        });
        expect(res.status).toBe(403);
    });

    it('stops looking after 20 wrong codes an hour from one address, even at a right one', async () => {
        const { code } = await newInvite();
        for (let i = 0; i < 20; i++) {
            expect((await call('POST', '/api/invites/check', { body: { code: 'BIES-2222-2222' } })).status).toBe(400);
        }
        const blocked = await call('POST', '/api/invites/check', { body: { code } });
        expect(blocked.status).toBe(429);
        expect(blocked.body.reason).toBe('invite_rate_limited');
        expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);

        // Sign-up from there is refused the same way, without making anything.
        await setInviteOnly(true);
        const email = newEmail();
        const signUp = await emailSignUp(email, code);
        expect(signUp.status).toBe(429);
        expect(await userByEmail(email)).toBeNull();
        await setInviteOnly(false);

        // Another address isn't affected.
        expect((await call('POST', '/api/invites/check', { body: { code }, from: freshIp() })).status).toBe(200);
    });

    it('counts tries sent at the same moment: 30 at once from one address, 20 looked at', async () => {
        const answers = await Promise.all(Array.from({ length: 30 }, () =>
            call('POST', '/api/invites/check', { body: { code: 'BIES-2222-2222' } })));
        const statuses = answers.map((a) => a.status);
        expect(statuses.filter((s) => s === 400)).toHaveLength(20);
        expect(statuses.filter((s) => s === 429)).toHaveLength(10);
    });

    it('a right code is given back: it never uses up the allowance', async () => {
        const { code } = await newInvite();
        for (let i = 0; i < 25; i++) expect((await call('POST', '/api/invites/check', { body: { code } })).status).toBe(200);
    });

    it('counts IPv6 by /64, so one machine cannot rotate through its block', async () => {
        expect(limitKey('2001:db8:1:2::5')).toBe(limitKey('2001:0db8:0001:0002:ffff:aaaa:bbbb:9'));
        expect(limitKey('2001:db8:1:2::5')).not.toBe(limitKey('2001:db8:1:3::5'));
        expect(limitKey('::ffff:10.0.0.1')).toBe('10.0.0.1');
        for (let i = 0; i < 20; i++) {
            expect((await call('POST', '/api/invites/check', { body: { code: 'BIES-2222-2222' }, from: `2001:db8:7:7::${(i + 1).toString(16)}` })).status).toBe(400);
        }
        expect((await call('POST', '/api/invites/check', { body: { code: 'BIES-2222-2222' }, from: '2001:db8:7:7:abcd::1' })).status).toBe(429);
        expect((await call('POST', '/api/invites/check', { body: { code: 'BIES-2222-2222' }, from: '2001:db8:7:8::1' })).status).toBe(400);
    });

    it('past 1,000 wrong codes an hour, addresses that got one wrong wait; real codes from others still work', async () => {
        const { code } = await newInvite();
        const guesser = freshIp();
        expect((await call('POST', '/api/invites/check', { body: { code: 'BIES-2222-2222' }, from: guesser })).status).toBe(400);
        for (let i = 0; i < 1000; i++) recordInviteFailure(`10.9.${Math.floor(i / 250)}.${i % 250}`);
        expect((await call('POST', '/api/invites/check', { body: { code }, from: guesser })).status).toBe(429);
        expect((await call('POST', '/api/invites/check', { body: { code }, from: freshIp() })).status).toBe(200);
        // A fresh address gets one try past the ceiling, not more.
        const another = freshIp();
        expect((await call('POST', '/api/invites/check', { body: { code: 'BIES-3333-3333' }, from: another })).status).toBe(400);
        expect((await call('POST', '/api/invites/check', { body: { code }, from: another })).status).toBe(429);
    });
});

describe('Admin Panel → Invites', () => {
    it('lists codes only while open, who used one, and notes; never cached', async () => {
        const open = await newInvite(mike, 'Juan, Nov meetup');
        const used = await newInvite();
        const email = newEmail();
        await emailSignUp(email, used.code);
        const joined = await prisma.user.update({ where: { email }, data: { profile: { update: { name: 'Carlos Rivera' } } }, include: { profile: true } });

        const list = await call('GET', '/api/admin/invites', { token: mike.token });
        expect(list.status).toBe(200);
        expect(list.headers.get('cache-control')).toBe('no-store');
        const openRow = list.body.invites.find((i: any) => i.id === open.id);
        const usedRow = list.body.invites.find((i: any) => i.id === used.id);
        expect(openRow).toMatchObject({ status: 'open', code: open.code, note: 'Juan, Nov meetup', createdBy: { id: mike.id } });
        expect(usedRow).toMatchObject({ status: 'used', code: null, usedBy: { id: joined.id, name: 'Carlos Rivera' } });
        expect(JSON.stringify(list.body)).not.toContain(used.code);

        const noted = await call('PUT', `/api/admin/invites/${used.id}/note`, { token: mike.token, body: { note: 'Carlos, dev meetup' } });
        expect(noted.body.invite.note).toBe('Carlos, dev meetup');
        expect((await call('PUT', `/api/admin/invites/${used.id}/note`, { token: mike.token, body: { note: 'x'.repeat(81) } })).status).toBe(400);

        // A used code can't be revoked; an open one can, once.
        expect((await call('POST', `/api/admin/invites/${used.id}/revoke`, { token: mike.token })).status).toBe(409);
        expect((await call('POST', `/api/admin/invites/${open.id}/revoke`, { token: mike.token })).status).toBe(200);
        expect((await call('POST', `/api/admin/invites/${open.id}/revoke`, { token: mike.token })).status).toBe(409);
    });

    it("codes of someone no longer an admin show as revoked, without the code, and don't count as open", async () => {
        const former = await account({ admin: true });
        const theirs = await newInvite(former);
        await prisma.user.update({ where: { id: former.id }, data: { isAdmin: false } });
        const list = await call('GET', '/api/admin/invites', { token: mike.token });
        expect(list.body.invites.find((i: any) => i.id === theirs.id)).toMatchObject({ status: 'revoked', code: null });
        expect((await inviteRow(theirs.id))!.codeSealed).toBeNull();
    });

    it('lists every open invite, however many closed ones are newer', async () => {
        const old = await newInvite(mike, 'the oldest open one');
        await prisma.inviteCode.update({ where: { id: old.id }, data: { createdAt: new Date(Date.now() - 6 * 86400_000) } });
        await prisma.inviteCode.createMany({
            data: Array.from({ length: 210 }, (_, i) => ({
                codeHash: `closed-${Date.now()}-${i}`, createdById: mike.id, createdAt: new Date(Date.now() - i * 1000),
                expiresAt: new Date(Date.now() + 86400_000), revokedAt: new Date(),
            })),
        });
        const list = await call('GET', '/api/admin/invites', { token: mike.token });
        expect(list.body.invites.find((i: any) => i.id === old.id)).toMatchObject({ status: 'open', code: old.code });
        await call('POST', `/api/admin/invites/${old.id}/revoke`, { token: mike.token });
    });

    it('a deleted account leaves its invite used but unlinked', async () => {
        const { id, code } = await newInvite();
        const email = newEmail();
        await emailSignUp(email, code);
        await prisma.user.delete({ where: { email } });
        const row = await inviteRow(id);
        expect(row!.usedAt).toBeTruthy();
        expect(row!.usedById).toBeNull();
        const list = await call('GET', '/api/admin/invites', { token: mike.token });
        expect(list.body.invites.find((i: any) => i.id === id)).toMatchObject({ status: 'used', usedBy: null, accountDeleted: true });
    });

    it('stops at 100 open invites', async () => {
        await prisma.inviteCode.updateMany({ where: { usedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
        for (let i = 0; i < 100; i++) await newInvite();
        const over = await call('POST', '/api/admin/invites', { token: mike.token, body: {} });
        expect(over.status).toBe(409);
        expect(over.body.reason).toBe('too_many_open');
        await prisma.inviteCode.updateMany({ where: { usedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
    });

    it('the audit log records invite actions, never a code', async () => {
        await setInviteOnly(true);
        const { code } = await newInvite();
        await emailSignUp(newEmail(), code);
        await call('POST', '/api/invites/check', { body: { code } });
        await setInviteOnly(false);
        await new Promise((r) => setTimeout(r, 200));
        const logs = await prisma.auditLog.findMany();
        const actions = new Set(logs.map((l) => l.action));
        expect(actions).toContain('INVITE_CREATE');
        expect(actions).toContain('INVITE_ONLY_CHANGED');
        const body = normalizeInviteCode(code)!;
        expect(JSON.stringify(logs)).not.toContain(body);
        expect(JSON.stringify(logs)).not.toContain(code);
    });
});
