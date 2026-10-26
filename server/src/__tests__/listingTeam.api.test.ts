/**
 * A business's team: members who represent a farm or business beside the
 * member who runs it, and host events as it. Who runs it adds and removes
 * them; anyone on it can leave; a member who only recommended a business
 * can't. Real routes against a real SQLite database built from the repo's
 * migrations.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const env = vi.hoisted(() => {
    const dir = `${process.env.TMPDIR || '/tmp'}/bies-listing-team-test-${process.pid}-${Date.now()}`;
    process.env.DATABASE_URL = `file:${dir}/test.db`;
    process.env.RELAY_WHITELIST_PATH = `${dir}/relay/whitelist.txt`;
    process.env.CORS_ORIGIN = 'https://app.example.test';
    process.env.TERMS_VERSION = '2026-10';
    return { dir };
});

// Nothing in here should reach a relay.
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
import directoryRoutes from '../routes/directory.routes';
import moderationRoutes from '../routes/moderation.routes';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { createSession, signAccessToken } from '../services/session.service';
import { MAX_TEAM } from '../controllers/listingTeam.controller';

let server: http.Server;
let base: string;

beforeAll(async () => {
    fs.mkdirSync(env.dir, { recursive: true });
    execSync('npx prisma migrate deploy', { cwd: path.resolve(__dirname, '../..'), env: process.env, stdio: 'pipe' });
    const app = express();
    app.use(express.json());
    app.use('/api/directory', directoryRoutes);
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

type Member = { id: string; token: string };
let counter = 0;
async function member({ admin = false, name = '' } = {}): Promise<Member> {
    const user = await prisma.user.create({
        data: {
            nostrPubkey: getPublicKey(generateSecretKey()),
            isAdmin: admin, role: admin ? 'ADMIN' : 'MEMBER',
            termsVersion: '2026-10', termsAcceptedAt: new Date(),
            profile: { create: { name: name || `Member ${++counter}` } },
        },
    });
    const session = await createSession(user.id, 'native');
    return { id: user.id, token: signAccessToken({ id: user.id, role: admin ? 'ADMIN' : 'MEMBER', isAdmin: admin }, session.sessionId) };
}

/** A live business: its own (isOwnBusiness) or one the poster recommends. */
async function business(poster: Member, own: boolean) {
    const res = await call('POST', '/api/directory', {
        token: poster.token,
        body: { type: 'PROVIDER', name: `Biz ${++counter}`, category: 'food', isOwnBusiness: own, ...(own ? {} : { review: 'Great coffee and kind people, every time.' }) },
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
}

const add = (by: Member, listingId: string, userId: string) =>
    call('POST', `/api/directory/${listingId}/team`, { token: by.token, body: { userId } });
const teamOf = async (viewer: Member, listingId: string) =>
    ((await call('GET', `/api/directory/${listingId}`, { token: viewer.token })).body.team || []).map((m: any) => m.userId);
const represented = async (m: Member) =>
    (await call('GET', '/api/directory/represented', { token: m.token })).body.data as Array<{ id: string; role: string }>;

describe("a business's team", () => {
    it('the member who runs it adds people; they hear about it, show on its page, and can host as it', async () => {
        const owner = await member();
        const ana = await member({ name: 'Ana Team' });
        const id = await business(owner, true);

        const res = await add(owner, id, ana.id);
        expect(res.status).toBe(201);
        expect(await teamOf(owner, id)).toEqual([ana.id]);
        const note = await prisma.notification.findFirst({ where: { userId: ana.id } });
        expect(note?.title).toMatch(/added you to Biz \d+'s team/);
        expect(JSON.parse(note!.data)).toMatchObject({ link: `/trusted/${id}`, listingId: id, actorId: owner.id });

        expect(await represented(ana)).toEqual([expect.objectContaining({ id, role: 'team' })]);
        expect(await represented(owner)).toEqual([expect.objectContaining({ id, role: 'runs' })]);

        // Signed out, the page names no one on it.
        const publicView = await call('GET', `/api/directory/${id}`);
        expect(publicView.body.team).toEqual([]);
        expect(JSON.stringify(publicView.body)).not.toContain('Ana Team');
    });

    it("a member who only recommended it can't; an admin can", async () => {
        const recommender = await member();
        const ben = await member();
        const admin = await member({ admin: true });
        const id = await business(recommender, false);

        expect((await add(recommender, id, ben.id)).status).toBe(403);
        expect(await represented(recommender)).toEqual([]);
        expect((await add(admin, id, ben.id)).status).toBe(201);
        expect((await represented(ben)).map((l) => l.id)).toEqual([id]);
    });

    it('only who runs it changes the team; a member on it can leave', async () => {
        const owner = await member();
        const carl = await member();
        const dana = await member();
        const id = await business(owner, true);
        await add(owner, id, carl.id);
        await add(owner, id, dana.id);

        // Carl, on the team, can't add others or take Dana off.
        expect((await add(carl, id, (await member()).id)).status).toBe(403);
        expect((await call('DELETE', `/api/directory/${id}/team/${dana.id}`, { token: carl.token })).status).toBe(403);
        // He can leave; the owner can take Dana off.
        expect((await call('DELETE', `/api/directory/${id}/team/${carl.id}`, { token: carl.token })).status).toBe(200);
        expect((await call('DELETE', `/api/directory/${id}/team/${dana.id}`, { token: owner.token })).status).toBe(200);
        expect(await teamOf(owner, id)).toEqual([]);
        expect(await represented(carl)).toEqual([]);
        expect((await call('DELETE', `/api/directory/${id}/team/${dana.id}`, { token: owner.token })).status).toBe(404);
    });

    it('turns away the owner, someone on it already, a suspended member, a block, and a full team', async () => {
        const owner = await member();
        const eve = await member();
        const id = await business(owner, true);

        expect((await add(owner, id, owner.id)).body.reason).toBe('runs_it');
        expect((await add(owner, id, eve.id)).status).toBe(201);
        expect((await add(owner, id, eve.id)).status).toBe(409);

        const gone = await member();
        await prisma.user.update({ where: { id: gone.id }, data: { isBanned: true } });
        expect((await add(owner, id, gone.id)).body.reason).toBe('no_member');

        const blocker = await member();
        await call('POST', '/api/blocks', { token: blocker.token, body: { userId: owner.id } });
        expect((await add(owner, id, blocker.id)).body.reason).toBe('blocked');

        const many = await Promise.all(Array.from({ length: MAX_TEAM - 1 }, () => member()));
        await prisma.listingTeamMember.createMany({ data: many.map((m) => ({ listingId: id, userId: m.id })) });
        expect((await add(owner, id, (await member()).id)).body.reason).toBe('team_full');
    });

    it("leaves out members blocked either way, and a suspended member's place", async () => {
        const owner = await member();
        const fay = await member();
        const gus = await member();
        const viewer = await member();
        const id = await business(owner, true);
        await add(owner, id, fay.id);
        await add(owner, id, gus.id);

        await call('POST', '/api/blocks', { token: viewer.token, body: { userId: fay.id } });
        expect(await teamOf(viewer, id)).toEqual([gus.id]);
        await prisma.user.update({ where: { id: gus.id }, data: { isBanned: true } });
        expect(await teamOf(owner, id)).toEqual([fay.id]);
    });

    it('a business handed to someone on its team takes them off it: they run it now', async () => {
        const owner = await member();
        const hal = await member();
        const id = await business(owner, true);
        await add(owner, id, hal.id);

        const offer = await call('POST', `/api/directory/${id}/transfer`, { token: owner.token, body: { toUserId: hal.id } });
        await call('POST', `/api/directory/transfers/${offer.body.id}/accept`, { token: hal.token });
        expect(await teamOf(hal, id)).toEqual([]);
        expect(await represented(hal)).toEqual([expect.objectContaining({ id, role: 'runs' })]);
        expect(await represented(owner)).toEqual([]);
    });

    it('a hand-over leaves the old team behind', async () => {
        const owner = await member();
        const ivy = await member();
        const zed = await member();
        const id = await business(owner, true);
        await add(owner, id, ivy.id);

        const offer = await call('POST', `/api/directory/${id}/transfer`, { token: owner.token, body: { toUserId: zed.id } });
        await call('POST', `/api/directory/transfers/${offer.body.id}/accept`, { token: zed.token });
        expect(await teamOf(zed, id)).toEqual([]);
        expect(await represented(ivy)).toEqual([]);
    });

    it("a recommendation stays one: its recommender can't make it their own page; staff can", async () => {
        const fan = await member();
        const admin = await member({ admin: true });
        const id = await business(fan, false);

        const flip = await call('PUT', `/api/directory/${id}`, { token: fan.token, body: { isOwnBusiness: true } });
        expect(flip.status).toBe(403);
        expect(flip.body.reason).toBe('own_business');
        expect(await represented(fan)).toEqual([]);

        expect((await call('PUT', `/api/directory/${id}`, { token: admin.token, body: { isOwnBusiness: true } })).status).toBe(200);
        expect(await represented(fan)).toEqual([expect.objectContaining({ id, role: 'runs' })]);
    });

    it('once staff link a member to it, only they run it, and the old team goes', async () => {
        const owner = await member();
        const linked = await member();
        const kim = await member();
        const lou = await member();
        const admin = await member({ admin: true });
        const id = await business(owner, true);
        await add(owner, id, kim.id);

        expect((await call('PUT', `/api/directory/${id}`, { token: admin.token, body: { memberUserId: linked.id } })).status).toBe(200);
        expect(await teamOf(linked, id)).toEqual([]);
        expect(await represented(owner)).toEqual([]);
        expect((await add(owner, id, lou.id)).status).toBe(403);
        expect((await add(linked, id, lou.id)).status).toBe(201);
    });
});
