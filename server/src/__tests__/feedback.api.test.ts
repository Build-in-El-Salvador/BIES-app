/**
 * Reports and feedback, end to end: a member sends one with the page it's
 * about, a screenshot and the app's details; the screenshot is shrunk,
 * loses its metadata and is kept where only admins open it (a 15-minute
 * link); admins list, filter and delete reports, and a deleted report or
 * account takes its screenshot with it. Real routes against a real SQLite
 * database built from the repo's migrations, files in a temp folder.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const env = vi.hoisted(() => {
    const dir = `${process.env.TMPDIR || '/tmp'}/bies-feedback-test-${process.pid}-${Date.now()}`;
    process.env.DATABASE_URL = `file:${dir}/test.db`;
    process.env.RELAY_WHITELIST_PATH = `${dir}/relay/whitelist.txt`;
    process.env.UPLOAD_DIR = `${dir}/uploads`;
    process.env.CORS_ORIGIN = 'https://app.example.test';
    process.env.APP_PUBLIC_URL = 'https://app.example.test';
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
import fs from 'fs';
import http from 'http';
import path from 'path';
import express from 'express';
import sharp from 'sharp';
import prisma from '../lib/prisma';
import feedbackRoutes from '../routes/feedback.routes';
import adminRoutes from '../routes/admin.routes';
import uploadRoutes from '../routes/upload.routes';
import { deleteAccount } from '../services/account.service';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { createSession, signAccessToken } from '../services/session.service';

let server: http.Server;
let base: string;

beforeAll(async () => {
    fs.mkdirSync(env.dir, { recursive: true });
    execSync('npx prisma migrate deploy', { cwd: path.resolve(__dirname, '../..'), env: process.env, stdio: 'pipe' });
    const app = express();
    app.use(express.json());
    app.use('/api/feedback', feedbackRoutes);
    app.use('/api/admin', adminRoutes);
    app.use('/api/upload', uploadRoutes);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 120_000);

afterAll(async () => {
    server?.close();
    await prisma.$disconnect();
    fs.rmSync(env.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

type Member = { id: string; token: string };
async function member(name: string, { isAdmin = false } = {}): Promise<Member> {
    const user = await prisma.user.create({
        data: {
            nostrPubkey: getPublicKey(generateSecretKey()),
            isAdmin,
            termsVersion: '2026-10',
            termsAcceptedAt: new Date(),
            profile: { create: { name } },
        },
    });
    const session = await createSession(user.id, 'native');
    return { id: user.id, token: signAccessToken({ id: user.id, role: 'MEMBER', isAdmin }, session.sessionId) };
}

async function call(method: string, url: string, token?: string) {
    const res = await fetch(`${base}${url}`, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

/** An iPhone-sized screenshot, with a camera's EXIF it shouldn't keep. */
const screenshot = () =>
    sharp({ create: { width: 1179, height: 2556, channels: 3, background: { r: 240, g: 240, b: 245 } } })
        .withExif({ IFD0: { Make: 'TestPhone', Software: 'iOS 26.1' } })
        .png()
        .toBuffer();

type Report = { type?: string; message?: string; page?: string; device?: unknown; file?: { data: Buffer; type: string } };
async function send(m: Member | null, report: Report) {
    const form = new FormData();
    form.append('type', report.type ?? 'BUG');
    form.append('message', report.message ?? 'The Save button does nothing on my farm page.');
    if (report.page !== undefined) form.append('page', report.page);
    if (report.device !== undefined) form.append('device', typeof report.device === 'string' ? report.device : JSON.stringify(report.device));
    if (report.file) form.append('file', new Blob([new Uint8Array(report.file.data)], { type: report.file.type }), 'IMG_0042.PNG');
    const res = await fetch(`${base}/api/feedback`, { method: 'POST', headers: m ? { Authorization: `Bearer ${m.token}` } : {}, body: form });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

const privateFile = (name: string) => path.join(env.dir, 'uploads', 'private', name);
const publicFile = (name: string) => path.join(env.dir, 'uploads', 'public', name);

const DEVICE = {
    platform: 'ios', appVersion: '0.3.0', build: '11', screen: '393×852 @3x', language: 'en',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X)', path: '/farms/abc/edit',
};

describe('sending a report', () => {
    it('keeps the page, the app\'s details and a smaller screenshot without its metadata, where only admins open it', async () => {
        const ana = await member('Ana');
        const res = await send(ana, { page: 'farms', device: { ...DEVICE, password: 'not kept' }, file: { data: await screenshot(), type: 'image/png' } });
        expect(res.status).toBe(201);

        const row = await prisma.feedback.findUniqueOrThrow({ where: { id: res.body.id } });
        expect(row).toMatchObject({ userId: ana.id, type: 'BUG', page: 'farms', status: 'NEW' });
        expect(JSON.parse(row.device)).toEqual(DEVICE);

        expect(row.screenshot).toMatch(/^\d{13}-[0-9a-f]{32}\.png$/);
        expect(fs.existsSync(publicFile(row.screenshot))).toBe(false);
        const file = fs.readFileSync(privateFile(row.screenshot));
        const meta = await sharp(file).metadata();
        expect([meta.width, meta.height]).toEqual([738, 1600]);
        expect(meta.exif).toBeUndefined();
        expect(file.includes('TestPhone')).toBe(false);

        const record = await prisma.upload.findUniqueOrThrow({ where: { name: row.screenshot } });
        expect(record).toMatchObject({ userId: ana.id, isPrivate: true, mimeType: 'image/png', size: file.length });
    });

    it('takes one without a screenshot or a page', async () => {
        const ben = await member('Ben');
        const res = await send(ben, { type: 'GENERAL', message: 'Love the new Home page!' });
        expect(res.status).toBe(201);
        expect(await prisma.feedback.findUniqueOrThrow({ where: { id: res.body.id } })).toMatchObject({ page: '', screenshot: '', device: '{}' });
    });

    it('still takes the JSON an older copy of the app sends', async () => {
        const olga = await member('Olga');
        const res = await fetch(`${base}/api/feedback`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${olga.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'FEATURE', message: 'Dark mode for the Feed, please.' }),
        });
        expect(res.status).toBe(201);
        const { id } = await res.json() as any;
        expect(await prisma.feedback.findUniqueOrThrow({ where: { id } })).toMatchObject({ type: 'FEATURE', page: '', screenshot: '', device: '{}' });
    });

    it('still takes the report when the app\'s details don\'t read', async () => {
        const cleo = await member('Cleo');
        const res = await send(cleo, { device: '{not json', page: 'feed' });
        expect(res.status).toBe(201);
        expect((await prisma.feedback.findUniqueOrThrow({ where: { id: res.body.id } })).device).toBe('{}');
    });

    it('turns away a file that isn\'t a picture, or isn\'t the picture it says, and keeps nothing', async () => {
        const dan = await member('Dan');
        const [reports, uploads] = [await prisma.feedback.count(), await prisma.upload.count()];

        const html = await send(dan, { file: { data: Buffer.from('<html><script>alert(1)</script></html>'), type: 'text/html' } });
        expect(html.status).toBe(400);
        const fake = await send(dan, { file: { data: Buffer.from('<html><script>alert(1)</script></html>'), type: 'image/png' } });
        expect(fake.status).toBe(400);
        expect(fake.body.reason).toBe('unreadable');

        expect([await prisma.feedback.count(), await prisma.upload.count()]).toEqual([reports, uploads]);
        expect(fs.readdirSync(path.join(env.dir, 'uploads', 'private'))).not.toContainEqual(expect.stringMatching(/\.html$/));
    });

    it('needs a description and a page id from the list\'s shape, and a signed-in member', async () => {
        const eva = await member('Eva');
        expect((await send(eva, { message: 'bad' })).status).toBe(400);
        expect((await send(eva, { page: '../admin' })).status).toBe(400);
        expect((await send(eva, { page: 'x'.repeat(41) })).status).toBe(400);
        expect((await send(null, {})).status).toBe(401);
    });

    it('takes 10 an hour from one member', async () => {
        const fay = await member('Fay');
        for (let i = 0; i < 10; i++) expect((await send(fay, { message: `Report number ${i}` })).status).toBe(201);
        expect((await send(fay, { message: 'One more report' })).status).toBe(429);
        // Someone else still can.
        expect((await send(await member('Gus'), {})).status).toBe(201);
    });
});

describe('admins', () => {
    it('see reports with their page and details, and open the screenshot through a link that expires', async () => {
        const admin = await member('Ada Admin', { isAdmin: true });
        const hal = await member('Hal');
        const sent = await send(hal, { page: 'talent', device: DEVICE, file: { data: await screenshot(), type: 'image/png' } });

        const list = await call('GET', '/api/admin/feedback?onPage=talent', admin.token);
        expect(list.status).toBe(200);
        expect(list.body.data.map((f: any) => f.id)).toEqual([sent.body.id]);
        const [report] = list.body.data;
        expect(report).toMatchObject({ page: 'talent', device: DEVICE, user: { id: hal.id, profile: { name: 'Hal' } } });
        expect(report.screenshotUrl).toMatch(/^\/api\/upload\/private\/\d{13}-[0-9a-f]{32}\.png\?exp=\d+&sig=[0-9a-f]{64}$/);

        const image = await fetch(`${base}${report.screenshotUrl}`);
        expect(image.status).toBe(200);
        expect(image.headers.get('content-type')).toBe('image/png');
        expect(image.headers.get('content-disposition')).toBeNull();
        expect(image.headers.get('x-content-type-options')).toBe('nosniff');
        expect(image.headers.get('cache-control')).toBe('private, no-store');
        expect((await sharp(Buffer.from(await image.arrayBuffer())).metadata()).width).toBe(738);

        // A link that's been changed, or whose time is up, opens nothing.
        const tampered = report.screenshotUrl.replace(/sig=(.)/, (_: string, c: string) => `sig=${c === 'a' ? 'b' : 'a'}`);
        expect((await fetch(`${base}${tampered}`)).status).toBe(404);
        const expired = report.screenshotUrl.replace(/exp=\d+/, `exp=${Date.now() - 1000}`);
        expect((await fetch(`${base}${expired}`)).status).toBe(404);

        // Changing a report keeps its details and link.
        const updated = await fetch(`${base}/api/admin/feedback/${sent.body.id}`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'IN_REVIEW' }),
        });
        expect(await updated.json()).toMatchObject({ status: 'IN_REVIEW', device: DEVICE, screenshotUrl: expect.stringMatching(/^\/api\/upload\/private\//) });
    });

    it('are the only ones who see reports', async () => {
        const ivy = await member('Ivy');
        expect((await call('GET', '/api/admin/feedback', ivy.token)).status).toBe(403);
        expect((await call('GET', '/api/admin/feedback')).status).toBe(401);
    });

    it('delete a report with its screenshot', async () => {
        const admin = await member('Abe Admin', { isAdmin: true });
        const jo = await member('Jo');
        const sent = await send(jo, { file: { data: await screenshot(), type: 'image/png' } });
        const { screenshot: name } = await prisma.feedback.findUniqueOrThrow({ where: { id: sent.body.id } });
        expect(fs.existsSync(privateFile(name))).toBe(true);

        expect((await call('DELETE', `/api/admin/feedback/${sent.body.id}`, admin.token)).status).toBe(200);
        expect(fs.existsSync(privateFile(name))).toBe(false);
        expect(await prisma.upload.findUnique({ where: { name } })).toBeNull();
    });
});

it('deleting an account deletes its reports\' screenshots', async () => {
    const kim = await member('Kim');
    const sent = await send(kim, { file: { data: await screenshot(), type: 'image/png' } });
    const { screenshot: name } = await prisma.feedback.findUniqueOrThrow({ where: { id: sent.body.id } });

    await deleteAccount(kim.id, { notify: false });
    expect(await prisma.feedback.findUnique({ where: { id: sent.body.id } })).toBeNull();
    expect(fs.existsSync(privateFile(name))).toBe(false);
    expect(await prisma.upload.findUnique({ where: { name } })).toBeNull();
});
