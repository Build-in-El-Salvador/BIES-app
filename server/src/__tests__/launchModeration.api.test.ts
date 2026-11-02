/**
 * Blocks and reports where App Review looks (guideline 1.2): the bell shows
 * nothing from a member blocked either way, from before the block too; a
 * meetup's notices come from its proposer, so a block stops them; a comment
 * notification never quotes words the community rules don't allow; every
 * moderator and admin hears of a new report in the app; a member can't RSVP
 * across a block; inviting needs the terms; a listing's album says which
 * member Block would block. Real routes against a real SQLite
 * database built from the repo's migrations. Email and relays go nowhere.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const env = vi.hoisted(() => {
    const dir = `${process.env.TMPDIR || '/tmp'}/bies-launch-moderation-test-${process.pid}-${Date.now()}`;
    process.env.DATABASE_URL = `file:${dir}/test.db`;
    process.env.RELAY_WHITELIST_PATH = `${dir}/relay/whitelist.txt`;
    process.env.CORS_ORIGIN = 'https://app.example.test';
    process.env.MODERATION_EMAIL = 'moderators@example.test';
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

vi.mock('../services/email.service', () => ({ sendEmail: vi.fn(async () => {}) }));

import { execSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import express from 'express';
import prisma from '../lib/prisma';
import eventRoutes from '../routes/events.routes';
import albumRoutes from '../routes/album.routes';
import moderationRoutes from '../routes/moderation.routes';
import notificationRoutes from '../routes/notification.routes';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { createSession, signAccessToken } from '../services/session.service';
import { createNotification } from '../services/notification.service';
import { sweepProposals } from '../services/eventProposals.service';
import { previewToShow } from '../controllers/notification.controller';

let server: http.Server;
let base: string;

beforeAll(async () => {
    fs.mkdirSync(env.dir, { recursive: true });
    execSync('npx prisma migrate deploy', { cwd: path.resolve(__dirname, '../..'), env: process.env, stdio: 'pipe' });
    const app = express();
    app.use(express.json());
    app.use('/api/events', eventRoutes);
    app.use('/api/albums', albumRoutes);
    app.use('/api/notifications', notificationRoutes);
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

type Member = { id: string; pubkey: string; token: string; name: string };
let counter = 0;
async function member(name = '', { role = 'MEMBER', admin = false, terms = true } = {}): Promise<Member> {
    const shown = name || `Member ${++counter}`;
    const pubkey = getPublicKey(generateSecretKey());
    const user = await prisma.user.create({
        data: {
            nostrPubkey: pubkey, role, isAdmin: admin,
            termsVersion: terms ? '2026-10' : null, termsAcceptedAt: terms ? new Date() : null,
            profile: { create: { name: shown } },
        },
    });
    const session = await createSession(user.id, 'native');
    return { id: user.id, pubkey, name: shown, token: signAccessToken({ id: user.id, role, isAdmin: admin }, session.sessionId) };
}

const block = (who: Member, other: Member) => call('POST', '/api/blocks', { token: who.token, body: { userId: other.id } });
const bell = async (who: Member) => (await call('GET', '/api/notifications?limit=50', { token: who.token })).body;
const titles = (page: { data: { title: string }[] }) => page.data.map((n) => n.title);
const inDays = (d: number) => new Date(Date.now() + d * 86400_000).toISOString();
const hexId = () => crypto.randomBytes(32).toString('hex');

describe('the bell after a block', () => {
    it("drops what came from a member blocked either way, from before the block too, and counts it out", async () => {
        const ana = await member('Ana');
        const ben = await member('Ben');
        const cruz = await member('Cruz');
        await createNotification({ userId: ana.id, type: 'FOLLOW', title: 'Ben started following you', body: '', data: { followerId: ben.id } });
        await createNotification({ userId: ana.id, type: 'POST_LIKE', title: 'Ben liked your post', body: '', data: { actorPubkey: ben.pubkey, eventId: hexId() } });
        await createNotification({ userId: ana.id, type: 'EVENT_RSVP', title: 'Ben is going', body: '', data: { eventId: 'e1', attendeeId: ben.id } });
        await createNotification({ userId: ana.id, type: 'FOLLOW', title: 'Cruz started following you', body: '', data: { followerId: cruz.id } });
        await createNotification({ userId: ana.id, type: 'SYSTEM', title: 'Your listing is live', body: '', data: { link: '/farms/x' } });
        expect(titles(await bell(ana))).toHaveLength(5);
        expect((await call('GET', '/api/notifications/count', { token: ana.token })).body.count).toBe(5);

        // Ben blocks Ana: she no longer sees anything from him either.
        expect((await block(ben, ana)).status).toBe(201);
        const after = await bell(ana);
        expect(titles(after).sort()).toEqual(['Cruz started following you', 'Your listing is live']);
        expect(after.unreadCount).toBe(2);
        expect(after.pagination.total).toBe(2);
        expect((await call('GET', '/api/notifications/count', { token: ana.token })).body.count).toBe(2);

        // Unblocked: they're back (nothing was deleted).
        expect((await call('DELETE', `/api/blocks/${ana.id}`, { token: ben.token })).status).toBe(200);
        expect(titles(await bell(ana))).toHaveLength(5);
        expect((await call('GET', '/api/notifications/count', { token: ana.token })).body.count).toBe(5);
    });

    it("drops a proposed meetup's notices once its proposer is blocked, and sends no more", async () => {
        const host = await member('Edwin');
        const dee = await member('Dee');
        const eli = await member('Eli');
        const propose = async (title: string, minAttendees: number) => {
            const made = await call('POST', '/api/events', {
                token: host.token,
                body: { title, description: '', category: 'MEETUP', startDate: inDays(10), decideBy: inDays(9), minAttendees, locationName: 'Parrilla' },
            });
            expect(made.status).toBe(201);
            return made.body.id as string;
        };
        const lunch = await propose('Steak lunch', 3);
        const pupusas = await propose('Pupusa night', 5);
        for (const who of [dee, eli]) {
            for (const id of [lunch, pupusas]) {
                expect((await call('POST', `/api/events/${id}/rsvp`, { token: who.token, body: { status: 'GOING' } })).status).toBe(200);
            }
        }

        const notice = await prisma.notification.findFirstOrThrow({ where: { userId: dee.id, title: { startsWith: "It's on" } } });
        expect(JSON.parse(notice.data)).toMatchObject({ eventId: lunch, status: 'CONFIRMED', actorId: host.id });
        expect(titles(await bell(dee))).toContain('It\'s on: "Steak lunch"');

        // Dee blocks the proposer: the notice goes from her bell, and the
        // next one (the other meetup called off) never comes. Eli still hears.
        expect((await block(dee, host)).status).toBe(201);
        expect(titles(await bell(dee))).not.toContain('It\'s on: "Steak lunch"');
        await sweepProposals(new Date(Date.now() + 9.5 * 86400_000));
        expect(await prisma.notification.count({ where: { userId: eli.id, title: 'Called off: "Pupusa night"' } })).toBe(1);
        expect(await prisma.notification.count({ where: { userId: dee.id, title: { contains: 'Pupusa night' } } })).toBe(0);
    });
});

describe('a comment notification', () => {
    it('quotes the comment, cut short', () => {
        expect(previewToShow('Great post, see you at the meetup!')).toBe('Great post, see you at the meetup!');
        expect(previewToShow('a'.repeat(500))).toHaveLength(120);
        expect(previewToShow(42)).toBeUndefined();
        expect(previewToShow('   ')).toBeUndefined();
    });

    it("leaves out words the community rules don't allow, wherever they are in it", async () => {
        expect(previewToShow('you are a puta')).toBeUndefined();
        expect(previewToShow(`${'nice '.repeat(40)}hijo de puta`)).toBeUndefined();

        const author = await member('Fer');
        const troll = await member('Gus');
        const post = hexId();
        const sent = await call('POST', '/api/notifications/feed-interaction', {
            token: troll.token,
            body: { type: 'POST_COMMENT', targetPubkey: author.pubkey, eventId: post, contentPreview: 'k1ll yourself' },
        });
        expect(sent.status).toBe(200);
        const row = await prisma.notification.findFirstOrThrow({ where: { userId: author.id, type: 'POST_COMMENT' } });
        expect(row.title).toBe('Gus commented on your post');
        expect(row.body).toBe('Someone left a comment on your post.');

        await call('POST', '/api/notifications/feed-interaction', {
            token: troll.token,
            body: { type: 'COMMENT_REPLY', targetPubkey: author.pubkey, eventId: post, contentPreview: `Thanks! ${'x'.repeat(300)}` },
        });
        const reply = await prisma.notification.findFirstOrThrow({ where: { userId: author.id, type: 'COMMENT_REPLY' } });
        expect(reply.body.startsWith('Thanks! ')).toBe(true);
        expect(reply.body.length).toBeLessThanOrEqual(120);
    });
});

describe('a new report', () => {
    it('reaches every moderator and admin in the app, opening Admin → Reports', async () => {
        const admin = await member('Admin', { admin: true });
        const mod = await member('Mod', { role: 'MOD' });
        const bystander = await member('Bystander');
        const reporter = await member('Reporter');
        const target = await member('Target');

        const sent = await call('POST', '/api/reports', { token: reporter.token, body: { targetType: 'user', targetId: target.id, reason: 'harassment' } });
        expect(sent.status).toBe(201);

        for (const staff of [admin, mod]) {
            const rows = await prisma.notification.findMany({ where: { userId: staff.id, type: 'SYSTEM' } });
            expect(rows).toHaveLength(1);
            expect(rows[0].title).toBe('New report: Harassment, threats or hate');
            expect(rows[0].body).toBe('A profile was reported. Please review it within 24 hours.');
            expect(JSON.parse(rows[0].data)).toMatchObject({ link: '/admin/reports' });
        }
        for (const other of [bystander, reporter, target]) {
            expect(await prisma.notification.count({ where: { userId: other.id, type: 'SYSTEM' } })).toBe(0);
        }

        // The same report again is the same report: no second alert.
        await call('POST', '/api/reports', { token: reporter.token, body: { targetType: 'user', targetId: target.id, reason: 'harassment' } });
        expect(await prisma.notification.count({ where: { userId: admin.id, type: 'SYSTEM' } })).toBe(1);
    });

    it("isn't sent to a moderator it's about, nor to staff who sent it; a reporter they blocked doesn't stop it", async () => {
        const admin = await member('Admin 2', { admin: true });
        const mod = await member('Mod 2', { role: 'MOD' });
        const other = await member('Mod 3', { role: 'MOD' });
        const reporter = await member('Reporter 2');
        expect((await block(other, reporter)).status).toBe(201);

        expect((await call('POST', '/api/reports', { token: reporter.token, body: { targetType: 'user', targetId: mod.id, reason: 'scam_spam' } })).status).toBe(201);
        expect(await prisma.notification.count({ where: { userId: mod.id, type: 'SYSTEM' } })).toBe(0);
        expect(await prisma.notification.count({ where: { userId: admin.id, type: 'SYSTEM' } })).toBe(1);
        expect(await prisma.notification.count({ where: { userId: other.id, type: 'SYSTEM' } })).toBe(1);

        const before = await prisma.notification.count({ where: { userId: admin.id, type: 'SYSTEM' } });
        expect((await call('POST', '/api/reports', { token: admin.token, body: { targetType: 'user', targetId: reporter.id, reason: 'other' } })).status).toBe(201);
        expect(await prisma.notification.count({ where: { userId: admin.id, type: 'SYSTEM' } })).toBe(before);
    });
});

describe('events across a block', () => {
    const event = async (host: Member) => {
        const made = await call('POST', '/api/events', {
            token: host.token,
            body: { title: `Sunday Hike ${++counter}`, description: 'Up the volcano', category: 'MEETUP', startDate: inDays(5), locationName: 'El Boquerón' },
        });
        expect(made.status).toBe(201);
        return made.body.id as string;
    };

    it("a member can't RSVP to an event whose host they blocked, or who blocked them", async () => {
        const host = await member('Host');
        const hana = await member('Hana');
        const ivan = await member('Ivan');
        const id = await event(host);
        expect((await block(hana, host)).status).toBe(201);
        expect((await block(host, ivan)).status).toBe(201);
        for (const who of [hana, ivan]) {
            expect((await call('POST', `/api/events/${id}/rsvp`, { token: who.token, body: { status: 'GOING' } })).status).toBe(404);
        }
        expect(await prisma.eventAttendee.count({ where: { eventId: id, userId: { in: [hana.id, ivan.id] } } })).toBe(0);

        const jo = await member('Jo');
        expect((await call('POST', `/api/events/${id}/rsvp`, { token: jo.token, body: { status: 'GOING' } })).status).toBe(200);
    });

    it('inviting needs the terms accepted', async () => {
        const host = await member('Host 2');
        const guest = await member('Guest');
        const id = await event(host);
        await prisma.user.update({ where: { id: host.id }, data: { termsVersion: null } });
        const refused = await call('POST', `/api/events/${id}/invite`, { token: host.token, body: { userId: guest.id } });
        expect(refused.status).toBe(403);
        expect(refused.body.reason).toBe('terms_required');
    });
});

describe("a listing's album", () => {
    it('names the member who answers for it, whom Block blocks', async () => {
        const staff = await member('Staff', { admin: true });
        const farmer = await member('Farmer');
        const viewer = await member('Viewer');
        const listing = await prisma.directoryListing.create({
            data: { type: 'FARM', name: 'Finca Verde', ownerId: staff.id, memberUserId: farmer.id, status: 'active', isPublished: true },
        });
        const album = await prisma.album.create({ data: { listingId: listing.id, title: 'Harvest', visibility: 'MEMBERS' } });
        const seen = await call('GET', `/api/albums/${album.id}`, { token: viewer.token });
        expect(seen.status).toBe(200);
        expect(seen.body.owner).toMatchObject({ type: 'listing', name: 'Finca Verde', memberId: farmer.id, memberName: 'Farmer' });

        // Entered by a member for themselves: that member.
        const own = await prisma.directoryListing.create({ data: { type: 'PROVIDER', name: 'Cafe Uno', ownerId: farmer.id, status: 'active', isPublished: true } });
        const second = await prisma.album.create({ data: { listingId: own.id, title: 'Menu', visibility: 'MEMBERS' } });
        expect((await call('GET', `/api/albums/${second.id}`, { token: viewer.token })).body.owner).toMatchObject({ memberId: farmer.id, memberName: 'Farmer' });
    });
});
