/**
 * Uploads, end to end: what is stored (shrunk, without location), the record
 * of who uploaded it, and its file going when what showed it goes: an album
 * photo, an album, a replaced profile photo, a listing's photos, a deleted or
 * removed post, an account. Files still shown somewhere else stay, and
 * nobody's changes delete someone else's upload. Real routes against a real
 * SQLite database built from the repo's migrations, files in a temp folder.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const env = vi.hoisted(() => {
    const dir = `${process.env.TMPDIR || '/tmp'}/bies-uploads-test-${process.pid}-${Date.now()}`;
    process.env.DATABASE_URL = `file:${dir}/test.db`;
    process.env.RELAY_WHITELIST_PATH = `${dir}/relay/whitelist.txt`;
    process.env.UPLOAD_DIR = `${dir}/uploads`;
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
import sharp from 'sharp';
import prisma from '../lib/prisma';
import uploadRoutes from '../routes/upload.routes';
import albumRoutes from '../routes/album.routes';
import profileRoutes from '../routes/profile.routes';
import directoryRoutes from '../routes/directory.routes';
import adminRoutes from '../routes/admin.routes';
import moderationRoutes from '../routes/moderation.routes';
import { deleteAccount } from '../services/account.service';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { createSession, signAccessToken } from '../services/session.service';
import { HAS_FFMPEG, testClip } from './helpers/videos';

let server: http.Server;
let base: string;

beforeAll(async () => {
    fs.mkdirSync(env.dir, { recursive: true });
    execSync('npx prisma migrate deploy', { cwd: path.resolve(__dirname, '../..'), env: process.env, stdio: 'pipe' });
    const app = express();
    app.use(express.json());
    app.use('/api/upload', uploadRoutes);
    app.use('/api/albums', albumRoutes);
    app.use('/api/profiles', profileRoutes);
    app.use('/api/directory', directoryRoutes);
    app.use('/api/admin', adminRoutes);
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

async function call(method: string, url: string, { token, body }: { token?: string; body?: unknown } = {}) {
    const res = await fetch(`${base}${url}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

type Member = { id: string; token: string; secretKey: Uint8Array };
async function member(name: string, role = 'MEMBER'): Promise<Member> {
    const secretKey = generateSecretKey();
    const user = await prisma.user.create({
        data: {
            nostrPubkey: getPublicKey(secretKey),
            role,
            termsVersion: '2026-10',
            termsAcceptedAt: new Date(),
            profile: { create: { name } },
        },
    });
    const session = await createSession(user.id, 'native');
    return { id: user.id, secretKey, token: signAccessToken({ id: user.id, role, isAdmin: false }, session.sessionId) };
}

const photo = (seed = 0) =>
    sharp({ create: { width: 3200, height: 2400, channels: 3, background: { r: 100 + seed, g: 150, b: 90 } } }).jpeg()
        .withExif({ IFD0: { Make: 'TestPhone' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '13/1 41/1 34/1', GPSMapDatum: 'WGS-84' } })
        .toBuffer();

async function upload(m: Member, file: Buffer, type = 'image/jpeg') {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(file)], { type }), 'from-the-phone.jpg');
    const res = await fetch(`${base}/api/upload/media`, { method: 'POST', headers: { Authorization: `Bearer ${m.token}` }, body: form });
    return { status: res.status, body: (await res.json()) as any };
}

let seed = 0;
/** A photo this member uploaded: its link as stored (/uploads/public/...). */
const uploaded = async (m: Member) => {
    const res = await upload(m, await photo(++seed));
    if (res.status !== 200) throw new Error(`upload failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.url as string;
};
const absolute = (url: string) => `https://app.example.test${url}`;
const fileOf = (url: string) => path.join(env.dir, 'uploads', 'public', url.split('/').pop()!);
const stored = (url: string) => fs.existsSync(fileOf(url));

describe('uploading', () => {
    it('stores a smaller copy without its location, recorded as the member\'s', async () => {
        const ana = await member('Ana');
        const input = await photo();
        const res = await upload(ana, input);
        expect(res.status).toBe(200);
        expect(res.body.url).toMatch(/^\/uploads\/public\/\d{13}-[0-9a-f]{32}\.jpg$/);
        expect(res.body).toMatchObject({ type: 'image/jpeg', width: 1600, height: 1200 });

        const file = fs.readFileSync(fileOf(res.body.url));
        expect(file.includes('WGS-84')).toBe(false);
        expect(file.includes('TestPhone')).toBe(false);
        expect((await sharp(file).metadata()).exif).toBeUndefined();
        expect(res.body.size).toBe(file.length);
        expect(res.body.sha256).toBe(crypto.createHash('sha256').update(file).digest('hex'));

        const record = await prisma.upload.findUnique({ where: { name: res.body.url.split('/').pop() } });
        expect(record).toMatchObject({ userId: ana.id, mimeType: 'image/jpeg', size: file.length, isPrivate: false });
    });

    it('turns away a file that isn\'t the photo it says, and keeps nothing of it', async () => {
        const ana = await member('Ana B');
        const before = await prisma.upload.count();
        const res = await upload(ana, Buffer.from('<html><script>alert(1)</script></html>'));
        expect(res.status).toBe(400);
        expect(await prisma.upload.count()).toBe(before);
    });

    it.skipIf(!HAS_FFMPEG)('makes a video a smaller MP4, with a still from it when asked; both recorded as the member\'s, nothing left mid-way', { timeout: 60_000 }, async () => {
        const ana = await member('Ana V');
        const input = testClip(1, '1600x900');
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(input)], { type: 'video/quicktime' }), 'IMG_0001.MOV');
        const res = await fetch(`${base}/api/upload/media?poster=1`, { method: 'POST', headers: { Authorization: `Bearer ${ana.token}` }, body: form });
        const body = await res.json() as any;
        expect(res.status).toBe(200);
        expect(body).toMatchObject({ type: 'video/mp4', width: 1280, height: 720 });
        expect(body.duration).toBeCloseTo(1, 0);
        expect(body.url).toMatch(/^\/uploads\/public\/\d{13}-[0-9a-f]{32}\.mp4$/);
        expect(body.poster).toMatch(/^\/uploads\/public\/\d{13}-[0-9a-f]{32}\.jpg$/);

        const file = fs.readFileSync(fileOf(body.url));
        expect(file.length).toBe(body.size);
        expect(file.length).toBeLessThan(input.length);
        expect(body.sha256).toBe(crypto.createHash('sha256').update(file).digest('hex'));
        expect((await sharp(fs.readFileSync(fileOf(body.poster))).metadata()).width).toBe(1280);

        const records = await prisma.upload.findMany({ where: { name: { in: [body.url, body.poster].map((u: string) => u.split('/').pop()!) } } });
        expect(records.map((r) => [r.userId, r.mimeType]).sort()).toEqual([[ana.id, 'image/jpeg'], [ana.id, 'video/mp4']]);
        // Nothing left mid-way, the file sent included (removed once it's answered).
        await vi.waitFor(() => expect(fs.readdirSync(path.join(env.dir, 'uploads', 'processing'))).toEqual([]));

        // Without ?poster=1, just the video.
        const plain = new FormData();
        plain.append('file', new Blob([new Uint8Array(testClip())], { type: 'video/mp4' }), 'clip.mp4');
        const again = await (await fetch(`${base}/api/upload/media`, { method: 'POST', headers: { Authorization: `Bearer ${ana.token}` }, body: plain })).json() as any;
        expect(again.type).toBe('video/mp4');
        expect(again.poster).toBeUndefined();
    });

    it.skipIf(!HAS_FFMPEG)('one member\'s videos wait four at a time; more are turned away until those are done', { timeout: 60_000 }, async () => {
        const ana = await member('Ana Q');
        const clipFile = testClip(2);
        const send = () => {
            const form = new FormData();
            form.append('file', new Blob([new Uint8Array(clipFile)], { type: 'video/mp4' }), 'clip.mp4');
            return fetch(`${base}/api/upload/media`, { method: 'POST', headers: { Authorization: `Bearer ${ana.token}` }, body: form })
                .then(async (r) => ({ status: r.status, body: await r.json() as any }));
        };
        const all = await Promise.all([send(), send(), send(), send(), send(), send()]);
        const turnedAway = all.filter((r) => r.status === 429);
        expect(all.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(4);
        expect(turnedAway.length).toBeGreaterThanOrEqual(1);
        expect(turnedAway[0].body.reason).toBe('busy');
        // Their turns are given back.
        expect((await send()).status).toBe(200);
    });
});

describe('deleting', () => {
    it('albums take only the member\'s own uploads; a photo\'s file goes with it, unless it shows elsewhere', async () => {
        const ana = await member('Ana C');
        const ben = await member('Ben C');
        const [p1, p2, p3] = [await uploaded(ana), await uploaded(ana), await uploaded(ana)];
        const bens = await uploaded(ben);

        const album = (await call('POST', '/api/albums', { token: ana.token, body: { title: 'Harvest' } })).body.id;
        expect((await call('POST', `/api/albums/${album}/photos`, { token: ana.token, body: { photos: [{ url: absolute(bens) }] } })).status).toBe(400);
        const added = await call('POST', `/api/albums/${album}/photos`, { token: ana.token, body: { photos: [{ url: absolute(p1) }, { url: p2 }] } });
        expect(added.status).toBe(201);
        const [photo1, photo2] = added.body.data;

        // p1 is her profile photo too.
        expect((await call('PUT', '/api/profiles/me', { token: ana.token, body: { avatar: absolute(p1) } })).status).toBe(200);

        await call('DELETE', `/api/albums/${album}/photos/${photo2.id}`, { token: ana.token });
        expect(stored(p2)).toBe(false);
        expect(await prisma.upload.count({ where: { name: p2.split('/').pop() } })).toBe(0);

        await call('DELETE', `/api/albums/${album}`, { token: ana.token });
        expect(await prisma.albumPhoto.count({ where: { id: photo1.id } })).toBe(0);
        expect(stored(p1)).toBe(true); // still her profile photo

        // A new profile photo: the old one goes.
        await call('PUT', '/api/profiles/me', { token: ana.token, body: { avatar: absolute(p3) } });
        expect(stored(p1)).toBe(false);
        expect(stored(p3)).toBe(true);
        expect(stored(bens)).toBe(true);
    });

    it('nobody\'s changes delete someone else\'s upload', async () => {
        const ana = await member('Ana D');
        const ben = await member('Ben D');
        const bens = await uploaded(ben);

        // Ana uses Ben's photo as her cover, then drops it.
        await call('PUT', '/api/profiles/me', { token: ana.token, body: { banner: absolute(bens) } });
        await call('PUT', '/api/profiles/me', { token: ana.token, body: { banner: '' } });
        expect(stored(bens)).toBe(true);
        expect((await call('POST', '/api/upload/discard', { token: ana.token, body: { urls: [absolute(bens)] } })).body.deleted).toBe(0);
        expect(stored(bens)).toBe(true);

        // Ben deleting his own post's photo does delete it.
        expect((await call('POST', '/api/upload/discard', { token: ben.token, body: { urls: [absolute(bens)] } })).body.deleted).toBe(1);
        expect(stored(bens)).toBe(false);
    });

    it('a listing\'s photos and albums go with it; photos taken off it go too', async () => {
        const sofia = await member('Sofia');
        const mod = await member('Moderator', 'MOD');
        const [hero, gallery, inAlbum, other] = [await uploaded(sofia), await uploaded(sofia), await uploaded(sofia), await uploaded(sofia)];
        const farm = await prisma.directoryListing.create({
            data: { type: 'FARM', name: 'Finca U', ownerId: sofia.id, status: 'active', photo: absolute(hero), photos: JSON.stringify([absolute(gallery)]) },
        });

        expect((await call('PUT', `/api/directory/${farm.id}`, { token: sofia.token, body: { photos: [] } })).status).toBe(200);
        expect(stored(gallery)).toBe(false);
        expect(stored(hero)).toBe(true);

        const album = (await call('POST', '/api/albums', { token: sofia.token, body: { title: 'Coffee rows', listingId: farm.id } })).body.id;
        expect((await call('POST', `/api/albums/${album}/photos`, { token: sofia.token, body: { photos: [{ url: inAlbum }] } })).status).toBe(201);

        expect((await call('DELETE', `/api/directory/${farm.id}`, { token: sofia.token })).status).toBe(200);
        expect(stored(hero)).toBe(false);
        expect(stored(inAlbum)).toBe(false);
        expect(await prisma.album.count({ where: { id: album } })).toBe(0);

        // A moderator removing a listing: the same.
        const shop = await prisma.directoryListing.create({ data: { type: 'PROVIDER', name: 'Tienda U', ownerId: sofia.id, status: 'active', logo: absolute(other) } });
        expect((await call('DELETE', `/api/admin/directory/${shop.id}`, { token: mod.token })).status).toBe(200);
        expect(stored(other)).toBe(false);
    });

    it('a moderator removing a reported post deletes its photos, even past where the text was cut', async () => {
        const ana = await member('Ana E');
        const ben = await member('Ben E');
        const mod = await member('Moderator E', 'MOD');
        const [short, long] = [await uploaded(ana), await uploaded(ana)];
        const post = (content: string, url: string) => finalizeEvent({
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['t', 'bies'], ['imeta', `url ${absolute(url)}`, 'm image/jpeg']],
            content,
        }, ana.secretKey);

        for (const [event, url] of [[post(`Harvest day\n${absolute(short)}`, short), short], [post(`${'Long story. '.repeat(200)}\n${absolute(long)}`, long), long]] as const) {
            expect((await call('POST', '/api/reports', { token: ben.token, body: { targetType: 'note', targetId: event.id, event, reason: 'scam_spam' } })).status).toBe(201);
            const report = await prisma.report.findFirstOrThrow({ where: { targetType: 'note', targetId: event.id } });
            expect(report.snapshot).toContain(absolute(url));
            expect((await call('DELETE', `/api/admin/reports/${report.id}/note`, { token: mod.token })).status).toBe(200);
            expect(stored(url)).toBe(false);
        }
    });

    it('a GIF in the shared library stays when a post showing it is deleted, and goes with its uploader\'s account', async () => {
        const gina = await member('Gina');
        const gif = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#f80' } }).gif().toBuffer();
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(gif)], { type: 'image/gif' }), 'dance.gif');
        const res = await fetch(`${base}/api/upload/media?shared=1`, { method: 'POST', headers: { Authorization: `Bearer ${gina.token}` }, body: form });
        expect(res.status).toBe(200);
        const url = ((await res.json()) as any).url as string;
        expect(await prisma.upload.findUnique({ where: { name: url.split('/').pop() } })).toMatchObject({ shared: true });

        // Gina deletes her post with it: other members' posts may show it.
        expect((await call('POST', '/api/upload/discard', { token: gina.token, body: { urls: [absolute(url)] } })).status).toBe(200);
        expect(stored(url)).toBe(true);

        await deleteAccount(gina.id, { notify: false });
        expect(stored(url)).toBe(false);
    });

    it('deleting an account deletes the member\'s files, except one still shown on someone else\'s listing', async () => {
        const carla = await member('Carla');
        const dan = await member('Dan');
        const [avatar, inAlbum, inPost, onDansListing] = [await uploaded(carla), await uploaded(carla), await uploaded(carla), await uploaded(carla)];
        await call('PUT', '/api/profiles/me', { token: carla.token, body: { avatar: absolute(avatar) } });
        const album = (await call('POST', '/api/albums', { token: carla.token, body: { title: 'Mine' } })).body.id;
        await call('POST', `/api/albums/${album}/photos`, { token: carla.token, body: { photos: [{ url: inAlbum }] } });
        await prisma.directoryListing.create({ data: { type: 'FARM', name: 'Finca Dan', ownerId: dan.id, status: 'active', photo: absolute(onDansListing) } });

        await deleteAccount(carla.id, { notify: false });
        expect([avatar, inAlbum, inPost].map(stored)).toEqual([false, false, false]);
        expect(stored(onDansListing)).toBe(true);
        expect(await prisma.upload.findUnique({ where: { name: onDansListing.split('/').pop() } })).toMatchObject({ userId: null });
    });
});
