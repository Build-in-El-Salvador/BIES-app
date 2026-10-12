/**
 * BIES Trusted, end to end: members add businesses they recommend, vouch for
 * or downvote them (a downvote needs a reason), and 5 net vouches make a live
 * listing BIES Trusted. Real routes and middleware against a real SQLite
 * database built from the repo's migrations.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const env = vi.hoisted(() => {
    const dir = `${process.env.TMPDIR || '/tmp'}/bies-directory-test-${process.pid}-${Date.now()}`;
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
import adminRoutes from '../routes/admin.routes';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { createSession, signAccessToken } from '../services/session.service';
import { recomputeListingScore, TRUSTED_THRESHOLD } from '../services/directoryReputation.service';

let server: http.Server;
let base: string;

beforeAll(async () => {
    fs.mkdirSync(env.dir, { recursive: true });
    execSync('npx prisma migrate deploy', { cwd: path.resolve(__dirname, '../..'), env: process.env, stdio: 'pipe' });

    const app = express();
    app.use(express.json());
    app.use('/api/directory', directoryRoutes);
    app.use('/api/admin', adminRoutes);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 120_000);

afterAll(async () => {
    server?.close();
    await prisma.$disconnect();
    fs.rmSync(env.dir, { recursive: true, force: true });
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
async function member({ role = 'MEMBER', admin = false } = {}): Promise<Member> {
    const user = await prisma.user.create({
        data: {
            nostrPubkey: getPublicKey(generateSecretKey()),
            role,
            isAdmin: admin,
            termsVersion: '2026-10',
            termsAcceptedAt: new Date(),
            profile: { create: { name: `Member ${++counter}` } },
        },
    });
    const session = await createSession(user.id, 'native');
    return { id: user.id, token: signAccessToken({ id: user.id, role, isAdmin: admin }, session.sessionId) };
}

const REASON = 'They took the deposit and never came back to finish the job.';

/** A member adds a business; staff approves it so it can be reviewed. */
async function liveListing(poster: Member, body: Record<string, unknown> = {}) {
    const created = await call('POST', '/api/directory', {
        token: poster.token,
        body: { type: 'PROVIDER', name: `Biz ${++counter}`, category: 'home', review: 'Fixed our roof quickly and fairly.', ...body },
    });
    expect(created.status).toBe(201);
    const admin = await member({ role: 'ADMIN', admin: true });
    const approved = await call('PUT', `/api/admin/directory/${created.body.id}/review`, { token: admin.token, body: { action: 'approve' } });
    expect(approved.status).toBe(200);
    await recomputeListingScore(created.body.id);
    return created.body.id as string;
}

const row = (id: string) => prisma.directoryListing.findUniqueOrThrow({ where: { id } });

const vote = (m: Member, id: string, v: 1 | -1, comment?: string) =>
    call('POST', `/api/directory/${id}/endorse`, { token: m.token, body: { vote: v, ...(comment !== undefined ? { comment } : {}) } });

// ─── Adding a business ────────────────────────────────────────────────────────

describe('adding a business', () => {
    it("counts the poster's review as the first vouch, and waits for review", async () => {
        const ana = await member();
        const res = await call('POST', '/api/directory', {
            token: ana.token,
            body: {
                type: 'PROVIDER', name: 'Plomería Rivas', category: 'home', hours: 'Mon–Sat 8–5',
                phone: '+503 7000 0000', email: 'rivas@example.test', location: 'San Salvador',
                photos: ['/uploads/a.jpg', '/uploads/b.jpg'],
                review: 'Fixed a burst pipe at night and charged a fair price.',
            },
        });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ status: 'pending-review', category: 'home', hours: 'Mon–Sat 8–5', isOwnBusiness: false });
        expect(res.body.photos).toEqual(['/uploads/a.jpg', '/uploads/b.jpg']);

        const reviews = await prisma.directoryEndorsement.findMany({ where: { listingId: res.body.id } });
        expect(reviews).toHaveLength(1);
        expect(reviews[0]).toMatchObject({ userId: ana.id, vote: 1, comment: 'Fixed a burst pipe at night and charged a fair price.' });
        expect(await row(res.body.id)).toMatchObject({ vouchCount: 1, reputationScore: 1, isCertified: false });
    });

    it("doesn't vouch for the poster's own business, and they can't review it", async () => {
        const bea = await member();
        const id = await liveListing(bea, { isOwnBusiness: true });
        expect(await prisma.directoryEndorsement.count({ where: { listingId: id } })).toBe(0);
        expect(await row(id)).toMatchObject({ vouchCount: 0, reputationScore: 0 });

        const own = await vote(bea, id, 1);
        expect(own.status).toBe(403);
        expect(own.body.reason).toBe('own_business');
    });

    it('drops the vouch when the poster later marks it as their own business', async () => {
        const cora = await member();
        const id = await liveListing(cora);
        expect((await row(id)).vouchCount).toBe(1);
        const edited = await call('PUT', `/api/directory/${id}`, { token: cora.token, body: { isOwnBusiness: true } });
        expect(edited.status).toBe(200);
        expect(await row(id)).toMatchObject({ vouchCount: 0, reputationScore: 0 });
    });

    it('refuses an unknown category', async () => {
        const dan = await member();
        const res = await call('POST', '/api/directory', { token: dan.token, body: { type: 'PROVIDER', name: 'X', category: 'casino' } });
        expect(res.status).toBe(400);
    });

    it("lets only staff link a member's account to a listing", async () => {
        const eve = await member();
        const victim = await member();
        const res = await call('POST', '/api/directory', {
            token: eve.token, body: { type: 'PROVIDER', name: 'Linked?', memberUserId: victim.id },
        });
        expect(res.status).toBe(201);
        expect(res.body.memberUserId).toBeNull();

        const mod = await member({ role: 'MOD' });
        const byStaff = await call('POST', '/api/directory', {
            token: mod.token, body: { type: 'PROVIDER', name: 'Linked by staff', memberUserId: victim.id },
        });
        expect(byStaff.body.memberUserId).toBe(victim.id);
        // And the linked member can't review it.
        const linked = await vote(victim, byStaff.body.id, 1);
        expect(linked.status).toBe(403);
        expect(linked.body.reason).toBe('own_business');
    });
});

// ─── Voting ───────────────────────────────────────────────────────────────────

describe('vouching and downvoting', () => {
    it("can't happen before the listing is live", async () => {
        const fay = await member();
        const created = await call('POST', '/api/directory', { token: fay.token, body: { type: 'PROVIDER', name: 'Pending' } });
        const res = await vote(await member(), created.body.id, 1);
        expect(res.status).toBe(409);
        expect(res.body.reason).toBe('not_live');
    });

    it('needs a reason for a downvote', async () => {
        const id = await liveListing(await member());
        const critic = await member();

        for (const comment of [undefined, '', 'Bad.', '   short reason      ']) {
            const res = await vote(critic, id, -1, comment);
            expect(res.status).toBe(400);
            expect(res.body).toMatchObject({ reason: 'reason_required', min: 20 });
        }
        expect(await prisma.directoryEndorsement.count({ where: { listingId: id, userId: critic.id } })).toBe(0);

        const ok = await vote(critic, id, -1, REASON);
        expect(ok.status).toBe(201);
        expect(ok.body.listing).toMatchObject({ vouchCount: 1, downvoteCount: 1, reputationScore: 0 });
    });

    it('lets a vouch go without words, and lets members change their mind', async () => {
        const id = await liveListing(await member());
        const gil = await member();
        expect((await vote(gil, id, 1)).body.listing).toMatchObject({ vouchCount: 2, reputationScore: 2 });

        // Same member again: one review each, changed in place.
        const changed = await vote(gil, id, -1, REASON);
        expect(changed.body.listing).toMatchObject({ vouchCount: 1, downvoteCount: 1, reputationScore: 0 });
        expect(await prisma.directoryEndorsement.count({ where: { listingId: id, userId: gil.id } })).toBe(1);

        const removed = await call('DELETE', `/api/directory/${id}/endorse`, { token: gil.token });
        expect(removed.status).toBe(200);
        expect(removed.body.listing).toMatchObject({ vouchCount: 1, downvoteCount: 0, reputationScore: 1 });
    });

    it('screens review text like any other post', async () => {
        const id = await liveListing(await member());
        const res = await vote(await member(), id, -1, 'The owner told my wife to kill yourself, avoid them');
        expect(res.status).toBe(422);
    });
});

// ─── BIES Trusted ─────────────────────────────────────────────────────────────

describe('BIES Trusted', () => {
    it(`comes at ${TRUSTED_THRESHOLD} net vouches, and goes when downvotes bring it below`, async () => {
        expect(TRUSTED_THRESHOLD).toBe(5);
        const id = await liveListing(await member()); // the poster's vouch: 1
        const voters = await Promise.all([1, 2, 3].map(() => member()));
        for (const v of voters) await vote(v, id, 1);
        expect(await row(id)).toMatchObject({ reputationScore: 4, isCertified: false, certifiedAt: null });

        await vote(await member(), id, 1);
        const trusted = await row(id);
        expect(trusted).toMatchObject({ reputationScore: 5, vouchCount: 5, isCertified: true });
        expect(trusted.certifiedAt).toBeInstanceOf(Date);

        const critic = await member();
        await vote(critic, id, -1, REASON);
        expect(await row(id)).toMatchObject({ reputationScore: 4, downvoteCount: 1, isCertified: false, certifiedAt: null });

        await call('DELETE', `/api/directory/${id}/endorse`, { token: critic.token });
        expect(await row(id)).toMatchObject({ reputationScore: 5, isCertified: true });
    });

    it("doesn't count banned members' votes", async () => {
        const id = await liveListing(await member());
        const voters = await Promise.all([1, 2, 3, 4].map(() => member()));
        for (const v of voters) await vote(v, id, 1);
        expect((await row(id)).isCertified).toBe(true);

        await prisma.user.update({ where: { id: voters[0].id }, data: { isBanned: true } });
        await recomputeListingScore(id);
        expect(await row(id)).toMatchObject({ vouchCount: 4, isCertified: false });
    });

    it('is a filter and a sort order in the directory', async () => {
        const list = await call('GET', '/api/directory?type=PROVIDER&certified=true&limit=50');
        expect(list.status).toBe(200);
        expect(list.body.trustedThreshold).toBe(5);
        expect(list.body.data.length).toBeGreaterThan(0);
        expect(list.body.data.every((l: any) => l.isCertified)).toBe(true);

        const byScore = await call('GET', '/api/directory?type=PROVIDER&sort=score&limit=50');
        const scores = byScore.body.data.map((l: any) => l.reputationScore);
        expect(scores).toEqual([...scores].sort((a, b) => b - a));

        const home = await call('GET', '/api/directory?type=PROVIDER&category=home&limit=50');
        expect(home.body.data.every((l: any) => l.category === 'home')).toBe(true);
        expect((await call('GET', '/api/directory?type=PROVIDER&category=legal')).body.data).toHaveLength(0);
    });
});

// ─── Reading ──────────────────────────────────────────────────────────────────

describe('reading a listing', () => {
    it('shows reviews with their votes to members, and only the counts to anyone else', async () => {
        const id = await liveListing(await member());
        const critic = await member();
        await vote(critic, id, -1, REASON);

        const signedIn = await call('GET', `/api/directory/${id}`, { token: (await member()).token });
        expect(signedIn.body).toMatchObject({ vouchCount: 1, downvoteCount: 1, reputationScore: 0, trustedThreshold: 5 });
        expect(signedIn.body.endorsements.map((e: any) => e.vote).sort()).toEqual([-1, 1]);
        expect(signedIn.body.endorsements.find((e: any) => e.vote === -1).comment).toBe(REASON);

        const signedOut = await call('GET', `/api/directory/${id}`);
        expect(signedOut.status).toBe(200);
        expect(signedOut.body.endorsements).toEqual([]);
        expect(signedOut.body).toMatchObject({ vouchCount: 1, downvoteCount: 1 });
    });
});
