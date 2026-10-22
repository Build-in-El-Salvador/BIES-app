/**
 * The Members list asks for cards only (?fields=card): what a member card
 * shows, after the privacy rules, without the rest of the profile. Without
 * it the list is unchanged. Pages come in a stable order, so scrolling
 * neither repeats nor skips members. Real routes against a real SQLite
 * database built from the repo's migrations.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const env = vi.hoisted(() => {
    const dir = `${process.env.TMPDIR || '/tmp'}/bies-cards-test-${process.pid}-${Date.now()}`;
    process.env.DATABASE_URL = `file:${dir}/test.db`;
    process.env.RELAY_WHITELIST_PATH = `${dir}/relay/whitelist.txt`;
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

async function get(url: string, token: string) {
    const res = await fetch(`${base}${url}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function member(name: string, profile: Record<string, unknown> = {}) {
    const pubkey = getPublicKey(generateSecretKey());
    const user = await prisma.user.create({
        data: {
            nostrPubkey: pubkey,
            termsVersion: '2026-10', termsAcceptedAt: new Date(),
            profile: { create: { name, ...profile } },
        },
    });
    const session = await createSession(user.id, 'native');
    return { id: user.id, pubkey, token: signAccessToken({ id: user.id, role: 'MEMBER', isAdmin: false }, session.sessionId) };
}

describe('member cards', () => {
    it('carry only what a card shows', async () => {
        const viewer = await member('Card Viewer');
        const longBio = `<p>${'Builds things in El Salvador. '.repeat(30)}</p>`;
        const m = await member('Card Member', {
            title: 'Founder', company: 'Casa', location: 'San Salvador', bio: longBio,
            skills: JSON.stringify(['a', 'b', 'c', 'd']), tags: JSON.stringify(['x', 'y', 'z', 'w']),
            experience: JSON.stringify([{ title: 'CEO', company: 'Old Co' }]),
            customSections: JSON.stringify([{ title: 'More', body: 'A long section' }]),
        });

        const res = await get('/api/profiles?limit=50&fields=card', viewer.token);
        expect(res.status).toBe(200);
        const card = res.body.data.find((p: any) => p.userId === m.id);
        expect(card).toBeTruthy();
        expect(Object.keys(card).sort()).toEqual(
            ['avatar', 'bio', 'company', 'id', 'location', 'name', 'skills', 'tags', 'title', 'user', 'userId'].sort());
        expect(card.user).toEqual({ id: m.id, nostrPubkey: m.pubkey });
        expect(card.bio).not.toContain('<');
        expect(card.bio.length).toBeLessThanOrEqual(200);
        expect(card.skills).toEqual(['a', 'b', 'c']);
        expect(card.tags).toEqual(['x', 'y', 'z']);
        expect(JSON.stringify(res.body)).not.toContain('Old Co');
    });

    it('leave the full list unchanged when not asked for', async () => {
        const viewer = await member('Full Viewer');
        const m = await member('Full Member', { experience: JSON.stringify([{ title: 'CTO', company: 'Kept Co' }]) });
        // Each test asks for its own page size: lists are cached for 2 minutes.
        const res = await get('/api/profiles?limit=49', viewer.token);
        const full = res.body.data.find((p: any) => p.userId === m.id);
        expect(full.experience).toEqual([{ title: 'CTO', company: 'Kept Co' }]);
    });

    it('come in a stable order, so pages neither repeat nor skip members', async () => {
        const viewer = await member('Order Viewer');
        for (let i = 0; i < 7; i++) await member(`Same Views ${i}`);
        const total = (await get('/api/profiles?limit=48&fields=card', viewer.token)).body.pagination.total;
        const seen: string[] = [];
        for (let page = 1; page <= Math.ceil(total / 3); page++) {
            const res = await get(`/api/profiles?page=${page}&limit=3&fields=card`, viewer.token);
            seen.push(...res.body.data.map((p: any) => p.id));
        }
        expect(seen.length).toBe(total);
        expect(new Set(seen).size).toBe(total);
    });
});

describe('a profile page', () => {
    it("says whether the viewer follows them, so the app needn't fetch who they follow", async () => {
        const viewer = await member('Follow Viewer');
        const followed = await member('Followed One');
        const other = await member('Not Followed');
        await prisma.follow.create({ data: { followerId: viewer.id, followingId: followed.id } });

        expect((await get(`/api/profiles/${followed.id}`, viewer.token)).body.followedByMe).toBe(true);
        expect((await get(`/api/profiles/${other.id}`, viewer.token)).body.followedByMe).toBe(false);
        // The profile is cached for everyone: the answer stays the viewer's own.
        expect((await get(`/api/profiles/${followed.id}`, other.token)).body.followedByMe).toBe(false);
        expect((await get(`/api/profiles/${viewer.id}`, viewer.token)).body.followedByMe).toBe(false);
    });
});
