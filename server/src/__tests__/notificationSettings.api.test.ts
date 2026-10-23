/**
 * Settings → Notifications: the switches are saved, and push (APNs and web
 * push) follows them, while the bell keeps every notification. Real routes
 * against a real SQLite database built from the repo's migrations; APNs and
 * web push are stand-ins that record what would have been sent.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const env = vi.hoisted(() => {
    const dir = `${process.env.TMPDIR || '/tmp'}/bies-notify-test-${process.pid}-${Date.now()}`;
    process.env.DATABASE_URL = `file:${dir}/test.db`;
    process.env.RELAY_WHITELIST_PATH = `${dir}/relay/whitelist.txt`;
    process.env.CORS_ORIGIN = 'https://app.example.test';
    return { dir };
});

const push = vi.hoisted(() => ({ apns: [] as { userId: string; title: string; url?: string }[], web: [] as { userId: string; title: string }[] }));
vi.mock('../services/apns.service', () => ({
    isApnsEnabled: () => true,
    initApns: () => {},
    sendApnsToUser: vi.fn(async (userId: string, payload: { title: string; url?: string }) => { push.apns.push({ userId, ...payload }); return 1; }),
}));
vi.mock('../services/webpush.service', () => ({
    isWebPushEnabled: () => true,
    initWebPush: () => {},
    sendPushToUser: vi.fn(async (userId: string, payload: { title: string }) => { push.web.push({ userId, ...payload }); return 1; }),
}));

import { execSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import express from 'express';
import prisma from '../lib/prisma';
import settingsRoutes from '../routes/settings.routes';
import notificationRoutes from '../routes/notification.routes';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { createSession, signAccessToken } from '../services/session.service';
import { createNotification } from '../services/notification.service';

let server: http.Server;
let base: string;

beforeAll(async () => {
    fs.mkdirSync(env.dir, { recursive: true });
    execSync('npx prisma migrate deploy', { cwd: path.resolve(__dirname, '../..'), env: process.env, stdio: 'pipe' });
    const app = express();
    app.use(express.json());
    app.use('/api/settings', settingsRoutes);
    app.use('/api/notifications', notificationRoutes);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 120_000);

afterAll(async () => {
    server?.close();
    await prisma.$disconnect();
    fs.rmSync(env.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); // a late write can race the delete (ENOTEMPTY)
});

beforeEach(() => { push.apns.length = 0; push.web.length = 0; });

async function call(method: string, url: string, { token, body }: { token?: string; body?: unknown } = {}) {
    const res = await fetch(`${base}${url}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function member(name: string) {
    const user = await prisma.user.create({
        data: { nostrPubkey: getPublicKey(generateSecretKey()), role: 'MEMBER', profile: { create: { name } } },
    });
    const session = await createSession(user.id, 'native');
    return { id: user.id, token: signAccessToken({ id: user.id, role: 'MEMBER', isAdmin: false }, session.sessionId) };
}

const notify = (userId: string, type: Parameters<typeof createNotification>[0]['type'], title: string = type) =>
    createNotification({ userId, type, title, body: 'body', data: {} });
const bell = (userId: string) => prisma.notification.count({ where: { userId } });

describe('Settings → Notifications', () => {
    it('starts with every switch on but profile views, and saves each one', async () => {
        const ana = await member('Ana');
        const initial = await call('GET', '/api/settings', { token: ana.token });
        expect(initial.status).toBe(200);
        for (const key of ['pushNotifications', 'notifyLikes', 'notifyComments', 'notifyFollows', 'notifyMessages', 'notifyZaps', 'notifyEvents', 'notifyInvestments', 'notifyProjectUpdates']) {
            expect(initial.body[key], key).toBe(true);
        }
        expect(initial.body.notifyProfileViews).toBe(false);

        const saved = await call('PUT', '/api/settings/notifications', { token: ana.token, body: { notifyLikes: false, notifyProfileViews: true } });
        expect(saved.status).toBe(200);
        const after = await call('GET', '/api/settings', { token: ana.token });
        expect(after.body).toMatchObject({ notifyLikes: false, notifyProfileViews: true, notifyComments: true, pushNotifications: true });
    });

    it('takes only true or false, and nothing but the switches', async () => {
        const ana = await member('Ana B');
        expect((await call('PUT', '/api/settings/notifications', { token: ana.token, body: { notifyLikes: 'no' } })).status).toBe(400);
        const res = await call('PUT', '/api/settings/notifications', { token: ana.token, body: { notifyComments: false, userId: 'someone-else', relays: '["wss://x"]' } });
        expect(res.status).toBe(200);
        const row = await prisma.userSettings.findUnique({ where: { userId: ana.id } });
        expect(row?.notifyComments).toBe(false);
        expect(row?.relays).toBe('[]');
    });

    it('needs a signed-in member', async () => {
        expect((await call('PUT', '/api/settings/notifications', { body: { notifyLikes: false } })).status).toBe(401);
    });

    it('a member without settings yet, asking from two screens at once, gets them both times', async () => {
        const ana = await member('Ana C');
        const answers = await Promise.all(Array.from({ length: 4 }, () => call('GET', '/api/settings', { token: ana.token })));
        expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 200]);
        expect(await prisma.userSettings.count({ where: { userId: ana.id } })).toBe(1);
    });
});

describe('push follows the switches; the bell keeps everything', () => {
    it('a member with no settings yet gets everything pushed', async () => {
        const ana = await member('Ana C');
        await notify(ana.id, 'POST_LIKE');
        expect(push.apns.map((p) => p.userId)).toEqual([ana.id]);
        expect(push.web.map((p) => p.userId)).toEqual([ana.id]);
    });

    it('a category turned off is not pushed, to the phone or the browser, but is in the bell', async () => {
        const ana = await member('Ana D');
        await call('PUT', '/api/settings/notifications', { token: ana.token, body: { notifyLikes: false } });
        await notify(ana.id, 'POST_LIKE', 'liked your post');
        await notify(ana.id, 'COMMENT_LIKE', 'liked your comment');
        await notify(ana.id, 'POST_COMMENT', 'commented');
        expect(push.apns.map((p) => p.title)).toEqual(['commented']);
        expect(push.web.map((p) => p.title)).toEqual(['commented']);
        expect(await bell(ana.id)).toBe(3);
    });

    it('each switch covers its own kinds', async () => {
        const ana = await member('Ana E');
        await call('PUT', '/api/settings/notifications', {
            token: ana.token,
            body: { notifyComments: false, notifyFollows: false, notifyProfileViews: false, notifyMessages: false, notifyZaps: false, notifyEvents: false, notifyInvestments: false, notifyProjectUpdates: false },
        });
        for (const type of ['POST_COMMENT', 'COMMENT_REPLY', 'FOLLOW', 'PROFILE_VIEW', 'NEW_MESSAGE', 'ZAP_RECEIVED', 'EVENT_RSVP', 'INVESTMENT_INTEREST', 'DECK_REQUEST', 'PROJECT_UPDATE'] as const) {
            await notify(ana.id, type);
        }
        await notify(ana.id, 'POST_LIKE');
        expect(push.apns.map((p) => p.title)).toEqual(['POST_LIKE']);
    });

    it('account and listing notices have no switch: pushed while push is on', async () => {
        const ana = await member('Ana F');
        await call('PUT', '/api/settings/notifications', { token: ana.token, body: { notifyLikes: false, notifyComments: false, notifyFollows: false } });
        await createNotification({ userId: ana.id, type: 'SYSTEM', title: 'Sofía wants to take over Finca El Roble', body: 'b', data: { link: '/farms/abc' } });
        expect(push.apns).toEqual([expect.objectContaining({ title: 'Sofía wants to take over Finca El Roble', url: '/farms/abc' })]);
    });

    it('push off stops everything, even notices; the bell still has them', async () => {
        const ana = await member('Ana G');
        await call('PUT', '/api/settings/notifications', { token: ana.token, body: { pushNotifications: false } });
        await notify(ana.id, 'POST_LIKE');
        await notify(ana.id, 'SYSTEM');
        expect(push.apns).toEqual([]);
        expect(push.web).toEqual([]);
        expect(await bell(ana.id)).toBe(2);

        await call('PUT', '/api/settings/notifications', { token: ana.token, body: { pushNotifications: true } });
        await notify(ana.id, 'POST_LIKE');
        expect(push.apns).toHaveLength(1);
    });

    it('tapping one opens what it is about', async () => {
        const ana = await member('Ana I');
        const post = 'ab'.repeat(32);
        await createNotification({ userId: ana.id, type: 'POST_LIKE', title: 'like', body: 'b', data: { eventId: post } });
        await createNotification({ userId: ana.id, type: 'FOLLOW', title: 'follow', body: 'b', data: { followerId: 'user123' } });
        await createNotification({ userId: ana.id, type: 'PROFILE_VIEW', title: 'view', body: 'b', data: { viewerId: 'user456' } });
        await createNotification({ userId: ana.id, type: 'POST_COMMENT', title: 'odd', body: 'b', data: { eventId: '../admin' } });
        expect(push.apns.map((p) => [p.title, p.url])).toEqual([
            ['like', `/feed?post=${post}`],
            ['follow', '/builder/user123'],
            ['view', '/builder/user456'],
            ['odd', '/feed'],
        ]);
    });

    it('a phone registers its push token, and signs it out again', async () => {
        const ana = await member('Ana H');
        const token = 'a'.repeat(64);
        expect((await call('POST', '/api/notifications/device-token', { token: ana.token, body: { token, platform: 'ios' } })).status).toBe(200);
        expect(await prisma.deviceToken.findUnique({ where: { token } })).toMatchObject({ userId: ana.id, platform: 'ios' });
        expect((await call('DELETE', '/api/notifications/device-token', { token: ana.token, body: { token } })).status).toBe(200);
        expect(await prisma.deviceToken.findUnique({ where: { token } })).toBeNull();
    });
});
