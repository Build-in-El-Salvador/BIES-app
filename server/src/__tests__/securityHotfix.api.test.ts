/**
 * The 2026-10-13 security hotfix, end to end: an upload can't choose its own
 * extension and only photos and videos are served from the uploads folder;
 * crafted multipart field names are refused; rich HTML loses event handlers
 * however they're disguised; a feed notification names its real sender.
 * Real routes against a real SQLite database built from the repo's
 * migrations, files in a temp folder.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const env = vi.hoisted(() => {
    const dir = `${process.env.TMPDIR || '/tmp'}/bies-hotfix-test-${process.pid}-${Date.now()}`;
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
import prisma from '../lib/prisma';
import uploadRoutes from '../routes/upload.routes';
import notificationRoutes from '../routes/notification.routes';
import { servableUploadsOnly } from '../middleware/uploads';
import { sanitize } from '../middleware/sanitize';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { createSession, signAccessToken } from '../services/session.service';

let server: http.Server;
let base: string;

beforeAll(async () => {
    fs.mkdirSync(env.dir, { recursive: true });
    execSync('npx prisma migrate deploy', { cwd: path.resolve(__dirname, '../..'), env: process.env, stdio: 'pipe' });
    const app = express();
    app.use(express.json());
    app.use(sanitize);
    app.use('/uploads', servableUploadsOnly, express.static(path.join(env.dir, 'uploads')));
    app.use('/api/upload', uploadRoutes);
    app.use('/api/notifications', notificationRoutes);
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        void _next;
        res.status(400).json({ error: err.message });
    });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 120_000);

afterAll(async () => {
    server?.close();
    await prisma.$disconnect();
    fs.rmSync(env.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

type Member = { id: string; pubkey: string; token: string };
async function member(name: string): Promise<Member> {
    const pubkey = getPublicKey(generateSecretKey());
    const user = await prisma.user.create({
        data: { nostrPubkey: pubkey, role: 'MEMBER', termsVersion: '2026-10', termsAcceptedAt: new Date(), profile: { create: { name } } },
    });
    const session = await createSession(user.id, 'native');
    return { id: user.id, pubkey, token: signAccessToken({ id: user.id, role: 'MEMBER', isAdmin: false }, session.sessionId) };
}

async function send(m: Member, form: FormData) {
    const res = await fetch(`${base}/api/upload/media`, { method: 'POST', headers: { Authorization: `Bearer ${m.token}` }, body: form });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

describe('uploads', () => {
    it('a "video" named x.html is stored as .mp4 (or refused if it isn\'t one), and served as a video that runs nothing', async () => {
        const ana = await member('Ana');
        // A web page sent as a video isn't one: refused (services/mediaProcessing.ts).
        let form = new FormData();
        form.append('file', new Blob(['<html><script>alert(document.cookie)</script></html>'], { type: 'video/mp4' }), 'x.html');
        expect((await send(ana, form)).status).toBe(400);

        // A real (tiny) movie with an .html name keeps .mp4.
        const box = (type: string, body = Buffer.alloc(0)) => {
            const head = Buffer.alloc(8);
            head.writeUInt32BE(8 + body.length, 0);
            head.write(type, 4, 'latin1');
            return Buffer.concat([head, body]);
        };
        const movie = Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isom', 'latin1')), box('moov', box('mvhd', Buffer.alloc(100))), box('mdat', Buffer.from('frames'))]);
        form = new FormData();
        form.append('file', new Blob([new Uint8Array(movie)], { type: 'video/mp4' }), 'x.html');
        const res = await send(ana, form);
        expect(res.status).toBe(200);
        expect(res.body.url).toMatch(/^\/uploads\/public\/\d{13}-[0-9a-f]{32}\.mp4$/);

        const served = await fetch(`${base}${res.body.url}`);
        expect(served.status).toBe(200);
        expect(served.headers.get('content-type')).toBe('video/mp4');
        expect(served.headers.get('x-content-type-options')).toBe('nosniff');
        expect(served.headers.get('content-security-policy')).toContain('sandbox');
    });

    it('nothing but photos and videos is served: not an .html already there, not the private decks', async () => {
        const name = `1760000000000-${'a'.repeat(32)}`;
        fs.mkdirSync(path.join(env.dir, 'uploads', 'private'), { recursive: true });
        fs.writeFileSync(path.join(env.dir, 'uploads', 'public', `${name}.html`), '<script>alert(1)</script>');
        fs.writeFileSync(path.join(env.dir, 'uploads', 'private', `${name}.pdf`), '%PDF-1.7');
        fs.writeFileSync(path.join(env.dir, 'uploads', 'public', `${name}.jpg`), 'jpeg');
        expect((await fetch(`${base}/uploads/public/${name}.html`)).status).toBe(404);
        expect((await fetch(`${base}/uploads/private/${name}.pdf`)).status).toBe(404);
        expect((await fetch(`${base}/uploads/public/../private/${name}.pdf`)).status).toBe(404);
        expect((await fetch(`${base}/uploads/public/${name}.jpg`)).status).toBe(200);
    });

    it('crafted field names are refused at once, without a file being stored', async () => {
        const ana = await member('Ana B');
        const before = fs.readdirSync(path.join(env.dir, 'uploads', 'public')).length;
        for (const field of ['items[4294967294]', 'a[b][c][d]']) {
            const form = new FormData();
            form.append(field, 'x');
            form.append('file', new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }), 'p.jpg');
            const started = Date.now();
            const res = await send(ana, form);
            expect(res.status, field).toBeGreaterThanOrEqual(400);
            expect(Date.now() - started).toBeLessThan(2000);
        }
        expect(fs.readdirSync(path.join(env.dir, 'uploads', 'public')).length).toBe(before);
    });
});

describe('rich HTML', () => {
    it('loses event handlers however they are disguised', async () => {
        const run = (body: string) => {
            const req = { path: '/api/profiles/me', body: { body } } as unknown as express.Request;
            sanitize(req, {} as express.Response, () => {});
            return String((req.body as { body: string }).body);
        };
        for (const payload of [
            'Hello<img src=x &#111;nerror=alert(document.domain)>',
            'Hello<img src=x/onerror=alert(1)>',
            'Hello<img src=x &#x6f;nerror="alert(1)">',
            '<a href="&#106;avascript:alert(1)">x</a>',
        ]) {
            const out = run(payload).toLowerCase();
            expect(out, payload).not.toMatch(/onerror|javascript:/);
        }
        expect(run('<p>Coffee <strong>rows</strong></p>')).toBe('<p>Coffee <strong>rows</strong></p>');
    });
});

describe('feed notifications', () => {
    it('name their real sender, not what the request says', async () => {
        const ana = await member('Ana C');
        const ben = await member('Ben C');
        const res = await fetch(`${base}/api/notifications/feed-interaction`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ben.token}` },
            body: JSON.stringify({ type: 'POST_COMMENT', targetPubkey: ana.pubkey, eventId: 'a'.repeat(64), actorName: 'BIES Support', contentPreview: 'Renew at https://evil.example' }),
        });
        expect(res.status).toBe(200);
        const note = await prisma.notification.findFirst({ where: { userId: ana.id }, orderBy: { createdAt: 'desc' } });
        expect(note?.title).toBe('Ben C commented on your post');
    });
});
