/**
 * Settings → Privacy and photo albums, end to end: who sees which parts of a
 * profile (signed out, a member, the member), follower lists, the Members
 * directory switch, browsing privately; and albums for members and for farms
 * and businesses, with who runs them and who sees them. Real routes against
 * a real SQLite database built from the repo's migrations.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const env = vi.hoisted(() => {
    const dir = `${process.env.TMPDIR || '/tmp'}/bies-privacy-test-${process.pid}-${Date.now()}`;
    process.env.DATABASE_URL = `file:${dir}/test.db`;
    process.env.RELAY_WHITELIST_PATH = `${dir}/relay/whitelist.txt`;
    process.env.CORS_ORIGIN = 'https://app.example.test';
    process.env.APP_PUBLIC_URL = 'https://app.example.test';
    process.env.MODERATION_EMAIL = 'moderators@example.test';
    process.env.TERMS_VERSION = '2026-10';
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
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import express from 'express';
import prisma from '../lib/prisma';
import profileRoutes from '../routes/profile.routes';
import settingsRoutes from '../routes/settings.routes';
import albumRoutes from '../routes/album.routes';
import searchRoutes from '../routes/search.routes';
import moderationRoutes from '../routes/moderation.routes';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { createSession, signAccessToken } from '../services/session.service';

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
    app.use('/api/search', searchRoutes);
    app.use('/api', moderationRoutes);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 120_000);

afterAll(async () => {
    server?.close();
    await prisma.$disconnect();
    fs.rmSync(env.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); // a late write can race the delete (ENOTEMPTY)
});

async function call(method: string, url: string, { token, body }: { token?: string; body?: unknown } = {}) {
    const res = await fetch(`${base}${url}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

type Member = { id: string; token: string; profileId: string };
let n = 0;
async function member(name: string, profile: Record<string, unknown> = {}): Promise<Member> {
    const user = await prisma.user.create({
        data: {
            nostrPubkey: getPublicKey(generateSecretKey()),
            role: 'MEMBER',
            termsVersion: '2026-10',
            termsAcceptedAt: new Date(),
            profile: {
                create: {
                    name, bio: `${name} grows coffee`, title: 'Founder', company: `${name} Co`, location: `Town${++n}`,
                    website: 'https://example.test', lightningAddress: `${name.toLowerCase().replace(/\W/g, '')}@ln.test`,
                    experience: JSON.stringify([{ title: 'Grower' }]), tags: JSON.stringify(['coffee']),
                    ...profile,
                },
            },
        },
        include: { profile: true },
    });
    const session = await createSession(user.id, 'native');
    return { id: user.id, profileId: user.profile!.id, token: signAccessToken({ id: user.id, role: 'MEMBER', isAdmin: false }, session.sessionId) };
}

const setPrivacy = (m: Member, body: Record<string, unknown>) => call('PUT', '/api/settings/privacy', { token: m.token, body });

describe('who sees what on a profile', () => {
    it('signed out: name, photos and headline, and the bio; nothing else', async () => {
        const ana = await member('Ana');
        const res = await call('GET', `/api/profiles/${ana.id}`);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ name: 'Ana', title: 'Founder', company: 'Ana Co', bio: 'Ana grows coffee' });
        for (const hidden of ['location', 'website', 'lightningAddress', 'experience', 'tags', 'viewCount', 'privacy']) {
            expect(res.body[hidden], hidden).toBeUndefined();
        }
        expect(res.body.networkHidden).toBe(true);

        await setPrivacy(ana, { bio: 'MEMBERS' });
        expect((await call('GET', `/api/profiles/${ana.id}`)).body.bio).toBe('');
    });

    it('a member sees the rest, unless it is set to Only me; the member sees it all', async () => {
        const ana = await member('Ana B');
        const ben = await member('Ben');
        let res = await call('GET', `/api/profiles/${ana.id}`, { token: ben.token });
        expect(res.body).toMatchObject({ location: expect.stringMatching(/^Town/), website: 'https://example.test', tags: ['coffee'], networkHidden: false });
        expect(res.body.privacy).toBeUndefined();

        await setPrivacy(ana, { location: 'ONLY_ME', links: 'ONLY_ME', details: 'ONLY_ME', network: 'ONLY_ME' });
        res = await call('GET', `/api/profiles/${ana.id}`, { token: ben.token });
        expect(res.body).toMatchObject({ location: '', website: '', lightningAddress: '', tags: [], experience: [], networkHidden: true, name: 'Ana B' });

        res = await call('GET', `/api/profiles/${ana.id}`, { token: ana.token });
        expect(res.body).toMatchObject({ website: 'https://example.test', tags: ['coffee'], privacy: { location: 'ONLY_ME', bio: 'PUBLIC' } });
    });

    it('a search finds a member only by what the searcher can see', async () => {
        const cara = await member('Cara', { location: 'Perquin' });
        const ben = await member('Ben C');
        const found = (r: any) => (r.body.profiles || []).some((p: any) => p.userId === cara.id);
        expect(found(await call('GET', '/api/search?q=Perquin&type=profiles', { token: ben.token }))).toBe(true);
        expect(found(await call('GET', '/api/search?q=Perquin&type=profiles'))).toBe(false);
        await setPrivacy(cara, { location: 'ONLY_ME' });
        expect(found(await call('GET', '/api/search?q=Perquin&type=profiles', { token: ben.token }))).toBe(false);
        const listed = await call('GET', '/api/profiles?search=Perquin', { token: ben.token });
        expect(listed.body.data.some((p: any) => p.userId === cara.id)).toBe(false);
    });

    it('followers and following: members only, and Only me hides them from others', async () => {
        const ana = await member('Ana D');
        const ben = await member('Ben D');
        await prisma.follow.create({ data: { followerId: ben.id, followingId: ana.id } });
        expect((await call('GET', `/api/profiles/${ana.id}/followers`)).status).toBe(401);
        let res = await call('GET', `/api/profiles/${ana.id}/followers`, { token: ben.token });
        expect(res.body.data.map((u: any) => u.id)).toEqual([ben.id]);

        await setPrivacy(ana, { network: 'ONLY_ME' });
        res = await call('GET', `/api/profiles/${ana.id}/followers`, { token: ben.token });
        expect(res.body).toMatchObject({ data: [], hidden: true, pagination: { total: 1 } });
        res = await call('GET', `/api/profiles/${ana.id}/followers`, { token: ana.token });
        expect(res.body.data).toHaveLength(1);
    });

    it('out of the Members directory: not listed, not for strangers, still for members', async () => {
        const dan = await member('Dan');
        const ben = await member('Ben E');
        await setPrivacy(dan, { showInDirectory: false });
        const list = await call('GET', '/api/profiles?limit=50', { token: ben.token });
        expect(list.body.data.some((p: any) => p.userId === dan.id)).toBe(false);
        expect((await call('GET', `/api/profiles/${dan.id}`)).status).toBe(404);
        expect((await call('GET', `/api/profiles/${dan.id}`, { token: ben.token })).status).toBe(200);
    });

    it('browsing privately sends no "viewed your profile"', async () => {
        const ana = await member('Ana F');
        const ben = await member('Ben F');
        const cleo = await member('Cleo F');
        await setPrivacy(cleo, { browsePrivately: true });
        await call('GET', `/api/profiles/${ana.id}`, { token: ben.token });
        await call('GET', `/api/profiles/${ana.id}`, { token: cleo.token });
        await new Promise((r) => setTimeout(r, 300));
        const views = await prisma.notification.findMany({ where: { userId: ana.id, type: 'PROFILE_VIEW' } });
        expect(views.map((v) => JSON.parse(v.data).viewerId)).toEqual([ben.id]);
    });

    it('the settings: defaults, saving, and only the allowed choices', async () => {
        const eva = await member('Eva');
        expect((await call('GET', '/api/settings/privacy', { token: eva.token })).body).toEqual({
            showInDirectory: true, browsePrivately: false, postsOnProfile: true,
            bio: 'PUBLIC', location: 'MEMBERS', links: 'MEMBERS', details: 'MEMBERS', network: 'MEMBERS',
        });
        expect((await setPrivacy(eva, { location: 'PUBLIC' })).status).toBe(400);
        expect((await setPrivacy(eva, { bio: 'ONLY_ME' })).status).toBe(400);
        const saved = await setPrivacy(eva, { postsOnProfile: false, details: 'ONLY_ME' });
        expect(saved.body).toMatchObject({ postsOnProfile: false, details: 'ONLY_ME', location: 'MEMBERS' });
        expect((await prisma.profile.findUnique({ where: { userId: eva.id } }))?.nostrFeedMode).toBe('off');
    });
});

describe('photo albums', () => {
    // A stored file's link (storage.service.ts names), and its record as this member's upload.
    const fileName = (label: string) => `1760000000000-${crypto.createHash('md5').update(label).digest('hex')}.jpg`;
    const upload = (label: string) => `https://app.example.test/uploads/public/${fileName(label)}`;
    const owned = (m: Member, ...labels: string[]) =>
        Promise.all(labels.map((label) => prisma.upload.create({ data: { name: fileName(label), userId: m.id } })));

    it('a member makes an album and adds BIES photos; members see it, strangers do not', async () => {
        const ana = await member('Ana G');
        const ben = await member('Ben G');
        const created = await call('POST', '/api/albums', { token: ana.token, body: { title: 'Harvest 2026', description: 'Week by week' } });
        expect(created.status).toBe(201);
        expect(created.body.visibility).toBe('MEMBERS');
        const id = created.body.id;

        expect((await call('POST', `/api/albums/${id}/photos`, { token: ana.token, body: { photos: [{ url: 'https://elsewhere.test/x.jpg' }] } })).status).toBe(400);
        expect((await call('POST', `/api/albums/${id}/photos`, { token: ben.token, body: { photos: [{ url: upload('b') }] } })).status).toBe(403);
        // Only her own uploads: one of Ben's is turned away.
        await owned(ben, 'b');
        expect((await call('POST', `/api/albums/${id}/photos`, { token: ana.token, body: { photos: [{ url: upload('b') }] } })).status).toBe(400);
        await owned(ana, 'week1', 'week2');
        const added = await call('POST', `/api/albums/${id}/photos`, {
            token: ana.token,
            body: { photos: [{ url: upload('week1'), caption: 'Week 1' }, { url: new URL(upload('week2')).pathname, caption: 'Week 2' }] },
        });
        expect(added.status).toBe(201);

        const seen = await call('GET', `/api/albums/${id}`, { token: ben.token });
        expect(seen.body).toMatchObject({ title: 'Harvest 2026', canManage: false, owner: { type: 'user', id: ana.id, name: 'Ana G' } });
        expect(seen.body.photos.map((p: any) => p.caption)).toEqual(['Week 1', 'Week 2']);
        expect((await call('GET', `/api/albums/${id}`)).status).toBe(404);
        const list = await call('GET', `/api/albums?user=${ana.id}`, { token: ben.token });
        expect(list.body).toMatchObject({ canManage: false, data: [{ id, photoCount: 2, cover: { url: upload('week1') } }] });
        expect((await call('GET', `/api/albums?user=${ana.id}`, { token: ana.token })).body.canManage).toBe(true);
    });

    it('Public for anyone, Only me for the member alone', async () => {
        const ana = await member('Ana H');
        const ben = await member('Ben H');
        const pub = (await call('POST', '/api/albums', { token: ana.token, body: { title: 'Open day', visibility: 'PUBLIC' } })).body.id;
        const mine = (await call('POST', '/api/albums', { token: ana.token, body: { title: 'Drafts', visibility: 'ONLY_ME' } })).body.id;
        expect((await call('GET', `/api/albums/${pub}`)).status).toBe(200);
        expect((await call('GET', `/api/albums/${mine}`, { token: ben.token })).status).toBe(404);
        expect((await call('GET', `/api/albums/${mine}`, { token: ana.token })).status).toBe(200);
        const titles = (r: any) => r.body.data.map((a: any) => a.title).sort();
        expect(titles(await call('GET', `/api/albums?user=${ana.id}`))).toEqual(['Open day']);
        expect(titles(await call('GET', `/api/albums?user=${ana.id}`, { token: ana.token }))).toEqual(['Drafts', 'Open day']);
    });

    it('a farm\'s albums are run by whoever runs the farm, and follow it when it changes hands', async () => {
        const sofia = await member('Sofia');
        const ben = await member('Ben I');
        const farm = await prisma.directoryListing.create({ data: { type: 'FARM', name: 'Finca I', ownerId: sofia.id, status: 'active', isOwnBusiness: true } });
        expect((await call('POST', '/api/albums', { token: ben.token, body: { title: 'Nope', listingId: farm.id } })).status).toBe(403);
        expect((await call('POST', '/api/albums', { token: sofia.token, body: { title: 'Mine', listingId: farm.id, visibility: 'ONLY_ME' } })).status).toBe(400);
        const album = await call('POST', '/api/albums', { token: sofia.token, body: { title: 'Coffee rows', listingId: farm.id, visibility: 'PUBLIC' } });
        expect(album.status).toBe(201);
        const seen = await call('GET', `/api/albums/${album.body.id}`);
        expect(seen.body.owner).toMatchObject({ type: 'listing', id: farm.id, name: 'Finca I', path: `/farms/${farm.id}` });
        expect((await call('GET', `/api/albums?listing=${farm.id}`, { token: sofia.token })).body.canManage).toBe(true);

        await prisma.directoryListing.update({ where: { id: farm.id }, data: { ownerId: ben.id } });
        expect((await call('PATCH', `/api/albums/${album.body.id}`, { token: ben.token, body: { title: 'Coffee rows, 2026' } })).status).toBe(200);
        expect((await call('PATCH', `/api/albums/${album.body.id}`, { token: sofia.token, body: { title: 'x' } })).status).toBe(403);
    });

    it('the cover, and what happens when its photo goes', async () => {
        const ana = await member('Ana J');
        const id = (await call('POST', '/api/albums', { token: ana.token, body: { title: 'Cover test' } })).body.id;
        await owned(ana, 'c1', 'c2');
        const photos = (await call('POST', `/api/albums/${id}/photos`, { token: ana.token, body: { photos: [{ url: upload('c1') }, { url: upload('c2') }] } })).body.data;
        expect((await call('PATCH', `/api/albums/${id}`, { token: ana.token, body: { coverPhotoId: photos[1].id } })).status).toBe(200);
        const cover = async () => (await call('GET', `/api/albums?user=${ana.id}`, { token: ana.token })).body.data[0].cover.url;
        expect(await cover()).toBe(upload('c2'));
        await call('DELETE', `/api/albums/${id}/photos/${photos[1].id}`, { token: ana.token });
        expect(await cover()).toBe(upload('c1'));
        const other = (await call('POST', '/api/albums', { token: ana.token, body: { title: 'Other' } })).body.id;
        expect((await call('PATCH', `/api/albums/${other}`, { token: ana.token, body: { coverPhotoId: photos[0].id } })).status).toBe(400);
    });

    it('captions are screened; a blocked member\'s albums are hidden; albums and photos can be reported', async () => {
        const ana = await member('Ana K');
        const ben = await member('Ben K');
        const id = (await call('POST', '/api/albums', { token: ana.token, body: { title: 'Farm' } })).body.id;
        await owned(ana, 'k', 'k2');
        const bad = await call('POST', `/api/albums/${id}/photos`, { token: ana.token, body: { photos: [{ url: upload('k'), caption: 'kill yourself' }] } });
        expect(bad.status).toBe(422);
        expect((await call('POST', '/api/albums', { token: ana.token, body: { title: 'Puta farm' } })).status).toBe(422);

        const photo = (await call('POST', `/api/albums/${id}/photos`, { token: ana.token, body: { photos: [{ url: upload('k2') }] } })).body.data[0];
        expect((await call('POST', '/api/reports', { token: ben.token, body: { targetType: 'photo', targetId: photo.id, reason: 'sexual' } })).status).toBe(201);
        expect((await call('POST', '/api/reports', { token: ben.token, body: { targetType: 'album', targetId: id, reason: 'scam_spam' } })).status).toBe(201);
        expect((await call('POST', '/api/reports', { token: ana.token, body: { targetType: 'photo', targetId: photo.id, reason: 'scam_spam' } })).status).not.toBe(201);
        const report = await prisma.report.findFirst({ where: { targetType: 'photo', targetId: photo.id } });
        expect(report?.targetUserId).toBe(ana.id);

        await prisma.block.create({ data: { blockerId: ben.id, blockedId: ana.id } });
        expect((await call('GET', `/api/albums/${id}`, { token: ben.token })).status).toBe(404);
    });

    it('deleting an album deletes its photos', async () => {
        const ana = await member('Ana L');
        const id = (await call('POST', '/api/albums', { token: ana.token, body: { title: 'Gone' } })).body.id;
        await owned(ana, 'l');
        await call('POST', `/api/albums/${id}/photos`, { token: ana.token, body: { photos: [{ url: upload('l') }] } });
        expect((await call('DELETE', `/api/albums/${id}`, { token: ana.token })).status).toBe(200);
        expect(await prisma.albumPhoto.count({ where: { albumId: id } })).toBe(0);
    });
});
