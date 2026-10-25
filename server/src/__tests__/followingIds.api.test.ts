/**
 * GET /api/profiles/me/following-ids: everyone the signed-in member follows,
 * for the Follow buttons on member lists. /:id/following pages 50 at a time,
 * so the lists used to show "Follow" for anyone past the first 50. Real
 * routes against a real SQLite database built from the repo's migrations.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const env = vi.hoisted(() => {
    const dir = `${process.env.TMPDIR || '/tmp'}/bies-following-ids-test-${process.pid}-${Date.now()}`;
    process.env.DATABASE_URL = `file:${dir}/test.db`;
    process.env.RELAY_WHITELIST_PATH = `${dir}/relay/whitelist.txt`;
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
import profileRoutes from '../routes/profile.routes';
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
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 120_000);

afterAll(async () => {
    server?.close();
    await prisma.$disconnect();
    fs.rmSync(env.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function call(method: string, url: string, token?: string) {
    const res = await fetch(`${base}${url}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

const newUser = (name: string) => prisma.user.create({
    data: {
        nostrPubkey: getPublicKey(generateSecretKey()),
        termsVersion: '2026-10', termsAcceptedAt: new Date(),
        profile: { create: { name } },
    },
});
async function member(name: string) {
    const user = await newUser(name);
    const session = await createSession(user.id, 'native');
    return { id: user.id, token: signAccessToken({ id: user.id, role: 'MEMBER', isAdmin: false }, session.sessionId) };
}

describe('GET /api/profiles/me/following-ids', () => {
    it('lists everyone I follow, past the 50 a page of /following holds', async () => {
        const me = await member('Ana Follows');
        const others = await Promise.all(Array.from({ length: 60 }, (_, i) => newUser(`Member ${i}`)));
        await prisma.follow.createMany({ data: others.slice(0, 59).map((o) => ({ followerId: me.id, followingId: o.id })) });
        // And one through the API, as the Follow button does.
        expect((await call('POST', `/api/profiles/${others[59].id}/follow`, me.token)).status).toBe(201);

        const page = await call('GET', `/api/profiles/${me.id}/following?limit=100`, me.token);
        expect(page.body.data).toHaveLength(50);

        const res = await call('GET', '/api/profiles/me/following-ids', me.token);
        expect(res.status).toBe(200);
        expect(new Set(res.body.ids)).toEqual(new Set(others.map((o) => o.id)));

        await call('DELETE', `/api/profiles/${others[0].id}/follow`, me.token);
        const after = await call('GET', '/api/profiles/me/following-ids', me.token);
        expect(after.body.ids).toHaveLength(59);
        expect(after.body.ids).not.toContain(others[0].id);
    });

    it("gives only my own follows, and only when I'm signed in", async () => {
        const ben = await member('Ben Follows');
        const carl = await member('Carl Follows');
        const dana = await newUser('Dana');
        await prisma.follow.create({ data: { followerId: carl.id, followingId: dana.id } });

        expect((await call('GET', '/api/profiles/me/following-ids', ben.token)).body).toEqual({ ids: [] });
        expect((await call('GET', '/api/profiles/me/following-ids', carl.token)).body).toEqual({ ids: [dana.id] });
        expect((await call('GET', '/api/profiles/me/following-ids')).status).toBe(401);
    });
});
