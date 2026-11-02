/**
 * Inviting members to a proposed meetup: as it's posted, from its page, or
 * by editing it. Each one invited gets one notification; who's invited is
 * for the proposer (and admins) only, and an invite never counts as being
 * in. Real routes against a real SQLite database built from the repo's
 * migrations; Nostr publishing goes nowhere.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const env = vi.hoisted(() => {
    const dir = `${process.env.TMPDIR || '/tmp'}/bies-event-invites-test-${process.pid}-${Date.now()}`;
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
import previewRoutes from '../routes/preview.routes';
import profileRoutes from '../routes/profile.routes';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { createSession, signAccessToken } from '../services/session.service';
import { setFlags } from '../services/featureFlags.service';
import { MAX_INVITES, MAX_INVITES_PER_DAY } from '../services/eventInvites.service';

let server: http.Server;
let base: string;

beforeAll(async () => {
    fs.mkdirSync(env.dir, { recursive: true });
    execSync('npx prisma migrate deploy', { cwd: path.resolve(__dirname, '../..'), env: process.env, stdio: 'pipe' });
    await setFlags({ events: true });
    const app = express();
    app.use(express.json());
    app.use('/api/events', eventRoutes);
    app.use('/api/preview', previewRoutes);
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
async function member(name = '', admin = false): Promise<Member> {
    const shown = name || `Member ${++counter}`;
    const user = await prisma.user.create({
        data: {
            nostrPubkey: getPublicKey(generateSecretKey()),
            role: 'MEMBER', isAdmin: admin, termsVersion: '2026-10', termsAcceptedAt: new Date(),
            profile: { create: { name: shown, avatar: `/uploads/public/${++counter}.jpg` } },
        },
    });
    const session = await createSession(user.id, 'native');
    return { id: user.id, name: shown, token: signAccessToken({ id: user.id, role: 'MEMBER', isAdmin: admin }, session.sessionId) };
}
/** Members who are only invited (no session needed). */
async function people(n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
        const user = await prisma.user.create({
            data: { nostrPubkey: getPublicKey(generateSecretKey()), profile: { create: { name: `Guest ${++counter}` } } },
        });
        ids.push(user.id);
    }
    return ids;
}

const inDays = (d: number, hours = 0) => new Date(Date.now() + d * 86400_000 + hours * 3600_000).toISOString();

/** A meetup proposed for ten days from now, deciding the day before. */
function propose(host: Member, body: Record<string, unknown> = {}) {
    return call('POST', '/api/events', {
        token: host.token,
        body: {
            title: `Hike ${++counter}`, description: '', category: 'MEETUP',
            startDate: inDays(10), decideBy: inDays(9), minAttendees: 3,
            locationName: 'Somewhere nice', ...body,
        },
    });
}

const invite = (who: Member, id: string, userIds: string[]) => call('POST', `/api/events/${id}/invites`, { token: who.token, body: { userIds } });
const join = (who: Member, id: string) => call('POST', `/api/events/${id}/rsvp`, { token: who.token, body: { status: 'GOING' } });
const statusOf = async (eventId: string, userId: string) => (await prisma.eventAttendee.findUnique({ where: { eventId_userId: { eventId, userId } } }))?.status ?? null;
/** The invite notifications a member got for a meetup. */
const invites = (userId: string, eventId: string) => prisma.notification.findMany({
    where: { userId, type: 'EVENT_RSVP', data: { contains: `"eventId":"${eventId}"` }, title: { contains: 'invited you' } },
});
const listed = async (who: Member, id: string) => (await call('GET', '/api/events?upcoming=true&limit=50', { token: who.token })).body.data.find((e: { id: string }) => e.id === id);

describe('inviting as it is posted', () => {
    it('each one invited gets an invite and one notification that opens the meetup', async () => {
        const edwin = await member('Edwin Rivas');
        const [ana, ben] = [await member('Ana'), await member('Ben')];
        const res = await propose(edwin, { title: 'Sunday hike', inviteeIds: [ana.id, ben.id] });
        expect(res.status).toBe(201);
        expect(res.body.invited).toBe(2);
        const id = res.body.id;
        expect(await statusOf(id, ana.id)).toBe('INVITED');
        expect(await statusOf(id, ben.id)).toBe('INVITED');

        const notes = await invites(ana.id, id);
        expect(notes).toHaveLength(1);
        expect(notes[0].title).toBe('Edwin Rivas invited you to "Sunday hike"');
        expect(notes[0].body).toMatch(/^A meetup on \w{3}, \w{3} \d+, \d+:\d{2} [AP]M at Somewhere nice\. Are you in\?$/);
        expect(JSON.parse(notes[0].data)).toMatchObject({ eventId: id, inviterId: edwin.id, status: 'INVITED', link: `/events/${id}` });
        // Still only the proposer is in.
        expect(res.body.goingCount).toBe(1);
    });

    it('a usual event takes no invitees this way', async () => {
        const host = await member();
        const guest = await member();
        const res = await call('POST', '/api/events', {
            token: host.token, body: { title: 'Talk', description: 'About things.', startDate: inDays(5), inviteeIds: [guest.id] },
        });
        expect(res.status).toBe(201);
        expect(await statusOf(res.body.id, guest.id)).toBeNull();
    });
});

describe('inviting from its page', () => {
    it('skips the proposer, repeats, unknown ids, suspended or deleted members, anyone answered, and blocks either way', async () => {
        const host = await member('Host');
        const id = (await propose(host)).body.id;
        const [ok, blocksHost, blockedByHost, banned, gone, going] = [await member(), await member(), await member(), await member(), await member(), await member()];
        await prisma.block.create({ data: { blockerId: blocksHost.id, blockedId: host.id } });
        await prisma.block.create({ data: { blockerId: host.id, blockedId: blockedByHost.id } });
        await prisma.user.update({ where: { id: banned.id }, data: { isBanned: true } });
        await prisma.user.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
        await join(going, id);

        const res = await invite(host, id, [ok.id, ok.id, host.id, 'nobody', blocksHost.id, blockedByHost.id, banned.id, gone.id, going.id]);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ invited: 1, skipped: 7 });
        expect(await statusOf(id, ok.id)).toBe('INVITED');
        for (const who of [blocksHost, blockedByHost, banned, gone]) expect(await statusOf(id, who.id)).toBeNull();
        expect(await statusOf(id, going.id)).toBe('GOING');
        expect(await invites(blocksHost.id, id)).toHaveLength(0);

        // Invited already: not again, and not told twice.
        expect((await invite(host, id, [ok.id])).body).toEqual({ invited: 0, skipped: 1 });
        expect(await invites(ok.id, id)).toHaveLength(1);
    });

    it('only its proposer or an admin, only on a meetup people can still join', async () => {
        const host = await member();
        const other = await member();
        const admin = await member('Admin', true);
        const guest = await member();
        const id = (await propose(host)).body.id;
        expect((await invite(other, id, [guest.id])).status).toBe(403);
        expect(await statusOf(id, guest.id)).toBeNull();
        // An admin's invite is in the admin's name: the proposer didn't send it.
        expect((await invite(admin, id, [guest.id])).body.invited).toBe(1);
        expect((await invites(guest.id, id))[0].title).toMatch(/^Admin invited you to/);

        const usual = await call('POST', '/api/events', { token: host.token, body: { title: 'Talk', description: 'Talk.', startDate: inDays(5) } });
        expect((await invite(host, usual.body.id, [guest.id])).body.reason).toBe('not_a_proposal');

        const late = (await propose(host)).body.id;
        await prisma.event.update({ where: { id: late }, data: { decideBy: new Date(Date.now() - 60_000) } });
        const tooLate = await invite(host, late, [guest.id]);
        expect(tooLate.status).toBe(409);
        expect(tooLate.body.reason).toBe('called_off');

        const off = (await propose(host)).body.id;
        await call('POST', `/api/events/${off}/call-off`, { token: host.token });
        expect((await invite(host, off, [guest.id])).body.reason).toBe('called_off');

        const started = (await propose(host, { minAttendees: 2 })).body.id;
        await join(await member(), started);
        await prisma.event.update({ where: { id: started }, data: { startDate: new Date(Date.now() - 60_000), decideBy: new Date(Date.now() - 3600_000) } });
        expect((await invite(host, started, [guest.id])).body.reason).toBe('started');
        expect((await invite(host, 'nope', [guest.id])).status).toBe(404);
        expect((await invite(host, id, [])).status).toBe(400);
    });

    it('a meetup that is on still takes invites', async () => {
        const host = await member();
        const id = (await propose(host, { minAttendees: 2 })).body.id;
        await join(await member(), id);
        const guest = await member();
        expect((await invite(host, id, [guest.id])).body.invited).toBe(1);
    });

    it('at most a set number waiting per meetup', async () => {
        const host = await member();
        const id = (await propose(host)).body.id;
        const ids = await people(MAX_INVITES + 1);
        expect((await invite(host, id, ids.slice(0, MAX_INVITES))).body.invited).toBe(MAX_INVITES);
        const more = await invite(host, id, ids.slice(MAX_INVITES));
        expect(more.status).toBe(400);
        expect(more.body).toMatchObject({ reason: 'too_many_invites', max: MAX_INVITES, room: 0 });
        expect(await statusOf(id, ids[MAX_INVITES])).toBeNull();
        // Too many at once is refused outright.
        const other = (await propose(host)).body.id;
        expect((await invite(host, other, ids)).status).toBe(400);
        expect(await prisma.eventAttendee.count({ where: { eventId: other, status: 'INVITED' } })).toBe(0);

        // An edit's list is everyone invited, so it can't be longer either; nothing saves.
        const edit = await call('PUT', `/api/events/${id}`, { token: host.token, body: { title: 'Renamed', inviteeIds: ids } });
        expect(edit.status).toBe(400);
        expect((await prisma.event.findUnique({ where: { id } }))!.title).not.toBe('Renamed');
        // Swapping one for another fits.
        const swap = await call('PUT', `/api/events/${id}`, { token: host.token, body: { inviteeIds: ids.slice(1) } });
        expect(swap.status).toBe(200);
        expect(swap.body).toMatchObject({ withdrawn: 1, invited: 1 });
    });
});

describe('who sees an invite', () => {
    it('never counts as in, and nobody but the proposer (and admins) sees who is invited', async () => {
        const host = await member('Edwin Rivas');
        const [ana, ben, carla] = [await member('Ana'), await member('Ben'), await member('Carla')];
        const admin = await member('Admin', true);
        const id = (await propose(host, { minAttendees: 3, inviteeIds: [ana.id, ben.id] })).body.id;

        // Another member: one in (the proposer), no list, no invite of theirs.
        const seen = (await call('GET', `/api/events/${id}`, { token: carla.token })).body;
        expect(seen.goingCount).toBe(1);
        expect(seen.going.map((p: { id: string }) => p.id)).toEqual([host.id]);
        expect(seen.invited).toBeUndefined();
        expect(seen.myInvite).toBeUndefined();
        expect(JSON.stringify(seen)).not.toContain(ana.id);
        const card = await listed(carla, id);
        expect(card.goingCount).toBe(1);
        expect(JSON.stringify(card)).not.toContain(ana.id);
        // The shared preview, and the invitee's profile.
        expect((await call('GET', `/api/preview/events/${id}`)).body.members.going).toBe(1);
        const profile = (await call('GET', `/api/profiles/${ana.id}`, { token: carla.token })).body;
        expect(profile.user.eventRSVPs.map((r: { eventId: string }) => r.eventId)).not.toContain(id);
        const hosts = (await call('GET', `/api/profiles/${host.id}`, { token: carla.token })).body;
        expect(hosts.user.eventRSVPs.map((r: { eventId: string }) => r.eventId)).toContain(id); // going shows

        // The invitee: only that they're invited, and by whom.
        const mine = (await call('GET', `/api/events/${id}`, { token: ana.token })).body;
        expect(mine.invited).toBeUndefined();
        expect(mine.goingCount).toBe(1);
        expect(JSON.stringify(mine)).not.toContain(ben.id);

        // The proposer and admins see the list.
        for (const who of [host, admin]) {
            const theirs = (await call('GET', `/api/events/${id}`, { token: who.token })).body;
            expect(theirs.invited.map((p: { id: string }) => p.id).sort()).toEqual([ana.id, ben.id].sort());
            expect(theirs.invited.find((p: { id: string }) => p.id === ana.id)).toMatchObject({ name: 'Ana', avatar: expect.stringMatching(/^\/uploads\//) });
        }
        // The proposer's own list counts who's going.
        const own = (await call('GET', '/api/events/my', { token: host.token })).body.data.find((e: { id: string }) => e.id === id);
        expect(own).toMatchObject({ goingCount: 1, attendeeCount: 1 });

        // Lowering the number to what's invited doesn't make it go ahead.
        await call('PUT', `/api/events/${id}`, { token: host.token, body: { minAttendees: 2 } });
        expect((await prisma.event.findUnique({ where: { id } }))!.confirmedAt).toBeNull();
    });

    it('the invitee sees who invited them, until they are in; the proposer hears they are', async () => {
        const host = await member('Edwin Rivas');
        const ana = await member('Ana');
        const id = (await propose(host, { inviteeIds: [ana.id] })).body.id;

        const card = await listed(ana, id);
        expect(card.rsvpStatus).toBe('INVITED');
        expect(card.myInvite).toEqual({ by: { id: host.id, name: 'Edwin Rivas', avatar: expect.stringMatching(/^\/uploads\//) } });
        expect((await call('GET', `/api/events/${id}`, { token: ana.token })).body.myInvite.by.name).toBe('Edwin Rivas');

        expect((await join(ana, id)).status).toBe(200);
        expect((await listed(ana, id)).myInvite).toBeUndefined();
        const after = (await call('GET', `/api/events/${id}`, { token: ana.token })).body;
        expect(after).toMatchObject({ rsvpStatus: 'GOING', goingCount: 2 });
        expect(after.myInvite).toBeUndefined();
        // Joining from an invite tells the proposer, as any join does.
        expect(await prisma.notification.count({ where: { userId: host.id, title: { startsWith: 'Ana is in' } } })).toBe(1);
        // And they're no longer on the invite list.
        expect((await call('GET', `/api/events/${id}`, { token: host.token })).body.invited).toEqual([]);
    });

    it('an invite is no place in a full meetup', async () => {
        const host = await member();
        const [a, b] = [await member(), await member()];
        const id = (await propose(host, { minAttendees: 2, maxAttendees: 2, inviteeIds: [a.id, b.id] })).body.id;
        expect((await join(a, id)).body.confirmed).toBe(true);
        const full = await join(b, id);
        expect(full.status).toBe(409);
        expect(full.body.reason).toBe('full');
        expect(await statusOf(id, b.id)).toBe('INVITED');
        // Who's going can still answer again.
        expect((await join(a, id)).status).toBe(200);
    });
});

describe('editing the invite list', () => {
    it('shows who is invited, adds more, and takes back only those who have not joined', async () => {
        const host = await member();
        const [a, b, c, d] = [await member(), await member(), await member(), await member()];
        const id = (await propose(host, { inviteeIds: [a.id, b.id, c.id] })).body.id;
        await join(c, id);
        expect((await call('GET', `/api/events/${id}`, { token: host.token })).body.invited.map((p: { id: string }) => p.id).sort()).toEqual([a.id, b.id].sort());

        // What the form sends: everyone it shows. a is off, d is new; c joined.
        const res = await call('PUT', `/api/events/${id}`, { token: host.token, body: { title: 'Hike, take two', inviteeIds: [b.id, d.id] } });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ withdrawn: 1, invited: 1 });
        expect(await statusOf(id, a.id)).toBeNull();
        expect(await statusOf(id, b.id)).toBe('INVITED');
        expect(await statusOf(id, c.id)).toBe('GOING');
        expect(await statusOf(id, d.id)).toBe('INVITED');
        // Taken back quietly; the new one is told, in the new title.
        expect(await invites(a.id, id)).toHaveLength(1);
        expect(await invites(b.id, id)).toHaveLength(1);
        expect((await invites(d.id, id))[0].title).toMatch(/invited you to "Hike, take two"$/);

        // An edit without the list leaves it alone.
        expect((await call('PUT', `/api/events/${id}`, { token: host.token, body: { title: 'Hike' } })).status).toBe(200);
        expect(await prisma.eventAttendee.count({ where: { eventId: id, status: 'INVITED' } })).toBe(2);
        // Another member's edit can't touch it.
        expect((await call('PUT', `/api/events/${id}`, { token: a.token, body: { inviteeIds: [] } })).status).toBe(403);
        expect(await prisma.eventAttendee.count({ where: { eventId: id, status: 'INVITED' } })).toBe(2);
    });

    it('after the deadline, the list can shrink but not grow', async () => {
        const host = await member();
        const [a, b] = [await member(), await member()];
        const id = (await propose(host, { inviteeIds: [a.id] })).body.id;
        await prisma.event.update({ where: { id }, data: { decideBy: new Date(Date.now() - 60_000) } });
        const grow = await call('PUT', `/api/events/${id}`, { token: host.token, body: { inviteeIds: [a.id, b.id] } });
        expect(grow.status).toBe(409);
        expect(await statusOf(id, b.id)).toBeNull();
        expect((await call('PUT', `/api/events/${id}`, { token: host.token, body: { inviteeIds: [a.id] } })).status).toBe(200);
        expect((await call('PUT', `/api/events/${id}`, { token: host.token, body: { inviteeIds: [] } })).body.withdrawn).toBe(1);
    });
});

describe('the single invite', () => {
    it('still invites to an invite-only event, but not someone in a block with the host', async () => {
        const host = await member();
        const [guest, blocker] = [await member(), await member()];
        const event = await prisma.event.create({
            data: { title: 'Dinner', description: 'x', hostId: host.id, isPublished: true, visibility: 'INVITE_ONLY', startDate: new Date(Date.now() + 86_400_000) },
        });
        expect((await call('POST', `/api/events/${event.id}/invite`, { token: host.token, body: { userId: guest.id } })).status).toBe(201);
        expect(await statusOf(event.id, guest.id)).toBe('INVITED');
        await prisma.block.create({ data: { blockerId: blocker.id, blockedId: host.id } });
        expect((await call('POST', `/api/events/${event.id}/invite`, { token: host.token, body: { userId: blocker.id } })).status).toBe(404);
        expect(await statusOf(event.id, blocker.id)).toBeNull();
    });

    it('on a proposed meetup, as the batch one', async () => {
        const host = await member('Edwin Rivas');
        const guest = await member();
        const id = (await propose(host, { title: 'Sunday hike' })).body.id;
        expect((await call('POST', `/api/events/${id}/invite`, { token: host.token, body: { userId: guest.id } })).status).toBe(201);
        expect((await invites(guest.id, id))[0].title).toBe('Edwin Rivas invited you to "Sunday hike"');
        expect((await call('POST', `/api/events/${id}/invite`, { token: host.token, body: { userId: guest.id } })).status).toBe(409);
    });
});

describe('limits on invites (launch review)', () => {
    it('tells a member about an invite to a meetup once, however often they are invited again', async () => {
        const host = await member();
        const ana = await member('Ana');
        const id = (await propose(host)).body.id;
        for (let round = 0; round < 4; round++) {
            expect((await invite(host, id, [ana.id])).body.invited).toBe(1);
            expect((await call('PUT', `/api/events/${id}`, { token: host.token, body: { inviteeIds: [] } })).status).toBe(200);
        }
        expect(await invites(ana.id, id)).toHaveLength(1);
    });

    it('keeps to 50 waiting when invites arrive at once', async () => {
        const host = await member();
        const id = (await propose(host)).body.id;
        const batches = await Promise.all(Array.from({ length: 5 }, () => people(15)));
        await Promise.all(batches.map((ids) => invite(host, id, ids)));
        expect(await prisma.eventAttendee.count({ where: { eventId: id, status: 'INVITED' } })).toBeLessThanOrEqual(MAX_INVITES);
    });

    it('caps how many members one member invites in a day, across meetups', async () => {
        const host = await member();
        let sent = 0;
        let refused: { status: number; body: any } | null = null;
        for (let i = 0; i < 4 && !refused; i++) {
            const id = (await propose(host)).body.id;
            const res = await invite(host, id, await people(40));
            if (res.status === 200) sent += res.body.invited;
            else refused = res;
        }
        expect(sent).toBeLessThanOrEqual(MAX_INVITES_PER_DAY);
        expect(refused?.status).toBe(400);
        expect(refused?.body.reason).toBe('too_many_today');
    });

    it("an edit form opened before an invite was sent doesn't take it back", async () => {
        const host = await member();
        const [a, b] = [await member(), await member()];
        const id = (await propose(host, { inviteeIds: [a.id] })).body.id;
        // The form opened showing a; meanwhile b is invited from the page.
        await invite(host, id, [b.id]);
        const res = await call('PUT', `/api/events/${id}`, { token: host.token, body: { inviteeIds: [a.id], inviteeIdsShown: [a.id] } });
        expect(res.status).toBe(200);
        expect(await statusOf(id, b.id)).toBe('INVITED');
    });

    it("an admin's invite is in the admin's name", async () => {
        const host = await member('Pat Proposer');
        const admin = await member('Ada Admin', true);
        const guest = await member();
        const id = (await propose(host)).body.id;
        expect((await invite(admin, id, [guest.id])).body.invited).toBe(1);
        expect((await invites(guest.id, id))[0].title).toMatch(/^Ada Admin invited you/);
    });

    it("Can't make it closes the invite, and it isn't sent again", async () => {
        const host = await member();
        const guest = await member();
        const id = (await propose(host, { inviteeIds: [guest.id] })).body.id;
        expect((await call('POST', `/api/events/${id}/rsvp`, { token: guest.token, body: { status: 'NOT_GOING' } })).status).toBe(200);
        expect(await statusOf(id, guest.id)).toBe('NOT_GOING');
        expect((await invite(host, id, [guest.id])).body.invited).toBe(0);
    });

    it("invites from a host in a block, or to a called-off meetup, leave 'invited to'", async () => {
        const host = await member();
        const guest = await member();
        const id = (await propose(host, { inviteeIds: [guest.id] })).body.id;
        const attending = async () => (await call('GET', '/api/events/attending', { token: guest.token })).body.data.map((e: { id: string }) => e.id);
        expect(await attending()).toContain(id);
        await call('POST', `/api/events/${id}/call-off`, { token: host.token });
        expect(await attending()).not.toContain(id);

        const id2 = (await propose(host, { inviteeIds: [guest.id] })).body.id;
        expect(await attending()).toContain(id2);
        await prisma.block.create({ data: { blockerId: guest.id, blockedId: host.id } });
        expect(await attending()).not.toContain(id2);
    });
});
