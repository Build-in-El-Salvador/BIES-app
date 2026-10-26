/**
 * Events as members see them: hosted by a member or as a business or farm
 * they act for (BIES's own page makes it a BIES event), with co-hosts and
 * sponsors; who may edit; what the list shows; and the public preview of a
 * shared event. Real routes against a real SQLite database built from the
 * repo's migrations; Nostr publishing goes nowhere.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const env = vi.hoisted(() => {
    const dir = `${process.env.TMPDIR || '/tmp'}/bies-event-hosts-test-${process.pid}-${Date.now()}`;
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
import eventRoutes from '../routes/events.routes';
import directoryRoutes from '../routes/directory.routes';
import adminRoutes from '../routes/admin.routes';
import moderationRoutes from '../routes/moderation.routes';
import previewRoutes from '../routes/preview.routes';
import { setFlags } from '../services/featureFlags.service';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { createSession, signAccessToken } from '../services/session.service';

let server: http.Server;
let base: string;

beforeAll(async () => {
    fs.mkdirSync(env.dir, { recursive: true });
    execSync('npx prisma migrate deploy', { cwd: path.resolve(__dirname, '../..'), env: process.env, stdio: 'pipe' });
    const app = express();
    app.use(express.json());
    app.use('/api/events', eventRoutes);
    app.use('/api/directory', directoryRoutes);
    app.use('/api/admin', adminRoutes);
    app.use('/api/preview', previewRoutes);
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
    const text = await res.text();
    let json: any = {};
    try { json = JSON.parse(text); } catch { json = {}; }
    return { status: res.status, body: json, text };
}

type Member = { id: string; token: string; name: string };
let counter = 0;
async function member({ admin = false, name = '' } = {}): Promise<Member> {
    const shown = name || `Member ${++counter}`;
    const user = await prisma.user.create({
        data: {
            nostrPubkey: getPublicKey(generateSecretKey()),
            isAdmin: admin, role: admin ? 'ADMIN' : 'MEMBER',
            termsVersion: '2026-10', termsAcceptedAt: new Date(),
            profile: { create: { name: shown } },
        },
    });
    const session = await createSession(user.id, 'native');
    return { id: user.id, name: shown, token: signAccessToken({ id: user.id, role: admin ? 'ADMIN' : 'MEMBER', isAdmin: admin }, session.sessionId) };
}

async function business(poster: Member, own = true, name = '') {
    const res = await call('POST', '/api/directory', {
        token: poster.token,
        body: { type: 'PROVIDER', name: name || `Biz ${++counter}`, category: 'food', isOwnBusiness: own, ...(own ? {} : { review: 'Great coffee and kind people, every time.' }) },
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
}

// Sat 14 Nov 2026, 7:00 PM in El Salvador (UTC-6).
const NIGHT = '2026-11-15T01:00:00.000Z';
const inDays = (d: number) => new Date(Date.now() + d * 86400_000).toISOString();

function event(host: Member, body: Record<string, unknown> = {}) {
    return call('POST', '/api/events', {
        token: host.token,
        body: {
            title: `Event ${++counter}`, description: 'An evening for founders and builders.',
            startDate: inDays(10), nostrPublish: 'none', ...body,
        },
    });
}

describe('who hosts an event', () => {
    it('is for members only; signed out, the API says no', async () => {
        const host = await member();
        const created = await event(host);
        expect((await call('GET', '/api/events')).status).toBe(401);
        expect((await call('GET', `/api/events/${created.body.id}`)).status).toBe(401);
    });

    it('a member hosts as a business they run or are on the team of, never one they only recommended', async () => {
        const owner = await member();
        const teammate = await member();
        const recommender = await member();
        const own = await business(owner, true, 'Café Ruta');
        await call('POST', `/api/directory/${own}/team`, { token: owner.token, body: { userId: teammate.id } });
        const recommended = await business(recommender, false);

        const asOwner = await event(owner, { hostListingId: own });
        expect(asOwner.status).toBe(201);
        expect(asOwner.body.hostListing).toMatchObject({ id: own, name: 'Café Ruta' });
        expect(asOwner.body.hostId).toBe(owner.id);

        expect((await event(teammate, { hostListingId: own })).status).toBe(201);
        const refused = await event(recommender, { hostListingId: recommended });
        expect(refused.status).toBe(403);
        expect(refused.body.reason).toBe('not_your_listing');
    });

    it("hosted as BIES's own page, it's a BIES event; the app can't just say so", async () => {
        const admin = await member({ admin: true });
        const core = await member();
        const bies = await business(core, true, 'Build in El Salvador');
        const earlier = await event(core, { hostListingId: bies });
        expect(earlier.body.isOfficial).toBe(false);

        expect((await call('PUT', `/api/admin/directory/${bies}/official`, { token: core.token, body: { official: true } })).status).toBe(403);
        expect((await call('PUT', `/api/admin/directory/${bies}/official`, { token: admin.token, body: { official: true } })).status).toBe(200);

        const later = await event(core, { hostListingId: bies });
        expect(later.body.isOfficial).toBe(true);
        expect((await call('GET', `/api/events/${earlier.body.id}`, { token: core.token })).body.isOfficial).toBe(true);

        const claimed = await event(core, { isOfficial: true });
        expect(claimed.body.isOfficial).toBe(false);
        const official = (await call('GET', '/api/events?isOfficial=true&upcoming=true', { token: core.token })).body.data.map((e: any) => e.id);
        expect(official).toEqual(expect.arrayContaining([earlier.body.id, later.body.id]));
        expect(official).not.toContain(claimed.body.id);
    });
});

describe('co-hosts and sponsors', () => {
    it('are members, businesses or names, in order; the people named hear about it', async () => {
        const host = await member({ name: 'Mateo Host' });
        const cohost = await member({ name: 'Lucía Cohost' });
        const sponsorOwner = await member();
        const sponsor = await business(sponsorOwner, true, 'Finca El Roble');
        const res = await event(host, {
            title: 'Coffee Cupping',
            partners: [
                { role: 'COHOST', userId: cohost.id },
                { role: 'SPONSOR', listingId: sponsor },
                { role: 'SPONSOR', name: 'Volcán Brewing', url: 'https://volcan.example' },
                { role: 'COHOST', userId: cohost.id },
            ],
        });
        expect(res.status).toBe(201);
        expect(res.body.partners).toEqual([
            expect.objectContaining({ role: 'COHOST', kind: 'member', userId: cohost.id, name: 'Lucía Cohost' }),
            expect.objectContaining({ role: 'SPONSOR', kind: 'listing', listingId: sponsor, name: 'Finca El Roble' }),
            expect.objectContaining({ role: 'SPONSOR', kind: 'other', name: 'Volcán Brewing', url: 'https://volcan.example' }),
        ]);
        const toCohost = await prisma.notification.findFirst({ where: { userId: cohost.id } });
        expect(toCohost?.title).toBe('Mateo Host added you as a co-host of Coffee Cupping');
        const toSponsor = await prisma.notification.findFirst({ where: { userId: sponsorOwner.id } });
        expect(toSponsor?.title).toBe('Mateo Host added Finca El Roble as a sponsor of Coffee Cupping');
        expect(JSON.parse(toSponsor!.data).link).toBe(`/events/${res.body.id}`);
    });

    it('turns away a blocked member, a logo that isn’t yours, and more than 12', async () => {
        const host = await member();
        const blocker = await member();
        await call('POST', '/api/blocks', { token: blocker.token, body: { userId: host.id } });
        expect((await event(host, { partners: [{ role: 'COHOST', userId: blocker.id }] })).body.reason).toBe('blocked');
        expect((await event(host, { partners: [{ role: 'SPONSOR', name: 'X', logo: '/uploads/public/1761400000000-0123456789abcdef0123456789abcdef.jpg' }] })).body.reason).toBe('logo_not_yours');
        const many = Array.from({ length: 13 }, (_, i) => ({ role: 'SPONSOR', name: `Sponsor ${i}` }));
        expect((await event(host, { partners: many })).status).toBe(400);
    });

    it('co-hosts edit it with the host; sponsors and others don’t; only the host side deletes it', async () => {
        const host = await member();
        const cohost = await member();
        const sponsorMember = await member();
        const stranger = await member();
        const created = await event(host, { partners: [{ role: 'COHOST', userId: cohost.id }, { role: 'SPONSOR', userId: sponsorMember.id }] });
        const id = created.body.id;

        expect((await call('PUT', `/api/events/${id}`, { token: cohost.token, body: { title: 'Renamed by co-host' } })).status).toBe(200);
        expect((await call('PUT', `/api/events/${id}`, { token: sponsorMember.token, body: { title: 'Nope' } })).status).toBe(403);
        expect((await call('PUT', `/api/events/${id}`, { token: stranger.token, body: { title: 'Nope' } })).status).toBe(403);
        expect((await call('GET', `/api/events/${id}`, { token: cohost.token })).body).toMatchObject({ canEdit: true, canDelete: false });
        expect((await call('DELETE', `/api/events/${id}`, { token: cohost.token })).status).toBe(403);
        // A co-host can't move it to their own business.
        const theirs = await business(cohost, true);
        expect((await call('PUT', `/api/events/${id}`, { token: cohost.token, body: { hostListingId: theirs } })).status).toBe(403);
        expect((await call('DELETE', `/api/events/${id}`, { token: host.token })).status).toBe(200);
    });

    it("the host business's team edits and deletes it", async () => {
        const owner = await member();
        const teammate = await member();
        const biz = await business(owner, true);
        await call('POST', `/api/directory/${biz}/team`, { token: owner.token, body: { userId: teammate.id } });
        const created = await event(owner, { hostListingId: biz });
        expect((await call('PUT', `/api/events/${created.body.id}`, { token: teammate.token, body: { priceLabel: 'From $25' } })).status).toBe(200);
        expect((await call('GET', '/api/events/my', { token: teammate.token })).body.data.map((e: any) => e.id)).toContain(created.body.id);
        expect((await call('DELETE', `/api/events/${created.body.id}`, { token: teammate.token })).status).toBe(200);
    });

    it('a co-host or sponsor can take their own name off', async () => {
        const host = await member();
        const sponsorMember = await member();
        const stranger = await member();
        const created = await event(host, { partners: [{ role: 'SPONSOR', userId: sponsorMember.id }] });
        const detail = await call('GET', `/api/events/${created.body.id}`, { token: sponsorMember.token });
        expect(detail.body.myPartnerIds).toHaveLength(1);
        const partnerId = detail.body.myPartnerIds[0];
        expect((await call('DELETE', `/api/events/${created.body.id}/partners/${partnerId}`, { token: stranger.token })).status).toBe(403);
        expect((await call('DELETE', `/api/events/${created.body.id}/partners/${partnerId}`, { token: sponsorMember.token })).status).toBe(200);
        expect((await call('GET', `/api/events/${created.body.id}`, { token: host.token })).body.partners).toEqual([]);
    });

    it('an edit that sends one field leaves the rest as they were', async () => {
        const host = await member();
        const created = await event(host, { category: 'WORKSHOP', isOnline: true, onlineUrl: 'https://zoom.example/j/1' });
        await call('PUT', `/api/events/${created.body.id}`, { token: host.token, body: { visibility: 'DRAFT' } });
        expect(await prisma.event.findUniqueOrThrow({ where: { id: created.body.id } })).toMatchObject({ category: 'WORKSHOP', isOnline: true, visibility: 'DRAFT' });
    });
});

describe('who keeps control of an event', () => {
    it("someone who leaves the business's team stops running the events they hosted as it", async () => {
        const owner = await member();
        const mate = await member();
        const biz = await business(owner, true);
        await call('POST', `/api/directory/${biz}/team`, { token: owner.token, body: { userId: mate.id } });
        const created = await event(mate, { hostListingId: biz, ticketUrl: 'https://lu.ma/night' });
        expect(created.status).toBe(201);

        expect((await call('DELETE', `/api/directory/${biz}/team/${mate.id}`, { token: owner.token })).status).toBe(200);
        expect((await call('PUT', `/api/events/${created.body.id}`, { token: mate.token, body: { ticketUrl: 'https://elsewhere.example/pay' } })).status).toBe(403);
        expect((await call('GET', `/api/events/${created.body.id}`, { token: mate.token })).body).toMatchObject({ canEdit: false, canDelete: false });
        expect((await call('DELETE', `/api/events/${created.body.id}`, { token: mate.token })).status).toBe(403);
        expect((await call('PUT', `/api/events/${created.body.id}`, { token: owner.token, body: { title: 'Still ours' } })).status).toBe(200);
    });

    it('co-hosts edit what it is; tickets, money, hosts and who sees it stay with the host side', async () => {
        const host = await member();
        const cohost = await member();
        const extra = await member();
        const created = await event(host, {
            ticketUrl: 'https://lu.ma/night', priceLabel: 'From $25', payoutLightningAddress: 'host@ln.example',
            partners: [{ role: 'COHOST', userId: cohost.id }],
        });
        const id = created.body.id;
        const put = (body: Record<string, unknown>) => call('PUT', `/api/events/${id}`, { token: cohost.token, body });

        expect((await put({ title: 'Renamed', description: 'Better words.' })).status).toBe(200);
        // Sending the same tickets back (as a form does) is fine; changing them isn't.
        expect((await put({ title: 'Renamed again', ticketUrl: 'https://lu.ma/night', priceLabel: 'From $25' })).status).toBe(200);
        for (const body of [
            { ticketUrl: 'https://elsewhere.example/pay' },
            { bitcoinUrl: 'https://elsewhere.example/btc' },
            { payoutLightningAddress: 'cohost@ln.example' },
            { visibility: 'DRAFT' },
            { partners: [{ role: 'COHOST', userId: cohost.id }, { role: 'COHOST', userId: extra.id }] },
        ]) {
            const res = await put(body);
            expect(res.status, JSON.stringify(body)).toBe(403);
            expect(res.body.reason).toBe('host_only');
        }
        const seen = (await call('GET', `/api/events/${id}`, { token: cohost.token })).body;
        expect(seen).toMatchObject({ canEdit: true, canDelete: false, ticketUrl: 'https://lu.ma/night', title: 'Renamed again' });
        expect(seen.payoutLightningAddress).toBeUndefined();
        expect(seen.guestList).toBeUndefined();
    });

    it("saving keeps the co-hosts and sponsors the editor can't see", async () => {
        const host = await member();
        const cohost = await member();
        const sponsorOwner = await member();
        const sponsor = await business(sponsorOwner, true);
        const created = await event(host, { partners: [{ role: 'COHOST', userId: cohost.id }, { role: 'SPONSOR', listingId: sponsor }] });
        await prisma.directoryListing.update({ where: { id: sponsor }, data: { isPublished: false } });

        const res = await call('PUT', `/api/events/${created.body.id}`, { token: host.token, body: { title: 'Typo fixed', partners: [{ role: 'COHOST', userId: cohost.id }] } });
        expect(res.status).toBe(200);
        const rows = await prisma.eventPartner.findMany({ where: { eventId: created.body.id } });
        expect(rows.map((r) => r.listingId || r.userId).sort()).toEqual([cohost.id, sponsor].sort());
    });

    it('only BIES names BIES on an event', async () => {
        const admin = await member({ admin: true });
        const core = await member();
        const stranger = await member();
        const bies = await business(core, true, `BIES Hub ${++counter}`);
        await call('PUT', `/api/admin/directory/${bies}/official`, { token: admin.token, body: { official: true } });

        const res = await event(stranger, { partners: [{ role: 'SPONSOR', listingId: bies }] });
        expect(res.status).toBe(400);
        expect(res.body.reason).toBe('official_listing');
        expect((await event(core, { partners: [{ role: 'SPONSOR', listingId: bies }] })).status).toBe(201);
        expect((await event(admin, { partners: [{ role: 'SPONSOR', listingId: bies }] })).status).toBe(201);
    });

    it("a business that's been taken down shows as neither the host nor BIES", async () => {
        const admin = await member({ admin: true });
        const core = await member({ name: 'Core Person' });
        const viewer = await member();
        const bies = await business(core, true, `BIES Hub ${++counter}`);
        await call('PUT', `/api/admin/directory/${bies}/official`, { token: admin.token, body: { official: true } });
        const title = `Taken down ${Date.now()}`;
        const created = await event(core, { title, hostListingId: bies });
        expect(created.body.isOfficial).toBe(true);

        await prisma.directoryListing.update({ where: { id: bies }, data: { status: 'inactive', isPublished: false } });
        const card = (await call('GET', `/api/events?upcoming=true&isOfficial=false&search=${encodeURIComponent(title)}`, { token: viewer.token })).body.data.find((e: any) => e.id === created.body.id);
        expect(card).toMatchObject({ isOfficial: false, hostListing: null });
        const preview = (await call('GET', `/api/preview/events/${created.body.id}`)).body;
        expect(preview).toMatchObject({ isOfficial: false, host: 'A BIES member' });
    });

    it("My events: co-hosts don't get the guest list or sales; a member who left the team doesn't get its events", async () => {
        const owner = await member();
        const mate = await member();
        const cohost = await member();
        const biz = await business(owner, true);
        await call('POST', `/api/directory/${biz}/team`, { token: owner.token, body: { userId: mate.id } });
        const created = await event(mate, {
            hostListingId: biz, payoutLightningAddress: 'host@ln.example',
            visibility: 'PRIVATE', guestList: [{ name: 'Guest', userId: cohost.id }],
            partners: [{ role: 'COHOST', userId: cohost.id }],
        });
        const mine = async (m: Member) => (await call('GET', '/api/events/my', { token: m.token })).body.data.find((e: any) => e.id === created.body.id);

        const asCohost = await mine(cohost);
        expect(asCohost).toMatchObject({ canDelete: false });
        expect(JSON.stringify(asCohost)).not.toMatch(/host@ln|guestList|revenueSats/);
        expect(await mine(owner)).toMatchObject({ canDelete: true, revenueSats: 0 });

        await call('DELETE', `/api/directory/${biz}/team/${mate.id}`, { token: owner.token });
        expect(await mine(mate)).toBeUndefined();
    });

    it("while its business is down, its runner and team still look after its events; who left doesn't", async () => {
        const owner = await member();
        const mate = await member();
        const gone = await member();
        const biz = await business(owner, true);
        await call('POST', `/api/directory/${biz}/team`, { token: owner.token, body: { userId: mate.id } });
        await call('POST', `/api/directory/${biz}/team`, { token: owner.token, body: { userId: gone.id } });
        const created = await event(gone, { hostListingId: biz });
        await call('DELETE', `/api/directory/${biz}/team/${gone.id}`, { token: owner.token });
        await prisma.directoryListing.update({ where: { id: biz }, data: { status: 'rejected', isPublished: false } });

        for (const m of [owner, mate]) {
            expect((await call('GET', `/api/events/${created.body.id}`, { token: m.token })).body).toMatchObject({ canEdit: true, canDelete: true });
        }
        expect((await call('PUT', `/api/events/${created.body.id}`, { token: gone.token, body: { ticketUrl: 'https://elsewhere.example/pay' } })).status).toBe(403);
        expect((await call('PUT', `/api/events/${created.body.id}`, { token: owner.token, body: { title: 'Still ours' } })).status).toBe(200);
    });

    it("a business that's down with its runner suspended: its team doesn't get its events back", async () => {
        const owner = await member();
        const mate = await member();
        const biz = await business(owner, true);
        await call('POST', `/api/directory/${biz}/team`, { token: owner.token, body: { userId: mate.id } });
        const created = await event(owner, { hostListingId: biz });
        await prisma.user.update({ where: { id: owner.id }, data: { isBanned: true } });
        await prisma.directoryListing.update({ where: { id: biz }, data: { status: 'rejected', isPublished: false } });
        expect((await call('PUT', `/api/events/${created.body.id}`, { token: mate.token, body: { payoutLightningAddress: 'mate@ln.example' } })).status).toBe(403);
    });

    it("co-hosts don't change the online link, and BIES named as a sponsor can't become a co-host", async () => {
        const admin = await member({ admin: true });
        const host = await member();
        const cohost = await member();
        const core = await member();
        const bies = await business(core, true, `BIES Hub ${++counter}`);
        await call('PUT', `/api/admin/directory/${bies}/official`, { token: admin.token, body: { official: true } });
        const created = await event(host, { isOnline: true, onlineUrl: 'https://zoom.example/j/1', partners: [{ role: 'COHOST', userId: cohost.id }] });
        const id = created.body.id;

        const online = await call('PUT', `/api/events/${id}`, { token: cohost.token, body: { onlineUrl: 'https://elsewhere.example/join' } });
        expect(online.status).toBe(403);

        // An admin names BIES as a sponsor; the host can keep it, but not make it a co-host.
        expect((await call('PUT', `/api/events/${id}`, { token: admin.token, body: { partners: [{ role: 'COHOST', userId: cohost.id }, { role: 'SPONSOR', listingId: bies }] } })).status).toBe(200);
        expect((await call('PUT', `/api/events/${id}`, { token: host.token, body: { partners: [{ role: 'COHOST', userId: cohost.id }, { role: 'SPONSOR', listingId: bies }] } })).status).toBe(200);
        const promoted = await call('PUT', `/api/events/${id}`, { token: host.token, body: { partners: [{ role: 'COHOST', userId: cohost.id }, { role: 'COHOST', listingId: bies }] } });
        expect(promoted.status).toBe(400);
        expect(promoted.body.reason).toBe('official_listing');
    });

    it('whoever moves an event off its business is its host from then on', async () => {
        const owner = await member();
        const mate = await member();
        const biz = await business(owner, true);
        await call('POST', `/api/directory/${biz}/team`, { token: owner.token, body: { userId: mate.id } });
        const created = await event(mate, { hostListingId: biz });
        expect((await call('PUT', `/api/events/${created.body.id}`, { token: owner.token, body: { hostListingId: null } })).status).toBe(200);
        expect((await prisma.event.findUniqueOrThrow({ where: { id: created.body.id } })).hostId).toBe(owner.id);
        expect((await call('PUT', `/api/events/${created.body.id}`, { token: mate.token, body: { title: 'Mine?' } })).status).toBe(403);
    });

    it("a teammate can't move off the business an event someone else made", async () => {
        const owner = await member();
        const mate = await member();
        const biz = await business(owner, true);
        await call('POST', `/api/directory/${biz}/team`, { token: owner.token, body: { userId: mate.id } });
        const created = await event(owner, { hostListingId: biz });
        const moved = await call('PUT', `/api/events/${created.body.id}`, { token: mate.token, body: { hostListingId: null } });
        expect(moved.status).toBe(403);
        expect((await prisma.event.findUniqueOrThrow({ where: { id: created.body.id } })).hostListingId).toBe(biz);
    });

    it('an edit reaches the shared preview at once', async () => {
        const host = await member();
        const created = await event(host);
        expect((await call('GET', `/api/preview/events/${created.body.id}`)).status).toBe(200);
        await call('PUT', `/api/events/${created.body.id}`, { token: host.token, body: { visibility: 'DRAFT' } });
        expect((await call('GET', `/api/preview/events/${created.body.id}`)).status).toBe(404);
    });
});

describe('the events list and page', () => {
    it("shows what's still on, past events apart, and no host blocked either way", async () => {
        const host = await member();
        const viewer = await member();
        const blockedHost = await member();
        const tag = `List${Date.now()}`;
        const now = await event(host, { title: `${tag} on now`, startDate: inDays(-0.1), endDate: inDays(0.1) });
        const soon = await event(host, { title: `${tag} soon`, startDate: inDays(3) });
        const done = await event(host, { title: `${tag} done`, startDate: inDays(-3), endDate: inDays(-2.9) });
        const hidden = await event(blockedHost, { title: `${tag} by someone blocked` });
        await call('POST', '/api/blocks', { token: viewer.token, body: { userId: blockedHost.id } });

        const upcoming = (await call('GET', `/api/events?upcoming=true&search=${tag}`, { token: viewer.token })).body.data.map((e: any) => e.id);
        expect(upcoming).toEqual([now.body.id, soon.body.id]);
        const past = (await call('GET', `/api/events?past=true&search=${tag}`, { token: viewer.token })).body.data.map((e: any) => e.id);
        expect(past).toEqual([done.body.id]);
        expect((await call('GET', `/api/events/${hidden.body.id}`, { token: viewer.token })).status).toBe(404);
    });

    it('keeps the guest list, payout address and online link off the list; the guest list for the host only', async () => {
        const host = await member();
        const guest = await member();
        const title = `Invite only ${Date.now()}`;
        const created = await event(host, {
            title, isOnline: true, onlineUrl: 'https://zoom.example/j/2', payoutLightningAddress: 'host@ln.example',
            visibility: 'INVITE_ONLY', guestList: [{ name: 'Guest', userId: guest.id }],
        });
        const list = (await call('GET', `/api/events?upcoming=true&search=${encodeURIComponent(title)}`, { token: guest.token })).body.data.find((e: any) => e.id === created.body.id);
        expect(list).toBeTruthy();
        expect(JSON.stringify(list)).not.toMatch(/zoom\.example|host@ln|guestList/);
        const forGuest = (await call('GET', `/api/events/${created.body.id}`, { token: guest.token })).body;
        expect(forGuest.onlineUrl).toBe('https://zoom.example/j/2');
        expect(forGuest.guestList).toBeUndefined();
        expect(forGuest.payoutLightningAddress).toBeUndefined();
        expect((await call('GET', `/api/events/${created.body.id}`, { token: host.token })).body.guestList).toEqual([{ name: 'Guest', userId: guest.id }]);
    });

    it('takes a Bitcoin payment link beside the ticket link (web links only) and shows it on the list, page and preview', async () => {
        const host = await member();
        const viewer = await member();
        expect((await event(host, { bitcoinUrl: 'javascript:alert(1)' })).status).toBe(400);
        const btc = 'https://pretix.example/bies/btc-night/';
        const title = `Bitcoin Night ${Date.now()}`;
        const created = await event(host, { title, ticketUrl: 'https://lu.ma/btc-night', bitcoinUrl: btc });
        expect(created.status).toBe(201);
        const list = (await call('GET', `/api/events?upcoming=true&search=${encodeURIComponent(title)}`, { token: viewer.token })).body.data.find((e: any) => e.id === created.body.id);
        expect(list).toMatchObject({ ticketUrl: 'https://lu.ma/btc-night', bitcoinUrl: btc });
        expect((await call('GET', `/api/events/${created.body.id}`, { token: viewer.token })).body.bitcoinUrl).toBe(btc);
        expect((await call('GET', `/api/preview/events/${created.body.id}`)).body.bitcoinUrl).toBe(btc);

        expect((await call('PUT', `/api/events/${created.body.id}`, { token: host.token, body: { bitcoinUrl: '' } })).status).toBe(200);
        expect((await call('GET', `/api/events/${created.body.id}`, { token: viewer.token })).body)
            .toMatchObject({ ticketUrl: 'https://lu.ma/btc-night', bitcoinUrl: '' });
    });

    it('a private event: its guests see it and say they\'re going; no one else sees it', async () => {
        const host = await member();
        const guest = await member();
        const other = await member();
        const created = await event(host, { visibility: 'PRIVATE', guestList: [{ name: 'Guest', userId: guest.id }] });
        expect((await call('GET', `/api/events/${created.body.id}`, { token: guest.token })).status).toBe(200);
        expect((await call('POST', `/api/events/${created.body.id}/rsvp`, { token: guest.token, body: { status: 'GOING' } })).status).toBe(200);
        expect((await call('GET', `/api/events/${created.body.id}`, { token: other.token })).status).toBe(404);
        expect((await call('POST', `/api/events/${created.body.id}/rsvp`, { token: other.token, body: { status: 'GOING' } })).status).toBe(404);
    });
});

describe('a shared event, signed out', () => {
    it('previews the date, place, hosts, sponsors and tickets, never the address, online link or who is going', async () => {
        const owner = await member({ name: 'Daniela Owner' });
        const cohost = await member({ name: 'Kevin Cohost' });
        const goer = await member({ name: 'Secret Goer' });
        const biz = await business(owner, true, 'Networking Collective');
        const sponsor = await business(owner, true, 'Tostadores del Volcán');
        const created = await event(owner, {
            title: 'BIES Networking Night', startDate: NIGHT, hostListingId: biz,
            locationName: 'Rooftop venue', locationAddress: 'Calle La Reforma 123, San Benito',
            ticketUrl: 'https://pretix.example/bies/night/', priceLabel: 'From $25',
            partners: [{ role: 'COHOST', userId: cohost.id }, { role: 'SPONSOR', listingId: sponsor }],
        });
        await call('POST', `/api/events/${created.body.id}/rsvp`, { token: goer.token, body: { status: 'GOING' } });

        const res = await call('GET', `/api/preview/events/${created.body.id}`);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            section: 'events', name: 'BIES Networking Night', location: 'Rooftop venue',
            host: 'Networking Collective', cohosts: ['Kevin Cohost'], sponsors: ['Tostadores del Volcán'],
            ticketUrl: 'https://pretix.example/bies/night/', priceLabel: 'From $25',
            members: { address: true, going: 1 },
        });
        expect(res.text).not.toMatch(/Calle La Reforma|Secret Goer|Daniela Owner/);

        const card = await call('GET', `/api/preview/events/${created.body.id}/og`);
        expect(card.text).toContain('content="BIES Networking Night | BIES"');
        expect(card.text).toContain('Sat 14 Nov · 7:00 PM · Rooftop venue');
        expect(card.text).toContain('content="noindex"');
    });

    it('a private event or a draft has no preview, nor any event while events are off', async () => {
        const host = await member();
        const priv = await event(host, { visibility: 'PRIVATE' });
        const draft = await event(host, { visibility: 'DRAFT' });
        expect((await call('GET', `/api/preview/events/${priv.body.id}`)).status).toBe(404);
        expect((await call('GET', `/api/preview/events/${draft.body.id}`)).status).toBe(404);

        const open = await event(host);
        await setFlags({ events: false });
        try {
            expect((await call('GET', `/api/preview/events/${open.body.id}`)).status).toBe(404);
        } finally {
            await setFlags({ events: true });
        }
    });
});
