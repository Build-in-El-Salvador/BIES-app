/**
 * Small copies of public photos for lists (thumbnails.service.ts): made when
 * a photo is uploaded, 320px at most, served beside it under public/t/, and
 * deleted with it. Real routes against a real SQLite database built from
 * the repo's migrations, files in a temp folder.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const env = vi.hoisted(() => {
    const dir = `${process.env.TMPDIR || '/tmp'}/bies-thumbs-test-${process.pid}-${Date.now()}`;
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

import { execSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import express from 'express';
import sharp from 'sharp';
import prisma from '../lib/prisma';
import uploadRoutes from '../routes/upload.routes';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { createSession, signAccessToken } from '../services/session.service';
import { SERVABLE_UPLOAD } from '../middleware/uploads';

let server: http.Server;
let base: string;

beforeAll(async () => {
    fs.mkdirSync(env.dir, { recursive: true });
    execSync('npx prisma migrate deploy', { cwd: path.resolve(__dirname, '../..'), env: process.env, stdio: 'pipe' });
    const app = express();
    app.use(express.json());
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

async function member() {
    const user = await prisma.user.create({
        data: {
            nostrPubkey: getPublicKey(generateSecretKey()),
            termsVersion: '2026-10', termsAcceptedAt: new Date(), profile: { create: { name: 'Photo Member' } },
        },
    });
    const session = await createSession(user.id, 'native');
    return signAccessToken({ id: user.id, role: 'MEMBER', isAdmin: false }, session.sessionId);
}

const PUBLIC = () => path.join(env.dir, 'uploads', 'public');

describe('small copies of photos', () => {
    it('are made at upload, much smaller, and go when the photo is deleted', async () => {
        const token = await member();
        const photo = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: '#3a7' } })
            .composite([{ input: Buffer.from('<svg width="2400" height="1600"><circle cx="1200" cy="800" r="600" fill="#f80"/></svg>') }])
            .jpeg({ quality: 95 }).toBuffer();
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(photo)], { type: 'image/jpeg' }), 'p.jpg');
        const res = await fetch(`${base}/api/upload/media`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
        expect(res.status).toBe(200);
        const { url } = await res.json() as { url: string };
        const name = url.split('/').pop()!;
        const base32 = name.replace(/\.[a-z]+$/i, '');

        const thumbFile = path.join(PUBLIC(), 't', `${base32}.jpg`);
        expect(fs.existsSync(thumbFile)).toBe(true);
        const meta = await sharp(thumbFile).metadata();
        expect(Math.max(meta.width!, meta.height!)).toBe(320);
        expect(fs.statSync(thumbFile).size).toBeLessThan(fs.statSync(path.join(PUBLIC(), name)).size / 4);
        expect(SERVABLE_UPLOAD.test(`/public/t/${base32}.jpg`)).toBe(true);

        const gone = await fetch(`${base}/api/upload/discard`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls: [url] }),
        });
        expect(gone.status).toBe(200);
        expect(fs.existsSync(path.join(PUBLIC(), name))).toBe(false);
        expect(fs.existsSync(thumbFile)).toBe(false);
    });

    it('are served only under their own name, as .jpg', () => {
        const n = '1792420291927-941c97ef590adc592d0c4a0d7f575d56';
        expect(SERVABLE_UPLOAD.test(`/public/t/${n}.jpg`)).toBe(true);
        expect(SERVABLE_UPLOAD.test(`/public/t/${n}.png`)).toBe(false);
        expect(SERVABLE_UPLOAD.test(`/public/t/${n}.mp4`)).toBe(false);
        expect(SERVABLE_UPLOAD.test('/public/t/../private/x.jpg')).toBe(false);
        expect(SERVABLE_UPLOAD.test(`/private/t/${n}.jpg`)).toBe(false);
        expect(SERVABLE_UPLOAD.test(`/public/t/t/${n}.jpg`)).toBe(false);
    });
});
