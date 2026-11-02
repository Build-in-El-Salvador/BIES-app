/**
 * How the member adding a business or farm is connected to it: they
 * recommend it, it's their business (they run it), or they work there
 * (addedAs STAFF: it's the business's own listing, they're on its team, and
 * they don't run it). Switching between the last two on edit, a claim on a
 * listing added by someone who works there, "Runs" and "Works at" on a
 * profile, hosting events as the business, who hears when it's named on an
 * event, and whose votes count. Real routes against a real SQLite database
 * built from the repo's migrations.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const env = vi.hoisted(() => {
    const dir = `${process.env.TMPDIR || '/tmp'}/bies-business-connection-test-${process.pid}-${Date.now()}`;
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
import eventRoutes from '../routes/events.routes';
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
    app.use('/api/directory', directoryRoutes);
    app.use('/api/events', eventRoutes);
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
async function member({ admin = false } = {}): Promise<Member> {
    const user = await prisma.user.create({
        data: {
            nostrPubkey: getPublicKey(generateSecretKey()),
            isAdmin: admin, role: admin ? 'ADMIN' : 'MEMBER',
            termsVersion: '2026-10', termsAcceptedAt: new Date(),
            profile: { create: { name: `Member ${++counter}` } },
        },
    });
    const session = await createSession(user.id, 'native');
    return { id: user.id, token: signAccessToken({ id: user.id, role: admin ? 'ADMIN' : 'MEMBER', isAdmin: admin }, session.sessionId) };
}

type Connection = 'customer' | 'owner' | 'staff';
const FIELDS: Record<Connection, Record<string, unknown>> = {
    customer: { isOwnBusiness: false, addedAs: '', review: 'Great coffee and kind people, every time.' },
    owner: { isOwnBusiness: true, addedAs: '' },
    staff: { isOwnBusiness: true, addedAs: 'STAFF' },
};

/** A live business, added by `poster` as `connection`. */
async function business(poster: Member, connection: Connection) {
    const res = await call('POST', '/api/directory', {
        token: poster.token,
        body: { type: 'PROVIDER', name: `Biz ${++counter}`, category: 'food', ...FIELDS[connection] },
    });
    expect(res.status).toBe(201);
    return res.body as { id: string; isOwnBusiness: boolean; addedAs: string; vouchCount: number };
}

const listingOf = async (viewer: Member, id: string) => (await call('GET', `/api/directory/${id}`, { token: viewer.token })).body;
const teamOf = async (viewer: Member, id: string) => ((await listingOf(viewer, id)).team || []).map((m: any) => m.userId);
const represented = async (m: Member) =>
    (await call('GET', '/api/directory/represented', { token: m.token })).body.data as Array<{ id: string; role: string }>;
const worksAt = async (viewer: Member | null, userId: string) =>
    ((await call('GET', `/api/directory?worksAt=${userId}`, viewer ? { token: viewer.token } : {})).body.data || []).map((l: any) => l.id);
const runs = async (viewer: Member | null, userId: string) =>
    ((await call('GET', `/api/directory?runBy=${userId}`, viewer ? { token: viewer.token } : {})).body.data || []).map((l: any) => l.id);
const notificationsOf = async (m: Member) =>
    (await prisma.notification.findMany({ where: { userId: m.id }, orderBy: { createdAt: 'asc' } })).map((n) => n.title);
const edit = (by: Member, id: string, body: Record<string, unknown>) => call('PUT', `/api/directory/${id}`, { token: by.token, body });
const addToTeam = (by: Member, id: string, userId: string) => call('POST', `/api/directory/${id}/team`, { token: by.token, body: { userId } });

const inDays = (d: number) => new Date(Date.now() + d * 86400_000).toISOString();
const hostEvent = (host: Member, hostListingId: string) => call('POST', '/api/events', {
    token: host.token,
    body: { title: `Event ${++counter}`, description: 'An evening for founders and builders.', startDate: inDays(10), nostrPublish: 'none', hostListingId },
});

describe('"I work there"', () => {
    it("puts the member who adds it on its team: the business's own listing, which they don't run", async () => {
        const eric = await member();
        const viewer = await member();
        const listing = await business(eric, 'staff');
        expect(listing).toMatchObject({ isOwnBusiness: true, addedAs: 'STAFF', vouchCount: 0 });

        expect(await teamOf(viewer, listing.id)).toEqual([eric.id]);
        expect(await represented(eric)).toEqual([expect.objectContaining({ id: listing.id, role: 'team' })]);
        // No review of their own, and none later: their vote doesn't count.
        expect(await prisma.directoryEndorsement.count({ where: { listingId: listing.id } })).toBe(0);
        const review = await call('POST', `/api/directory/${listing.id}/endorse`, { token: eric.token, body: { vote: 1, comment: 'The best shop in town, honestly.' } });
        expect(review.status).toBe(403);
        expect(review.body.reason).toBe('own_business');
        // They can't change its team: nobody runs it yet.
        expect((await addToTeam(eric, listing.id, viewer.id)).status).toBe(403);
        // They still edit what they added.
        expect((await edit(eric, listing.id, { hours: 'Mon–Sat 9–6' })).status).toBe(200);
    });

    it('is only for a business\'s own listing', async () => {
        const fan = await member();
        const res = await call('POST', '/api/directory', {
            token: fan.token,
            body: { type: 'PROVIDER', name: `Biz ${++counter}`, category: 'food', isOwnBusiness: false, addedAs: 'STAFF', review: 'Great coffee and kind people, every time.' },
        });
        expect(res.status).toBe(400);
        expect(res.body.reason).toBe('staff_not_own');
    });

    it('lets them host events as the business, as anyone on its team', async () => {
        const eric = await member();
        const listing = await business(eric, 'staff');

        const event = await hostEvent(eric, listing.id);
        expect(event.status).toBe(201);
        expect(event.body.hostListing).toMatchObject({ id: listing.id });
        const mine = await call('GET', '/api/events/my', { token: eric.token });
        expect(mine.body.data.map((e: any) => e.id)).toContain(event.body.id);

        // Off the team, they don't.
        expect((await call('DELETE', `/api/directory/${listing.id}/team/${eric.id}`, { token: eric.token })).status).toBe(200);
        expect((await hostEvent(eric, listing.id)).status).toBe(403);
    });
});

describe('"Runs" and "Works at" on a profile', () => {
    it('"Works at" is only the businesses they said they work at, live ones, for members', async () => {
        const eric = await member();
        const boss = await member();
        const viewer = await member();
        const shop = await business(eric, 'staff');
        const cafe = await business(boss, 'owner');
        const ownShop = await business(eric, 'owner');

        // A team someone else put them on shows on the business's page, not as "Works at".
        expect((await addToTeam(boss, cafe.id, eric.id)).status).toBe(201);
        expect(await teamOf(viewer, cafe.id)).toEqual([eric.id]);
        expect(await worksAt(viewer, eric.id)).toEqual([shop.id]);
        expect(await worksAt(eric, eric.id)).toEqual([shop.id]);
        expect(await runs(viewer, eric.id)).toEqual([ownShop.id]);
        // Signed out: neither.
        expect(await worksAt(null, eric.id)).toEqual([]);
        expect(await runs(null, eric.id)).toEqual([]);

        // Not once it's down, nor once they left its team.
        await prisma.directoryListing.update({ where: { id: shop.id }, data: { isPublished: false } });
        expect(await worksAt(viewer, eric.id)).toEqual([]);
        await prisma.directoryListing.update({ where: { id: shop.id }, data: { isPublished: true } });
        expect((await call('DELETE', `/api/directory/${shop.id}/team/${eric.id}`, { token: eric.token })).status).toBe(200);
        expect(await worksAt(viewer, eric.id)).toEqual([]);
    });

    it('"Runs" is the businesses they run: their own, or one staff linked them to; not where they work', async () => {
        const eric = await member();
        const viewer = await member();
        const admin = await member({ admin: true });
        const own = await business(eric, 'owner');
        const linked = await business(admin, 'customer');
        expect((await edit(admin, linked.id, { memberUserId: eric.id })).status).toBe(200);
        const shop = await business(eric, 'staff');
        await business(eric, 'customer');

        expect((await runs(viewer, eric.id)).sort()).toEqual([own.id, linked.id].sort());
        expect(await runs(viewer, eric.id)).not.toContain(shop.id);
    });

    it('nothing for a member blocked either way, suspended or deleted', async () => {
        const eric = await member();
        const viewer = await member();
        const shop = await business(eric, 'staff');
        const own = await business(eric, 'owner');
        expect(await worksAt(viewer, eric.id)).toEqual([shop.id]);

        await call('POST', '/api/blocks', { token: viewer.token, body: { userId: eric.id } });
        expect(await worksAt(viewer, eric.id)).toEqual([]);
        expect(await runs(viewer, eric.id)).toEqual([]);
        await call('DELETE', `/api/blocks/${eric.id}`, { token: viewer.token });
        expect(await runs(viewer, eric.id)).toEqual([own.id]);

        await call('POST', '/api/blocks', { token: eric.token, body: { userId: viewer.id } });
        expect(await worksAt(viewer, eric.id)).toEqual([]);
        expect(await runs(viewer, eric.id)).toEqual([]);
        await call('DELETE', `/api/blocks/${viewer.id}`, { token: eric.token });

        await prisma.user.update({ where: { id: eric.id }, data: { isBanned: true } });
        expect(await worksAt(viewer, eric.id)).toEqual([]);
        await prisma.user.update({ where: { id: eric.id }, data: { isBanned: false, deletedAt: new Date() } });
        expect(await worksAt(viewer, eric.id)).toEqual([]);
        expect(await runs(viewer, eric.id)).toEqual([]);
    });

    it('Settings → Privacy → Details: Only me hides both from everyone else', async () => {
        const eric = await member();
        const viewer = await member();
        const admin = await member({ admin: true });
        const shop = await business(eric, 'staff');
        const own = await business(eric, 'owner');
        await prisma.profile.update({ where: { userId: eric.id }, data: { privacy: JSON.stringify({ details: 'ONLY_ME' }) } });

        for (const other of [viewer, admin]) {
            expect(await worksAt(other, eric.id)).toEqual([]);
            expect(await runs(other, eric.id)).toEqual([]);
        }
        expect(await worksAt(eric, eric.id)).toEqual([shop.id]);
        expect(await runs(eric, eric.id)).toEqual([own.id]);

        await prisma.profile.update({ where: { userId: eric.id }, data: { privacy: JSON.stringify({ details: 'MEMBERS' }) } });
        expect(await worksAt(viewer, eric.id)).toEqual([shop.id]);
    });
});

describe('switching between "It\'s my business" and "I work there"', () => {
    it('moves the member who added it between running it and being on its team', async () => {
        const eric = await member();
        const ana = await member();
        const listing = await business(eric, 'staff');

        // It's theirs after all: they run it, and aren't listed twice.
        const toOwner = await edit(eric, listing.id, { isOwnBusiness: true, addedAs: '' });
        expect(toOwner.status).toBe(200);
        expect(toOwner.body.addedAs).toBe('');
        expect(await teamOf(eric, listing.id)).toEqual([]);
        expect(await represented(eric)).toEqual([expect.objectContaining({ id: listing.id, role: 'runs' })]);
        expect((await addToTeam(eric, listing.id, ana.id)).status).toBe(201);

        // They work there: on the team, and the people they added stay.
        const toStaff = await edit(eric, listing.id, { isOwnBusiness: true, addedAs: 'STAFF' });
        expect(toStaff.status).toBe(200);
        expect((await teamOf(eric, listing.id)).sort()).toEqual([ana.id, eric.id].sort());
        expect(await represented(eric)).toEqual([expect.objectContaining({ id: listing.id, role: 'team' })]);
        expect((await addToTeam(eric, listing.id, (await member()).id)).status).toBe(403);

        // A recommendation after all: off the team.
        const toCustomer = await edit(eric, listing.id, { isOwnBusiness: false, addedAs: 'STAFF' });
        expect(toCustomer.status).toBe(400);
        expect((await edit(eric, listing.id, { isOwnBusiness: false })).body.addedAs).toBe('');
        expect(await teamOf(eric, listing.id)).toEqual([ana.id]);
        expect(await represented(eric)).toEqual([]);
    });

    it("a recommendation stays one: its recommender can't make it their business or their workplace", async () => {
        const fan = await member();
        const listing = await business(fan, 'customer');

        const staff = await edit(fan, listing.id, { addedAs: 'STAFF' });
        expect(staff.status).toBe(400);
        expect(staff.body.reason).toBe('staff_not_own');
        const both = await edit(fan, listing.id, { isOwnBusiness: true, addedAs: 'STAFF' });
        expect(both.status).toBe(403);
        expect(both.body.reason).toBe('own_business');

        const after = await prisma.directoryListing.findUnique({ where: { id: listing.id } });
        expect(after).toMatchObject({ isOwnBusiness: false, addedAs: '' });
        expect(await teamOf(fan, listing.id)).toEqual([]);
        expect(await represented(fan)).toEqual([]);
    });

    it("only its creator (or an admin) can switch it", async () => {
        const eric = await member();
        const other = await member();
        const listing = await business(eric, 'staff');
        expect((await edit(other, listing.id, { addedAs: '' })).status).toBe(403);
        expect((await prisma.directoryListing.findUnique({ where: { id: listing.id } }))?.addedAs).toBe('STAFF');
    });
});

describe('the owner claims a listing someone who works there added', () => {
    it('the claimer runs it; the member who added it stays on its team and stops editing it', async () => {
        const eric = await member();
        const boss = await member();
        const listing = await business(eric, 'staff');

        const claim = await call('POST', `/api/directory/${listing.id}/claim`, { token: boss.token, body: {} });
        expect(claim.status).toBe(201);
        expect((await call('POST', `/api/directory/transfers/${claim.body.id}/accept`, { token: eric.token })).status).toBe(200);

        const after = await prisma.directoryListing.findUnique({ where: { id: listing.id } });
        expect(after).toMatchObject({ ownerId: boss.id, isOwnBusiness: true, addedAs: '', memberUserId: null });
        expect(await teamOf(boss, listing.id)).toEqual([eric.id]);
        expect(await represented(boss)).toEqual([expect.objectContaining({ id: listing.id, role: 'runs' })]);
        expect(await represented(eric)).toEqual([expect.objectContaining({ id: listing.id, role: 'team' })]);
        expect(await worksAt(boss, eric.id)).toEqual([listing.id]);
        expect((await edit(eric, listing.id, { hours: 'Closed Sundays' })).status).toBe(403);
        // The new owner manages the team now, Eric included.
        expect((await call('DELETE', `/api/directory/${listing.id}/team/${eric.id}`, { token: boss.token })).status).toBe(200);
    });

    it('staff linking the member who runs it keeps the member who added it on the team', async () => {
        const eric = await member();
        const boss = await member();
        const admin = await member({ admin: true });
        const listing = await business(eric, 'staff');

        expect((await edit(admin, listing.id, { memberUserId: boss.id })).status).toBe(200);
        expect(await teamOf(boss, listing.id)).toEqual([eric.id]);
        expect(await represented(boss)).toEqual([expect.objectContaining({ id: listing.id, role: 'runs' })]);
        expect(await represented(eric)).toEqual([expect.objectContaining({ id: listing.id, role: 'team' })]);
    });

    it('a member on its team who takes it over runs it, off the team', async () => {
        const eric = await member();
        const listing = await business(eric, 'staff');
        const offerTo = await member();
        await prisma.listingTeamMember.create({ data: { listingId: listing.id, userId: offerTo.id } });

        const offer = await call('POST', `/api/directory/${listing.id}/transfer`, { token: eric.token, body: { toUserId: offerTo.id } });
        expect((await call('POST', `/api/directory/transfers/${offer.body.id}/accept`, { token: offerTo.token })).status).toBe(200);
        expect(await teamOf(offerTo, listing.id)).toEqual([eric.id]);
        expect(await represented(offerTo)).toEqual([expect.objectContaining({ id: listing.id, role: 'runs' })]);
    });
});

describe('while another member runs it', () => {
    it("the member who added it can't put themselves on its team by saying they work there", async () => {
        const eric = await member();
        const boss = await member();
        const admin = await member({ admin: true });
        const listing = await business(eric, 'owner');
        expect((await edit(admin, listing.id, { memberUserId: boss.id })).status).toBe(200);

        const toStaff = await edit(eric, listing.id, { isOwnBusiness: true, addedAs: 'STAFF' });
        expect(toStaff.status).toBe(403);
        expect(toStaff.body.reason).toBe('runner_linked');
        expect((await prisma.directoryListing.findUnique({ where: { id: listing.id } }))?.addedAs).toBe('');
        expect(await teamOf(boss, listing.id)).toEqual([]);
        expect((await hostEvent(eric, listing.id)).status).toBe(403);
        // The rest of the form still saves (the connection sent as it was).
        expect((await edit(eric, listing.id, { isOwnBusiness: true, addedAs: '', hours: 'Mon–Fri 8–5' })).status).toBe(200);

        // Staff can switch it; the team stays the runner's to choose.
        expect((await edit(admin, listing.id, { addedAs: 'STAFF' })).status).toBe(200);
        expect(await teamOf(boss, listing.id)).toEqual([]);
    });

    it('a member who works there, taken off its team by its runner, stays off it', async () => {
        const eric = await member();
        const boss = await member();
        const admin = await member({ admin: true });
        const listing = await business(eric, 'staff');
        expect((await edit(admin, listing.id, { memberUserId: boss.id })).status).toBe(200);
        expect(await teamOf(boss, listing.id)).toEqual([eric.id]);
        expect((await call('DELETE', `/api/directory/${listing.id}/team/${eric.id}`, { token: boss.token })).status).toBe(200);

        expect((await edit(eric, listing.id, { addedAs: '' })).body.reason).toBe('runner_linked');
        expect((await edit(eric, listing.id, { addedAs: 'STAFF', hours: 'Closed Mondays' })).status).toBe(200);
        expect(await teamOf(boss, listing.id)).toEqual([]);
    });

    it('staff adding a business for another member who runs it, as someone who works there, stays off its team', async () => {
        const admin = await member({ admin: true });
        const boss = await member();
        const res = await call('POST', '/api/directory', {
            token: admin.token,
            body: { type: 'PROVIDER', name: `Biz ${++counter}`, category: 'food', isOwnBusiness: true, addedAs: 'STAFF', memberUserId: boss.id },
        });
        expect(res.status).toBe(201);
        expect(await teamOf(boss, res.body.id)).toEqual([]);
    });

    it('once staff unlink the member who ran it, the member who added it is back on its team; a new runner chooses their own', async () => {
        const eric = await member();
        const boss = await member();
        const boss2 = await member();
        const ana = await member();
        const admin = await member({ admin: true });
        const listing = await business(eric, 'staff');
        expect((await edit(admin, listing.id, { memberUserId: boss.id })).status).toBe(200);
        expect((await addToTeam(boss, listing.id, ana.id)).status).toBe(201);

        expect((await edit(admin, listing.id, { memberUserId: '' })).status).toBe(200);
        expect(await teamOf(eric, listing.id)).toEqual([eric.id]);
        expect(await worksAt(ana, eric.id)).toEqual([listing.id]);

        expect((await edit(admin, listing.id, { memberUserId: boss.id })).status).toBe(200);
        expect((await edit(admin, listing.id, { memberUserId: boss2.id })).status).toBe(200);
        expect(await teamOf(boss2, listing.id)).toEqual([]);
    });
});

describe('a claim on a business nobody ran', () => {
    it('keeps only the member who added it as someone who works there, and tells the new owner', async () => {
        const eric = await member();
        const boss = await member();
        const stranger = await member();
        const admin = await member({ admin: true });
        const listing = await business(eric, 'staff');
        expect((await addToTeam(admin, listing.id, stranger.id)).status).toBe(201);
        expect((await teamOf(eric, listing.id)).sort()).toEqual([eric.id, stranger.id].sort());

        const claim = await call('POST', `/api/directory/${listing.id}/claim`, { token: boss.token, body: {} });
        expect((await call('POST', `/api/directory/transfers/${claim.body.id}/accept`, { token: eric.token })).status).toBe(200);

        expect(await teamOf(boss, listing.id)).toEqual([eric.id]);
        expect((await hostEvent(stranger, listing.id)).status).toBe(403);
        const ericName = (await prisma.profile.findUnique({ where: { userId: eric.id } }))!.name;
        const listingName = (await listingOf(boss, listing.id)).name;
        expect(await notificationsOf(boss)).toContain(`${ericName} is on ${listingName}'s team`);
    });

    it("keeps nobody of a recommendation's team", async () => {
        const fan = await member();
        const boss = await member();
        const helper = await member();
        const admin = await member({ admin: true });
        const listing = await business(fan, 'customer');
        expect((await addToTeam(admin, listing.id, helper.id)).status).toBe(201);

        const claim = await call('POST', `/api/directory/${listing.id}/claim`, { token: boss.token, body: {} });
        expect((await call('POST', `/api/directory/transfers/${claim.body.id}/accept`, { token: fan.token })).status).toBe(200);
        expect(await teamOf(boss, listing.id)).toEqual([]);
        expect((await notificationsOf(boss)).filter((t) => t.includes("'s team"))).toEqual([]);
    });
});

describe('a business nobody runs, named on an event', () => {
    it('its team hears about it', async () => {
        const eric = await member();
        const host = await member();
        const listing = await business(eric, 'staff');
        const res = await call('POST', '/api/events', {
            token: host.token,
            body: {
                title: 'Night Market', description: 'An evening for founders and builders.', startDate: inDays(10), nostrPublish: 'none',
                partners: [{ role: 'SPONSOR', listingId: listing.id }],
            },
        });
        expect(res.status).toBe(201);
        const name = (await listingOf(host, listing.id)).name;
        expect((await notificationsOf(eric)).some((t) => t.endsWith(`added ${name} as a sponsor of Night Market`))).toBe(true);
    });
});

describe("its team's votes", () => {
    it("don't count toward its Trust Score, and a member on it can't review it", async () => {
        const boss = await member();
        const fan = await member();
        const fan2 = await member();
        const listing = await business(boss, 'owner');
        for (const m of [fan, fan2]) {
            const vouch = await call('POST', `/api/directory/${listing.id}/endorse`, { token: m.token, body: { vote: 1 } });
            expect(vouch.status).toBe(201);
        }
        expect((await listingOf(boss, listing.id)).vouchCount).toBe(2);

        // On its team: their vouch stops counting, and they can't vote again.
        expect((await addToTeam(boss, listing.id, fan.id)).status).toBe(201);
        expect((await listingOf(boss, listing.id)).vouchCount).toBe(1);
        const again = await call('POST', `/api/directory/${listing.id}/endorse`, { token: fan.token, body: { vote: 1 } });
        expect(again.status).toBe(403);
        expect(again.body.reason).toBe('team');
        // Even after some other change recomputes it.
        expect((await edit(boss, listing.id, { hours: 'Every day' })).status).toBe(200);
        expect((await listingOf(boss, listing.id)).vouchCount).toBe(1);

        // Off it, it counts again.
        expect((await call('DELETE', `/api/directory/${listing.id}/team/${fan.id}`, { token: fan.token })).status).toBe(200);
        expect((await listingOf(boss, listing.id)).vouchCount).toBe(2);
    });
});
