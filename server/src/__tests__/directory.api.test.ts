/**
 * BIES Trusted and the farm directory, end to end: members add businesses and
 * farms they recommend, which go live at once; others vouch for or downvote
 * them (a downvote needs a reason), and 5 net vouches make a live listing
 * BIES Trusted. Staff can take a listing down. Real routes and middleware
 * against a real SQLite database built from the repo's migrations.
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
import { config } from '../config';

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

/** A member adds a business, which goes live at once. */
async function liveListing(poster: Member, body: Record<string, unknown> = {}) {
    const created = await call('POST', '/api/directory', {
        token: poster.token,
        body: { type: 'PROVIDER', name: `Biz ${++counter}`, category: 'home', review: 'Fixed our roof quickly and fairly.', ...body },
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('active');
    return created.body.id as string;
}

const staffReview = async (id: string, action: 'approve' | 'reject') => {
    const admin = await member({ role: 'ADMIN', admin: true });
    return call('PUT', `/api/admin/directory/${id}/review`, { token: admin.token, body: { action } });
};

const row = (id: string) => prisma.directoryListing.findUniqueOrThrow({ where: { id } });

const vote = (m: Member, id: string, v: 1 | -1, comment?: string) =>
    call('POST', `/api/directory/${id}/endorse`, { token: m.token, body: { vote: v, ...(comment !== undefined ? { comment } : {}) } });

// ─── Adding a business ────────────────────────────────────────────────────────

describe('adding a business', () => {
    it("goes live at once, with the poster's review as the first vouch", async () => {
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
        expect(res.body).toMatchObject({ status: 'active', category: 'home', hours: 'Mon–Sat 8–5', isOwnBusiness: false });
        expect(res.body.photos).toEqual(['/uploads/a.jpg', '/uploads/b.jpg']);

        const reviews = await prisma.directoryEndorsement.findMany({ where: { listingId: res.body.id } });
        expect(reviews).toHaveLength(1);
        expect(reviews[0]).toMatchObject({ userId: ana.id, vote: 1, comment: 'Fixed a burst pipe at night and charged a fair price.' });
        expect(await row(res.body.id)).toMatchObject({ vouchCount: 1, reputationScore: 1, isCertified: false });

        const list = await call('GET', '/api/directory?type=PROVIDER&limit=50');
        expect(list.body.data.map((l: any) => l.id)).toContain(res.body.id);
    });

    it('waits for staff when DIRECTORY_REQUIRE_APPROVAL is on, except for staff', async () => {
        config.directoryRequireApproval = true;
        try {
            const held = await call('POST', '/api/directory', {
                token: (await member()).token,
                body: { type: 'PROVIDER', name: 'Held', category: 'home', review: 'Good people, fair prices, on time.' },
            });
            expect(held.body.status).toBe('pending-review');
            const res = await vote(await member(), held.body.id, 1);
            expect(res.status).toBe(409);
            expect(res.body.reason).toBe('not_live');

            const byStaff = await call('POST', '/api/directory', {
                token: (await member({ role: 'MOD' })).token, body: { type: 'PROVIDER', name: 'Staff pick' },
            });
            expect(byStaff.body.status).toBe('active');

            expect((await staffReview(held.body.id, 'approve')).status).toBe(200);
            expect((await vote(await member(), held.body.id, 1)).status).toBe(201);
        } finally {
            config.directoryRequireApproval = false;
        }
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
    it("can't happen once staff take the listing down", async () => {
        const fay = await member();
        const id = await liveListing(fay);
        const voters = await Promise.all([1, 2, 3, 4].map(() => member()));
        for (const v of voters) await vote(v, id, 1);
        expect((await row(id)).isCertified).toBe(true);

        const down = await staffReview(id, 'reject');
        expect(down.status).toBe(200);
        expect(await row(id)).toMatchObject({ status: 'rejected', isCertified: false });
        const notice = await prisma.notification.findFirst({ where: { userId: fay.id }, orderBy: { createdAt: 'desc' } });
        expect(notice?.title).toBe('Directory Listing Taken Down');

        const res = await vote(await member(), id, 1);
        expect(res.status).toBe(409);
        expect(res.body.reason).toBe('not_live');
        expect((await call('GET', '/api/directory?type=PROVIDER&limit=50')).body.data.map((l: any) => l.id)).not.toContain(id);

        // Put back, it's BIES Trusted again.
        expect((await staffReview(id, 'approve')).status).toBe(200);
        expect(await row(id)).toMatchObject({ status: 'active', isCertified: true });
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

// ─── Farms ────────────────────────────────────────────────────────────────────

describe('the farm directory', () => {
    it('works the same way, on its own list', async () => {
        const farm = await call('POST', '/api/directory', {
            token: (await member()).token,
            body: {
                type: 'FARM', name: 'Finca El Roble', location: 'Chalatenango',
                products: [{ label: 'Huevos de campo', icon: 'egg' }, { label: 'Café' }],
                practices: ['regenerative'],
                review: 'We buy eggs here every week. Always fresh, fair price.',
            },
        });
        expect(farm.status).toBe(201);
        expect(farm.body).toMatchObject({ status: 'active', type: 'FARM', isOwnBusiness: false });
        expect(await row(farm.body.id)).toMatchObject({ vouchCount: 1, reputationScore: 1 });

        const ownFarm = await call('POST', '/api/directory', {
            token: (await member()).token, body: { type: 'FARM', name: 'Mi Finca', isOwnBusiness: true },
        });
        expect(await row(ownFarm.body.id)).toMatchObject({ status: 'active', vouchCount: 0 });

        const farms = await call('GET', '/api/directory?type=FARM&sort=score&limit=50');
        const ids = farms.body.data.map((l: any) => l.id);
        expect(ids.slice(0, 2)).toEqual([farm.body.id, ownFarm.body.id]);
        expect(farms.body.data.every((l: any) => l.type === 'FARM')).toBe(true);
        const businesses = await call('GET', '/api/directory?type=PROVIDER&limit=50');
        expect(businesses.body.data.some((l: any) => l.type === 'FARM')).toBe(false);
    });
});

// ─── Saving and maps ──────────────────────────────────────────────────────────

describe('saving a listing', () => {
    it('saves and forgets, shows savedByMe, and filters the list to my saved ones', async () => {
        const id = await liveListing(await member());
        const otherId = await liveListing(await member());
        const me = await member();

        expect((await call('GET', `/api/directory/${id}`, { token: me.token })).body.savedByMe).toBe(false);
        const saved = await call('POST', `/api/directory/${id}/save`, { token: me.token });
        expect(saved.body).toEqual({ saved: true });
        // Twice is fine.
        expect((await call('POST', `/api/directory/${id}/save`, { token: me.token })).status).toBe(200);
        expect((await call('GET', `/api/directory/${id}`, { token: me.token })).body.savedByMe).toBe(true);

        const mine = await call('GET', '/api/directory?type=PROVIDER&saved=true&limit=50', { token: me.token });
        expect(mine.body.data.map((l: any) => l.id)).toEqual([id]);
        expect(mine.body.data.map((l: any) => l.id)).not.toContain(otherId);
        // Signed out, or someone else: nothing saved.
        expect((await call('GET', '/api/directory?type=PROVIDER&saved=true')).body.data).toHaveLength(0);
        expect((await call('GET', '/api/directory?type=PROVIDER&saved=true', { token: (await member()).token })).body.data).toHaveLength(0);

        expect((await call('DELETE', `/api/directory/${id}/save`, { token: me.token })).body).toEqual({ saved: false });
        expect((await call('GET', `/api/directory/${id}`, { token: me.token })).body.savedByMe).toBe(false);
        expect((await call('POST', '/api/directory/nope/save', { token: me.token })).status).toBe(404);
        expect((await call('POST', `/api/directory/${id}/save`)).status).toBe(401);
    });

    it('takes a map-app link for Directions, and nothing else', async () => {
        const poster = await member();
        for (const mapUrl of ['https://maps.app.goo.gl/AbC123', 'https://www.google.com/maps/place/El+Tunco', 'https://maps.apple.com/?q=El+Tunco']) {
            const res = await call('POST', '/api/directory', {
                token: poster.token, body: { type: 'FARM', name: `Map ${++counter}`, isOwnBusiness: true, mapUrl },
            });
            expect(res.status).toBe(201);
            expect(res.body.mapUrl).toBe(mapUrl);
        }
        for (const mapUrl of ['https://evil.example/maps', 'javascript:alert(1)', 'http://maps.app.goo.gl/x']) {
            const res = await call('POST', '/api/directory', {
                token: poster.token, body: { type: 'FARM', name: 'Bad map', isOwnBusiness: true, mapUrl },
            });
            expect(res.status).toBe(400);
        }
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

// ─── Handing a listing to the member who runs it ─────────────────────────────

describe('handing a listing over', () => {
    const notes = (userId: string) => prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });

    it('a claim: the poster hands it over; it becomes the new owner’s own business', async () => {
        const poster = await member();
        const id = await liveListing(poster);
        const runner = await member();
        const fan = await member();
        await vote(runner, id, 1); // their vouch can't count once it's theirs
        await vote(fan, id, 1);
        expect((await row(id)).vouchCount).toBe(3);

        const claim = await call('POST', `/api/directory/${id}/claim`, { token: runner.token, body: { message: 'I run it with my brother.' } });
        expect(claim.status).toBe(201);
        expect(claim.body).toMatchObject({ kind: 'claim', status: 'pending', fromUserId: poster.id, toUserId: runner.id });
        // Asking twice doesn't open a second request.
        const again = await call('POST', `/api/directory/${id}/claim`, { token: runner.token, body: {} });
        expect(again.body.id).toBe(claim.body.id);
        // The poster hears about it, with a link to the listing.
        const [note] = await notes(poster.id);
        expect(JSON.parse(note.data)).toMatchObject({ link: `/trusted/${id}`, transferId: claim.body.id });

        // The poster sees the request on the listing; someone else doesn't.
        expect((await call('GET', `/api/directory/${id}`, { token: poster.token })).body.transfers).toHaveLength(1);
        expect((await call('GET', `/api/directory/${id}`, { token: fan.token })).body.transfers).toEqual([]);

        // Only the poster (or staff) can grant it.
        expect((await call('POST', `/api/directory/transfers/${claim.body.id}/accept`, { token: fan.token })).status).toBe(403);
        expect((await call('POST', `/api/directory/transfers/${claim.body.id}/accept`, { token: runner.token })).status).toBe(403);
        const granted = await call('POST', `/api/directory/transfers/${claim.body.id}/accept`, { token: poster.token });
        expect(granted.status).toBe(200);

        expect(await row(id)).toMatchObject({ ownerId: runner.id, isOwnBusiness: true, memberUserId: null, vouchCount: 2 });
        expect(await prisma.directoryEndorsement.count({ where: { listingId: id, userId: runner.id } })).toBe(0);
        // The poster's own recommendation stays and still counts.
        expect(await prisma.directoryEndorsement.count({ where: { listingId: id, userId: poster.id } })).toBe(1);
        // The new owner edits it now; the old one can't.
        expect((await call('PUT', `/api/directory/${id}`, { token: runner.token, body: { hours: 'Mon–Fri' } })).status).toBe(200);
        expect((await call('PUT', `/api/directory/${id}`, { token: poster.token, body: { hours: 'Never' } })).status).toBe(403);
        // Answering twice is refused.
        expect((await call('POST', `/api/directory/transfers/${claim.body.id}/accept`, { token: poster.token })).status).toBe(409);
    });

    it("a claim the poster says no to stays open for staff, who decide", async () => {
        const poster = await member();
        const id = await liveListing(poster);
        const runner = await member();
        const claim = await call('POST', `/api/directory/${id}/claim`, { token: runner.token, body: {} });
        const no = await call('POST', `/api/directory/transfers/${claim.body.id}/decline`, { token: poster.token });
        expect(no.body).toMatchObject({ status: 'pending', ownerDeclined: true });
        expect((await row(id)).ownerId).toBe(poster.id);

        const staff = await member({ role: 'MOD' });
        const open = await call('GET', '/api/admin/directory/transfers', { token: staff.token });
        const listed = open.body.data.find((t: any) => t.id === claim.body.id);
        expect(listed.ownerDeclinedAt).toBeTruthy();
        expect(listed.listing).toMatchObject({ id });

        const granted = await call('POST', `/api/directory/transfers/${claim.body.id}/accept`, { token: staff.token });
        expect(granted.status).toBe(200);
        expect((await row(id)).ownerId).toBe(runner.id);
        expect(await prisma.auditLog.count({ where: { action: 'DIRECTORY_LISTING_TRANSFERRED', resource: `directory:${id}` } })).toBe(1);
        // Both members hear what happened.
        expect((await notes(runner.id)).at(-1)!.title).toMatch(/is yours now/);
        expect((await notes(poster.id)).at(-1)!.title).toMatch(/has a new owner/);
    });

    it('staff can close a claim for good', async () => {
        const poster = await member();
        const id = await liveListing(poster);
        const claimant = await member();
        const claim = await call('POST', `/api/directory/${id}/claim`, { token: claimant.token, body: {} });
        const staff = await member({ admin: true });
        const closed = await call('POST', `/api/directory/transfers/${claim.body.id}/decline`, { token: staff.token });
        expect(closed.body.status).toBe('declined');
        expect((await row(id)).ownerId).toBe(poster.id);
        expect((await notes(claimant.id)).at(-1)!.title).toMatch(/was declined/);
    });

    it('an offer: the poster picks the member who runs it, who accepts', async () => {
        const poster = await member();
        const id = await liveListing(poster, { type: 'FARM', category: undefined });
        const farmer = await member();
        const other = await member();

        expect((await call('POST', `/api/directory/${id}/transfer`, { token: other.token, body: { toUserId: farmer.id } })).status).toBe(403);
        const offer = await call('POST', `/api/directory/${id}/transfer`, { token: poster.token, body: { toUserId: farmer.id } });
        expect(offer.status).toBe(201);
        expect(offer.body).toMatchObject({ kind: 'offer', toUserId: farmer.id });
        expect(JSON.parse((await notes(farmer.id)).at(-1)!.data).link).toBe(`/farms/${id}`);
        expect((await call('GET', `/api/directory/${id}`, { token: farmer.token })).body.transfers).toHaveLength(1);

        // The poster can't accept their own offer.
        expect((await call('POST', `/api/directory/transfers/${offer.body.id}/accept`, { token: poster.token })).status).toBe(403);
        const took = await call('POST', `/api/directory/transfers/${offer.body.id}/accept`, { token: farmer.token });
        expect(took.status).toBe(200);
        expect(await row(id)).toMatchObject({ ownerId: farmer.id, isOwnBusiness: true });
    });

    it('an offer can be said no to, or taken back', async () => {
        const poster = await member();
        const id = await liveListing(poster);
        const a = await member();
        const b = await member();
        const first = await call('POST', `/api/directory/${id}/transfer`, { token: poster.token, body: { toUserId: a.id } });
        const no = await call('POST', `/api/directory/transfers/${first.body.id}/decline`, { token: a.token });
        expect(no.body.status).toBe('declined');
        expect((await row(id)).ownerId).toBe(poster.id);

        const second = await call('POST', `/api/directory/${id}/transfer`, { token: poster.token, body: { toUserId: b.id } });
        expect((await call('POST', `/api/directory/transfers/${second.body.id}/cancel`, { token: b.token })).status).toBe(403);
        expect((await call('POST', `/api/directory/transfers/${second.body.id}/cancel`, { token: poster.token })).body.status).toBe('cancelled');
        expect((await call('POST', `/api/directory/transfers/${second.body.id}/accept`, { token: b.token })).status).toBe(409);
    });

    it('offering it to someone who already asked for it hands it over at once', async () => {
        const poster = await member();
        const id = await liveListing(poster);
        const runner = await member();
        await call('POST', `/api/directory/${id}/claim`, { token: runner.token, body: {} });
        const moved = await call('POST', `/api/directory/${id}/transfer`, { token: poster.token, body: { toUserId: runner.id } });
        expect(moved.body).toMatchObject({ moved: true, ownerId: runner.id });
        expect(await prisma.listingTransfer.count({ where: { listingId: id, status: 'pending' } })).toBe(0);
    });

    it("refuses a member who doesn't exist, is banned, or is blocked", async () => {
        const poster = await member();
        const id = await liveListing(poster);
        expect((await call('POST', `/api/directory/${id}/transfer`, { token: poster.token, body: { toUserId: 'nobody' } })).body.reason).toBe('no_member');
        const banned = await member();
        await prisma.user.update({ where: { id: banned.id }, data: { isBanned: true } });
        expect((await call('POST', `/api/directory/${id}/transfer`, { token: poster.token, body: { toUserId: banned.id } })).body.reason).toBe('no_member');
        const blocked = await member();
        await prisma.block.create({ data: { blockerId: poster.id, blockedId: blocked.id } });
        expect((await call('POST', `/api/directory/${id}/transfer`, { token: poster.token, body: { toUserId: blocked.id } })).body.reason).toBe('blocked');
        // And you can't claim your own listing.
        expect((await call('POST', `/api/directory/${id}/claim`, { token: poster.token, body: {} })).body.reason).toBe('already_owner');
    });

    it('staff can move a listing outright, and open requests close', async () => {
        const poster = await member();
        const id = await liveListing(poster);
        const claimant = await member();
        const runner = await member();
        await call('POST', `/api/directory/${id}/claim`, { token: claimant.token, body: {} });

        expect((await call('POST', `/api/admin/directory/${id}/owner`, { token: claimant.token, body: { userId: claimant.id } })).status).toBe(403);
        const staff = await member({ admin: true });
        const moved = await call('POST', `/api/admin/directory/${id}/owner`, { token: staff.token, body: { userId: runner.id } });
        expect(moved.status).toBe(200);
        expect(await row(id)).toMatchObject({ ownerId: runner.id, isOwnBusiness: true });
        expect(await prisma.listingTransfer.count({ where: { listingId: id, status: 'pending' } })).toBe(0);
        expect(await prisma.listingTransfer.count({ where: { listingId: id, kind: 'staff', status: 'accepted' } })).toBe(1);
    });

    it('a request goes stale if the listing changed hands in between', async () => {
        const poster = await member();
        const id = await liveListing(poster);
        const a = await member();
        const offer = await call('POST', `/api/directory/${id}/transfer`, { token: poster.token, body: { toUserId: a.id } });
        // Staff move it elsewhere without closing this one (e.g. an older request).
        await prisma.directoryListing.update({ where: { id }, data: { ownerId: (await member()).id } });
        const late = await call('POST', `/api/directory/transfers/${offer.body.id}/accept`, { token: a.token });
        expect(late.status).toBe(409);
        expect(late.body.reason).toBe('stale');
    });
});
