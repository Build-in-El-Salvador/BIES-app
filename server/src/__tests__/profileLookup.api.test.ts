/**
 * Members' BIES names and photos by Nostr key (POST /profiles/lookup), which
 * the Feed shows instead of whatever a member's Nostr profile says: for
 * members only; not for unnamed, suspended or deleted members, nor anyone
 * blocked either way. Real routes against a real SQLite database built from
 * the repo's migrations.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const env = vi.hoisted(() => {
    const dir = `${process.env.TMPDIR || '/tmp'}/bies-lookup-test-${process.pid}-${Date.now()}`;
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
import prisma from '../lib/prisma';
import profileRoutes from '../routes/profile.routes';
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

type Member = { id: string; pubkey: string; token: string };
async function member(name: string, avatar = ''): Promise<Member> {
    const pubkey = getPublicKey(generateSecretKey());
    const user = await prisma.user.create({
        data: { nostrPubkey: pubkey, role: 'MEMBER', termsVersion: '2026-10', termsAcceptedAt: new Date(), profile: { create: { name, avatar } } },
    });
    const session = await createSession(user.id, 'native');
    return { id: user.id, pubkey, token: signAccessToken({ id: user.id, role: 'MEMBER', isAdmin: false }, session.sessionId) };
}

const lookup = (viewer: Member, pubkeys: string[]) => call('POST', '/api/profiles/lookup', { token: viewer.token, body: { pubkeys } });

describe('looking up members by Nostr key', () => {
    it('gives each member\'s BIES name and photo; nothing for unnamed members or keys that aren\'t members', async () => {
        const viewer = await member('Viewer');
        const ana = await member('Ana Rivera', 'https://app.example.test/uploads/public/1760000000000-' + 'a'.repeat(32) + '.jpg');
        const unnamed = await member(`nostr:${'b'.repeat(8)}`);
        const stranger = getPublicKey(generateSecretKey());

        const res = await lookup(viewer, [ana.pubkey, unnamed.pubkey, stranger, ana.pubkey]);
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ [ana.pubkey]: { name: 'Ana Rivera', avatar: expect.stringContaining('/uploads/public/') } });
    });

    it('is for members only, and takes Nostr keys only', async () => {
        const viewer = await member('Viewer B');
        expect((await call('POST', '/api/profiles/lookup', { body: { pubkeys: [viewer.pubkey] } })).status).toBe(401);
        expect((await lookup(viewer, ['not-a-key'])).status).toBe(400);
        expect((await lookup(viewer, [])).status).toBe(400);
    });

    it('leaves out suspended and deleted members, and anyone blocked either way', async () => {
        const viewer = await member('Viewer C');
        const [banned, deleted, blockedByViewer, blockedViewer, fine] = [
            await member('Banned'), await member('Deleted'), await member('Blocked by viewer'), await member('Blocked the viewer'), await member('Fine'),
        ];
        await prisma.user.update({ where: { id: banned.id }, data: { isBanned: true } });
        await prisma.user.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });
        expect((await call('POST', '/api/blocks', { token: viewer.token, body: { userId: blockedByViewer.id } })).status).toBe(201);
        expect((await call('POST', '/api/blocks', { token: blockedViewer.token, body: { userId: viewer.id } })).status).toBe(201);

        const res = await lookup(viewer, [banned, deleted, blockedByViewer, blockedViewer, fine].map((m) => m.pubkey));
        expect(Object.keys(res.body.data)).toEqual([fine.pubkey]);
    });
});
