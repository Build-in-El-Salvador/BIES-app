/**
 * BIES Talents, end to end: members list what they offer to do (a skill or
 * a service) with their proof of work, for members only; only they change
 * it, and staff can remove it; blocks hide it both ways; its photos and
 * videos are the member's own uploads and go with it, unless something else
 * still shows them. Real routes against a real SQLite database built from the repo's
 * migrations, files in a temp folder.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const env = vi.hoisted(() => {
    const dir = `${process.env.TMPDIR || '/tmp'}/bies-talent-test-${process.pid}-${Date.now()}`;
    process.env.DATABASE_URL = `file:${dir}/test.db`;
    process.env.RELAY_WHITELIST_PATH = `${dir}/relay/whitelist.txt`;
    process.env.UPLOAD_DIR = `${dir}/uploads`;
    process.env.CORS_ORIGIN = 'https://app.example.test';
    process.env.APP_PUBLIC_URL = 'https://app.example.test';
    process.env.MODERATION_EMAIL = 'moderators@example.test';
    process.env.TERMS_VERSION = '2026-10';
    return { dir };
});

// Nothing in here should reach a relay or send an email.
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
import sharp from 'sharp';
import prisma from '../lib/prisma';
import talentRoutes from '../routes/talent.routes';
import uploadRoutes from '../routes/upload.routes';
import profileRoutes from '../routes/profile.routes';
import moderationRoutes from '../routes/moderation.routes';
import { deleteAccount } from '../services/account.service';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { createSession, signAccessToken } from '../services/session.service';
import { HAS_FFMPEG, testClip } from './helpers/videos';
import { MAX_TALENTS_PER_MEMBER } from '../controllers/talent.controller';
import { syncAccounts } from '../controllers/admin.controller';

let server: http.Server;
let base: string;

beforeAll(async () => {
    fs.mkdirSync(env.dir, { recursive: true });
    execSync('npx prisma migrate deploy', { cwd: path.resolve(__dirname, '../..'), env: process.env, stdio: 'pipe' });

    const app = express();
    app.use(express.json());
    app.use('/api/talent', talentRoutes);
    app.use('/api/upload', uploadRoutes);
    app.use('/api/profiles', profileRoutes);
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function call(method: string, url: string, { token, body }: { token?: string; body?: unknown } = {}) {
    const res = await fetch(`${base}${url}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

type Member = { id: string; token: string };

let counter = 0;
async function member({ name = `Member ${++counter}`, role = 'MEMBER', terms = true } = {}): Promise<Member> {
    const user = await prisma.user.create({
        data: {
            nostrPubkey: getPublicKey(generateSecretKey()),
            role,
            ...(terms ? { termsVersion: '2026-10', termsAcceptedAt: new Date() } : {}),
            profile: { create: { name } },
        },
    });
    const session = await createSession(user.id, 'native');
    return { id: user.id, token: signAccessToken({ id: user.id, role, isAdmin: false }, session.sessionId) };
}

const TALENT = { title: 'App developer', category: 'tech', workTypes: ['one-off'] };

async function addTalent(m: Member, body: Record<string, unknown> = {}) {
    const res = await call('POST', '/api/talent', { token: m.token, body: { ...TALENT, ...body } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
}

let seed = 0;
/** A photo this member uploaded: its link as stored (/uploads/public/...). */
async function uploaded(m: Member): Promise<string> {
    const file = await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 40 + (++seed % 200), g: 120, b: 90 } } }).jpeg().toBuffer();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(file)], { type: 'image/jpeg' }), 'work.jpg');
    const res = await fetch(`${base}/api/upload/media`, { method: 'POST', headers: { Authorization: `Bearer ${m.token}` }, body: form });
    const body = (await res.json()) as any;
    if (res.status !== 200) throw new Error(`upload failed: ${res.status} ${JSON.stringify(body)}`);
    return body.url as string;
}
const stored = (url: string) => fs.existsSync(path.join(env.dir, 'uploads', 'public', url.split('/').pop()!));

const ids = (res: { body: any }) => (res.body.data as { id: string }[]).map((t) => t.id);

// ─── Listing a talent ─────────────────────────────────────────────────────────

describe('listing a talent', () => {
    it('a member adds one, and other members see it with their name', async () => {
        const ana = await member({ name: 'Ana Developer' });
        const ben = await member();
        const talent = await addTalent(ana, {
            about: 'I build mobile apps for small businesses.',
            skills: ['React', 'iOS', 'React'],
            workTypes: ['long-term', 'one-off', 'long-term'],
            rate: '$40 an hour',
            btcAccepted: true,
            remote: true,
            location: 'El Zonte',
            works: [{ title: 'Surf school bookings', details: 'Booking app with Lightning payments.', link: 'https://example.com/surf', year: '2026' }],
            whatsapp: '+503 6123 4567',
            email: 'ana@example.com',
        });
        expect(talent.userId).toBe(ana.id);
        expect(talent.available).toBe(true);
        // Once each, in the same order every time.
        expect(talent.skills).toEqual(['React', 'iOS']);
        expect(talent.workTypes).toEqual(['one-off', 'long-term']);
        expect(talent.works).toEqual([{ title: 'Surf school bookings', details: 'Booking app with Lightning payments.', link: 'https://example.com/surf', year: '2026', media: [] }]);

        const seen = await call('GET', `/api/talent/${talent.id}`, { token: ben.token });
        expect(seen.status).toBe(200);
        expect(seen.body.user).toMatchObject({ id: ana.id, profile: { name: 'Ana Developer' } });
        // Only the member's name and photo come with it.
        expect(seen.body.user.isBanned).toBeUndefined();
        const listed = await call('GET', '/api/talent', { token: ben.token });
        expect(ids(listed)).toContain(talent.id);
        // Contact details come with the talent, not in lists.
        const inList = listed.body.data.find((t: any) => t.id === talent.id);
        expect([inList.whatsapp, inList.email]).toEqual([undefined, undefined]);
        expect(seen.body.email).toBe('ana@example.com');
    });

    it('is for members only', async () => {
        const ana = await member();
        const talent = await addTalent(ana);
        expect((await call('GET', '/api/talent')).status).toBe(401);
        expect((await call('GET', `/api/talent/${talent.id}`)).status).toBe(401);
    });

    it('needs a title, a category and at least one kind of work', async () => {
        const ana = await member();
        const post = (body: Record<string, unknown>) => call('POST', '/api/talent', { token: ana.token, body: { ...TALENT, ...body } });
        expect((await post({ title: '' })).status).toBe(400);
        expect((await post({ category: 'astrology' })).status).toBe(400);
        expect((await post({ workTypes: [] })).status).toBe(400);
        expect((await post({ workTypes: ['forever'] })).status).toBe(400);
        expect((await post({ works: [{ title: '' }] })).status).toBe(400);
    });

    it('takes only web links', async () => {
        const ana = await member();
        const post = (body: Record<string, unknown>) => call('POST', '/api/talent', { token: ana.token, body: { ...TALENT, ...body } });
        expect((await post({ website: 'ftp://example.com/portfolio' })).status).toBe(400);
        expect((await post({ works: [{ title: 'Logo', link: 'ftp://example.com/logo' }] })).status).toBe(400);
        expect((await post({ website: 'https://example.com', works: [{ title: 'Logo', link: 'https://example.com/logo' }] })).status).toBe(201);
    });

    it(`allows up to ${MAX_TALENTS_PER_MEMBER} per member`, async () => {
        const ana = await member();
        for (let i = 0; i < MAX_TALENTS_PER_MEMBER; i++) await addTalent(ana, { title: `Talent ${i}` });
        const extra = await call('POST', '/api/talent', { token: ana.token, body: TALENT });
        expect(extra.status).toBe(409);
        expect(extra.body).toMatchObject({ reason: 'too_many', max: MAX_TALENTS_PER_MEMBER });
    });

    it('holds the limit when several are sent at once', async () => {
        const ana = await member();
        const all = await Promise.all(Array.from({ length: 8 }, () => call('POST', '/api/talent', { token: ana.token, body: TALENT })));
        expect(await prisma.talentListing.count({ where: { userId: ana.id } })).toBeLessThanOrEqual(MAX_TALENTS_PER_MEMBER);
        expect(all.filter((r) => r.status === 409).every((r) => r.body.reason === 'too_many')).toBe(true);
        expect(all.filter((r) => r.status === 201).length).toBeLessThanOrEqual(MAX_TALENTS_PER_MEMBER);
    });

    it('needs the terms of use accepted', async () => {
        const newcomer = await member({ terms: false });
        const res = await call('POST', '/api/talent', { token: newcomer.token, body: TALENT });
        expect(res.status).toBe(403);
        expect(res.body.reason).toBe('terms_required');
    });
});

// ─── Changing and removing ────────────────────────────────────────────────────

describe('changing and removing a talent', () => {
    it('only its member changes it, not other members or staff', async () => {
        const ana = await member();
        const ben = await member();
        const mod = await member({ role: 'MOD' });
        const talent = await addTalent(ana);

        expect((await call('PUT', `/api/talent/${talent.id}`, { token: ben.token, body: { title: 'Scammer' } })).status).toBe(403);
        expect((await call('PUT', `/api/talent/${talent.id}`, { token: mod.token, body: { title: 'Edited' } })).status).toBe(403);

        const changed = await call('PUT', `/api/talent/${talent.id}`, { token: ana.token, body: { available: false, workTypes: ['short-term'] } });
        expect(changed.status).toBe(200);
        expect(changed.body).toMatchObject({ title: 'App developer', available: false, workTypes: ['short-term'] });
    });

    it('its member or staff can remove it, and staff removals are logged', async () => {
        const ana = await member();
        const ben = await member();
        const mod = await member({ role: 'MOD' });
        const mine = await addTalent(ana);
        const reported = await addTalent(ana);

        expect((await call('DELETE', `/api/talent/${mine.id}`, { token: ben.token })).status).toBe(403);
        expect((await call('DELETE', `/api/talent/${mine.id}`, { token: ana.token })).status).toBe(200);
        expect((await call('DELETE', `/api/talent/${reported.id}`, { token: mod.token })).status).toBe(200);
        expect(await prisma.talentListing.count({ where: { userId: ana.id } })).toBe(0);

        const logged = await prisma.auditLog.findMany({ where: { action: 'TALENT_REMOVED' } });
        expect(logged.map((l) => l.resource)).toEqual([`talent:${reported.id}`]);
        expect(logged[0].userId).toBe(mod.id);
    });
});

// ─── Photos and videos ────────────────────────────────────────────────────────

/** A work's photos (and videos), as the app sends them. */
const media = (...urls: string[]) => urls.map((url) => ({ url }));

describe("a talent's photos and videos", () => {
    it("are the member's own uploads, a video's poster too; four to a work", async () => {
        const ana = await member();
        const ben = await member();
        const bens = await uploaded(ben);
        const anas = await uploaded(ana);

        const post = (body: Record<string, unknown>) => call('POST', '/api/talent', { token: ana.token, body: { ...TALENT, ...body } });
        expect((await post({ photo: bens })).body.reason).toBe('not_your_photo');
        expect((await post({ works: [{ title: 'Mural', media: media('https://elsewhere.example/mural.jpg') }] })).body.reason).toBe('not_your_photo');
        expect((await post({ works: [{ title: 'Mural', media: [{ url: anas, poster: bens }] }] })).body.reason).toBe('not_your_photo');
        expect((await post({ works: [{ title: 'Mural', media: media(anas, anas, anas, anas, anas) }] })).status).toBe(400);

        const talent = await addTalent(ana, { photo: anas });
        expect((await call('PUT', `/api/talent/${talent.id}`, { token: ana.token, body: { works: [{ title: 'Mural', media: media(bens) }] } })).status).toBe(400);
        expect((await call('PUT', `/api/talent/${talent.id}`, { token: ana.token, body: { works: [{ title: 'Mural', media: media(anas) }] } })).status).toBe(200);
    });

    it.skipIf(!HAS_FFMPEG)('a video goes on a work with its poster, and both files go when it is taken off', { timeout: 60_000 }, async () => {
        const ana = await member();
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(testClip())], { type: 'video/mp4' }), 'clip.mp4');
        const res = await fetch(`${base}/api/upload/media?poster=1`, { method: 'POST', headers: { Authorization: `Bearer ${ana.token}` }, body: form });
        const video = (await res.json()) as any;
        expect(res.status).toBe(200);
        const still = await uploaded(ana);

        const talent = await addTalent(ana, { works: [{ title: 'Launch film', media: [{ url: video.url, poster: video.poster }, { url: still }] }] });
        expect(talent.works[0].media).toEqual([{ url: video.url, poster: video.poster }, { url: still }]);
        expect([stored(video.url), stored(video.poster)]).toEqual([true, true]);

        await call('PUT', `/api/talent/${talent.id}`, { token: ana.token, body: { works: [{ title: 'Launch film', media: media(still) }] } });
        expect([stored(video.url), stored(video.poster), stored(still)]).toEqual([false, false, true]);
    });

    it('go when taken off it or when it is deleted, unless something else shows them', async () => {
        const ana = await member();
        const [cover, w1, w2, avatar] = [await uploaded(ana), await uploaded(ana), await uploaded(ana), await uploaded(ana)];
        // Her profile photo is on her work too.
        expect((await call('PUT', '/api/profiles/me', { token: ana.token, body: { avatar } })).status).toBe(200);
        const talent = await addTalent(ana, { photo: cover, works: [{ title: 'Garden', media: media(w1, w2, avatar) }] });

        await call('PUT', `/api/talent/${talent.id}`, { token: ana.token, body: { works: [{ title: 'Garden', media: media(w1, avatar) }] } });
        expect(stored(w2)).toBe(false);
        expect(stored(w1)).toBe(true);

        // A new profile photo: the old one stays, the talent still shows it.
        await call('PUT', '/api/profiles/me', { token: ana.token, body: { avatar: '' } });
        expect(stored(avatar)).toBe(true);

        await call('DELETE', `/api/talent/${talent.id}`, { token: ana.token });
        expect(stored(cover)).toBe(false);
        expect(stored(w1)).toBe(false);
        expect(stored(avatar)).toBe(false);
    });

    it('move with their talent when two accounts are merged, so the member can still change them', async () => {
        const [source, target, admin] = [await member(), await member(), await member()];
        const cover = await uploaded(source);
        await addTalent(source, { photo: cover });
        const res: any = { status(code: number) { this.code = code; return this; }, json(body: unknown) { this.body = body; return this; } };
        await syncAccounts({ body: { sourceUserId: source.id, targetUserId: target.id, deleteSource: false }, user: { id: admin.id, isAdmin: true } } as any, res);
        expect(res.code ?? 200).toBe(200);
        expect((await prisma.upload.findUnique({ where: { name: cover.split('/').pop()! } }))?.userId).toBe(target.id);
        const moved = await prisma.talentListing.findFirstOrThrow({ where: { userId: target.id } });
        expect((await call('PUT', `/api/talent/${moved.id}`, { token: target.token, body: { photo: '' } })).status).toBe(200);
        expect(stored(cover)).toBe(false);
    });

    it('go with the account', async () => {
        const ana = await member();
        const photo = await uploaded(ana);
        await addTalent(ana, { works: [{ title: 'Wedding', media: media(photo) }] });
        await deleteAccount(ana.id, { notify: false });
        expect(await prisma.talentListing.count({ where: { userId: ana.id } })).toBe(0);
        expect(stored(photo)).toBe(false);
    });
});

// ─── Finding talent ───────────────────────────────────────────────────────────

describe('finding talent', () => {
    it('filters by category, kind of work, availability, remote, bitcoin, member and words', async () => {
        const viewer = await member();
        const ana = await member({ name: 'Ana Gardener Filters' });
        const ben = await member();
        const tag = `Q${Date.now()}`;
        const garden = await addTalent(ana, { title: `Garden design ${tag}`, category: 'home', workTypes: ['one-off'], skills: ['Permaculture'] });
        const app = await addTalent(ben, { title: `Apps ${tag}`, category: 'tech', workTypes: ['long-term'], remote: true, btcAccepted: true, available: false });

        const find = async (query: string) => ids(await call('GET', `/api/talent?search=${tag}&${query}`, { token: viewer.token }));
        expect(await find('category=home')).toEqual([garden.id]);
        expect(await find('workType=long-term')).toEqual([app.id]);
        expect(await find('available=true')).toEqual([garden.id]);
        expect(await find('remote=true')).toEqual([app.id]);
        expect(await find('btc=true')).toEqual([app.id]);
        expect(await find(`userId=${ana.id}`)).toEqual([garden.id]);
        // Members taking on work come first.
        expect(await find('')).toEqual([garden.id, app.id]);

        expect(ids(await call('GET', '/api/talent?search=Permaculture', { token: viewer.token }))).toContain(garden.id);
        expect(ids(await call('GET', '/api/talent?search=Gardener Filters', { token: viewer.token }))).toEqual([garden.id]);
    });

    it('sorts by the newest, or A–Z as people read it', async () => {
        const viewer = await member();
        const tag = `S${Date.now()}`;
        const zumba = await addTalent(await member(), { title: `Zumba classes ${tag}` });
        const arbol = await addTalent(await member(), { title: `árbol pruning ${tag}`, available: false });
        const baking = await addTalent(await member(), { title: `Baking ${tag}` });

        const find = async (query: string) => ids(await call('GET', `/api/talent?search=${tag}&${query}`, { token: viewer.token }));
        expect(await find('sort=newest')).toEqual([baking.id, arbol.id, zumba.id]);
        expect(await find('sort=name')).toEqual([arbol.id, baking.id, zumba.id]);
        // Unknown: members taking on work first, as before.
        expect((await find('sort=whatever')).at(-1)).toBe(arbol.id);
    });

    it("leaves out suspended members' talent", async () => {
        const viewer = await member();
        const ana = await member();
        const talent = await addTalent(ana);
        await prisma.user.update({ where: { id: ana.id }, data: { isBanned: true } });
        expect(ids(await call('GET', `/api/talent?userId=${ana.id}`, { token: viewer.token }))).toEqual([]);
        expect((await call('GET', `/api/talent/${talent.id}`, { token: viewer.token })).status).toBe(404);
    });
});

// ─── Blocks and reports ───────────────────────────────────────────────────────

describe('blocks and reports', () => {
    it('a block hides each member\'s talent from the other', async () => {
        const ana = await member();
        const ben = await member();
        const anas = await addTalent(ana);
        const bens = await addTalent(ben);
        expect((await call('POST', '/api/blocks', { token: ben.token, body: { userId: ana.id } })).status).toBe(201);

        expect(ids(await call('GET', `/api/talent?userId=${ana.id}`, { token: ben.token }))).toEqual([]);
        const blocked = await call('GET', `/api/talent/${anas.id}`, { token: ben.token });
        expect(blocked.status).toBe(404);
        expect(blocked.body.reason).toBe('blocked');

        // And Ana, whom Ben blocked, doesn't see his (without being told why).
        expect(ids(await call('GET', `/api/talent?userId=${ben.id}`, { token: ana.token }))).toEqual([]);
        const hidden = await call('GET', `/api/talent/${bens.id}`, { token: ana.token });
        expect(hidden.status).toBe(404);
        expect(hidden.body.reason).toBeUndefined();
    });

    it('a member can report a talent; the report names whose it is', async () => {
        const ana = await member();
        const ben = await member();
        const talent = await addTalent(ana);
        const report = { targetType: 'talent', targetId: talent.id, reason: 'not_their_work', details: 'These photos are from a magazine.' };

        expect((await call('POST', '/api/reports', { token: ben.token, body: report })).status).toBe(201);
        const row = await prisma.report.findFirstOrThrow({ where: { targetType: 'talent', targetId: talent.id } });
        expect(row).toMatchObject({ reporterId: ben.id, targetUserId: ana.id, reason: 'not_their_work' });

        const own = await call('POST', '/api/reports', { token: ana.token, body: report });
        expect(own.status).toBe(400);
        expect(own.body.reason).toBe('own_content');
    });
});
