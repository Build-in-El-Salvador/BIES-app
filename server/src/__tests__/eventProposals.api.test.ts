/**
 * Meetups members propose: one goes ahead once enough members are in by its
 * decide-by time, else it's called off; everyone in is told either way. Where
 * it is can be a business or farm on BIES, whose name, address, map link and
 * photo fill the event's. Real routes against a real SQLite database built
 * from the repo's migrations; Nostr publishing goes nowhere.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const env = vi.hoisted(() => {
    const dir = `${process.env.TMPDIR || '/tmp'}/bies-event-proposals-test-${process.pid}-${Date.now()}`;
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
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { createSession, signAccessToken } from '../services/session.service';
import { MAX_OPEN_PROPOSALS, sweepProposals } from '../services/eventProposals.service';

let server: http.Server;
let base: string;

beforeAll(async () => {
    fs.mkdirSync(env.dir, { recursive: true });
    execSync('npx prisma migrate deploy', { cwd: path.resolve(__dirname, '../..'), env: process.env, stdio: 'pipe' });
    const app = express();
    app.use(express.json());
    app.use('/api/events', eventRoutes);
    app.use('/api/directory', directoryRoutes);
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
async function member(name = ''): Promise<Member> {
    const shown = name || `Member ${++counter}`;
    const user = await prisma.user.create({
        data: {
            nostrPubkey: getPublicKey(generateSecretKey()),
            role: 'MEMBER', termsVersion: '2026-10', termsAcceptedAt: new Date(),
            profile: { create: { name: shown } },
        },
    });
    const session = await createSession(user.id, 'native');
    return { id: user.id, name: shown, token: signAccessToken({ id: user.id, role: 'MEMBER', isAdmin: false }, session.sessionId) };
}

/** A restaurant on BIES, recommended by a member. */
async function restaurant(poster: Member, extra: Record<string, unknown> = {}) {
    const res = await call('POST', '/api/directory', {
        token: poster.token,
        body: {
            type: 'PROVIDER', name: `Parrilla ${++counter}`, category: 'food', isOwnBusiness: false,
            review: 'The best steak in town, every single time.', location: 'San Salvador',
            mapUrl: 'https://maps.app.goo.gl/parrilla', ...extra,
        },
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
}

const inDays = (d: number, hours = 0) => new Date(Date.now() + d * 86400_000 + hours * 3600_000).toISOString();

/** A meetup proposed for ten days from now, deciding the day before. */
function propose(host: Member, body: Record<string, unknown> = {}) {
    return call('POST', '/api/events', {
        token: host.token,
        body: {
            title: `Lunch ${++counter}`, description: '', category: 'MEETUP',
            startDate: inDays(10), decideBy: inDays(9), minAttendees: 3,
            locationName: 'Somewhere nice', ...body,
        },
    });
}

const join = (who: Member, id: string) => call('POST', `/api/events/${id}/rsvp`, { token: who.token, body: { status: 'GOING' } });
const leave = (who: Member, id: string) => call('DELETE', `/api/events/${id}/rsvp`, { token: who.token });
const told = (userId: string, eventId: string, start: string) => prisma.notification.count({
    where: { userId, title: { startsWith: start }, data: { contains: eventId } },
});

describe('proposing a meetup', () => {
    it('is a public meetup by the member, who is the first one in; no description needed', async () => {
        const edwin = await member('Edwin Rivas');
        const res = await propose(edwin, { title: 'Steak lunch' });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ stage: 'proposed', minAttendees: 3, goingCount: 1, visibility: 'PUBLIC', hostListing: null, nostrPublished: false });

        const seen = await call('GET', `/api/events/${res.body.id}`, { token: edwin.token });
        expect(seen.body.rsvpStatus).toBe('GOING');
        expect(seen.body.going.map((p: { id: string }) => p.id)).toEqual([edwin.id]);
        expect(seen.body.decideBy).toBeTruthy();
        expect((await prisma.event.findUnique({ where: { id: res.body.id } }))!.nostrPublish).toBe('none');
    });

    it('a usual event still needs a description', async () => {
        const host = await member();
        const res = await call('POST', '/api/events', { token: host.token, body: { title: 'Talk', description: '  ', startDate: inDays(5) } });
        expect(res.status).toBe(400);
        expect(res.body.reason).toBe('description_missing');
    });

    it('checks the number and the deadline', async () => {
        const host = await member();
        expect((await propose(host, { decideBy: null })).body.reason).toBe('decide_by_missing');
        expect((await propose(host, { decideBy: inDays(-1) })).body.reason).toBe('decide_by_past');
        expect((await propose(host, { decideBy: inDays(11) })).body.reason).toBe('decide_by_after_start');
        expect((await propose(host, { minAttendees: 4, maxAttendees: 3 })).body.reason).toBe('max_below_min');
        expect((await propose(host, { minAttendees: 1 })).status).toBe(400);
        expect((await propose(host, { minAttendees: 51 })).status).toBe(400);
    });

    it('a member can have only a few open at once', async () => {
        const host = await member();
        for (let i = 0; i < MAX_OPEN_PROPOSALS; i++) expect((await propose(host)).status).toBe(201);
        const extra = await propose(host);
        expect(extra.status).toBe(400);
        expect(extra.body.reason).toBe('too_many_proposals');
        // A usual event isn't held back.
        expect((await call('POST', '/api/events', { token: host.token, body: { title: 'Talk', description: 'About things.', startDate: inDays(5) } })).status).toBe(201);
    });

    it('is a member\'s own: not hosted as a business, no co-hosts', async () => {
        const owner = await member();
        const own = await call('POST', '/api/directory', { token: owner.token, body: { type: 'PROVIDER', name: `Own ${++counter}`, category: 'food', isOwnBusiness: true } });
        const other = await member();
        const res = await propose(owner, { hostListingId: own.body.id, partners: [{ role: 'COHOST', userId: other.id }] });
        expect(res.status).toBe(201);
        expect(res.body.hostListing).toBeNull();
        expect(res.body.partners).toEqual([]);
    });
});

describe('tagging where it is', () => {
    it('a business on BIES fills the name, address, map link and photo', async () => {
        const poster = await member();
        const venue = await restaurant(poster, { photo: '/uploads/public/1793000000001-0123456789abcdef0123456789abcdef.jpg' });
        const host = await member();
        const res = await propose(host, { venueListingId: venue, locationName: 'typed', locationMapUrl: '' });
        expect(res.status).toBe(201);
        const row = (await prisma.event.findUnique({ where: { id: res.body.id } }))!;
        expect(row.venueListingId).toBe(venue);
        expect(row.locationName).toMatch(/^Parrilla /);
        expect(row.locationAddress).toBe('San Salvador');
        expect(row.locationMapUrl).toBe('https://maps.app.goo.gl/parrilla');
        expect(row.thumbnail).toBe('/uploads/public/1793000000001-0123456789abcdef0123456789abcdef.jpg');
        expect(res.body.venueListing).toMatchObject({ id: venue, location: 'San Salvador', mapUrl: 'https://maps.app.goo.gl/parrilla' });
    });

    it('the member\'s own map link and photo stay when they gave them', async () => {
        const venue = await restaurant(await member());
        const host = await member();
        const res = await propose(host, { venueListingId: venue, locationMapUrl: 'https://maps.app.goo.gl/mine' });
        const row = (await prisma.event.findUnique({ where: { id: res.body.id } }))!;
        expect(row.locationMapUrl).toBe('https://maps.app.goo.gl/mine');
    });

    it('works on usual events too, and not with a listing that isn\'t up (unless it\'s the member\'s own)', async () => {
        const poster = await member();
        const pending = await restaurant(poster);
        await prisma.directoryListing.update({ where: { id: pending }, data: { status: 'pending-review' } });
        const someone = await member();
        expect((await propose(someone, { venueListingId: pending })).body.reason).toBe('venue_not_found');
        expect((await propose(someone, { venueListingId: 'nope' })).body.reason).toBe('venue_not_found');
        // Its owner may (just added from the meetup): it shows once it's up.
        const mine = await propose(poster, { venueListingId: pending });
        expect(mine.status).toBe(201);
        expect(mine.body.venueListing).toBeNull();

        const live = await restaurant(poster);
        const usual = await call('POST', '/api/events', { token: someone.token, body: { title: 'Dinner', description: 'Dinner.', startDate: inDays(4), venueListingId: live } });
        expect(usual.status).toBe(201);
        expect(usual.body.venueListing?.id).toBe(live);
    });

    it('a place typed in can be tagged later, when it\'s added to Businesses', async () => {
        const host = await member();
        const created = await propose(host, { locationName: 'Tacos El Paisa', locationMapUrl: 'https://maps.app.goo.gl/tacos' });
        const venue = await restaurant(host, { name: 'Tacos El Paisa', mapUrl: '' });
        const tagged = await call('PUT', `/api/events/${created.body.id}`, { token: host.token, body: { venueListingId: venue } });
        expect(tagged.status).toBe(200);
        const row = (await prisma.event.findUnique({ where: { id: created.body.id } }))!;
        expect(row.venueListingId).toBe(venue);
        expect(row.locationMapUrl).toBe('https://maps.app.goo.gl/tacos'); // its own kept: the business has none
        // Another member can't retag it.
        const other = await member();
        expect((await call('PUT', `/api/events/${created.body.id}`, { token: other.token, body: { venueListingId: null } })).status).toBe(403);
    });

    it('a business\'s page lists what it hosts and what\'s on there, nothing else', async () => {
        const poster = await member();
        const venue = await restaurant(poster);
        const elsewhere = await restaurant(poster);
        const host = await member();
        const here = await propose(host, { venueListingId: venue });
        await propose(host, { venueListingId: elsewhere });
        const list = await call('GET', `/api/events?upcoming=true&atListingId=${venue}`, { token: host.token });
        expect(list.body.data.map((e: { id: string }) => e.id)).toEqual([here.body.id]);
    });
});

describe('going ahead', () => {
    it('the moment the number is in, it\'s on, and everyone in is told once', async () => {
        const host = await member();
        const a = await member();
        const b = await member();
        const c = await member();
        const id = (await propose(host)).body.id;

        const first = await join(a, id);
        expect(first.body.confirmed).toBe(false);
        expect((await call('GET', `/api/events/${id}`, { token: a.token })).body.stage).toBe('proposed');
        expect(await told(host.id, id, 'Called off')).toBe(0);

        const second = await join(b, id);
        expect(second.body.confirmed).toBe(true);
        const seen = await call('GET', `/api/events/${id}`, { token: b.token });
        expect(seen.body).toMatchObject({ stage: 'on', goingCount: 3 });
        expect(seen.body.confirmedAt).toBeTruthy();
        for (const who of [host, a, b]) expect(await told(who.id, id, "It's on")).toBe(1);

        // Someone more: still on, nobody told again.
        expect((await join(c, id)).body.confirmed).toBe(false);
        expect(await told(c.id, id, "It's on")).toBe(0);
        expect(await told(host.id, id, "It's on")).toBe(1);

        // Dropping out after: it stays on.
        await leave(a, id);
        await leave(b, id);
        expect((await call('GET', `/api/events/${id}`, { token: host.token })).body.stage).toBe('on');
    });

    it('two joining at once confirm it once', async () => {
        const host = await member();
        const [a, b] = [await member(), await member()];
        const id = (await propose(host)).body.id;
        const both = await Promise.all([join(a, id), join(b, id)]);
        expect(both.filter((r) => r.body.confirmed).length).toBe(1);
        expect(await told(host.id, id, "It's on")).toBe(1);
    });

    it('it moves from the proposals into the events once on', async () => {
        const host = await member();
        const a = await member();
        const id = (await propose(host, { minAttendees: 2 })).body.id;
        const before = (await call('GET', '/api/events?upcoming=true&limit=50', { token: a.token })).body.data.find((e: { id: string }) => e.id === id);
        expect(before.stage).toBe('proposed');
        await join(a, id);
        const after = (await call('GET', '/api/events?upcoming=true&limit=50', { token: a.token })).body.data.find((e: { id: string }) => e.id === id);
        expect(after.stage).toBe('on');
    });

    it('max capacity still holds', async () => {
        const host = await member();
        const id = (await propose(host, { minAttendees: 2, maxAttendees: 2 })).body.id;
        expect((await join(await member(), id)).status).toBe(200);
        expect((await join(await member(), id)).status).toBe(409);
    });
});

describe('editing a proposal', () => {
    it('its proposer can lower the number, and it goes ahead if that\'s met', async () => {
        const host = await member();
        const a = await member();
        const id = (await propose(host, { minAttendees: 4 })).body.id;
        await join(a, id);
        const res = await call('PUT', `/api/events/${id}`, { token: host.token, body: { minAttendees: 2 } });
        expect(res.status).toBe(200);
        expect((await call('GET', `/api/events/${id}`, { token: host.token })).body.stage).toBe('on');
        expect(await told(a.id, id, "It's on")).toBe(1);
    });

    it('checks a new deadline, and leaves the number alone once it\'s on', async () => {
        const host = await member();
        const id = (await propose(host, { minAttendees: 2 })).body.id;
        expect((await call('PUT', `/api/events/${id}`, { token: host.token, body: { decideBy: inDays(12) } })).body.reason).toBe('decide_by_after_start');
        await join(await member(), id);
        await call('PUT', `/api/events/${id}`, { token: host.token, body: { minAttendees: 9, decideBy: inDays(-3) } });
        const row = (await prisma.event.findUnique({ where: { id } }))!;
        expect(row.minAttendees).toBe(2);
        expect(row.confirmedAt).toBeTruthy();
    });

    it('a usual event doesn\'t become one, and others can\'t edit it', async () => {
        const host = await member();
        const usual = await call('POST', '/api/events', { token: host.token, body: { title: 'Talk', description: 'Talk.', startDate: inDays(5) } });
        await call('PUT', `/api/events/${usual.body.id}`, { token: host.token, body: { minAttendees: 3, decideBy: inDays(4) } });
        expect((await prisma.event.findUnique({ where: { id: usual.body.id } }))!.minAttendees).toBeNull();

        const id = (await propose(host)).body.id;
        const other = await member();
        expect((await call('PUT', `/api/events/${id}`, { token: other.token, body: { minAttendees: 2 } })).status).toBe(403);
    });
});

describe('called off', () => {
    it('past its deadline without enough people: called off, everyone in told, gone from the lists', async () => {
        const host = await member();
        const a = await member();
        const late = await member();
        const id = (await propose(host)).body.id;
        await join(a, id);
        await prisma.event.update({ where: { id }, data: { decideBy: new Date(Date.now() - 60_000) } });

        // Too late to join, even before the sweep comes round.
        const tooLate = await join(late, id);
        expect(tooLate.status).toBe(409);
        expect(tooLate.body.reason).toBe('called_off');

        expect(await sweepProposals()).toBeGreaterThanOrEqual(1);
        const seen = await call('GET', `/api/events/${id}`, { token: a.token });
        expect(seen.body.stage).toBe('calledOff');
        for (const who of [host, a]) expect(await told(who.id, id, 'Called off')).toBe(1);
        expect(await told(late.id, id, 'Called off')).toBe(0);

        const list = await call('GET', '/api/events?upcoming=true&limit=50', { token: a.token });
        expect(list.body.data.some((e: { id: string }) => e.id === id)).toBe(false);
        expect((await join(late, id)).status).toBe(409);

        // Once only.
        await sweepProposals();
        expect(await told(host.id, id, 'Called off')).toBe(1);
    });

    it('one that went ahead is never called off', async () => {
        const host = await member();
        const id = (await propose(host, { minAttendees: 2 })).body.id;
        await join(await member(), id);
        await prisma.event.update({ where: { id }, data: { decideBy: new Date(Date.now() - 60_000) } });
        await sweepProposals();
        expect((await prisma.event.findUnique({ where: { id } }))!.calledOffAt).toBeNull();
    });

    it('frees a place in the member\'s open proposals', async () => {
        const host = await member();
        const ids: string[] = [];
        for (let i = 0; i < MAX_OPEN_PROPOSALS; i++) ids.push((await propose(host)).body.id);
        await prisma.event.update({ where: { id: ids[0] }, data: { decideBy: new Date(Date.now() - 60_000) } });
        await sweepProposals();
        expect((await propose(host)).status).toBe(201);
    });
});
