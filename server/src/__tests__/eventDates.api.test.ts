/**
 * One date of a repeating event, different or called off: "BIES Soccer" at
 * the beach field at 10 AM on one Saturday, no game the next. An edit at a
 * date is for that date only, or for it and every date after; the members
 * going to that date (and only them) are told. Real routes against a real
 * SQLite database built from the repo's migrations; Nostr publishing goes
 * nowhere.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const env = vi.hoisted(() => {
    const dir = `${process.env.TMPDIR || '/tmp'}/bies-event-dates-test-${process.pid}-${Date.now()}`;
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
import { dayName } from '../services/eventDates.service';
import { endOfDay } from '../utils/eventRepeat';

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
/** `days` from now at a time of day in El Salvador (UTC-6). */
function svAt(days: number, time: string): Date {
    const day = new Date(Date.now() - 6 * 3600_000 + days * DAY).toISOString().slice(0, 10);
    return new Date(`${day}T${time}:00-06:00`);
}
const iso = (d: Date) => d.toISOString();

/**
 * "BIES Soccer", every week, 4 to 6 PM at the usual field, from 11 days ago:
 * its next dates are in 3, 10 and 17 days, whatever the time now. `before`
 * is the date before the next (over).
 */
async function soccer(host: Member, extra: Record<string, unknown> = {}) {
    const first = svAt(-11, '16:00');
    const res = await call('POST', '/api/events', {
        token: host.token,
        body: {
            title: `BIES Soccer ${++counter}`, description: 'Five-a-side, all levels.', category: 'MEETUP',
            startDate: iso(first), endDate: iso(svAt(-11, '18:00')), repeat: 'WEEKLY',
            locationName: 'Usual field', locationAddress: 'San Benito', location: 'Usual field, San Benito', ...extra,
        },
    });
    expect(res.status).toBe(201);
    return {
        id: res.body.id as string, title: res.body.title as string,
        next: svAt(3, '16:00'), after: svAt(10, '16:00'), third: svAt(17, '16:00'), before: svAt(-4, '16:00'),
    };
}

/** What the event form sends for a date: everything, as it shows it, plus the changes. */
function formBody(e: { title: string }, key: Date, changes: Record<string, unknown> = {}, scope?: 'date' | 'series') {
    const day = Math.round((key.getTime() - svAt(0, '16:00').getTime()) / DAY);
    return {
        title: e.title, description: 'Five-a-side, all levels.', category: 'MEETUP', visibility: 'PUBLIC',
        startDate: iso(svAt(day, '16:00')), endDate: iso(svAt(day, '18:00')),
        repeat: 'WEEKLY', repeatUntil: null, isOnline: false, onlineUrl: '',
        locationName: 'Usual field', locationAddress: 'San Benito', location: 'Usual field, San Benito', locationMapUrl: '',
        occurrence: iso(key), ...(scope ? { scope } : {}), ...changes,
    };
}

const page = (who: Member, id: string) => call('GET', `/api/events/${id}`, { token: who.token }).then((r) => r.body);
const go = (who: Member, id: string) => call('POST', `/api/events/${id}/rsvp`, { token: who.token, body: { status: 'GOING' } });
/** The notifications about one of an event's dates a member got (not "X is going" and the like). */
const notes = (userId: string, eventId: string) => prisma.notification.findMany({
    where: { userId, AND: [{ data: { contains: eventId } }, { data: { contains: '"DATE_' } }] }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
});

describe('one date only', () => {
    it('keeps that date\'s own time and place; the rest of the edit is the event\'s; who\'s going to it is told', async () => {
        const host = await member();
        const [guest, earlier] = [await member(), await member()];
        const e = await soccer(host);
        await go(guest, e.id);
        await go(earlier, e.id);
        await prisma.eventAttendee.updateMany({ where: { eventId: e.id, userId: earlier.id }, data: { occurrenceStart: e.before } });

        const res = await call('PUT', `/api/events/${e.id}`, {
            token: host.token,
            body: formBody(e, e.next, {
                startDate: iso(svAt(3, '10:00')), endDate: iso(svAt(3, '12:00')),
                locationName: 'Beach field', location: 'Beach field, San Benito', thumbnail: '/uploads/soccer.jpg',
            }, 'date'),
        });
        expect(res.status).toBe(200);
        const row = await prisma.eventDateChange.findUnique({ where: { eventId_occurrenceStart: { eventId: e.id, occurrenceStart: e.next } } });
        expect(row).toMatchObject({ startDate: svAt(3, '10:00'), endDate: svAt(3, '12:00'), locationName: 'Beach field', title: null, locationAddress: null });
        const series = (await prisma.event.findUnique({ where: { id: e.id } }))!;
        expect(series).toMatchObject({ locationName: 'Usual field', location: 'Usual field, San Benito', thumbnail: '/uploads/soccer.jpg', startDate: svAt(-11, '16:00') });

        // Its page: the date as it is, how it differs, and its dates.
        const seen = await page(guest, e.id);
        expect(seen).toMatchObject({
            startDate: iso(svAt(3, '10:00')), endDate: iso(svAt(3, '12:00')), occurrence: iso(e.next), dateChanged: true,
            locationName: 'Beach field', location: 'Beach field, San Benito', rsvpStatus: 'GOING', goingCount: 1,
        });
        expect(seen.dateChange).toMatchObject({
            key: iso(e.next), time: true, place: true, title: false, details: false,
            date: { startDate: iso(svAt(3, '10:00')), locationName: 'Beach field' },
            usual: { startDate: iso(e.next), endDate: iso(svAt(3, '18:00')), locationName: 'Usual field' },
        });
        expect(seen.upcomingDates.map((d: any) => [d.key, d.startDate, d.changed, d.calledOff])).toEqual([
            [iso(e.next), iso(svAt(3, '10:00')), true, false],
            [iso(e.after), iso(e.after), false, false],
            [iso(e.third), iso(e.third), false, false],
            [iso(svAt(24, '16:00')), iso(svAt(24, '16:00')), false, false],
        ]);
        // The list shows the same.
        const card = (await call('GET', `/api/events?upcoming=true&search=${encodeURIComponent(e.title)}`, { token: guest.token })).body.data[0];
        expect(card).toMatchObject({ startDate: iso(svAt(3, '10:00')), dateChanged: true, locationName: 'Beach field', occurrence: iso(e.next) });

        // Told: the member going to that date, not one going to another, not whoever changed it.
        const told = await notes(guest.id, e.id);
        expect(told.map((n) => [n.title, n.body])).toEqual([[`${e.title}: ${dayName(e.next)} changed`, '10:00 AM at Beach field (usually 4:00 PM at Usual field)']]);
        expect(JSON.parse(told[0].data)).toMatchObject({ eventId: e.id, status: 'DATE_CHANGED', occurrence: iso(e.next) });
        expect(await notes(earlier.id, e.id)).toHaveLength(0);
        expect(await notes(host.id, e.id)).toHaveLength(0);
    });

    it('says only what this edit changed, and drops what\'s back to usual', async () => {
        const host = await member();
        const guest = await member();
        const e = await soccer(host);
        await go(guest, e.id);
        const key = { eventId_occurrenceStart: { eventId: e.id, occurrenceStart: e.next } };
        const edit = (changes: Record<string, unknown>) => call('PUT', `/api/events/${e.id}`, { token: host.token, body: formBody(e, e.next, changes, 'date') });

        // Time only.
        expect((await edit({ startDate: iso(svAt(3, '10:00')), endDate: iso(svAt(3, '12:00')) })).status).toBe(200);
        // Then the place only (the form sends the date's time as it shows it).
        expect((await edit({ startDate: iso(svAt(3, '10:00')), endDate: iso(svAt(3, '12:00')), locationName: 'Park', location: 'Park, San Benito' })).status).toBe(200);
        // Then the time back to usual.
        expect((await edit({ locationName: 'Park', location: 'Park, San Benito' })).status).toBe(200);
        expect(await prisma.eventDateChange.findUnique({ where: key })).toMatchObject({ startDate: null, endDate: null, locationName: 'Park' });
        // Then the words only.
        expect((await edit({ locationName: 'Park', description: 'Bring water: it\'s hot.' })).status).toBe(200);
        // Then all back to usual: nothing of its own left.
        expect((await edit({})).status).toBe(200);
        expect(await prisma.eventDateChange.findUnique({ where: key })).toBeNull();
        // Saving the date as it is says nothing.
        expect((await edit({})).status).toBe(200);

        expect((await notes(guest.id, e.id)).map((n) => n.body)).toEqual([
            '10:00 AM (usually 4:00 PM)',
            'At Park (usually at Usual field)',
            'Back to the usual time, 4:00 PM',
            'Details changed',
            // Place and words back to usual: only the place is said.
            'Back at Usual field',
        ]);
        expect((await page(guest, e.id)).dateChanged).toBe(false);
    });

    it('a date moves only between the dates either side of it, and only one that isn\'t over', async () => {
        const host = await member();
        const e = await soccer(host);
        const edit = (key: Date, changes: Record<string, unknown>, scope: 'date' | 'series' = 'date') => call('PUT', `/api/events/${e.id}`, { token: host.token, body: formBody(e, key, changes, scope) });
        expect((await edit(e.next, { startDate: iso(svAt(10, '16:00')), endDate: iso(svAt(10, '18:00')) })).body.reason).toBe('date_out_of_order');
        expect((await edit(e.next, { startDate: iso(svAt(4, '10:00')), endDate: iso(svAt(4, '09:00')) })).body.reason).toBe('date_end_before_start');
        // Another day the same week is fine: Sunday.
        expect((await edit(e.next, { startDate: iso(svAt(4, '10:00')), endDate: iso(svAt(4, '12:00')) })).status).toBe(200);
        expect((await edit(svAt(3, '15:00'), {})).body.reason).toBe('date_not_found');
        expect((await edit(e.before, {})).status).toBe(409);
        // A later date can be changed on its own too.
        expect((await edit(e.after, { locationName: 'Beach field' })).status).toBe(200);
        // But only the next date changes the dates after it.
        expect((await edit(e.after, { title: 'BIES Football' }, 'series')).body.reason).toBe('date_not_next');
    });

    it('a co-host can change one date; a change to how it repeats is for every date', async () => {
        const host = await member();
        const cohost = await member();
        const e = await soccer(host, {});
        await prisma.eventPartner.create({ data: { eventId: e.id, role: 'COHOST', userId: cohost.id } });
        const asCohost = formBody(e, e.next, { locationName: 'Beach field' }, 'date');
        for (const f of ['visibility', 'isOnline', 'onlineUrl']) delete (asCohost as Record<string, unknown>)[f];
        expect((await call('PUT', `/api/events/${e.id}`, { token: cohost.token, body: asCohost })).status).toBe(200);
        expect((await page(host, e.id)).locationName).toBe('Beach field');

        const rule = await call('PUT', `/api/events/${e.id}`, { token: host.token, body: formBody(e, e.next, { repeat: 'BIWEEKLY', locationName: 'Beach field' }, 'date') });
        expect(rule.status).toBe(200);
        const series = (await prisma.event.findUnique({ where: { id: e.id }, include: { dateChanges: true } }))!;
        // Every other week from the next date: that date is still one of its
        // dates, so it keeps its own place (the form sent it as it showed it).
        expect(series).toMatchObject({ repeat: 'BIWEEKLY', startDate: e.next });
        expect(series.dateChanges.map((c) => [iso(c.occurrenceStart), c.locationName])).toEqual([[iso(e.next), 'Beach field']]);
    });
});

describe('this date and every date after', () => {
    it('with the same dates: the event changes from the next date, and later dates keep what they had', async () => {
        const host = await member();
        const e = await soccer(host);
        await call('PUT', `/api/events/${e.id}`, { token: host.token, body: formBody(e, e.next, { startDate: iso(svAt(3, '10:00')), endDate: iso(svAt(3, '12:00')), locationName: 'Beach field', location: 'Beach field, San Benito' }, 'date') });
        await call('PUT', `/api/events/${e.id}`, { token: host.token, body: formBody(e, e.after, { locationName: 'Park', location: 'Park, San Benito' }, 'date') });

        // The form shows the next date as it is (10 AM at the beach), with a new title.
        const res = await call('PUT', `/api/events/${e.id}`, {
            token: host.token,
            body: formBody(e, e.next, { title: 'BIES Football', startDate: iso(svAt(3, '10:00')), endDate: iso(svAt(3, '12:00')), locationName: 'Beach field', location: 'Beach field, San Benito' }, 'series'),
        });
        expect(res.status).toBe(200);
        const series = (await prisma.event.findUnique({ where: { id: e.id }, include: { dateChanges: { orderBy: { occurrenceStart: 'asc' } } } }))!;
        // Its dates don't move (its first date stays), at the usual time and place: what was that date's own stays its own.
        expect(series).toMatchObject({ title: 'BIES Football', startDate: svAt(-11, '16:00'), endDate: svAt(-11, '18:00'), locationName: 'Usual field', location: 'Usual field, San Benito' });
        expect(series.dateChanges.map((c) => [iso(c.occurrenceStart), c.locationName, c.startDate && iso(c.startDate)])).toEqual([
            [iso(e.next), 'Beach field', iso(svAt(3, '10:00'))],
            [iso(e.after), 'Park', null],
        ]);
        expect((await page(host, e.id)).title).toBe('BIES Football');
    });

    it('a date\'s own value edited for every date is the event\'s from then on', async () => {
        const host = await member();
        const e = await soccer(host);
        await call('PUT', `/api/events/${e.id}`, { token: host.token, body: formBody(e, e.next, { title: 'Soccer: final', locationName: 'Beach field' }, 'date') });
        const res = await call('PUT', `/api/events/${e.id}`, { token: host.token, body: formBody(e, e.next, { title: 'BIES Football', locationName: 'Beach field' }, 'series') });
        expect(res.status).toBe(200);
        const row = await prisma.eventDateChange.findUnique({ where: { eventId_occurrenceStart: { eventId: e.id, occurrenceStart: e.next } } });
        // The title is the event's now; the place stays that date's.
        expect(row).toMatchObject({ title: null, locationName: 'Beach field' });
        expect((await prisma.event.findUnique({ where: { id: e.id } }))!.title).toBe('BIES Football');
    });

    it('a new time moves every date: their changes and call-offs move with them, the next date\'s answers too, and who\'s going is told', async () => {
        const host = await member();
        const [guest, earlier] = [await member(), await member()];
        const e = await soccer(host);
        await go(guest, e.id);
        await go(earlier, e.id);
        await prisma.eventAttendee.updateMany({ where: { eventId: e.id, userId: earlier.id }, data: { occurrenceStart: e.before } });
        await call('PUT', `/api/events/${e.id}`, { token: host.token, body: formBody(e, e.after, { locationName: 'Park' }, 'date') });
        await call('POST', `/api/events/${e.id}/dates/call-off`, { token: host.token, body: { occurrence: iso(e.third) } });
        // A change from before the next date (over) stays, unseen.
        await prisma.eventDateChange.create({ data: { eventId: e.id, occurrenceStart: e.before, locationName: 'Old field' } });

        const res = await call('PUT', `/api/events/${e.id}`, {
            token: host.token, body: formBody(e, e.next, { startDate: iso(svAt(3, '17:00')), endDate: iso(svAt(3, '19:00')) }, 'series'),
        });
        expect(res.status).toBe(200);
        const series = (await prisma.event.findUnique({ where: { id: e.id }, include: { dateChanges: { orderBy: { occurrenceStart: 'asc' } } } }))!;
        expect(series).toMatchObject({ startDate: svAt(3, '17:00'), endDate: svAt(3, '19:00') });
        // The date after keeps its own place, the third stays called off, each at the new time; the one that's over stays.
        expect(series.dateChanges.map((c) => [iso(c.occurrenceStart), c.locationName, !!c.calledOffAt])).toEqual([
            [iso(e.before), 'Old field', false],
            [iso(svAt(10, '17:00')), 'Park', false],
            [iso(svAt(17, '17:00')), null, true],
        ]);
        expect((await prisma.eventAttendee.findFirst({ where: { eventId: e.id, userId: guest.id } }))!.occurrenceStart).toEqual(svAt(3, '17:00'));
        expect((await prisma.eventAttendee.findFirst({ where: { eventId: e.id, userId: earlier.id } }))!.occurrenceStart).toEqual(e.before);
        const seen = await page(guest, e.id);
        expect(seen).toMatchObject({ startDate: iso(svAt(3, '17:00')), occurrence: iso(svAt(3, '17:00')), goingCount: 1, rsvpStatus: 'GOING' });
        expect(seen.upcomingDates.slice(0, 3).map((d: any) => [d.key, d.changed, d.calledOff])).toEqual([
            [iso(svAt(3, '17:00')), false, false],
            [iso(svAt(10, '17:00')), true, false],
            [iso(svAt(17, '17:00')), false, true],
        ]);
        // Who's going to the next date hears its new time; no one else.
        expect((await notes(guest.id, e.id)).map((n) => [n.title, n.body])).toEqual([[`${e.title}: ${dayName(e.next)} changed`, 'Now 5:00 PM (was 4:00 PM)']]);
        expect(await notes(earlier.id, e.id)).toHaveLength(0);
        expect(await notes(host.id, e.id)).toHaveLength(0);
    });

    it('with no scope, as before: the dates as a whole', async () => {
        const host = await member();
        const e = await soccer(host);
        const res = await call('PUT', `/api/events/${e.id}`, { token: host.token, body: formBody(e, e.next, { title: 'BIES Football' }) });
        expect(res.status).toBe(200);
        expect((await prisma.event.findUnique({ where: { id: e.id } }))!.title).toBe('BIES Football');
        expect(await prisma.eventDateChange.count({ where: { eventId: e.id } })).toBe(0);
    });
});

describe('calling off one date', () => {
    it('the event goes on at the date after; who\'s going to it is told, and again when it\'s back', async () => {
        const host = await member();
        const [guest, other] = [await member(), await member()];
        const e = await soccer(host);
        await go(guest, e.id);
        await go(other, e.id);
        await prisma.eventAttendee.updateMany({ where: { eventId: e.id, userId: other.id }, data: { occurrenceStart: e.before } });

        expect((await call('POST', `/api/events/${e.id}/dates/call-off`, { token: host.token, body: { occurrence: iso(e.next) } })).body).toEqual({ calledOff: true });
        const seen = await page(guest, e.id);
        expect(seen).toMatchObject({ startDate: iso(e.after), occurrence: iso(e.after), rsvpStatus: null, goingCount: 0 });
        expect(seen.upcomingDates.slice(0, 2).map((d: any) => [d.key, d.calledOff])).toEqual([[iso(e.next), true], [iso(e.after), false]]);
        const card = (await call('GET', `/api/events?upcoming=true&search=${encodeURIComponent(e.title)}`, { token: guest.token })).body.data[0];
        expect(card.startDate).toBe(iso(e.after));
        // Saying they're going now is for the date after.
        await go(other, e.id);
        expect((await prisma.eventAttendee.findFirst({ where: { eventId: e.id, userId: other.id } }))!.occurrenceStart).toEqual(e.after);

        expect((await notes(guest.id, e.id)).map((n) => [n.title, n.body])).toEqual([[`${e.title}: ${dayName(e.next)} is called off`, `It's back on ${dayName(e.after)}.`]]);
        expect(await notes(other.id, e.id)).toHaveLength(0);
        // Again: nothing more happens.
        expect((await call('POST', `/api/events/${e.id}/dates/call-off`, { token: host.token, body: { occurrence: iso(e.next) } })).status).toBe(200);
        expect(await notes(guest.id, e.id)).toHaveLength(1);

        expect((await call('POST', `/api/events/${e.id}/dates/restore`, { token: host.token, body: { occurrence: iso(e.next) } })).body).toEqual({ calledOff: false });
        expect(await prisma.eventDateChange.count({ where: { eventId: e.id } })).toBe(0);
        expect(await page(guest, e.id)).toMatchObject({ startDate: iso(e.next), rsvpStatus: 'GOING', goingCount: 1 });
        expect((await notes(guest.id, e.id)).map((n) => [n.title, n.body]).pop()).toEqual([`${e.title}: ${dayName(e.next)} is back on`, 'It\'s on after all: 4:00 PM at Usual field.']);
    });

    it('a changed date called off and back keeps its change', async () => {
        const host = await member();
        const e = await soccer(host);
        await call('PUT', `/api/events/${e.id}`, { token: host.token, body: formBody(e, e.next, { locationName: 'Beach field' }, 'date') });
        await call('POST', `/api/events/${e.id}/dates/call-off`, { token: host.token, body: { occurrence: iso(e.next) } });
        await call('POST', `/api/events/${e.id}/dates/restore`, { token: host.token, body: { occurrence: iso(e.next) } });
        expect(await prisma.eventDateChange.findFirst({ where: { eventId: e.id } })).toMatchObject({ locationName: 'Beach field', calledOffAt: null });
    });

    it('is the host side\'s, for a date of a repeating event that hasn\'t started', async () => {
        const host = await member();
        const [cohost, stranger] = [await member(), await member()];
        const e = await soccer(host);
        await prisma.eventPartner.create({ data: { eventId: e.id, role: 'COHOST', userId: cohost.id } });
        const off = (who: Member, id: string, occurrence: string) => call('POST', `/api/events/${id}/dates/call-off`, { token: who.token, body: { occurrence } });
        expect((await off(cohost, e.id, iso(e.next))).status).toBe(403);
        expect((await off(stranger, e.id, iso(e.next))).status).toBe(403);
        expect((await off(host, e.id, iso(svAt(3, '15:00')))).body.reason).toBe('date_not_found');
        expect((await off(host, e.id, iso(e.before))).body.reason).toBe('started');
        expect((await call('POST', `/api/events/${e.id}/dates/call-off`, { token: host.token, body: {} })).status).toBe(400);
        // On now: started.
        const now = await call('POST', '/api/events', {
            token: host.token,
            body: { title: 'Now', description: 'On now.', startDate: iso(new Date(Date.now() - 3600_000)), endDate: iso(new Date(Date.now() + 3600_000)), repeat: 'WEEKLY' },
        });
        expect((await off(host, now.body.id, now.body.occurrence)).body.reason).toBe('started');
        // A one-off has no dates to call off.
        const oneOff = await call('POST', '/api/events', { token: host.token, body: { title: 'Once', description: 'Once.', startDate: iso(svAt(5, '18:00')) } });
        expect((await off(host, oneOff.body.id, iso(svAt(5, '18:00')))).body.reason).toBe('not_repeating');
    });
});

describe('lists and previews', () => {
    it('sort by the date as it is, and page through exactly', async () => {
        const host = await member();
        const tag = `dated${Date.now()}`;
        // Moved early on its next date: 8 AM, before a one-off at noon that day.
        const early = await soccer(host, { title: `${tag} early` });
        await call('PUT', `/api/events/${early.id}`, { token: host.token, body: formBody(early, early.next, { title: `${tag} early`, startDate: iso(svAt(3, '08:00')), endDate: iso(svAt(3, '09:00')) }, 'date') });
        // Its next date called off: listed at the one after, in 10 days.
        const off = await soccer(host, { title: `${tag} off` });
        await call('POST', `/api/events/${off.id}/dates/call-off`, { token: host.token, body: { occurrence: iso(off.next) } });
        const oneOff = async (days: number, time: string) => (await call('POST', '/api/events', { token: host.token, body: { title: `${tag} ${days}`, description: 'Once.', startDate: iso(svAt(days, time)) } })).body.id;
        const noon = await oneOff(3, '12:00');
        const fifth = await oneOff(5, '12:00');
        const twelfth = await oneOff(12, '12:00');

        const all = (await call('GET', `/api/events?upcoming=true&limit=50&search=${tag}`, { token: host.token })).body;
        expect(all.data.map((x: any) => x.id)).toEqual([early.id, noon, fifth, off.id, twelfth]);
        const paged: string[] = [];
        for (let p = 1; p <= 3; p++) paged.push(...(await call('GET', `/api/events?upcoming=true&limit=2&page=${p}&search=${tag}`, { token: host.token })).body.data.map((x: any) => x.id));
        expect(paged).toEqual(all.data.map((x: any) => x.id));
    });

    it('the shared preview shows the next date as it really is', async () => {
        const host = await member();
        const e = await soccer(host);
        await call('PUT', `/api/events/${e.id}`, { token: host.token, body: formBody(e, e.next, { startDate: iso(svAt(3, '10:00')), endDate: iso(svAt(3, '12:00')), locationName: 'Beach field' }, 'date') });
        const preview = (await call('GET', `/api/preview/events/${e.id}`)).body;
        expect(preview).toMatchObject({ startDate: iso(svAt(3, '10:00')), location: 'Beach field', repeat: 'WEEKLY' });
        const og = (await call('GET', `/api/preview/events/${e.id}/og`)).text;
        expect(og).toContain('10:00 AM');
        expect(og).toContain('Beach field');
    });
});

describe('when every date moves, what each date had moves with it', () => {
    it('a new time at the next date keeps that date\'s own place, at the new time', async () => {
        const host = await member();
        const e = await soccer(host);
        await call('PUT', `/api/events/${e.id}`, { token: host.token, body: formBody(e, e.next, { locationName: 'Beach field', location: 'Beach field, San Benito' }, 'date') });
        // The form shows the next date at the beach; 5 PM for it and every date after.
        const res = await call('PUT', `/api/events/${e.id}`, {
            token: host.token,
            body: formBody(e, e.next, { startDate: iso(svAt(3, '17:00')), endDate: iso(svAt(3, '19:00')), locationName: 'Beach field', location: 'Beach field, San Benito' }, 'series'),
        });
        expect(res.status).toBe(200);
        const series = (await prisma.event.findUnique({ where: { id: e.id }, include: { dateChanges: true } }))!;
        expect(series).toMatchObject({ startDate: svAt(3, '17:00'), locationName: 'Usual field' });
        expect(series.dateChanges.map((c) => [iso(c.occurrenceStart), c.locationName, c.startDate])).toEqual([[iso(svAt(3, '17:00')), 'Beach field', null]]);
        expect(await page(host, e.id)).toMatchObject({ startDate: iso(svAt(3, '17:00')), locationName: 'Beach field' });
    });

    it('edited as a whole from its first date, a call-off stays on its date at the new time', async () => {
        const host = await member();
        const e = await soccer(host);
        await call('POST', `/api/events/${e.id}/dates/call-off`, { token: host.token, body: { occurrence: iso(e.after) } });
        // A form for the whole event: its first date, an hour later.
        const res = await call('PUT', `/api/events/${e.id}`, { token: host.token, body: { startDate: iso(svAt(-11, '17:00')), endDate: iso(svAt(-11, '19:00')) } });
        expect(res.status).toBe(200);
        const rows = await prisma.eventDateChange.findMany({ where: { eventId: e.id } });
        expect(rows.map((c) => [iso(c.occurrenceStart), !!c.calledOffAt])).toEqual([[iso(svAt(10, '17:00')), true]]);
        const seen = await page(host, e.id);
        expect(seen.startDate).toBe(iso(svAt(3, '17:00')));
        expect(seen.upcomingDates.slice(0, 2).map((d: any) => [d.key, d.calledOff])).toEqual([[iso(svAt(3, '17:00')), false], [iso(svAt(10, '17:00')), true]]);
    });

    it('with another rule, a date that\'s still one of its dates keeps what it had; the others go', async () => {
        const host = await member();
        const e = await soccer(host);
        await call('PUT', `/api/events/${e.id}`, { token: host.token, body: formBody(e, e.after, { locationName: 'Park' }, 'date') });
        await call('POST', `/api/events/${e.id}/dates/call-off`, { token: host.token, body: { occurrence: iso(e.third) } });
        // Every other week from the next date: the third date (two weeks on) is still one, the one after the next isn't.
        const res = await call('PUT', `/api/events/${e.id}`, { token: host.token, body: formBody(e, e.next, { repeat: 'BIWEEKLY' }, 'series') });
        expect(res.status).toBe(200);
        const rows = await prisma.eventDateChange.findMany({ where: { eventId: e.id } });
        expect(rows.map((c) => [iso(c.occurrenceStart), c.locationName, !!c.calledOffAt])).toEqual([[iso(e.third), null, true]]);
        expect((await page(host, e.id)).upcomingDates.slice(0, 2).map((d: any) => [d.key, d.calledOff])).toEqual([[iso(e.next), false], [iso(e.third), true]]);
    });
});

describe('an app that edits the whole event (iOS up to 17, Android up to 8)', () => {
    /** What that app's form sends: the event as its page showed it (the next date, as it is), no date named. */
    const oldAppBody = (seen: any, changes: Record<string, unknown> = {}) => ({
        title: seen.title, description: seen.description, category: seen.category, visibility: seen.visibility,
        startDate: seen.startDate, endDate: seen.endDate, isOnline: seen.isOnline, onlineUrl: seen.onlineUrl || '',
        location: [seen.locationName, seen.locationAddress].filter(Boolean).join(', '),
        locationName: seen.locationName, locationAddress: seen.locationAddress, locationMapUrl: seen.locationMapUrl || '',
        thumbnail: seen.thumbnail || '', ticketUrl: '', bitcoinUrl: '', priceLabel: '', partners: [],
        ...changes,
    });

    it('keeps the next date\'s own time and place its own, its first date, and every call-off', async () => {
        const host = await member();
        const e = await soccer(host);
        await call('PUT', `/api/events/${e.id}`, {
            token: host.token,
            body: formBody(e, e.next, { startDate: iso(svAt(3, '10:00')), endDate: iso(svAt(3, '12:00')), locationName: 'Beach field', location: 'Beach field, San Benito' }, 'date'),
        });
        await call('POST', `/api/events/${e.id}/dates/call-off`, { token: host.token, body: { occurrence: iso(e.third) } });
        const seen = await page(host, e.id);
        expect(seen).toMatchObject({ startDate: iso(svAt(3, '10:00')), locationName: 'Beach field' });

        // A new photo and a new title, from the old form.
        const res = await call('PUT', `/api/events/${e.id}`, { token: host.token, body: oldAppBody(seen, { thumbnail: '/uploads/new.jpg', title: 'BIES Football' }) });
        expect(res.status).toBe(200);
        const series = (await prisma.event.findUnique({ where: { id: e.id }, include: { dateChanges: { orderBy: { occurrenceStart: 'asc' } } } }))!;
        expect(series).toMatchObject({
            title: 'BIES Football', thumbnail: '/uploads/new.jpg', startDate: svAt(-11, '16:00'), endDate: svAt(-11, '18:00'),
            locationName: 'Usual field', location: 'Usual field, San Benito',
        });
        expect(series.dateChanges.map((c) => [iso(c.occurrenceStart), c.locationName, c.startDate && iso(c.startDate), !!c.calledOffAt])).toEqual([
            [iso(e.next), 'Beach field', iso(svAt(3, '10:00')), false],
            [iso(e.third), null, null, true],
        ]);
    });

    it('a new time from it is a new time for the next date and every date after', async () => {
        const host = await member();
        const guest = await member();
        const e = await soccer(host);
        await go(guest, e.id);
        await call('POST', `/api/events/${e.id}/dates/call-off`, { token: host.token, body: { occurrence: iso(e.third) } });
        const seen = await page(host, e.id);
        const res = await call('PUT', `/api/events/${e.id}`, { token: host.token, body: oldAppBody(seen, { startDate: iso(svAt(3, '17:00')), endDate: iso(svAt(3, '19:00')) }) });
        expect(res.status).toBe(200);
        expect((await prisma.event.findUnique({ where: { id: e.id } }))!.startDate).toEqual(svAt(3, '17:00'));
        expect((await prisma.eventDateChange.findMany({ where: { eventId: e.id } })).map((c) => [iso(c.occurrenceStart), !!c.calledOffAt])).toEqual([[iso(svAt(17, '17:00')), true]]);
        expect(await page(guest, e.id)).toMatchObject({ startDate: iso(svAt(3, '17:00')), rsvpStatus: 'GOING' });
        expect((await notes(guest.id, e.id)).map((n) => n.body)).toEqual(['Now 5:00 PM (was 4:00 PM)']);
    });
});

describe('made a one-off at a changed date', () => {
    it('is that date as it is: its own time and place', async () => {
        const host = await member();
        const guest = await member();
        const e = await soccer(host);
        await go(guest, e.id);
        await call('PUT', `/api/events/${e.id}`, {
            token: host.token,
            body: formBody(e, e.next, { startDate: iso(svAt(3, '10:00')), endDate: iso(svAt(3, '12:00')), locationName: 'Beach field', location: 'Beach field, San Benito' }, 'date'),
        });
        // "Doesn't repeat", from the form as it shows the next date.
        const res = await call('PUT', `/api/events/${e.id}`, {
            token: host.token,
            body: formBody(e, e.next, { repeat: '', startDate: iso(svAt(3, '10:00')), endDate: iso(svAt(3, '12:00')), locationName: 'Beach field', location: 'Beach field, San Benito' }, 'series'),
        });
        expect(res.status).toBe(200);
        const event = (await prisma.event.findUnique({ where: { id: e.id }, include: { dateChanges: true } }))!;
        expect(event).toMatchObject({
            repeat: '', startDate: svAt(3, '10:00'), endDate: svAt(3, '12:00'),
            locationName: 'Beach field', locationAddress: 'San Benito', location: 'Beach field, San Benito',
        });
        expect(event.dateChanges).toEqual([]);
        expect(await page(guest, e.id)).toMatchObject({ rsvpStatus: 'GOING', goingCount: 1, startDate: iso(svAt(3, '10:00')) });
    });
});

describe('what a member answered for, in their events', () => {
    const attending = async (who: Member, id: string) => (await call('GET', '/api/events/attending', { token: who.token })).body.data.find((x: any) => x.id === id);

    it('an edit that moves no dates leaves the first date as it is, and an earlier answer shows its own date', async () => {
        const host = await member();
        const earlier = await member();
        const e = await soccer(host);
        await go(earlier, e.id);
        await prisma.eventAttendee.updateMany({ where: { eventId: e.id, userId: earlier.id }, data: { occurrenceStart: e.before } });
        // A new photo, at the next date, for every date.
        expect((await call('PUT', `/api/events/${e.id}`, { token: host.token, body: formBody(e, e.next, { thumbnail: '/uploads/new.jpg' }, 'series') })).status).toBe(200);
        expect((await prisma.event.findUnique({ where: { id: e.id } }))!.startDate).toEqual(svAt(-11, '16:00'));
        expect(await attending(earlier, e.id)).toMatchObject({ startDate: iso(e.before), occurrence: iso(e.before), calledOff: false });
        // A new time makes the next date the first: the earlier answer still shows its own date.
        expect((await call('PUT', `/api/events/${e.id}`, { token: host.token, body: formBody(e, e.next, { startDate: iso(svAt(3, '17:00')), endDate: iso(svAt(3, '19:00')) }, 'series') })).status).toBe(200);
        expect(await attending(earlier, e.id)).toMatchObject({ startDate: iso(e.before), endDate: iso(svAt(-4, '18:00')), occurrence: iso(e.before) });
    });

    it('a date called off shows as called off, not going', async () => {
        const host = await member();
        const guest = await member();
        const e = await soccer(host);
        await go(guest, e.id);
        await call('POST', `/api/events/${e.id}/dates/call-off`, { token: host.token, body: { occurrence: iso(e.next) } });
        expect(await attending(guest, e.id)).toMatchObject({ startDate: iso(e.next), occurrence: iso(e.next), calledOff: true, rsvpStatus: 'GOING' });
    });

    it('an answer for a date older than lists load shows that date as it was', async () => {
        const host = await member();
        const guest = await member();
        const e = await soccer(host, { startDate: iso(svAt(-200, '16:00')), endDate: iso(svAt(-200, '18:00')) });
        const old = svAt(-81, '16:00'); // its 17th date
        await prisma.eventDateChange.create({ data: { eventId: e.id, occurrenceStart: old, locationName: 'Old beach' } });
        await prisma.eventAttendee.create({ data: { eventId: e.id, userId: guest.id, status: 'GOING', occurrenceStart: old } });
        expect(await attending(guest, e.id)).toMatchObject({ startDate: iso(old), locationName: 'Old beach' });
    });
});

describe('how many date changes, and how far ahead', () => {
    it('one date can be changed or called off up to a year ahead', async () => {
        const host = await member();
        const e = await soccer(host);
        const far = svAt(3 + 7 * 60, '16:00');
        expect((await call('PUT', `/api/events/${e.id}`, { token: host.token, body: formBody(e, far, { title: 'Far', startDate: iso(far), endDate: iso(new Date(far.getTime() + 2 * 3600_000)) }, 'date') })).body.reason).toBe('date_too_far');
        expect((await call('POST', `/api/events/${e.id}/dates/call-off`, { token: host.token, body: { occurrence: iso(far) } })).body.reason).toBe('date_too_far');
        const nearYear = svAt(3 + 7 * 50, '16:00');
        expect((await call('POST', `/api/events/${e.id}/dates/call-off`, { token: host.token, body: { occurrence: iso(nearYear) } })).status).toBe(200);
        expect(await prisma.eventDateChange.count({ where: { eventId: e.id } })).toBe(1);
    });

    it(`an event has at most ${60} changed or called-off dates ahead`, async () => {
        const host = await member();
        const e = await soccer(host);
        // 60 dates ahead with a change already (from the one after the next on).
        await prisma.eventDateChange.createMany({
            data: Array.from({ length: 60 }, (_, k) => ({ eventId: e.id, occurrenceStart: svAt(10 + 7 * k, '16:00'), title: `Week ${k}` })),
        });
        expect((await call('PUT', `/api/events/${e.id}`, { token: host.token, body: formBody(e, e.next, { title: 'One more' }, 'date') })).body)
            .toMatchObject({ reason: 'too_many_date_changes', max: 60 });
        expect((await call('POST', `/api/events/${e.id}/dates/call-off`, { token: host.token, body: { occurrence: iso(e.next) } })).body.reason).toBe('too_many_date_changes');
        // A date that has a change already can still change, or be called off.
        expect((await call('PUT', `/api/events/${e.id}`, { token: host.token, body: formBody(e, e.after, { title: 'Still fine' }, 'date') })).status).toBe(200);
        expect((await call('POST', `/api/events/${e.id}/dates/call-off`, { token: host.token, body: { occurrence: iso(e.after) } })).status).toBe(200);
    });

    it('a series that\'s long over shows its last date as it was, in Past', async () => {
        const host = await member();
        const tag = `longover${Date.now()}`;
        // Every week from 300 days ago until 150 days ago; its last date moved to the beach, the one before it too.
        const first = svAt(-300, '16:00');
        // Posting one that's over is refused (already_over): it's posted for a date ahead, then given its own dates.
        const res = await call('POST', '/api/events', {
            token: host.token,
            body: { title: `${tag} soccer`, description: 'Five-a-side.', startDate: iso(svAt(30, '16:00')), endDate: iso(svAt(30, '18:00')) },
        });
        expect(res.status).toBe(201);
        await prisma.event.update({
            where: { id: res.body.id },
            data: { startDate: first, endDate: svAt(-300, '18:00'), repeat: 'WEEKLY', repeatUntil: endOfDay(new Date(Date.now() - 6 * 3600_000 - 150 * DAY).toISOString().slice(0, 10)) },
        });
        const last = new Date((await call('GET', `/api/events/${res.body.id}`, { token: host.token })).body.startDate);
        await prisma.eventDateChange.create({ data: { eventId: res.body.id, occurrenceStart: last, locationName: 'Final field' } });
        const past = (await call('GET', `/api/events?past=true&search=${tag}`, { token: host.token })).body;
        expect(past.data[0]).toMatchObject({ id: res.body.id, startDate: iso(last), locationName: 'Final field' });
        // Its last date called off: it ended on the one before.
        await prisma.eventDateChange.update({ where: { eventId_occurrenceStart: { eventId: res.body.id, occurrenceStart: last } }, data: { calledOffAt: new Date() } });
        const before = new Date(last.getTime() - 7 * DAY);
        expect((await call('GET', `/api/events/${res.body.id}`, { token: host.token })).body).toMatchObject({ startDate: iso(before), occurrence: iso(before) });
    });
});

describe('a co-host and where people join online', () => {
    it('can\'t change it for one date, nor for every date from one', async () => {
        const host = await member();
        const cohost = await member();
        const e = await soccer(host);
        await prisma.eventPartner.create({ data: { eventId: e.id, role: 'COHOST', userId: cohost.id } });
        // The host makes the next date online.
        expect((await call('PUT', `/api/events/${e.id}`, { token: host.token, body: formBody(e, e.next, { isOnline: true, onlineUrl: 'https://meet.example.test/soccer' }, 'date') })).status).toBe(200);
        const atNext = (changes: Record<string, unknown>, scope: 'date' | 'series') => {
            const body = formBody(e, e.next, changes, scope) as Record<string, unknown>;
            delete body.visibility;
            return call('PUT', `/api/events/${e.id}`, { token: cohost.token, body });
        };
        // Back to in person, for that date or from it on: the host's.
        expect((await atNext({ isOnline: false, onlineUrl: '' }, 'date')).body).toMatchObject({ reason: 'host_only', field: 'isOnline' });
        expect((await atNext({ isOnline: false, onlineUrl: '' }, 'series')).body).toMatchObject({ reason: 'host_only', field: 'isOnline' });
        // Sent as the date has it, with a change of their own: fine, and the date stays online.
        expect((await atNext({ isOnline: true, onlineUrl: 'https://meet.example.test/soccer', title: 'Soccer online' }, 'date')).status).toBe(200);
        const row = await prisma.eventDateChange.findUnique({ where: { eventId_occurrenceStart: { eventId: e.id, occurrenceStart: e.next } } });
        expect(row).toMatchObject({ isOnline: true, onlineUrl: 'https://meet.example.test/soccer', title: 'Soccer online' });
    });
});
