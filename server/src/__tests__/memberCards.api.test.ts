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
        // The network line only when asked for (the Cards layout).
        expect(Object.keys(card).sort()).toEqual(
            ['avatar', 'bio', 'company', 'id', 'joinedAt', 'location', 'name', 'skills', 'tags', 'title', 'user', 'userId'].sort());
        const withNetwork = (await get('/api/profiles?limit=50&fields=card&network=1', viewer.token)).body.data.find((p: any) => p.userId === m.id);
        expect(withNetwork.network).toEqual({ hidden: false, total: 0, youFollow: 0, people: [] });
        expect(card.user).toEqual({ id: m.id, nostrPubkey: m.pubkey });
        expect(card.bio).not.toContain('<');
        expect(card.bio.length).toBeLessThanOrEqual(200);
        expect(card.skills).toEqual(['a', 'b', 'c']);
        expect(card.tags).toEqual(['x', 'y', 'z']);
        expect(JSON.stringify(res.body)).not.toContain('Old Co');
        expect(Date.parse(card.joinedAt)).not.toBeNaN();
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

describe('the network line on a card', () => {
    const follow = (from: { id: string }, to: { id: string }) => prisma.follow.create({ data: { followerId: from.id, followingId: to.id } });
    // A search for the test's own tag: its own cached list, and only its members.
    const cards = async (tag: string, token: string) => {
        const res = await get(`/api/profiles?search=${tag}&limit=44&fields=card&network=1`, token);
        return new Map(res.body.data.map((c: any) => [c.userId, c]));
    };

    it('names people the viewer follows first, photos first, leaving out blocked, suspended and unnamed members', async () => {
        const tag = `Net${Date.now()}`;
        const viewer = await member('Net Viewer');
        const target = await member(`Target ${tag}`);
        const ana = await member('Ana Known');
        const beto = await member('Beto Known', { avatar: '/uploads/public/beto.jpg' });
        const unnamed = await member('nostr:npub1placeholder');
        const stranger = await member('Stranger Fan');
        const blocked = await member('Blocked Fan');
        const banned = await member('Banned Fan');
        for (const known of [ana, beto, unnamed, blocked, banned]) await follow(viewer, known);
        for (const fan of [ana, beto, unnamed, stranger, blocked, banned]) await follow(fan, target);
        await follow(target, stranger);
        await prisma.block.create({ data: { blockerId: viewer.id, blockedId: blocked.id } });
        await prisma.user.update({ where: { id: banned.id }, data: { isBanned: true } });

        const card: any = (await cards(tag, viewer.token)).get(target.id);
        // ana, beto, unnamed, stranger (both ways, counted once); not blocked or banned.
        expect(card.network).toMatchObject({ hidden: false, total: 4, youFollow: 3 });
        expect(card.network.people.map((p: any) => p.name)).toEqual(['Beto Known', 'Ana Known']);
        expect(card.network.people[0]).toEqual({ id: beto.id, name: 'Beto Known', avatar: '/uploads/public/beto.jpg' });
        expect(JSON.stringify(card)).not.toContain('Blocked Fan');
    });

    it('shows anyone in their network when the viewer follows none of them, never the viewer', async () => {
        const tag = `Open${Date.now()}`;
        const viewer = await member('Open Viewer');
        const target = await member(`Target ${tag}`);
        const fan = await member('Open Fan');
        const idol = await member('Open Idol');
        await follow(fan, target);
        await follow(target, idol);
        await follow(viewer, target);

        const card: any = (await cards(tag, viewer.token)).get(target.id);
        expect(card.network).toMatchObject({ hidden: false, total: 3, youFollow: 0 });
        expect(card.network.people.map((p: any) => p.id).sort()).toEqual([fan.id, idol.id].sort());
    });

    it('keeps a private network to the follower count, with no one named', async () => {
        const tag = `Private${Date.now()}`;
        const viewer = await member('Private Viewer');
        const target = await member(`Target ${tag}`, { privacy: JSON.stringify({ network: 'ONLY_ME' }) });
        const fan = await member('Secret Fan');
        await follow(viewer, fan);
        await follow(fan, target);
        await follow(viewer, target);

        const card: any = (await cards(tag, viewer.token)).get(target.id);
        expect(card.network).toEqual({ hidden: true, followers: 2 });
        expect(JSON.stringify(card)).not.toContain('Secret Fan');
        // Their own card still shows them their network.
        const own: any = (await cards(tag, target.token)).get(target.id);
        expect(own.network).toMatchObject({ hidden: false, total: 2 });
    });

    it("leaves out a member suspended since the list was cached, on others' cards too", async () => {
        const tag = `Banned${Date.now()}`;
        const viewer = await member('Banned Viewer');
        const target = await member(`Target ${tag}`);
        const later = await member(`Later ${tag}`);
        await follow(later, target);
        await follow(viewer, later);
        expect(((await cards(tag, viewer.token)).get(target.id) as any).network).toMatchObject({ total: 1, youFollow: 1 });
        // Suspended now; the list (and Later's card in it) is still cached.
        await prisma.user.update({ where: { id: later.id }, data: { isBanned: true } });
        const card: any = (await cards(tag, viewer.token)).get(target.id);
        expect(card.network).toMatchObject({ total: 0, youFollow: 0, people: [] });
    });

    it('is left out for signed-out visitors', async () => {
        const tag = `Public${Date.now()}`;
        const target = await member(`Target ${tag}`);
        const res = await fetch(`${base}/api/profiles?search=${tag}&limit=43&fields=card&network=1`);
        const body: any = await res.json();
        const card = body.data.find((c: any) => c.userId === target.id);
        expect(card).toBeTruthy();
        expect(card.network).toBeUndefined();
    });
});

describe('sorting members', () => {
    it('by name as people read it, the most followed, or the newest', async () => {
        const viewer = await member('Sort Viewer');
        const tag = `Sort${Date.now()}`;
        const zoe = await member(`Zoe ${tag}`);
        const alba = await member(`Álvaro ${tag}`);
        const beto = await member(`beto ${tag}`);
        for (const fan of [viewer, alba]) await prisma.follow.create({ data: { followerId: fan.id, followingId: zoe.id } });
        await prisma.follow.create({ data: { followerId: viewer.id, followingId: beto.id } });

        const order = async (query: string) =>
            (await get(`/api/profiles?search=${tag}&limit=46&fields=card&${query}`, viewer.token)).body.data.map((p: any) => p.userId);
        expect(await order('sort=name')).toEqual([alba.id, beto.id, zoe.id]);
        expect(await order('sort=followers')).toEqual([zoe.id, beto.id, alba.id]);
        expect(await order('sort=newest')).toEqual([beto.id, alba.id, zoe.id]);

        // Without a search too, page by page in that order (each sort is its own cached list).
        const all = (await get('/api/profiles?limit=45&fields=card&sort=name', viewer.token)).body;
        const names = all.data.map((p: any) => p.name);
        expect(names.indexOf(`Álvaro ${tag}`)).toBeLessThan(names.indexOf(`beto ${tag}`));
        expect(names.indexOf(`beto ${tag}`)).toBeLessThan(names.indexOf(`Zoe ${tag}`));
        const second = (await get('/api/profiles?page=2&limit=2&fields=card&sort=name', viewer.token)).body;
        expect(second.data.map((p: any) => p.name)).toEqual(names.slice(2, 4));
        expect(second.pagination.total).toBe(all.pagination.total);
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
