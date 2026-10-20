/**
 * Security review, round 4 (20 Oct 2026): suspended and deleted members are
 * gone from profiles, lists, search, directory listings and NIP-05; a code
 * can't put them back on the relay; account roles are listed for staff
 * only; staff-sounding NIP-05 names are kept for staff; a few new
 * Nostr-key accounts a day per address; preferences keep only what the app
 * uses. Real routes against a real SQLite database built from the repo's
 * migrations.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const env = vi.hoisted(() => {
    const dir = `${process.env.TMPDIR || '/tmp'}/bies-round4-test-${process.pid}-${Date.now()}`;
    process.env.DATABASE_URL = `file:${dir}/test.db`;
    process.env.RELAY_WHITELIST_PATH = `${dir}/relay/whitelist.txt`;
    process.env.CORS_ORIGIN = 'https://app.example.test';
    process.env.APP_PUBLIC_URL = 'https://app.example.test';
    process.env.TERMS_VERSION = '2026-10';
    process.env.NEW_ACCOUNTS_PER_IP_PER_DAY = '3';
    return { dir };
});

vi.mock('nostr-tools/pool', () => ({
    SimplePool: class {
        publish(urls: string[]) { return urls.map(() => Promise.resolve('')); }
        async querySync() { return []; }
        async get() { return null; }
    },
}));
vi.mock('../services/email.service', () => ({ sendEmail: vi.fn(async () => {}) }));

import { execSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import express from 'express';
import prisma from '../lib/prisma';
import authRoutes from '../routes/auth.routes';
import profileRoutes from '../routes/profile.routes';
import searchRoutes from '../routes/search.routes';
import directoryRoutes from '../routes/directory.routes';
import settingsRoutes from '../routes/settings.routes';
import nip05Routes from '../routes/nip05.routes';
import adminRoutes from '../routes/admin.routes';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { createSession, signAccessToken } from '../services/session.service';
import { redeemFree, VoucherError } from '../services/voucher.service';
import { isReservedNip05 } from '../controllers/profile.controller';

let server: http.Server;
let base: string;

beforeAll(async () => {
    fs.mkdirSync(env.dir, { recursive: true });
    execSync('npx prisma migrate deploy', { cwd: path.resolve(__dirname, '../..'), env: process.env, stdio: 'pipe' });
    const app = express();
    app.use(express.json());
    app.use('/api/auth', authRoutes);
    app.use('/api/profiles', profileRoutes);
    app.use('/api/search', searchRoutes);
    app.use('/api/directory', directoryRoutes);
    app.use('/api/settings', settingsRoutes);
    app.use('/.well-known', nip05Routes);
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

async function call(method: string, url: string, { token, body }: { token?: string; body?: unknown } = {}) {
    const res = await fetch(`${base}${url}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

type Member = { id: string; token: string; pubkey: string };
async function member(name: string, { role = 'MEMBER', isAdmin = false, nip05Name }: { role?: string; isAdmin?: boolean; nip05Name?: string } = {}): Promise<Member> {
    const pubkey = getPublicKey(generateSecretKey());
    const user = await prisma.user.create({
        data: {
            nostrPubkey: pubkey, role, isAdmin,
            termsVersion: '2026-10', termsAcceptedAt: new Date(), profile: { create: { name, nip05Name } },
        },
    });
    const session = await createSession(user.id, 'native');
    return { id: user.id, pubkey, token: signAccessToken({ id: user.id, role, isAdmin }, session.sessionId) };
}
// As Admin → Users → Suspend does, through the real route.
let adminToken = '';
async function suspend(m: Member) {
    if (!adminToken) adminToken = (await member('Suspending Admin', { isAdmin: true })).token;
    const res = await call('PUT', `/api/admin/users/${m.id}/ban`, { token: adminToken, body: { banned: true } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
}
const ids = (list: any[]) => list.map((p) => p.userId ?? p.user?.id ?? p.id);

describe('suspended and deleted members', () => {
    it('their profile page is gone, except to staff', async () => {
        const viewer = await member('Viewer');
        const admin = await member('Admin', { isAdmin: true });
        const gone = await member('Gone Member');
        expect((await call('GET', `/api/profiles/${gone.id}`, { token: viewer.token })).status).toBe(200);
        await suspend(gone);
        expect((await call('GET', `/api/profiles/${gone.id}`, { token: viewer.token })).status).toBe(404);
        expect((await call('GET', `/api/profiles/${gone.id}`)).status).toBe(404);
        const staff = await call('GET', `/api/profiles/${gone.id}`, { token: admin.token });
        expect(staff.status).toBe(200);
        expect(staff.body.user?.isBanned).toBeUndefined();
    });

    it("aren't listed or found, and lose their NIP-05", async () => {
        const viewer = await member('Viewer Two');
        const gone = await member('Zebulon Suspended', { nip05Name: 'zebulon' });
        const deleted = await member('Zebulon Deleted');
        expect((await call('GET', '/.well-known/nostr.json?name=zebulon')).body.names.zebulon).toBe(gone.pubkey);
        await suspend(gone);
        await prisma.user.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });

        const list = await call('GET', '/api/profiles?search=Zebulon', { token: viewer.token });
        expect(ids(list.body.data)).not.toContain(gone.id);
        expect(ids(list.body.data)).not.toContain(deleted.id);
        const found = await call('GET', '/api/search?q=Zebulon&type=profiles', { token: viewer.token });
        expect(found.body.profiles).toEqual([]);
        const suggested = await call('GET', '/api/search/suggestions?q=Zebulon', { token: viewer.token });
        expect(JSON.stringify(suggested.body.suggestions ?? suggested.body)).not.toContain('Zebulon');
        expect((await call('GET', '/.well-known/nostr.json?name=zebulon')).body.names).toEqual({});
    });

    it('a listing they run is gone, and so are their reviews', async () => {
        const viewer = await member('Viewer Three');
        const owner = await member('Listing Owner');
        const reviewer = await member('Reviewer');
        const listing = await prisma.directoryListing.create({
            data: { type: 'PROVIDER', name: 'Cafe Suspendido', ownerId: owner.id, status: 'active', isPublished: true },
        });
        await prisma.directoryEndorsement.create({ data: { listingId: listing.id, userId: reviewer.id, vote: 1, comment: 'Great coffee here.' } });

        let page = await call('GET', `/api/directory/${listing.id}`, { token: viewer.token });
        expect(page.status).toBe(200);
        expect(page.body.endorsements.length).toBe(1);

        await suspend(reviewer);
        page = await call('GET', `/api/directory/${listing.id}`, { token: viewer.token });
        expect(page.body.endorsements.length).toBe(0);

        await suspend(owner);
        expect((await call('GET', `/api/directory/${listing.id}`, { token: viewer.token })).status).toBe(404);
        const list = await call('GET', '/api/directory?type=PROVIDER&search=Suspendido', { token: viewer.token });
        expect(ids(list.body.data)).not.toContain(listing.id);
    });

    it("a relay access code doesn't put them back on the relay", async () => {
        const admin = await member('Code Maker', { isAdmin: true });
        const gone = await member('Code User');
        await suspend(gone);
        const voucher = await prisma.voucher.create({ data: { code: `r4-${Date.now()}`, createdById: admin.id } });
        await expect(redeemFree(voucher, gone.pubkey)).rejects.toBeInstanceOf(VoucherError);
        const whitelist = fs.existsSync(process.env.RELAY_WHITELIST_PATH!) ? fs.readFileSync(process.env.RELAY_WHITELIST_PATH!, 'utf8') : '';
        expect(whitelist).not.toContain(gone.pubkey);
        // Someone in good standing can use it.
        const fine = await member('Code User Two');
        await expect(redeemFree(voucher, fine.pubkey)).resolves.toBeTruthy();
    });
});

describe('who is listed by account role', () => {
    it('only staff can list members by account role', async () => {
        const mod = await member('A Moderator', { role: 'MOD' });
        const plain = await member('A Plain Member');
        const admin = await member('Role Admin', { isAdmin: true });
        // Signed out or as a member, the role is ignored: everyone is listed.
        const anon = await call('GET', '/api/profiles?role=MOD&limit=50');
        expect(ids(anon.body.data)).toContain(plain.id);
        const asStaff = await call('GET', '/api/profiles?role=MOD&limit=50', { token: admin.token });
        expect(ids(asStaff.body.data)).toContain(mod.id);
        expect(ids(asStaff.body.data)).not.toContain(plain.id);
    });
});

describe('NIP-05 names', () => {
    it('staff-sounding names are kept for staff', async () => {
        for (const name of ['admin', 'support', 'bies', 'bies.support', 'admin_mike', 'official-news']) expect(isReservedNip05(name), name).toBe(true);
        for (const name of ['mike', 'ana.lopez', 'adminton', 'biesta']) expect(isReservedNip05(name), name).toBe(false);

        const m = await member('Wants Support');
        const res = await call('PUT', '/api/profiles/me', { token: m.token, body: { nip05Name: 'support' } });
        expect(res.status).toBe(409);
        expect(res.body.reason).toBe('reserved');
        expect((await call('GET', '/api/profiles/check-nip05?name=bies.help', { token: m.token })).body.available).toBe(false);
        expect((await call('PUT', '/api/profiles/me', { token: m.token, body: { nip05Name: 'wantssupport' } })).status).toBe(200);
    });

    it('a member who already has one keeps it when they save their profile', async () => {
        const m = await member('Early Bies', { nip05Name: 'bies.early' });
        expect((await call('PUT', '/api/profiles/me', { token: m.token, body: { nip05Name: 'bies.early', bio: 'Still here' } })).status).toBe(200);
    });
});

describe('profile fields', () => {
    it('are held to a size', async () => {
        const m = await member('Sizes');
        expect((await call('PUT', '/api/profiles/me', { token: m.token, body: { name: 'x'.repeat(101) } })).status).toBe(400);
        expect((await call('PUT', '/api/profiles/me', { token: m.token, body: { bio: 'x'.repeat(10_001) } })).status).toBe(400);
        expect((await call('PUT', '/api/profiles/me', { token: m.token, body: { skills: Array(51).fill('a') } })).status).toBe(400);
        expect((await call('PUT', '/api/profiles/me', { token: m.token, body: { bio: 'A normal bio.' } })).status).toBe(200);
    });
});

describe('preferences', () => {
    it('keep only what the app uses', async () => {
        const m = await member('Prefs');
        const res = await call('PUT', '/api/settings/preferences', { token: m.token, body: { theme: 'dark', junk: 'x'.repeat(1000) } });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ theme: 'dark' });
        expect((await call('PUT', '/api/settings/preferences', { token: m.token, body: { theme: 'x'.repeat(33) } })).status).toBe(400);
        expect((await call('GET', '/api/settings/preferences', { token: m.token })).body).toEqual({ theme: 'dark' });
    });

    it('read lists keep the newest 1,000 of each', async () => {
        const m = await member('Reader');
        const many = Array.from({ length: 1500 }, (_, i) => `item-${i}`);
        const res = await call('POST', '/api/settings/media-read/bulk', { token: m.token, body: { add: { read: many } } });
        expect(res.status).toBe(200);
        expect(res.body.read.length).toBe(1000);
        expect(res.body.read[999]).toBe('item-1499');
    });
});

describe('new accounts with a Nostr key', () => {
    const LOGIN_URL = 'https://app.example.test/api/auth/nostr-login';
    async function signIn(key: Uint8Array) {
        const pubkey = getPublicKey(key);
        const challenge = (await call('GET', `/api/auth/nostr-challenge?pubkey=${pubkey}`)).body.challenge as string;
        const signedEvent = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags: [['u', LOGIN_URL], ['method', 'POST']], content: challenge }, key);
        return call('POST', '/api/auth/nostr-login', { body: { pubkey, signedEvent } });
    }

    it('a few a day from one address; members already here still sign in', async () => {
        const keys = Array.from({ length: 4 }, () => generateSecretKey());
        for (const key of keys.slice(0, 3)) expect((await signIn(key)).status).toBe(200);
        const fourth = await signIn(keys[3]);
        expect(fourth.status).toBe(429);
        expect(fourth.body.reason).toBe('too_many_new_accounts');
        // The first one, back again: not a new account.
        expect((await signIn(keys[0])).status).toBe(200);
    });
});
