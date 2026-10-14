/**
 * Fixes from the 14 Oct review of PRs #380-#388: privacy that reaches the
 * Nostr profile and the feed, privacy saves that can't undo each other,
 * blocks on follower lists, staff and "Only me" albums, moderators and their
 * own listings, the mutual-block card, and private file links. Real routes
 * against a real SQLite database built from the repo's migrations; Nostr
 * publishing is recorded instead of sent.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const env = vi.hoisted(() => {
    const dir = `${process.env.TMPDIR || '/tmp'}/bies-review-fixes-test-${process.pid}-${Date.now()}`;
    process.env.DATABASE_URL = `file:${dir}/test.db`;
    process.env.RELAY_WHITELIST_PATH = `${dir}/relay/whitelist.txt`;
    process.env.CORS_ORIGIN = 'https://app.example.test';
    process.env.APP_PUBLIC_URL = 'https://app.example.test';
    process.env.TERMS_VERSION = '2026-10';
    process.env.UPLOAD_DIR = `${dir}/uploads`;
    return { dir };
});

const nostr = vi.hoisted(() => ({
    publishProfileUpdate: vi.fn(async (..._args: unknown[]) => null),
    publishAnnouncement: vi.fn(async (..._args: unknown[]) => null),
    publishDirectoryListing: vi.fn(async (..._args: unknown[]) => null),
}));

vi.mock('nostr-tools/pool', () => ({
    SimplePool: class {
        publish(urls: string[]) { return urls.map(() => Promise.resolve('')); }
        async querySync() { return []; }
        async get() { return null; }
    },
}));
vi.mock('../services/email.service', () => ({ sendEmail: vi.fn(async () => {}) }));
vi.mock('../services/nostr.service', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/nostr.service')>()),
    ...nostr,
}));

import { execSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import express from 'express';
import prisma from '../lib/prisma';
import profileRoutes from '../routes/profile.routes';
import notificationRoutes from '../routes/notification.routes';
import settingsRoutes from '../routes/settings.routes';
import albumRoutes from '../routes/album.routes';
import adminRoutes from '../routes/admin.routes';
import moderationRoutes from '../routes/moderation.routes';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { createSession, signAccessToken } from '../services/session.service';
import { privateFileFromLink } from '../services/storage.service';

let server: http.Server;
let base: string;

beforeAll(async () => {
    fs.mkdirSync(env.dir, { recursive: true });
    execSync('npx prisma migrate deploy', { cwd: path.resolve(__dirname, '../..'), env: process.env, stdio: 'pipe' });
    const app = express();
    app.use(express.json());
    app.use('/api/profiles', profileRoutes);
    app.use('/api/settings', settingsRoutes);
    app.use('/api/albums', albumRoutes);
    app.use('/api/admin', adminRoutes);
    app.use('/api/notifications', notificationRoutes);
    app.use('/api', moderationRoutes);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 120_000);

afterAll(async () => {
    server?.close();
    await prisma.$disconnect();
    fs.rmSync(env.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

beforeEach(() => {
    for (const fn of Object.values(nostr)) fn.mockClear();
});

async function call(method: string, url: string, { token, body }: { token?: string; body?: unknown } = {}) {
    const res = await fetch(`${base}${url}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

type Member = { id: string; token: string };
async function member(name: string, { role = 'MEMBER', isAdmin = false, profile = {} as Record<string, unknown> } = {}): Promise<Member> {
    const user = await prisma.user.create({
        data: {
            nostrPubkey: getPublicKey(generateSecretKey()), role, isAdmin,
            termsVersion: '2026-10', termsAcceptedAt: new Date(),
            profile: {
                create: {
                    name, website: 'https://example.test', nip05Name: name.toLowerCase().replace(/\W/g, ''),
                    lightningAddress: `${name.toLowerCase().replace(/\W/g, '')}@ln.test`, ...profile,
                },
            },
        },
    });
    const session = await createSession(user.id, 'native');
    return { id: user.id, token: signAccessToken({ id: user.id, role, isAdmin }, session.sessionId) };
}
const block = (by: Member, who: Member) => call('POST', '/api/blocks', { token: by.token, body: { userId: who.id } });
const lastProfilePublish = () => nostr.publishProfileUpdate.mock.calls.at(-1)?.[1] as any;

describe('privacy reaches Nostr and the feed', () => {
    it('two privacy changes at once both stay', async () => {
        const ana = await member('Ana Privacy');
        const [a, b] = await Promise.all([
            call('PUT', '/api/settings/privacy', { token: ana.token, body: { location: 'ONLY_ME' } }),
            call('PUT', '/api/settings/privacy', { token: ana.token, body: { links: 'ONLY_ME' } }),
        ]);
        expect([a.status, b.status]).toEqual([200, 200]);
        const saved = (await call('GET', '/api/settings/privacy', { token: ana.token })).body;
        expect(saved).toMatchObject({ location: 'ONLY_ME', links: 'ONLY_ME' });
    });

    it('"Links: Only me" takes the links out of the Nostr profile, and back', async () => {
        const ben = await member('Ben Links');
        await call('PUT', '/api/settings/privacy', { token: ben.token, body: { links: 'ONLY_ME' } });
        expect(lastProfilePublish()).toMatchObject({ name: 'Ben Links', website: '', lud16: '', nip05: '', bolt12: '' });

        await call('PUT', '/api/settings/privacy', { token: ben.token, body: { links: 'MEMBERS' } });
        expect(lastProfilePublish()).toMatchObject({ website: 'https://example.test', lud16: 'benlinks@ln.test', nip05: 'benlinks@buildinelsalvador.com' });
    });

    it('a profile edit keeps hidden links out, and announces no Lightning address', async () => {
        const cara = await member('Cara Edit');
        await call('PUT', '/api/settings/privacy', { token: cara.token, body: { links: 'ONLY_ME' } });
        nostr.publishProfileUpdate.mockClear();
        const res = await call('PUT', '/api/profiles/me', { token: cara.token, body: { lightningAddress: 'cara2@ln.test' } });
        expect(res.status).toBe(200);
        expect(lastProfilePublish()).toMatchObject({ lud16: '', website: '' });
        expect(nostr.publishAnnouncement).not.toHaveBeenCalled();
    });

    it('a follow is announced only when neither member keeps their network private', async () => {
        const dan = await member('Dan Follow');
        const eve = await member('Eve Follow');
        const fay = await member('Fay Private');
        await call('PUT', '/api/settings/privacy', { token: fay.token, body: { network: 'ONLY_ME' } });

        expect((await call('POST', `/api/profiles/${eve.id}/follow`, { token: dan.token })).status).toBe(201);
        expect(nostr.publishAnnouncement).toHaveBeenCalledTimes(1);
        expect((await call('POST', `/api/profiles/${fay.id}/follow`, { token: dan.token })).status).toBe(201);
        expect((await call('POST', `/api/profiles/${dan.id}/follow`, { token: fay.token })).status).toBe(201);
        expect(nostr.publishAnnouncement).toHaveBeenCalledTimes(1);
    });
});

describe('blocks', () => {
    it("hide a member's followers and following both ways, and leave blocked members out of others' lists", async () => {
        const ana = await member('Ana Lists');
        const ben = await member('Ben Lists');
        const carl = await member('Carl Lists');
        await call('POST', `/api/profiles/${ana.id}/follow`, { token: carl.token });
        await call('POST', `/api/profiles/${ben.id}/follow`, { token: carl.token });
        await block(ana, ben);

        for (const [viewer, target] of [[ben, ana], [ana, ben]] as const) {
            expect((await call('GET', `/api/profiles/${target.id}/followers`, { token: viewer.token })).status).toBe(404);
            expect((await call('GET', `/api/profiles/${target.id}/following`, { token: viewer.token })).status).toBe(404);
        }
        // Carl follows both: Ben doesn't see Ana in Carl's list, nor the reverse.
        const forBen = (await call('GET', `/api/profiles/${carl.id}/following`, { token: ben.token })).body;
        expect(forBen.data.map((u: any) => u.id)).toEqual([ben.id]);
        expect(forBen.pagination.total).toBe(1);
        const forCarl = (await call('GET', `/api/profiles/${carl.id}/following`, { token: carl.token })).body;
        expect(forCarl.pagination.total).toBe(2);
    });

    it("don't hide a member from staff, and a mutual block keeps the Unblock card", async () => {
        const mod = await member('Mo Staff', { role: 'MOD' });
        const eve = await member('Eve Blocks');
        await block(eve, mod);
        expect((await call('GET', `/api/profiles/${eve.id}`, { token: mod.token })).status).toBe(200);

        const ana = await member('Ana Mutual');
        const ben = await member('Ben Mutual');
        await block(ana, ben);
        await block(ben, ana);
        const res = await call('GET', `/api/profiles/${ben.id}`, { token: ana.token });
        expect(res.status).toBe(200);
        expect(res.body.blocked).toBe(true);
    });
});

describe('staff', () => {
    it('see members\' "Only me" albums no more, can\'t change who sees an album, and can still take one down', async () => {
        const mod = await member('Mo Albums', { role: 'MOD' });
        const ana = await member('Ana Albums');
        const mine = await prisma.album.create({ data: { userId: ana.id, title: 'Just me', visibility: 'ONLY_ME' } });
        const shared = await prisma.album.create({ data: { userId: ana.id, title: 'Farm', visibility: 'MEMBERS' } });

        expect((await call('GET', `/api/albums/${mine.id}`, { token: mod.token })).status).toBe(404);
        const listed = (await call('GET', `/api/albums?user=${ana.id}`, { token: mod.token })).body;
        expect(listed.data.map((a: any) => a.id)).toEqual([shared.id]);
        expect(listed.canManage).toBe(false);
        expect((await call('PATCH', `/api/albums/${shared.id}`, { token: mod.token, body: { visibility: 'PUBLIC' } })).status).toBe(403);
        expect((await call('DELETE', `/api/albums/${shared.id}`, { token: mod.token })).status).toBe(200);
        expect((await call('GET', `/api/albums/${mine.id}`, { token: ana.token })).status).toBe(200);
    });

    it('a moderator can\'t move a listing to themselves; an admin can', async () => {
        const mod = await member('Mo Listings', { role: 'MOD' });
        const admin = await member('Ada Admin', { isAdmin: true });
        const owner = await member('Olga Owner');
        const listing = await prisma.directoryListing.create({
            data: { type: 'PROVIDER', name: 'Rival Café', ownerId: owner.id, status: 'active', isPublished: true },
        });
        const byMod = await call('POST', `/api/admin/directory/${listing.id}/owner`, { token: mod.token, body: { userId: mod.id } });
        expect(byMod.status).toBe(403);
        expect(byMod.body.reason).toBe('own_listing');
        expect((await call('POST', `/api/admin/directory/${listing.id}/owner`, { token: admin.token, body: { userId: admin.id } })).status).toBe(200);
    });
});

describe('feed notifications', () => {
    it('need a real post id, and the same one notifies once', async () => {
        const ana = await member('Ana Feed');
        const ben = await member('Ben Feed');
        const pubkey = (await prisma.user.findUniqueOrThrow({ where: { id: ana.id } })).nostrPubkey;
        const send = (body: Record<string, unknown>) => call('POST', '/api/notifications/feed-interaction', { token: ben.token, body: { targetPubkey: pubkey, ...body } });
        const count = () => prisma.notification.count({ where: { userId: ana.id } });

        expect((await send({ type: 'POST_LIKE' })).status).toBe(400);
        expect((await send({ type: 'POST_LIKE', eventId: '../admin' })).status).toBe(400);
        for (let i = 0; i < 3; i++) await send({ type: 'POST_LIKE', eventId: 'b'.repeat(64) });
        expect(await count()).toBe(1);
        // Two different comments on one post both notify; the same one twice doesn't.
        await send({ type: 'POST_COMMENT', eventId: 'b'.repeat(64), contentPreview: 'Lovely farm' });
        await send({ type: 'POST_COMMENT', eventId: 'b'.repeat(64), contentPreview: 'Lovely farm' });
        await send({ type: 'POST_COMMENT', eventId: 'b'.repeat(64), contentPreview: 'When can I visit?' });
        expect(await count()).toBe(3);
    });
});

describe('private file links', () => {
    it('refuse a malformed signature without throwing', () => {
        const name = '1760000000000-0123456789abcdef0123456789abcdef.pdf';
        const exp = String(Date.now() + 60_000);
        expect(privateFileFromLink(name, exp, 'é'.repeat(64))).toBeNull();
        expect(privateFileFromLink(name, exp, 'a'.repeat(63) + 'é')).toBeNull();
        expect(privateFileFromLink(name, exp, '')).toBeNull();
    });
});
