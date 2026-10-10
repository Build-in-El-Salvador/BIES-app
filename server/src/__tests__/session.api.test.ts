/**
 * Sessions end to end: access tokens checked against their session on every
 * request, refresh with rotation and reuse detection, the web app's cookie
 * versus the body for other clients, logout, revocation on a ban, cleanup,
 * and WebSockets closing when their session ends. Real routes and
 * middleware, against an in-memory Prisma stand-in.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';

vi.hoisted(() => {
    process.env.CORS_ORIGIN = 'https://app.example.test';
    process.env.CORS_NATIVE_ORIGIN = 'capacitor://localhost,https://localhost';
});

type Row = Record<string, any>;

const db = vi.hoisted(() => {
    const state = { sessions: [] as Row[], users: [] as Row[], deviceTokens: [] as Row[], seq: 0, failNextRead: false };
    // Yield like a real database call, so concurrent requests interleave.
    const io = () => new Promise<void>((resolve) => setImmediate(resolve));

    function matches(row: Row, where: Row): boolean {
        return Object.entries(where).every(([key, cond]) => {
            if (key === 'OR') return (cond as Row[]).some((w) => matches(row, w));
            if (cond && typeof cond === 'object' && !(cond instanceof Date) && 'lt' in cond) {
                return row[key] instanceof Date && row[key] < cond.lt;
            }
            return row[key] === cond || (cond === null && row[key] == null);
        });
    }

    const session = {
        create: vi.fn(async ({ data }: Row) => {
            await io();
            const now = new Date();
            const row = {
                id: `sess-${++state.seq}`, counter: 0, rotatedAt: null, revokedAt: null, revokedReason: null,
                createdAt: now, lastUsedAt: now, ...data,
            };
            state.sessions.push(row);
            return { ...row };
        }),
        findUnique: vi.fn(async ({ where }: Row) => {
            await io();
            if (state.failNextRead) {
                state.failNextRead = false;
                throw new Error('database unavailable');
            }
            const row = state.sessions.find((s) => s.id === where.id);
            if (!row) return null;
            const user = state.users.find((u) => u.id === row.userId);
            return { ...row, user: user ? { ...user } : null };
        }),
        updateMany: vi.fn(async ({ where, data }: Row) => {
            await io();
            let count = 0;
            for (const row of state.sessions) {
                if (matches(row, where)) {
                    Object.assign(row, data);
                    count++;
                }
            }
            return { count };
        }),
        deleteMany: vi.fn(async ({ where }: Row) => {
            await io();
            const before = state.sessions.length;
            state.sessions = state.sessions.filter((row) => !matches(row, where));
            return { count: before - state.sessions.length };
        }),
    };

    const deviceToken = {
        deleteMany: vi.fn(async ({ where }: Row) => {
            const before = state.deviceTokens.length;
            state.deviceTokens = state.deviceTokens.filter((t) => !(t.userId === where.userId && t.token === where.token));
            return { count: before - state.deviceTokens.length };
        }),
    };

    return { state, session, deviceToken };
});

vi.mock('../lib/prisma', () => ({ default: { session: db.session, deviceToken: db.deviceToken } }));

import authRoutes from '../routes/auth.routes';
import { authenticate } from '../middleware/auth';
import { config } from '../config';
import { attachWebSocketServer, WS_PROTOCOL } from '../services/websocket.service';
import {
    REFRESH_COOKIE,
    createSession,
    deleteOldSessions,
    revokeSession,
    revokeUserSessions,
    signAccessToken,
} from '../services/session.service';

const WEB = 'https://app.example.test';
const DAY = 24 * 60 * 60 * 1000;

const ALICE = {
    id: 'u-alice', email: 'alice@example.com', nostrPubkey: 'a'.repeat(64), role: 'MEMBER',
    isAdmin: false, isBanned: false, deletedAt: null,
};
const BOB = { ...ALICE, id: 'u-bob', email: 'bob@example.com', nostrPubkey: 'b'.repeat(64) };

// ─── Ephemeral app ───────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/auth', authRoutes);
    app.get('/api/private', authenticate, (req, res) => {
        res.json({ userId: req.user!.id, sessionId: req.sessionId });
    });
    server = http.createServer(app);
    attachWebSocketServer(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
    server?.close();
});

beforeEach(() => {
    db.state.sessions = [];
    db.state.users = [{ ...ALICE }, { ...BOB }];
    db.state.deviceTokens = [];
    db.state.failNextRead = false;
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sessionRow = (id: string) => db.state.sessions.find((s) => s.id === id)!;

async function signIn(user = ALICE) {
    const issued = await createSession(user.id, 'api');
    return { ...issued, token: signAccessToken(user, issued.sessionId) };
}

function getPrivate(token: string) {
    return fetch(`${base}/api/private`, { headers: { Authorization: `Bearer ${token}` } })
        .then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
}

function refresh(body: Row, headers: Record<string, string> = {}) {
    return fetch(`${base}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: (await r.json()) as any, setCookie: r.headers.get('set-cookie') }));
}

function logout(headers: Record<string, string>, body: Row = {}) {
    return fetch(`${base}/api/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, setCookie: r.headers.get('set-cookie') }));
}

const expiredToken = (sid: string, userId = ALICE.id) => jwt.sign(
    { userId, sid, role: 'MEMBER', isAdmin: false, typ: 'access' },
    config.jwtSecret,
    { algorithm: 'HS256', expiresIn: -60 },
);

const cookieValue = (setCookie: string | null) =>
    decodeURIComponent(setCookie?.match(new RegExp(`${REFRESH_COOKIE}=([^;]*)`))?.[1] ?? '');

// ─── Access tokens ───────────────────────────────────────────────────────────

describe('access tokens', () => {
    it('lets a live session through and names it', async () => {
        const { token, sessionId } = await signIn();
        const res = await getPrivate(token);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ userId: ALICE.id, sessionId });
    });

    it('lasts 15 minutes by default', async () => {
        const { token } = await signIn();
        const { exp, iat } = jwt.decode(token) as { exp: number; iat: number };
        expect(exp - iat).toBe(15 * 60);
    });

    it('asks for a refresh when the token has expired', async () => {
        const { sessionId } = await signIn();
        const res = await getPrivate(expiredToken(sessionId));
        expect(res.status).toBe(401);
        expect(res.body.reason).toBe('token_expired');
    });

    it('refuses tokens from before sessions existed, and forged ones', async () => {
        const legacy = jwt.sign({ userId: ALICE.id, role: 'MEMBER', isAdmin: false }, config.jwtSecret, { algorithm: 'HS256', expiresIn: '7d' });
        const { sessionId } = await signIn();
        const forged = jwt.sign({ userId: ALICE.id, sid: sessionId, role: 'MEMBER', isAdmin: true, typ: 'access' }, 'not-the-secret', { algorithm: 'HS256' });
        for (const token of [legacy, forged, 'garbage']) {
            const res = await getPrivate(token);
            expect(res.status).toBe(401);
            expect(res.body.reason).toBe('invalid_token');
        }
    });

    it('stops working the moment its session is revoked, not when it expires', async () => {
        const { token, sessionId } = await signIn();
        await revokeSession(sessionId, 'logout');
        const res = await getPrivate(token);
        expect(res.status).toBe(401);
        expect(res.body.reason).toBe('session_ended');
    });

    it('refuses a session that has sat idle past its limit', async () => {
        const { token, sessionId } = await signIn();
        sessionRow(sessionId).expiresAt = new Date(Date.now() - 1000);
        expect((await getPrivate(token)).body.reason).toBe('session_ended');
    });

    it('refuses a token naming a session that belongs to someone else', async () => {
        const { sessionId } = await signIn(BOB);
        const res = await getPrivate(signAccessToken(ALICE, sessionId));
        expect(res.body.reason).toBe('session_ended');
    });

    it('turns away suspended and deleted accounts on every request', async () => {
        const { token } = await signIn();
        db.state.users[0].isBanned = true;
        expect((await getPrivate(token)).body.reason).toBe('suspended');
        db.state.users[0].isBanned = false;
        db.state.users[0].deletedAt = new Date();
        expect((await getPrivate(token)).body.reason).toBe('account_deleted');
    });

    it('answers 503, not "signed out", when the database fails', async () => {
        const { token } = await signIn();
        db.state.failNextRead = true;
        const res = await getPrivate(token);
        expect(res.status).toBe(503);
        expect(res.body.reason).toBeUndefined();
    });
});

// ─── Refresh ─────────────────────────────────────────────────────────────────

describe('refresh', () => {
    it('swaps the refresh token for a new one and a working access token', async () => {
        const first = await signIn();
        const res = await refresh({ refreshToken: first.refreshToken });

        expect(res.status).toBe(200);
        expect(res.body.refreshToken).toMatch(/^rt1\./);
        expect(res.body.refreshToken).not.toBe(first.refreshToken);
        expect(res.body.expiresIn).toBe(15 * 60);
        expect((await getPrivate(res.body.token)).status).toBe(200);
        expect(sessionRow(first.sessionId).counter).toBe(1);
    });

    it('gives a retry of the token just replaced the same new token', async () => {
        const first = await signIn();
        const a = await refresh({ refreshToken: first.refreshToken });
        const b = await refresh({ refreshToken: first.refreshToken });

        expect(b.status).toBe(200);
        expect(b.body.refreshToken).toBe(a.body.refreshToken);
        expect(sessionRow(first.sessionId).counter).toBe(1);
    });

    it('lets two tabs refresh at once without ending the session', async () => {
        const first = await signIn();
        const results = await Promise.all(Array.from({ length: 5 }, () => refresh({ refreshToken: first.refreshToken })));

        expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
        expect(new Set(results.map((r) => r.body.refreshToken)).size).toBe(1);
        expect(sessionRow(first.sessionId).counter).toBe(1);
        expect(sessionRow(first.sessionId).revokedAt).toBeNull();
    });

    it('ends the session when a replaced token comes back after the grace period', async () => {
        const first = await signIn();
        const second = await refresh({ refreshToken: first.refreshToken });
        sessionRow(first.sessionId).rotatedAt = new Date(Date.now() - 2 * 60 * 1000);

        // A stolen copy of the old token...
        const reuse = await refresh({ refreshToken: first.refreshToken });
        expect(reuse.status).toBe(401);
        expect(reuse.body.reason).toBe('session_ended');
        expect(sessionRow(first.sessionId).revokedReason).toBe('reuse');

        // ...signs out the holder of the current one too, and its access token.
        expect((await refresh({ refreshToken: second.body.refreshToken })).status).toBe(401);
        expect((await getPrivate(second.body.token)).body.reason).toBe('session_ended');
    });

    it('ends the session when the owner comes back after a thief refreshed twice', async () => {
        const first = await signIn();
        const thief1 = await refresh({ refreshToken: first.refreshToken });
        await refresh({ refreshToken: thief1.body.refreshToken });

        const owner = await refresh({ refreshToken: first.refreshToken });
        expect(owner.status).toBe(401);
        expect(sessionRow(first.sessionId).revokedReason).toBe('reuse');
    });

    it('ignores a made-up token for a real session: session ids are not secret', async () => {
        const first = await signIn();
        // Every access token carries its session id, readable without the key.
        const { sid } = jwt.decode(first.token) as { sid: string };
        for (const refreshToken of [`rt1.${sid}.0.${'A'.repeat(43)}`, `rt1.${sid}.5.${'A'.repeat(43)}`]) {
            const res = await refresh({ refreshToken });
            expect(res.status).toBe(401);
        }
        expect(sessionRow(first.sessionId).revokedAt).toBeNull();
        expect((await refresh({ refreshToken: first.refreshToken })).status).toBe(200);
    });

    it('rejects malformed tokens without touching any session', async () => {
        const first = await signIn();
        for (const refreshToken of ['', 'nope', `rt2.${first.sessionId}.0.x`, `rt1.${first.sessionId}.0`, `rt1.${first.sessionId}.x.y`, 'rt1.unknown.0.abc', 42]) {
            const res = await refresh({ refreshToken });
            expect(res.status).toBe(401);
            expect(res.body.reason).toBe('session_ended');
        }
        expect(sessionRow(first.sessionId).revokedAt).toBeNull();
    });

    it('ends a suspended member’s session at refresh', async () => {
        const first = await signIn();
        db.state.users[0].isBanned = true;
        const res = await refresh({ refreshToken: first.refreshToken });
        expect(res.status).toBe(401);
        expect(res.body.reason).toBe('suspended');
        expect(sessionRow(first.sessionId).revokedReason).toBe('suspended');
    });

    it('pushes the idle limit back, but never past the hard limit', async () => {
        const first = await signIn();
        const row = sessionRow(first.sessionId);
        row.expiresAt = new Date(Date.now() + DAY);
        await refresh({ refreshToken: first.refreshToken });
        expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * DAY);

        row.maxExpiresAt = new Date(Date.now() + 2 * DAY);
        const again = await refresh({ refreshToken: (await refresh({ refreshToken: first.refreshToken })).body.refreshToken });
        expect(again.status).toBe(200);
        expect(row.expiresAt.getTime()).toBeLessThanOrEqual(row.maxExpiresAt.getTime());
    });

    it('refuses a session past its hard limit', async () => {
        const first = await signIn();
        sessionRow(first.sessionId).maxExpiresAt = new Date(Date.now() - 1000);
        expect((await refresh({ refreshToken: first.refreshToken })).status).toBe(401);
    });
});

// ─── Web app: the refresh token is a cookie it can't read ────────────────────

describe('web app cookie', () => {
    it('refreshes from an httpOnly, SameSite=Strict cookie and never puts the token in the body', async () => {
        const first = await signIn();
        const res = await refresh({}, { Origin: WEB, Cookie: `${REFRESH_COOKIE}=${encodeURIComponent(first.refreshToken)}` });

        expect(res.status).toBe(200);
        expect(res.body.token).toBeTruthy();
        expect(res.body.refreshToken).toBeUndefined();
        expect(res.setCookie).toMatch(/HttpOnly/i);
        expect(res.setCookie).toMatch(/SameSite=Strict/i);
        expect(res.setCookie).toMatch(/Path=\/api\/auth/);
        expect(cookieValue(res.setCookie)).toMatch(/^rt1\./);
        expect(cookieValue(res.setCookie)).not.toBe(first.refreshToken);
    });

    it('ignores a refresh token in the body from a web page', async () => {
        const first = await signIn();
        const res = await refresh({ refreshToken: first.refreshToken }, { Origin: WEB });
        expect(res.status).toBe(401);
        expect(sessionRow(first.sessionId).counter).toBe(0);
    });

    it('clears the cookie when the session is over', async () => {
        const res = await refresh({}, { Origin: WEB, Cookie: `${REFRESH_COOKIE}=rt1.nope.nope` });
        expect(res.status).toBe(401);
        expect(res.setCookie).toMatch(new RegExp(`${REFRESH_COOKIE}=;`));
    });

    it('refuses other sites before touching a session or the cookie', async () => {
        const first = await signIn();
        for (const origin of ['https://evil.example', 'https://git.example.test', 'null']) {
            const r = await refresh({}, { Origin: origin, Cookie: `${REFRESH_COOKIE}=${encodeURIComponent(first.refreshToken)}` });
            expect(r.status).toBe(403);
            expect(r.body.reason).toBe('bad_origin');
            expect(r.setCookie).toBeNull();
            const out = await logout({ Origin: origin, Cookie: `${REFRESH_COOKIE}=${encodeURIComponent(first.refreshToken)}` });
            expect(out.status).toBe(403);
            expect(out.setCookie).toBeNull();
        }
        expect(sessionRow(first.sessionId).counter).toBe(0);
        expect(sessionRow(first.sessionId).revokedAt).toBeNull();
    });

    it('trusts neither cookie when two arrive (one was planted)', async () => {
        const alice = await signIn();
        const mallory = await signIn(BOB);
        const res = await refresh({}, { Origin: WEB, Cookie: `${REFRESH_COOKIE}=${mallory.refreshToken}; ${REFRESH_COOKIE}=${alice.refreshToken}` });
        expect(res.status).toBe(401);
        expect(sessionRow(alice.sessionId).counter).toBe(0);
        expect(sessionRow(mallory.sessionId).counter).toBe(0);
    });

    it('treats the native app like other clients: token in the body', async () => {
        const first = await signIn();
        const res = await refresh({ refreshToken: first.refreshToken }, { Origin: 'capacitor://localhost' });
        expect(res.status).toBe(200);
        expect(res.body.refreshToken).toMatch(/^rt1\./);
        expect(res.setCookie).toBeNull();
    });
});

// ─── Logout ──────────────────────────────────────────────────────────────────

describe('logout', () => {
    it('ends the session: neither token works afterwards', async () => {
        const first = await signIn();
        expect((await logout({ Authorization: `Bearer ${first.token}` })).status).toBe(200);
        expect(sessionRow(first.sessionId).revokedReason).toBe('logout');
        expect((await getPrivate(first.token)).body.reason).toBe('session_ended');
        expect((await refresh({ refreshToken: first.refreshToken })).status).toBe(401);
    });

    it('works with an expired access token', async () => {
        const first = await signIn();
        await logout({ Authorization: `Bearer ${expiredToken(first.sessionId)}` });
        expect(sessionRow(first.sessionId).revokedReason).toBe('logout');
    });

    it('works with the refresh token alone, but not a made-up one', async () => {
        const first = await signIn();
        const other = await signIn(BOB);
        await logout({}, { refreshToken: `rt1.${other.sessionId}.0.${'A'.repeat(43)}` });
        expect(sessionRow(other.sessionId).revokedAt).toBeNull();

        await logout({}, { refreshToken: first.refreshToken });
        expect(sessionRow(first.sessionId).revokedReason).toBe('logout');
    });

    it('clears the web app’s cookie', async () => {
        const first = await signIn();
        const res = await logout({ Origin: WEB, Cookie: `${REFRESH_COOKIE}=${encodeURIComponent(first.refreshToken)}` });
        expect(res.setCookie).toMatch(new RegExp(`${REFRESH_COOKIE}=;`));
        expect(sessionRow(first.sessionId).revokedReason).toBe('logout');
    });

    it('removes this phone’s push registration with the session, and only its own', async () => {
        const first = await signIn();
        db.state.deviceTokens = [
            { userId: ALICE.id, token: 'apns-phone' },
            { userId: ALICE.id, token: 'apns-tablet' },
            { userId: BOB.id, token: 'apns-bob' },
        ];
        await logout({ Authorization: `Bearer ${first.token}` }, { pushToken: 'apns-phone' });
        expect(db.state.deviceTokens.map((t) => t.token)).toEqual(['apns-tablet', 'apns-bob']);
        // Someone else's token can't be removed this way.
        const bob = await signIn(BOB);
        await logout({ Authorization: `Bearer ${bob.token}` }, { pushToken: 'apns-tablet' });
        expect(db.state.deviceTokens.map((t) => t.token)).toEqual(['apns-tablet', 'apns-bob']);
    });

    it('keeps the cookie of a newer session when an older logout is retried', async () => {
        const old = await signIn();
        const now = await signIn();
        const res = await logout({ Origin: WEB, Authorization: `Bearer ${old.token}`, Cookie: `${REFRESH_COOKIE}=${encodeURIComponent(now.refreshToken)}` });
        expect(res.status).toBe(200);
        expect(sessionRow(old.sessionId).revokedReason).toBe('logout');
        expect(res.setCookie).toBeNull();
        expect(sessionRow(now.sessionId).revokedAt).toBeNull();
    });

    it('only ends this device’s session', async () => {
        const phone = await signIn();
        const laptop = await signIn();
        await logout({ Authorization: `Bearer ${phone.token}` });
        expect((await getPrivate(laptop.token)).status).toBe(200);
    });
});

// ─── Bans, deletions, cleanup ────────────────────────────────────────────────

describe('ending every session', () => {
    it('signs a member out on every device, and no one else', async () => {
        const phone = await signIn();
        const laptop = await signIn();
        const bob = await signIn(BOB);

        expect(await revokeUserSessions(ALICE.id, 'suspended')).toBe(2);
        expect((await getPrivate(phone.token)).body.reason).toBe('session_ended');
        expect((await getPrivate(laptop.token)).body.reason).toBe('session_ended');
        expect((await getPrivate(bob.token)).status).toBe(200);
    });

    it('deletes sessions that ended over 30 days ago and keeps the rest', async () => {
        const live = await signIn();
        const recent = await signIn();
        const old = await signIn();
        const stale = await signIn();
        sessionRow(recent.sessionId).revokedAt = new Date(Date.now() - 5 * DAY);
        sessionRow(old.sessionId).revokedAt = new Date(Date.now() - 31 * DAY);
        sessionRow(stale.sessionId).expiresAt = new Date(Date.now() - 31 * DAY);

        expect(await deleteOldSessions()).toBe(2);
        expect(db.state.sessions.map((s) => s.id).sort()).toEqual([live.sessionId, recent.sessionId].sort());
    });
});

// ─── WebSocket ───────────────────────────────────────────────────────────────

describe('WebSocket', () => {
    const wsUrl = () => base.replace('http', 'ws') + '/ws';

    function open(protocols?: string[]) {
        const ws = new WebSocket(wsUrl(), protocols);
        const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
        const firstMessage = new Promise<any>((resolve) => ws.on('message', (data) => resolve(JSON.parse(String(data)))));
        return { ws, closed, firstMessage };
    }

    it('signs in with the token as a subprotocol and answers with the protocol name only', async () => {
        const { token } = await signIn();
        const { ws, firstMessage } = open([WS_PROTOCOL, token]);
        expect(await firstMessage).toEqual({ type: 'connected', userId: ALICE.id });
        expect(ws.protocol).toBe(WS_PROTOCOL);
        ws.close();
    });

    it('closes with 4001 (refresh) without a token or with an expired one', async () => {
        const { sessionId } = await signIn();
        expect(await open().closed).toBe(4001);
        expect(await open([WS_PROTOCOL, expiredToken(sessionId)]).closed).toBe(4001);
    });

    it('closes with 4003 (signed out) when its session ends', async () => {
        const { token, sessionId } = await signIn();
        const { closed, firstMessage } = open([WS_PROTOCOL, token]);
        await firstMessage;
        await revokeSession(sessionId, 'logout');
        expect(await closed).toBe(4003);
    });

    it('refuses to open for an ended session', async () => {
        const { token, sessionId } = await signIn();
        await revokeSession(sessionId, 'logout');
        expect(await open([WS_PROTOCOL, token]).closed).toBe(4003);
    });
});
