/**
 * Security review, round 3: a Nostr sign-in names BIES (NIP-98 `u` and
 * `method`), and asking for a challenge with someone else's pubkey no longer
 * replaces theirs; push subscriptions go only to the browsers' push
 * services; invite-only events take invited members only; event import
 * fetches only public https pages. Real routes against a real SQLite
 * database built from the repo's migrations.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const env = vi.hoisted(() => {
    const dir = `${process.env.TMPDIR || '/tmp'}/bies-round3-test-${process.pid}-${Date.now()}`;
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
vi.mock('../services/email.service', () => ({ sendEmail: vi.fn(async () => {}) }));

import { execSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import express from 'express';
import prisma from '../lib/prisma';
import authRoutes from '../routes/auth.routes';
import notificationRoutes from '../routes/notification.routes';
import eventRoutes from '../routes/events.routes';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { createSession, signAccessToken } from '../services/session.service';

let server: http.Server;
let base: string;

beforeAll(async () => {
    fs.mkdirSync(env.dir, { recursive: true });
    execSync('npx prisma migrate deploy', { cwd: path.resolve(__dirname, '../..'), env: process.env, stdio: 'pipe' });
    const app = express();
    app.use(express.json());
    app.use('/api/auth', authRoutes);
    app.use('/api/notifications', notificationRoutes);
    app.use('/api/events', eventRoutes);
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
async function member(name: string): Promise<Member> {
    const user = await prisma.user.create({
        data: {
            nostrPubkey: getPublicKey(generateSecretKey()), role: 'MEMBER',
            termsVersion: '2026-10', termsAcceptedAt: new Date(), profile: { create: { name } },
        },
    });
    const session = await createSession(user.id, 'native');
    return { id: user.id, token: signAccessToken({ id: user.id, role: 'MEMBER', isAdmin: false }, session.sessionId) };
}

const LOGIN_URL = 'https://app.example.test/api/auth/nostr-login';
const now = () => Math.floor(Date.now() / 1000);

async function challengeFor(pubkey: string) {
    return (await call('GET', `/api/auth/nostr-challenge?pubkey=${pubkey}`)).body.challenge as string;
}
function login(secretKey: Uint8Array, challenge: string, tags: string[][]) {
    const pubkey = getPublicKey(secretKey);
    const signedEvent = finalizeEvent({ kind: 27235, created_at: now(), tags, content: challenge }, secretKey);
    return call('POST', '/api/auth/nostr-login', { body: { pubkey, signedEvent } });
}

describe('Nostr sign-in', () => {
    it('needs the event to name BIES\'s login (NIP-98)', async () => {
        const key = generateSecretKey();
        const pubkey = getPublicKey(key);

        // No tags at all: an app from before the check, told to reload.
        let res = await login(key, await challengeFor(pubkey), []);
        expect(res.status).toBe(400);
        expect(res.body.reason).toBe('update_required');

        res = await login(key, await challengeFor(pubkey), [['u', 'https://other.example/login'], ['method', 'POST']]);
        expect(res.body.reason).toBe('wrong_target');

        res = await login(key, await challengeFor(pubkey), [['u', LOGIN_URL], ['method', 'GET']]);
        expect(res.body.reason).toBe('wrong_target');

        res = await login(key, await challengeFor(pubkey), [['u', LOGIN_URL], ['method', 'POST']]);
        expect(res.status).toBe(200);
        expect(res.body.user?.nostrPubkey).toBe(pubkey);
    });

    it('a challenge someone else asks for with my pubkey doesn\'t replace mine, and each works once', async () => {
        const key = generateSecretKey();
        const pubkey = getPublicKey(key);
        const mine = await challengeFor(pubkey);
        await challengeFor(pubkey); // someone else, same pubkey
        const tags = [['u', LOGIN_URL], ['method', 'POST']];
        expect((await login(key, mine, tags)).status).toBe(200);
        expect((await login(key, mine, tags)).status).toBe(400); // used up

        // Another member's challenge isn't mine to use.
        const other = generateSecretKey();
        const theirs = await challengeFor(getPublicKey(other));
        expect((await login(key, theirs, tags)).status).toBe(400);
    });
});

describe('push subscriptions', () => {
    it('go only to the browsers\' push services', async () => {
        const ana = await member('Ana P');
        const keys = { p256dh: 'BPcMbn' + 'a'.repeat(80), auth: 'b'.repeat(22) };
        for (const endpoint of ['https://attacker.example/push', 'http://fcm.googleapis.com/fcm/send/x', 'https://127.0.0.1/x', 'https://fcm.googleapis.com:8443/fcm/send/x']) {
            expect((await call('POST', '/api/notifications/push/subscribe', { token: ana.token, body: { endpoint, keys } })).status, endpoint).toBe(400);
        }
        for (const endpoint of ['https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/abc', 'https://web.push.apple.com/abc']) {
            expect((await call('POST', '/api/notifications/push/subscribe', { token: ana.token, body: { endpoint, keys } })).status, endpoint).toBeLessThan(300);
        }
    });
});

describe('events', () => {
    it('invite-only events take invited members only', async () => {
        const host = await member('Host');
        const guest = await member('Guest');
        const stranger = await member('Stranger');
        const event = await prisma.event.create({
            data: {
                title: 'Dinner', description: 'x', hostId: host.id, isPublished: true, visibility: 'INVITE_ONLY',
                startDate: new Date(Date.now() + 86_400_000), location: 'San Salvador',
            },
        });
        await prisma.eventAttendee.create({ data: { eventId: event.id, userId: guest.id, status: 'INVITED' } });

        expect((await call('POST', `/api/events/${event.id}/rsvp`, { token: stranger.token, body: { status: 'GOING' } })).status).toBe(403);
        expect((await call('POST', `/api/events/${event.id}/rsvp`, { token: guest.token, body: { status: 'GOING' } })).status).toBeLessThan(300);
    });

    it('import fetches only public https pages', async () => {
        const ana = await member('Ana I');
        for (const url of ['http://example.com/event', 'https://127.0.0.1/event', 'https://localhost/event', 'file:///etc/passwd']) {
            expect((await call('POST', '/api/events/import-url', { token: ana.token, body: { url } })).status, url).toBe(400);
        }
    });
});
