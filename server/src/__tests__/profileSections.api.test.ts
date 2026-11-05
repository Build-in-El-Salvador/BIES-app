/**
 * A member's profile as the profile pages read it: custom sections' photos
 * come back as full links, so the phone app (on its own origin) shows them.
 * Real routes against a real SQLite database built from the repo's migrations.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const env = vi.hoisted(() => {
    const dir = `${process.env.TMPDIR || '/tmp'}/bies-profile-sections-test-${process.pid}-${Date.now()}`;
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
import profileRoutes from '../routes/profile.routes';
import uploadRoutes from '../routes/upload.routes';
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
async function member(fields: Record<string, unknown> = {}): Promise<Member> {
    const user = await prisma.user.create({
        data: {
            nostrPubkey: getPublicKey(generateSecretKey()),
            termsVersion: '2026-10',
            termsAcceptedAt: new Date(),
            profile: { create: { name: `Member ${++counter}`, ...fields } },
        },
    });
    const session = await createSession(user.id, 'native');
    return { id: user.id, token: signAccessToken({ id: user.id, role: 'MEMBER', isAdmin: false }, session.sessionId) };
}

let seed = 0;
/** A photo this member uploaded: its link as stored (/uploads/public/...). */
async function uploaded(m: Member): Promise<string> {
    const file = await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 40 + (++seed % 200), g: 120, b: 90 } } }).jpeg().toBuffer();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(file)], { type: 'image/jpeg' }), 'photo.jpg');
    const res = await fetch(`${base}/api/upload/media`, { method: 'POST', headers: { Authorization: `Bearer ${m.token}` }, body: form });
    const body = (await res.json()) as any;
    if (res.status !== 200) throw new Error(`upload failed: ${res.status} ${JSON.stringify(body)}`);
    return body.url as string;
}

const full = (link: string) => `https://app.example.test${link}`;

// ─── Section photos ───────────────────────────────────────────────────────────

describe("a profile's section photos", () => {
    it('come back as full links wherever the profile is read, and are saved as sent', async () => {
        const owner = await member();
        const viewer = await member();
        const one = await uploaded(owner);
        const two = await uploaded(owner);
        expect(one.startsWith('/uploads/public/')).toBe(true);

        const saved = await call('PUT', '/api/profiles/me', {
            token: owner.token,
            body: {
                customSections: [
                    { title: 'Photo', type: 'PHOTO', imageUrl: one },
                    { title: 'Photos', type: 'CAROUSEL', images: [one, two] },
                    { title: 'Elsewhere', type: 'PHOTO', imageUrl: 'https://images.example.org/a.jpg' },
                    { title: 'Words', type: 'TEXT', body: '<p>Hi</p>' },
                ],
            },
        });
        expect(saved.status).toBe(200);

        const expected = (sections: any[]) => {
            expect(sections[0].imageUrl).toBe(full(one));
            expect(sections[1].images).toEqual([full(one), full(two)]);
            expect(sections[2].imageUrl).toBe('https://images.example.org/a.jpg');
            expect(sections[3].imageUrl).toBeUndefined();
        };
        expected(saved.body.customSections);
        expected((await call('GET', '/api/profiles/me', { token: owner.token })).body.customSections);
        expected((await call('GET', `/api/profiles/${owner.id}`, { token: viewer.token })).body.customSections);

        // Stored as they were sent: the link is only completed on the way out.
        const row = await prisma.profile.findUnique({ where: { userId: owner.id }, select: { customSections: true } });
        expect(JSON.parse(row!.customSections)[0].imageUrl).toBe(one);
    });

    it('saved back as full links (an edit after reading them) still count as the member\'s uploads', async () => {
        const owner = await member();
        const photo = await uploaded(owner);
        await call('PUT', '/api/profiles/me', { token: owner.token, body: { customSections: [{ title: 'P', type: 'PHOTO', imageUrl: photo }] } });
        const read = (await call('GET', '/api/profiles/me', { token: owner.token })).body.customSections;
        const again = await call('PUT', '/api/profiles/me', { token: owner.token, body: { customSections: read } });
        expect(again.status).toBe(200);
        expect(again.body.customSections[0].imageUrl).toBe(full(photo));
        // The file is still there to serve.
        const name = photo.split('/').pop()!;
        expect(fs.existsSync(path.join(env.dir, 'uploads', 'public', name))).toBe(true);
    });

    it('leave a profile with no sections, or broken saved JSON, as an empty list', async () => {
        const plain = await member();
        expect((await call('GET', '/api/profiles/me', { token: plain.token })).body.customSections).toEqual([]);
        const broken = await member({ customSections: '{not json' });
        const viewer = await member();
        const res = await call('GET', `/api/profiles/${broken.id}`, { token: viewer.token });
        expect(res.status).toBe(200);
        expect(res.body.customSections).toEqual([]);
    });
});
