/**
 * Events that repeat (every week, every other week, a weekday of every
 * month): listed once at their next date, merged in among one-off events by
 * it (pages included); in Past only once they're all over; "going" is for
 * one date at a time. Real routes against a real SQLite database built from
 * the repo's migrations; Nostr publishing goes nowhere.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const env = vi.hoisted(() => {
    const dir = `${process.env.TMPDIR || '/tmp'}/bies-event-repeat-test-${process.pid}-${Date.now()}`;
    process.env.DATABASE_URL = `file:${dir}/test.db`;
    process.env.RELAY_WHITELIST_PATH = `${dir}/relay/whitelist.txt`;
    // Event link cards, drawn when a card page (/og) is read, land here, not in the app's uploads.
    process.env.UPLOAD_DIR = `${dir}/uploads`;
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
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { createSession, signAccessToken } from '../services/session.service';
import { endOfDay, nextOccurrence, occurrences } from '../utils/eventRepeat';
import { MAX_REPEATING } from '../controllers/events.controller';

let server: http.Server;
let base: string;

beforeAll(async () => {
    fs.mkdirSync(env.dir, { recursive: true });
    execSync('npx prisma migrate deploy', { cwd: path.resolve(__dirname, '../..'), env: process.env, stdio: 'pipe' });
    const app = express();
    app.use(express.json());
    app.use('/api/events', eventRoutes);
    app.use('/api/preview', previewRoutes);
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

type Member = { id: string; token: string };
let counter = 0;
async function member(): Promise<Member> {
    const user = await prisma.user.create({
        data: {
            nostrPubkey: getPublicKey(generateSecretKey()),
            role: 'MEMBER', termsVersion: '2026-10', termsAcceptedAt: new Date(),
            profile: { create: { name: `Member ${++counter}` } },
        },
    });
    const session = await createSession(user.id, 'native');
    return { id: user.id, token: signAccessToken({ id: user.id, role: 'MEMBER', isAdmin: false }, session.sessionId) };
}

const DAY = 86400_000;
/** `days` from now at a time of day in El Salvador (UTC-6): svAt(-21, '09:00'). */
function svAt(days: number, time: string): Date {
    const day = new Date(Date.now() - 6 * 3600_000 + days * DAY).toISOString().slice(0, 10);
    return new Date(`${day}T${time}:00-06:00`);
}
const iso = (d: Date) => d.toISOString();
/** That day in El Salvador, as the form sends a last day: "2026-11-21". */
const svDay = (days: number) => new Date(Date.now() - 6 * 3600_000 + days * DAY).toISOString().slice(0, 10);

/** An event with a unique word in its title, for searching the list for it. */
async function event(host: Member, tag: string, body: Record<string, unknown>) {
    const res = await call('POST', '/api/events', {
        token: host.token,
        body: { title: `${tag} ${++counter}`, description: 'Fresh produce and coffee.', category: 'MEETUP', ...body },
    });
    expect(res.status).toBe(201);
    return res.body as { id: string; title: string };
}
/**
 * An event that's already over. Posting one is refused (already_over), so it's
 * posted for a date ahead and then given its own dates, as if it had been
 * posted before they passed.
 */
async function pastEvent(host: Member, tag: string, body: Record<string, any>) {
    const created = await event(host, tag, { ...body, startDate: iso(svAt(30, '09:00')), endDate: undefined, repeat: undefined, repeatUntil: undefined });
    await prisma.event.update({
        where: { id: created.id },
        data: {
            startDate: new Date(body.startDate), endDate: body.endDate ? new Date(body.endDate) : null,
            repeat: body.repeat ?? '', repeatUntil: body.repeatUntil ? endOfDay(body.repeatUntil) : null,
        },
    });
    return created;
}
const list = async (who: Member, query: string) => (await call('GET', `/api/events?${query}`, { token: who.token })).body;
const ids = (body: { data: { id: string }[] }) => body.data.map((e) => e.id);

describe('a repeating event in the list', () => {
    it('is one item at its next date, among one-off events by that date, even when it began weeks ago', async () => {
        const host = await member();
        const tag = `market${Date.now()}`;
        // Every week from three weeks ago, 9 AM to 1 PM.
        const first = svAt(-21, '09:00');
        const market = await event(host, tag, { startDate: iso(first), endDate: iso(new Date(first.getTime() + 4 * 3600_000)), repeat: 'WEEKLY' });
        const soon = await event(host, tag, { startDate: iso(svAt(2, '18:00')) });
        const later = await event(host, tag, { startDate: iso(svAt(9, '18:00')) });
        const gone = await pastEvent(host, tag, { startDate: iso(svAt(-3, '18:00')) });

        const next = nextOccurrence({ startDate: first, endDate: new Date(first.getTime() + 4 * 3600_000), repeat: 'WEEKLY' }, new Date())!;
        const upcoming = await list(host, `upcoming=true&search=${tag}`);
        expect(upcoming.pagination.total).toBe(3);
        const card = upcoming.data.find((e: any) => e.id === market.id);
        expect(card).toMatchObject({
            startDate: iso(next.startDate), endDate: iso(next.endDate!),
            repeat: 'WEEKLY', repeatUntil: null, firstStartDate: iso(first),
        });
        // In date order: the market's next date is within the week.
        const expected = [{ id: market.id, at: next.startDate.getTime() }, { id: soon.id, at: svAt(2, '18:00').getTime() }, { id: later.id, at: svAt(9, '18:00').getTime() }]
            .sort((a, b) => a.at - b.at).map((e) => e.id);
        expect(ids(upcoming)).toEqual(expected);
        // Going on for good: never in Past.
        expect(ids(await list(host, `past=true&search=${tag}`))).toEqual([gone.id]);
        // On the host's profile, and with no time filter, once.
        expect(ids(await list(host, `hostId=${host.id}&search=${tag}`)).filter((id) => id === market.id)).toHaveLength(1);
    });

    it('pages through one-off and repeating events as one list', async () => {
        const host = await member();
        const tag = `paged${Date.now()}`;
        await event(host, tag, { startDate: iso(svAt(-30, '10:00')), repeat: 'WEEKLY' });
        await event(host, tag, { startDate: iso(svAt(-40, '11:00')), repeat: 'BIWEEKLY' });
        await event(host, tag, { startDate: iso(svAt(-60, '12:00')), repeat: 'MONTHLY_NTH' });
        for (const days of [1, 3, 5, 8, 12, 20, 33]) await event(host, tag, { startDate: iso(svAt(days, '19:00')) });

        const all = await list(host, `upcoming=true&limit=50&search=${tag}`);
        expect(all.pagination.total).toBe(10);
        const starts = all.data.map((e: any) => new Date(e.startDate).getTime());
        expect(starts).toEqual([...starts].sort((a, b) => a - b));
        for (const limit of [1, 2, 3, 4]) {
            const pages: string[] = [];
            for (let page = 1; page <= Math.ceil(10 / limit); page++) {
                const body = await list(host, `upcoming=true&limit=${limit}&page=${page}&search=${tag}`);
                expect(body.pagination.total).toBe(10);
                expect(body.data.length).toBeLessThanOrEqual(limit);
                pages.push(...ids(body));
            }
            expect(pages).toEqual(ids(all));
        }
    });

    it('goes to Past once its last date is over, at that date, latest first', async () => {
        const host = await member();
        const tag = `ended${Date.now()}`;
        // Every week for three weeks, ending ten days ago.
        const first = svAt(-24, '09:00');
        const until = endOfDay(svAt(-10, '12:00'))!;
        const series = await pastEvent(host, tag, { startDate: iso(first), endDate: iso(new Date(first.getTime() + 3600_000)), repeat: 'WEEKLY', repeatUntil: svDay(-10) });
        const older = await pastEvent(host, tag, { startDate: iso(svAt(-30, '18:00')) });
        const newer = await pastEvent(host, tag, { startDate: iso(svAt(-2, '18:00')) });

        expect(ids(await list(host, `upcoming=true&search=${tag}`))).toEqual([]);
        const past = await list(host, `past=true&search=${tag}`);
        expect(ids(past)).toEqual([newer.id, series.id, older.id]);
        const last = occurrences({ startDate: first, endDate: null, repeat: 'WEEKLY', repeatUntil: until }, first, 10).pop()!;
        expect(past.data[1].startDate).toBe(iso(last.startDate));
        expect(past.data[1].repeatUntil).toBe(iso(until));
    });
});

describe('an event page', () => {
    it('shows the next date and the four from it', async () => {
        const host = await member();
        const first = svAt(-15, '09:00');
        const s = { startDate: first, endDate: new Date(first.getTime() + 4 * 3600_000), repeat: 'BIWEEKLY' };
        const created = await event(host, 'page', { startDate: iso(s.startDate), endDate: iso(s.endDate), repeat: 'BIWEEKLY' });
        const page = (await call('GET', `/api/events/${created.id}`, { token: host.token })).body;
        const dates = occurrences(s, new Date(), 4).map((o) => iso(o.startDate));
        expect(page.startDate).toBe(dates[0]);
        // Each with its key, its times as it is, and whether it's different or called off.
        expect(page.upcomingDates).toEqual(occurrences(s, new Date(), 4).map((o) => ({
            key: iso(o.key), startDate: iso(o.startDate), endDate: iso(o.endDate!), changed: false, calledOff: false,
        })));
        expect(page.occurrence).toBe(dates[0]);
        expect(page.dateChanged).toBe(false);
        expect(page.firstStartDate).toBe(iso(first));
        expect(page.repeat).toBe('BIWEEKLY');
    });

    it('a one-off event has no upcoming dates and answers have no date', async () => {
        const host = await member();
        const guest = await member();
        const created = await event(host, 'oneoff', { startDate: iso(svAt(4, '18:00')) });
        const page = (await call('GET', `/api/events/${created.id}`, { token: host.token })).body;
        expect(page.upcomingDates).toBeUndefined();
        expect(page.repeat).toBe('');
        expect((await call('POST', `/api/events/${created.id}/rsvp`, { token: guest.token, body: { status: 'GOING' } })).status).toBe(200);
        const row = await prisma.eventAttendee.findFirst({ where: { eventId: created.id, userId: guest.id } });
        expect(row!.occurrenceStart).toBeNull();
        expect((await call('GET', `/api/events/${created.id}`, { token: host.token })).body.goingCount).toBe(1);
    });
});

describe('going, one date at a time', () => {
    // Every week from 11 days ago: the next date is in 3 days, whatever the time now.
    async function weekly(host: Member, extra: Record<string, unknown> = {}) {
        const first = svAt(-11, '09:00');
        const created = await event(host, 'rsvp', { startDate: iso(first), endDate: iso(new Date(first.getTime() + 4 * 3600_000)), repeat: 'WEEKLY', ...extra });
        const next = nextOccurrence({ startDate: first, endDate: new Date(first.getTime() + 4 * 3600_000), repeat: 'WEEKLY' }, new Date())!;
        return { id: created.id, next: next.startDate, before: new Date(next.startDate.getTime() - 7 * DAY) };
    }
    const page = (who: Member, id: string) => call('GET', `/api/events/${id}`, { token: who.token }).then((r) => r.body);
    const go = (who: Member, id: string) => call('POST', `/api/events/${id}/rsvp`, { token: who.token, body: { status: 'GOING' } });

    it('an answer is for the next date; after it, the count and my answer start again', async () => {
        const host = await member();
        const guest = await member();
        const { id, next, before } = await weekly(host);
        expect((await go(guest, id)).status).toBe(200);
        const row = await prisma.eventAttendee.findFirst({ where: { eventId: id, userId: guest.id } });
        expect(row!.occurrenceStart!.toISOString()).toBe(iso(next));
        let seen = await page(guest, id);
        expect(seen).toMatchObject({ goingCount: 1, rsvpStatus: 'GOING' });
        expect(seen.going.map((p: { id: string }) => p.id)).toEqual([guest.id]);
        const card = (await list(guest, `upcoming=true&search=${encodeURIComponent(seen.title)}`)).data[0];
        expect(card).toMatchObject({ goingCount: 1, rsvpStatus: 'GOING' });

        // As if that answer was for the date before: it doesn't count for this one.
        await prisma.eventAttendee.update({ where: { id: row!.id }, data: { occurrenceStart: before } });
        seen = await page(guest, id);
        expect(seen).toMatchObject({ goingCount: 0, rsvpStatus: null, going: [] });
        expect((await list(guest, `upcoming=true&search=${encodeURIComponent(seen.title)}`)).data[0]).toMatchObject({ goingCount: 0, rsvpStatus: null });
        // My events show the date I answered for.
        const attending = (await call('GET', '/api/events/attending', { token: guest.token })).body.data.find((e: any) => e.id === id);
        expect(attending.startDate).toBe(iso(before));

        // Going again: the same row, now for the next date.
        expect((await go(guest, id)).status).toBe(200);
        expect(await prisma.eventAttendee.count({ where: { eventId: id, userId: guest.id } })).toBe(1);
        expect(await page(guest, id)).toMatchObject({ goingCount: 1, rsvpStatus: 'GOING' });
    });

    it('a full event is full for one date only', async () => {
        const host = await member();
        const [a, b] = [await member(), await member()];
        const { id, before } = await weekly(host, { maxAttendees: 1 });
        expect((await go(a, id)).status).toBe(200);
        expect((await go(b, id)).body.reason).toBe('full');
        await prisma.eventAttendee.updateMany({ where: { eventId: id, userId: a.id }, data: { occurrenceStart: before } });
        expect((await go(b, id)).status).toBe(200);
        // A's answer for the date before doesn't let A past the limit.
        expect((await go(a, id)).body.reason).toBe('full');
    });

    it('moving the time moves the next date\'s answers with it', async () => {
        const host = await member();
        const guest = await member();
        const { id, next, before } = await weekly(host);
        await go(guest, id);
        const other = await member();
        await go(other, id);
        await prisma.eventAttendee.updateMany({ where: { eventId: id, userId: other.id }, data: { occurrenceStart: before } });

        const first = svAt(-11, '10:00');
        const res = await call('PUT', `/api/events/${id}`, { token: host.token, body: { startDate: iso(first), endDate: iso(new Date(first.getTime() + 4 * 3600_000)) } });
        expect(res.status).toBe(200);
        const moved = new Date(next.getTime() + 3600_000);
        const row = await prisma.eventAttendee.findFirst({ where: { eventId: id, userId: guest.id } });
        expect(row!.occurrenceStart!.toISOString()).toBe(iso(moved));
        expect(await page(guest, id)).toMatchObject({ goingCount: 1, rsvpStatus: 'GOING', startDate: iso(moved) });
        // The answer for the date before stays with it.
        expect((await prisma.eventAttendee.findFirst({ where: { eventId: id, userId: other.id } }))!.occurrenceStart!.toISOString()).toBe(iso(before));
    });

    it('stopping the repeat keeps the next date\'s answers; a one-off made to repeat keeps its own', async () => {
        const host = await member();
        const guest = await member();
        const other = await member();
        const { id, before } = await weekly(host);
        await go(guest, id);
        await go(other, id);
        await prisma.eventAttendee.updateMany({ where: { eventId: id, userId: other.id }, data: { occurrenceStart: before } });
        const next = svAt(5, '09:00');
        const res = await call('PUT', `/api/events/${id}`, { token: host.token, body: { repeat: '', startDate: iso(next), endDate: iso(new Date(next.getTime() + 3600_000)) } });
        expect(res.status).toBe(200);
        expect((await prisma.event.findUnique({ where: { id } }))!.repeat).toBe('');
        const rows = await prisma.eventAttendee.findMany({ where: { eventId: id } });
        expect(rows.map((r) => [r.userId, r.occurrenceStart])).toEqual([[guest.id, null]]);
        const oneOff = await page(guest, id);
        expect(oneOff).toMatchObject({ goingCount: 1, rsvpStatus: 'GOING', repeat: '' });
        expect(oneOff).not.toHaveProperty('upcomingDates');

        // And back: a one-off still ahead whose people are going, made to repeat.
        const again = await call('PUT', `/api/events/${id}`, { token: host.token, body: { repeat: 'WEEKLY' } });
        expect(again.status).toBe(200);
        expect((await prisma.eventAttendee.findFirst({ where: { eventId: id, userId: guest.id } }))!.occurrenceStart!.toISOString()).toBe(iso(next));
        expect(await page(guest, id)).toMatchObject({ goingCount: 1, rsvpStatus: 'GOING' });
    });

    it('"Doesn\'t repeat" as the form sends it (its first date as it was) makes a one-off on the next date, not the first', async () => {
        const host = await member();
        const guest = await member();
        const other = await member();
        const { id, next, before } = await weekly(host);
        await go(guest, id);
        await go(other, id);
        await prisma.eventAttendee.updateMany({ where: { eventId: id, userId: other.id }, data: { occurrenceStart: before } });
        // The form loads the series from its first date and sends it back unchanged.
        const loaded = await page(host, id);
        const res = await call('PUT', `/api/events/${id}`, {
            token: host.token,
            body: { title: loaded.title, description: loaded.description, startDate: loaded.firstStartDate, endDate: loaded.firstEndDate, repeat: '', repeatUntil: null },
        });
        expect(res.status).toBe(200);
        const saved = (await prisma.event.findUnique({ where: { id } }))!;
        expect(saved.repeat).toBe('');
        expect(iso(saved.startDate)).toBe(iso(next));
        expect(iso(saved.endDate!)).toBe(iso(new Date(next.getTime() + 4 * 3600_000)));
        // The next date's answers stay; the one for a date that's over goes.
        const rows = await prisma.eventAttendee.findMany({ where: { eventId: id } });
        expect(rows.map((r) => [r.userId, r.status, r.occurrenceStart])).toEqual([[guest.id, 'GOING', null]]);
        expect(await page(guest, id)).toMatchObject({ goingCount: 1, rsvpStatus: 'GOING', startDate: iso(next) });
        // Still ahead: in Upcoming, not in Past.
        expect(ids(await list(host, `upcoming=true&search=${encodeURIComponent(loaded.title)}`))).toEqual([id]);
        expect(ids(await list(host, `past=true&search=${encodeURIComponent(loaded.title)}`))).toEqual([]);
    });

    it('stopping the repeat keeps a new time sent with the first date', async () => {
        const host = await member();
        const { id, next } = await weekly(host);
        const first = svAt(-11, '10:30');
        const res = await call('PUT', `/api/events/${id}`, { token: host.token, body: { repeat: '', startDate: iso(first), endDate: iso(new Date(first.getTime() + 2 * 3600_000)) } });
        expect(res.status).toBe(200);
        const saved = (await prisma.event.findUnique({ where: { id } }))!;
        const at = new Date(next.getTime() + 90 * 60_000);
        expect(iso(saved.startDate)).toBe(iso(at));
        expect(iso(saved.endDate!)).toBe(iso(new Date(at.getTime() + 2 * 3600_000)));
    });

    it('stopping the repeat keeps an invite-only guest\'s invitation, so they can still say they\'re going', async () => {
        const host = await member();
        const guest = await member();
        const { id, before } = await weekly(host, { visibility: 'INVITE_ONLY' });
        expect((await call('POST', `/api/events/${id}/invite`, { token: host.token, body: { userId: guest.id } })).status).toBe(201);
        await go(guest, id);
        // Their answer was for a date that's over.
        await prisma.eventAttendee.updateMany({ where: { eventId: id, userId: guest.id }, data: { occurrenceStart: before } });
        const loaded = await page(host, id);
        expect((await call('PUT', `/api/events/${id}`, { token: host.token, body: { startDate: loaded.firstStartDate, endDate: loaded.firstEndDate, repeat: '' } })).status).toBe(200);
        const row = await prisma.eventAttendee.findFirst({ where: { eventId: id, userId: guest.id } });
        expect(row).toMatchObject({ status: 'INVITED', occurrenceStart: null });
        expect((await go(guest, id)).status).toBe(200);
    });

    it('stopping the repeat keeps the invitation of a member its host invited, on a public event too', async () => {
        const host = await member();
        const guest = await member();
        const stranger = await member();
        const { id, before } = await weekly(host);
        expect((await call('POST', `/api/events/${id}/invite`, { token: host.token, body: { userId: guest.id } })).status).toBe(201);
        // The invite's notice goes out in the background.
        for (let i = 0; i < 50 && !(await prisma.notification.count({ where: { userId: guest.id } })); i++) await new Promise((r) => setTimeout(r, 20));
        await go(guest, id);
        await go(stranger, id);
        await prisma.eventAttendee.updateMany({ where: { eventId: id }, data: { occurrenceStart: before } });
        expect((await call('PUT', `/api/events/${id}`, { token: host.token, body: { repeat: '' } })).status).toBe(200);
        const rows = await prisma.eventAttendee.findMany({ where: { eventId: id } });
        expect(rows.map((r) => [r.userId, r.status, r.occurrenceStart])).toEqual([[guest.id, 'INVITED', null]]);
    });
});

describe('a monthly event five weeks apart', () => {
    it('once its last date is over, it is in Past straight away (first Saturday: 3 Oct, then 7 Nov 2026)', async () => {
        // Only Date is faked: the HTTP server's own timers keep working.
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            // Monday 5 October 2026, in El Salvador: 3 October was its only date (7 November is after its last day).
            vi.setSystemTime(new Date('2026-10-05T12:00:00-06:00'));
            const host = await member();
            const tag = `firstsat${Date.now()}`;
            const first = new Date('2026-10-03T09:00:00-06:00');
            const series = await pastEvent(host, tag, { startDate: iso(first), endDate: iso(new Date(first.getTime() + 4 * 3600_000)), repeat: 'MONTHLY_NTH', repeatUntil: '2026-11-06' });
            expect(nextOccurrence({ startDate: first, repeat: 'MONTHLY_NTH' }, new Date())!.startDate.toISOString()).toBe(new Date('2026-11-07T09:00:00-06:00').toISOString());
            expect(ids(await list(host, `upcoming=true&search=${tag}`))).toEqual([]);
            const past = await list(host, `past=true&search=${tag}`);
            expect(ids(past)).toEqual([series.id]);
            expect(past.data[0].startDate).toBe(iso(first));
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('repeating events a member can have', () => {
    it(`at most ${MAX_REPEATING} at once; one long over doesn't count, and deleting one makes room`, async () => {
        const host = await member();
        const made: string[] = [];
        // One whose last day was long ago (it's only in Past).
        await pastEvent(host, 'old', { startDate: iso(svAt(-120, '09:00')), repeat: 'WEEKLY', repeatUntil: svDay(-90) });
        for (let i = 0; i < MAX_REPEATING; i++) {
            made.push((await event(host, 'cap', { startDate: iso(svAt(-3 + i, '09:00')), repeat: 'WEEKLY' })).id);
        }
        const more = await call('POST', '/api/events', { token: host.token, body: { title: 'One more', description: 'More.', startDate: iso(svAt(2, '09:00')), repeat: 'BIWEEKLY' } });
        expect(more.status).toBe(400);
        expect(more.body).toMatchObject({ reason: 'too_many_repeating', max: MAX_REPEATING });
        // A one-off is fine; making it repeat isn't.
        const oneOff = await event(host, 'cap', { startDate: iso(svAt(4, '09:00')) });
        expect((await call('PUT', `/api/events/${oneOff.id}`, { token: host.token, body: { repeat: 'WEEKLY' } })).body.reason).toBe('too_many_repeating');
        // Editing one that repeats already is fine.
        expect((await call('PUT', `/api/events/${made[0]}`, { token: host.token, body: { title: 'Renamed' } })).status).toBe(200);
        // Another member isn't held back by this one's.
        const other = await member();
        expect((await call('POST', '/api/events', { token: other.token, body: { title: 'Theirs', description: 'Theirs.', startDate: iso(svAt(2, '09:00')), repeat: 'WEEKLY' } })).status).toBe(201);

        expect((await call('DELETE', `/api/events/${made[0]}`, { token: host.token })).status).toBe(200);
        expect((await call('PUT', `/api/events/${oneOff.id}`, { token: host.token, body: { repeat: 'WEEKLY' } })).status).toBe(200);
    });
});

describe('what a repeat must fit', () => {
    const at = (text: string) => new Date(`${text}:00-06:00`).toISOString();
    const attempt = async (body: Record<string, unknown>) => {
        const host = await member();
        return call('POST', '/api/events', { token: host.token, body: { title: 'Market', description: 'Produce.', ...body } });
    };

    it('the last weekday only from a date in its month\'s last week; never a fifth', async () => {
        expect((await attempt({ startDate: at('2027-03-10T09:00'), repeat: 'MONTHLY_LAST' })).body.reason).toBe('repeat_not_last_week');
        expect((await attempt({ startDate: at('2027-03-27T09:00'), repeat: 'MONTHLY_LAST' })).status).toBe(201);
        // 30 January 2027 is January's fifth Saturday.
        expect((await attempt({ startDate: at('2027-01-30T09:00'), repeat: 'MONTHLY_NTH' })).body.reason).toBe('repeat_fifth_week');
        expect((await attempt({ startDate: at('2027-01-23T09:00'), repeat: 'MONTHLY_NTH' })).status).toBe(201);
        expect((await attempt({ startDate: at('2027-01-23T09:00'), repeat: 'DAILY' })).status).toBe(400);
    });

    it('the last day is on or after the first, and a real day', async () => {
        expect((await attempt({ startDate: at('2027-01-23T09:00'), repeat: 'WEEKLY', repeatUntil: '2027-01-22' })).body.reason).toBe('repeat_until_before_start');
        expect((await attempt({ startDate: at('2027-01-23T09:00'), repeat: 'WEEKLY', repeatUntil: '2027-02-30' })).body.reason).toBe('repeat_until_invalid');
        const ok = await attempt({ startDate: at('2027-01-23T09:00'), repeat: 'WEEKLY', repeatUntil: '2027-01-23' });
        expect(ok.status).toBe(201);
        expect(ok.body.repeatUntil).toBe('2027-01-24T05:59:59.999Z');
        // No repeat, no last day.
        const plain = await attempt({ startDate: at('2027-01-23T09:00'), repeatUntil: '2027-03-01' });
        expect(plain.body.repeatUntil).toBeNull();
    });

    it('a proposed meetup doesn\'t repeat', async () => {
        const host = await member();
        const start = svAt(10, '12:00');
        const proposal = { title: 'Lunch', description: '', startDate: iso(start), decideBy: iso(new Date(start.getTime() - DAY)), minAttendees: 3 };
        expect((await call('POST', '/api/events', { token: host.token, body: { ...proposal, repeat: 'WEEKLY' } })).body.reason).toBe('repeat_on_proposal');
        const made = await call('POST', '/api/events', { token: host.token, body: proposal });
        expect(made.status).toBe(201);
        expect((await call('PUT', `/api/events/${made.body.id}`, { token: host.token, body: { repeat: 'WEEKLY' } })).body.reason).toBe('repeat_on_proposal');
    });

    it('an edit checks the rule against the first date as it will be, and clears the last day with the repeat', async () => {
        const host = await member();
        const created = await event(host, 'edit', { startDate: at('2027-03-27T09:00'), repeat: 'MONTHLY_LAST', repeatUntil: '2027-12-31' });
        // Moving the first date out of the month's last week.
        expect((await call('PUT', `/api/events/${created.id}`, { token: host.token, body: { startDate: at('2027-03-13T09:00') } })).body.reason).toBe('repeat_not_last_week');
        expect((await call('PUT', `/api/events/${created.id}`, { token: host.token, body: { startDate: at('2027-03-13T09:00'), repeat: 'MONTHLY_NTH' } })).status).toBe(200);
        expect((await call('PUT', `/api/events/${created.id}`, { token: host.token, body: { repeat: '' } })).status).toBe(200);
        expect((await prisma.event.findUnique({ where: { id: created.id } }))!.repeatUntil).toBeNull();
    });
});

describe('the shared preview', () => {
    it('shows the next date and how it repeats', async () => {
        const host = await member();
        const first = svAt(-15, '09:00');
        const s = { startDate: first, endDate: new Date(first.getTime() + 4 * 3600_000), repeat: 'BIWEEKLY' };
        const created = await event(host, 'shared', { startDate: iso(s.startDate), endDate: iso(s.endDate), repeat: 'BIWEEKLY' });
        const preview = await call('GET', `/api/preview/events/${created.id}`);
        expect(preview.status).toBe(200);
        expect(preview.body).toMatchObject({ startDate: iso(nextOccurrence(s, new Date())!.startDate), repeat: 'BIWEEKLY' });
        const og = await call('GET', `/api/preview/events/${created.id}/og`);
        const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/El_Salvador', weekday: 'long' }).format(first);
        expect(og.text).toContain(`Every other ${weekday}`);
    });
});
