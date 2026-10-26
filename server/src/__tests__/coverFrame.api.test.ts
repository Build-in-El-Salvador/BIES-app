/**
 * Positioning a cover photo: an event's, a farm's or business's, a talent's,
 * an opportunity's (its first photo) and a member's banner. The part of the
 * photo its member chose is saved with it ("x,y,w,h", in % of the photo);
 * anything else is refused; a new photo sent without a position (an app from
 * before positioning) starts centred instead of taking the old photo's. Real
 * routes against a real SQLite database built from the repo's migrations.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const env = vi.hoisted(() => {
    const dir = `${process.env.TMPDIR || '/tmp'}/bies-cover-frame-test-${process.pid}-${Date.now()}`;
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
import eventRoutes from '../routes/events.routes';
import directoryRoutes from '../routes/directory.routes';
import talentRoutes from '../routes/talent.routes';
import projectRoutes from '../routes/project.routes';
import profileRoutes from '../routes/profile.routes';
import uploadRoutes from '../routes/upload.routes';
import previewRoutes from '../routes/preview.routes';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { createSession, signAccessToken } from '../services/session.service';
import { isCoverFrame } from '../utils/coverFrame';

let server: http.Server;
let base: string;

beforeAll(async () => {
    fs.mkdirSync(env.dir, { recursive: true });
    execSync('npx prisma migrate deploy', { cwd: path.resolve(__dirname, '../..'), env: process.env, stdio: 'pipe' });

    const app = express();
    app.use(express.json());
    app.use('/api/events', eventRoutes);
    app.use('/api/directory', directoryRoutes);
    app.use('/api/talent', talentRoutes);
    app.use('/api/projects', projectRoutes);
    app.use('/api/profiles', profileRoutes);
    app.use('/api/upload', uploadRoutes);
    app.use('/api/preview', previewRoutes);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 120_000);

afterAll(async () => {
    server?.close();
    await prisma.$disconnect();
    fs.rmSync(env.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
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
async function member(): Promise<Member> {
    const user = await prisma.user.create({
        data: {
            nostrPubkey: getPublicKey(generateSecretKey()),
            termsVersion: '2026-10',
            termsAcceptedAt: new Date(),
            profile: { create: { name: `Member ${++counter}` } },
        },
    });
    const session = await createSession(user.id, 'native');
    return { id: user.id, token: signAccessToken({ id: user.id, role: 'MEMBER', isAdmin: false }, session.sessionId) };
}

let seed = 0;
/** A photo this member uploaded: its link as stored (/uploads/public/...). */
async function uploaded(m: Member): Promise<string> {
    const file = await sharp({ create: { width: 400, height: 600, channels: 3, background: { r: 40 + (++seed % 200), g: 120, b: 90 } } }).jpeg().toBuffer();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(file)], { type: 'image/jpeg' }), 'cover.jpg');
    const res = await fetch(`${base}/api/upload/media`, { method: 'POST', headers: { Authorization: `Bearer ${m.token}` }, body: form });
    const body = (await res.json()) as any;
    if (res.status !== 200) throw new Error(`upload failed: ${res.status} ${JSON.stringify(body)}`);
    return body.url as string;
}

// A flyer zoomed out to show all of it: wider than the photo, so x is below 0.
const WHOLE_FLYER = '-80.5,0,261,100';
const TOP_PART = '0,5.25,100,37.5';

// ─── The position itself ──────────────────────────────────────────────────────

describe('a cover position', () => {
    it('is four numbers: a size and a part of the photo inside it', () => {
        for (const ok of [WHOLE_FLYER, TOP_PART, '10,20,30,40', '-1999.99,0,2000,100']) expect(isCoverFrame(ok), ok).toBe(true);
        for (const bad of [
            '', '1,2,3', '1,2,3,4,5', '0,0,0,50', '0,0,50,-5', '0,0,2001,50', // not four sizes that make sense
            '100,0,50,50', '0,100,50,50', '-60,0,50,50', '0,-60,50,50', // off the photo entirely
            '1e2,0,50,50', '0x10,0,50,50', '10.123,0,50,50', ' 10,0,50,50', '10,0,50,50;', 'NaN,0,50,50',
        ]) expect(isCoverFrame(bad), bad).toBe(false);
    });
});

// ─── Each cover ───────────────────────────────────────────────────────────────

describe("an event's cover", () => {
    it('keeps its position, shows it in the list and on the shared preview, and refuses a made-up one', async () => {
        const host = await member();
        const photo = await uploaded(host);
        const created = await call('POST', '/api/events', {
            token: host.token,
            body: { title: `Flyer night ${++counter}`, description: 'All the details are on the flyer.', startDate: new Date(Date.now() + 5 * 86400_000).toISOString(), nostrPublish: 'none', thumbnail: photo, coverFrame: WHOLE_FLYER },
        });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const id = created.body.id;
        expect((await call('GET', `/api/events/${id}`, { token: host.token })).body.coverFrame).toBe(WHOLE_FLYER);
        const listed = (await call('GET', '/api/events', { token: host.token })).body;
        expect((listed.data ?? listed).find((e: any) => e.id === id).coverFrame).toBe(WHOLE_FLYER);
        expect((await call('GET', `/api/preview/events/${id}`)).body.coverFrame).toBe(WHOLE_FLYER);

        expect((await call('PUT', `/api/events/${id}`, { token: host.token, body: { coverFrame: '0,0,0,0' } })).status).toBe(400);
        expect((await call('PUT', `/api/events/${id}`, { token: host.token, body: { coverFrame: 'url(javascript:alert(1))' } })).status).toBe(400);
        const moved = await call('PUT', `/api/events/${id}`, { token: host.token, body: { coverFrame: TOP_PART } });
        expect(moved.status).toBe(200);
        expect((await call('GET', `/api/events/${id}`, { token: host.token })).body.coverFrame).toBe(TOP_PART);
    });

    it('starts centred when a new photo comes without a position, and keeps it when the photo stays', async () => {
        const host = await member();
        const created = await call('POST', '/api/events', {
            token: host.token,
            body: { title: `Cover swap ${++counter}`, description: 'An evening.', startDate: new Date(Date.now() + 5 * 86400_000).toISOString(), nostrPublish: 'none', thumbnail: await uploaded(host), coverFrame: TOP_PART },
        });
        const id = created.body.id;
        // Another edit with the same photo: the position stays.
        await call('PUT', `/api/events/${id}`, { token: host.token, body: { title: 'Cover swap, renamed', thumbnail: created.body.thumbnail } });
        expect((await call('GET', `/api/events/${id}`, { token: host.token })).body.coverFrame).toBe(TOP_PART);
        // A new photo alone (an older app): centred.
        await call('PUT', `/api/events/${id}`, { token: host.token, body: { thumbnail: await uploaded(host) } });
        expect((await call('GET', `/api/events/${id}`, { token: host.token })).body.coverFrame).toBe('');
    });
});

describe("a farm's or business's cover", () => {
    it('keeps its position, and a new photo without one starts centred', async () => {
        const owner = await member();
        const created = await call('POST', '/api/directory', {
            token: owner.token,
            body: { type: 'PROVIDER', name: `Cover Café ${++counter}`, category: 'food', isOwnBusiness: true, photo: await uploaded(owner), coverFrame: TOP_PART },
        });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const id = created.body.id;
        expect((await call('GET', `/api/directory/${id}`, { token: owner.token })).body.coverFrame).toBe(TOP_PART);
        expect((await call('PUT', `/api/directory/${id}`, { token: owner.token, body: { coverFrame: '1,2,3' } })).status).toBe(400);

        await call('PUT', `/api/directory/${id}`, { token: owner.token, body: { photo: await uploaded(owner) } });
        expect((await call('GET', `/api/directory/${id}`, { token: owner.token })).body.coverFrame).toBe('');
        await call('PUT', `/api/directory/${id}`, { token: owner.token, body: { coverFrame: WHOLE_FLYER } });
        expect((await call('GET', `/api/directory/${id}`, { token: owner.token })).body.coverFrame).toBe(WHOLE_FLYER);
    });
});

describe("a talent's cover", () => {
    it('keeps its position, and a new photo without one starts centred', async () => {
        const ana = await member();
        const created = await call('POST', '/api/talent', {
            token: ana.token,
            body: { title: 'Photographer', category: 'media', workTypes: ['one-off'], photo: await uploaded(ana), coverFrame: TOP_PART },
        });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const id = created.body.id;
        expect((await call('GET', `/api/talent/${id}`, { token: ana.token })).body.coverFrame).toBe(TOP_PART);
        expect((await call('PUT', `/api/talent/${id}`, { token: ana.token, body: { coverFrame: '0,0,50' } })).status).toBe(400);

        await call('PUT', `/api/talent/${id}`, { token: ana.token, body: { photo: await uploaded(ana) } });
        expect((await call('GET', `/api/talent/${id}`, { token: ana.token })).body.coverFrame).toBe('');
    });
});

describe("an opportunity's cover (its first photo)", () => {
    it('keeps its position while the first photo stays, and starts centred when another comes first', async () => {
        const owner = await member();
        const [first, second] = [await uploaded(owner), await uploaded(owner)];
        const created = await call('POST', '/api/projects', {
            token: owner.token,
            body: { type: 'job', title: 'Bartender', kind: 'full-time', description: 'All the details.', whatsapp: '+503 7000 0000', photos: [first, second], coverFrame: TOP_PART },
        });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const id = created.body.id;
        expect((await call('GET', `/api/projects/${id}`, { token: owner.token })).body.coverFrame).toBe(TOP_PART);
        expect((await call('PUT', `/api/projects/${id}`, { token: owner.token, body: { coverFrame: 'x' } })).status).toBe(400);

        // Another photo added after it: the cover is the same, so is its position.
        await call('PUT', `/api/projects/${id}`, { token: owner.token, body: { photos: [first, second, await uploaded(owner)] } });
        expect((await call('GET', `/api/projects/${id}`, { token: owner.token })).body.coverFrame).toBe(TOP_PART);
        // The second photo moved first: a new cover, centred.
        await call('PUT', `/api/projects/${id}`, { token: owner.token, body: { photos: [second, first] } });
        expect((await call('GET', `/api/projects/${id}`, { token: owner.token })).body.coverFrame).toBe('');
    });
});

describe("a member's banner", () => {
    it('keeps its position, even for signed-out visitors, and a new banner without one starts centred', async () => {
        const ana = await member();
        const saved = await call('PUT', '/api/profiles/me', { token: ana.token, body: { banner: await uploaded(ana), coverFrame: TOP_PART } });
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        expect((await call('GET', '/api/profiles/me', { token: ana.token })).body.coverFrame).toBe(TOP_PART);
        const seen = (await call('GET', `/api/profiles/${ana.id}`)).body;
        expect((seen.profile ?? seen).coverFrame).toBe(TOP_PART);
        expect((await call('PUT', '/api/profiles/me', { token: ana.token, body: { coverFrame: '0,0,-1,1' } })).status).toBe(400);

        await call('PUT', '/api/profiles/me', { token: ana.token, body: { banner: await uploaded(ana) } });
        expect((await call('GET', '/api/profiles/me', { token: ana.token })).body.coverFrame).toBe('');
    });
});
