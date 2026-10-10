/**
 * Attacks found in review of session hardening, kept as regression tests:
 * forged refresh tokens, other sites signing visitors in or out, planted
 * cookies, old tokens draining a member's rate limit, WebSockets outliving
 * their session, and a logout that fails halfway. Real routes and
 * middleware against an in-memory Prisma stand-in.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import WebSocket from 'ws';

vi.hoisted(() => {
    process.env.CORS_NATIVE_ORIGIN = 'capacitor://localhost,https://localhost';
    process.env.CORS_ORIGIN = 'https://app.example.test';
});

type Row = Record<string, any>;

const db = vi.hoisted(() => {
    const state = {
        sessions: [] as Row[], users: [] as Row[], seq: 0,
        failNextWrite: false,
        onSessionRead: null as null | ((row: Row) => Promise<void>),
    };
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
            const row = state.sessions.find((s) => s.id === where.id);
            if (!row) return null;
            const user = state.users.find((u) => u.id === row.userId);
            const snapshot = { ...row, user: user ? { ...user } : null };
            if (state.onSessionRead) {
                const hook = state.onSessionRead;
                state.onSessionRead = null;
                await hook(row);
            }
            return snapshot;
        }),
        updateMany: vi.fn(async ({ where, data }: Row) => {
            await io();
            if (state.failNextWrite) {
                state.failNextWrite = false;
                throw new Error('database unavailable');
            }
            let count = 0;
            for (const row of state.sessions) {
                if (matches(row, where)) { Object.assign(row, data); count++; }
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

    const user = {
        findUnique: vi.fn(async ({ where }: Row) => {
            await io();
            const u = state.users.find((x) => (where.id ? x.id === where.id : x.email === where.email));
            return u ? { ...u, profile: { id: `p-${u.id}`, name: u.id } } : null;
        }),
        // ON DELETE CASCADE, as SQLite does for sessions.user_id
        delete: vi.fn(async ({ where }: Row) => {
            await io();
            const u = state.users.find((x) => x.id === where.id);
            state.users = state.users.filter((x) => x.id !== where.id);
            state.sessions = state.sessions.filter((s) => s.userId !== where.id);
            return u;
        }),
    };

    return { state, session, user };
});

vi.mock('../lib/prisma', () => ({ default: { session: db.session, user: db.user } }));
vi.mock('../services/emailCode.service', () => ({
    CODE_TTL_SECONDS: 600,
    RESEND_COOLDOWN_SECONDS: 60,
    issueEmailCode: vi.fn(),
    // The attacker's own address and the code that was mailed to them.
    verifyEmailCode: vi.fn(async (email: string, _purpose: string, code: string) =>
        email === 'mallory@evil.example' && code === '123456' ? { ok: true, email } : { ok: false, reason: 'invalid', attemptsLeft: 4 }),
}));
vi.mock('../services/relayWhitelist.service', () => ({ HEX_PUBKEY_RE: /^[0-9a-f]{64}$/, addToRelayWhitelist: vi.fn() }));
vi.mock('../services/nostr.service', () => ({ publishRelayList: vi.fn().mockResolvedValue(null) }));
vi.mock('../services/voucher.service', () => ({ recordOnboardingRedemption: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/email.service', () => ({ sendEmail: vi.fn() }));

import authRoutes from '../routes/auth.routes';
import settingsRoutes from '../routes/settings.routes';
import { authenticate, optionalAuth } from '../middleware/auth';
import { config } from '../config';
import { rateLimitKey } from '../utils/rateLimitKey';
import { attachWebSocketServer, WS_PROTOCOL, sendToUser } from '../services/websocket.service';
import { REFRESH_COOKIE, createSession, revokeSession, signAccessToken } from '../services/session.service';

const WEB = 'https://app.example.test';
const ALICE = { id: 'u-alice', email: 'alice@example.com', nostrPubkey: 'a'.repeat(64), role: 'MEMBER', isAdmin: false, isBanned: false, deletedAt: null, encryptedPrivkey: 'x' };
const BOB = { ...ALICE, id: 'u-bob', email: 'bob@example.com', nostrPubkey: 'b'.repeat(64) };
const MALLORY = { ...ALICE, id: 'u-mallory', email: 'mallory@evil.example', nostrPubkey: 'c'.repeat(64) };

let server: http.Server;
let base: string;
let limited: http.Server;
let limitedBase: string;

function listen(app: express.Express): Promise<[http.Server, string]> {
    const s = http.createServer(app);
    return new Promise((resolve) => s.listen(0, () => {
        const a = s.address() as { port: number };
        resolve([s, `http://127.0.0.1:${a.port}`]);
    }));
}

beforeAll(async () => {
    // Production order: json, urlencoded, then routes.
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use('/api/auth', authRoutes);
    app.use('/api/settings', settingsRoutes);
    app.get('/api/private', authenticate, (req, res) => res.json({ userId: req.user!.id }));
    app.get('/api/public', optionalAuth, (req, res) => res.json({ userId: req.user?.id ?? null }));
    [server, base] = await listen(app);
    attachWebSocketServer(server);

    // The production general limiter (index.ts), in front of the auth routes.
    const lapp = express();
    lapp.set('trust proxy', true);
    lapp.use(express.json());
    lapp.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKey }));
    lapp.use('/api/auth', authRoutes);
    lapp.get('/api/private', authenticate, (req, res) => res.json({ userId: req.user!.id }));
    [limited, limitedBase] = await listen(lapp);
});

afterAll(() => { server?.close(); limited?.close(); });

beforeEach(() => {
    db.state.sessions = [];
    db.state.users = [{ ...ALICE }, { ...BOB }, { ...MALLORY }];
    db.state.failNextWrite = false;
    db.state.onSessionRead = null;
});

const row = (id: string) => db.state.sessions.find((s) => s.id === id)!;

async function signIn(user = ALICE) {
    const issued = await createSession(user.id, 'api');
    return { ...issued, token: signAccessToken(user, issued.sessionId) };
}

const post = (url: string, headers: Record<string, string>, body: string) =>
    fetch(url, { method: 'POST', headers, body }).then(async (r) => ({
        status: r.status, body: (await r.json().catch(() => ({}))) as any, setCookie: r.headers.get('set-cookie'),
    }));

const getPrivate = (token: string) => fetch(`${base}/api/private`, { headers: { Authorization: `Bearer ${token}` } })
    .then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

const cookieValue = (setCookie: string | null) =>
    decodeURIComponent(setCookie?.match(new RegExp(`${REFRESH_COOKIE}=([^;]*)`))?.[1] ?? '');

// ─── Forged refresh tokens ───────────────────────────────────────────────────

describe('a session id alone', () => {
    it('can’t end anyone’s session, even with every id from a leaked backup', async () => {
        const alice = await signIn(ALICE);
        const bob = await signIn(BOB);
        for (const id of db.state.sessions.map((s) => s.id)) {
            for (const refreshToken of [`rt1.${id}.x`, `rt1.${id}.0.x`, `rt1.${id}.0.${'A'.repeat(43)}`]) {
                const r = await post(`${base}/api/auth/refresh`, { 'Content-Type': 'application/json' }, JSON.stringify({ refreshToken }));
                expect(r.status).toBe(401);
            }
        }
        expect(row(alice.sessionId).revokedAt).toBeNull();
        expect(row(bob.sessionId).revokedAt).toBeNull();
        expect((await getPrivate(alice.token)).status).toBe(200);
    });
});

// ─── Other sites ─────────────────────────────────────────────────────────────

describe('another site', () => {
    it('can’t sign a visitor into the attacker’s account with a form post', async () => {
        const r = await post(`${base}/api/auth/email/verify`,
            { Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' },
            'email=mallory%40evil.example&code=123456');
        expect(r.status).toBe(403);
        expect(r.setCookie).toBeNull();
        expect(db.state.sessions).toHaveLength(0);
    });

    it('can’t clear a visitor’s cookie through logout or refresh', async () => {
        for (const path of ['logout', 'refresh']) {
            const r = await post(`${base}/api/auth/${path}`, { Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' }, '');
            expect(r.status).toBe(403);
            expect(r.setCookie).toBeNull();
        }
    });

    it('can’t end a session from a sibling subdomain that the cookie reaches', async () => {
        const alice = await signIn(ALICE);
        const r = await post(`${base}/api/auth/logout`, { Origin: 'https://git.example.test', 'Content-Type': 'text/plain', Cookie: `${REFRESH_COOKIE}=${encodeURIComponent(alice.refreshToken)}` }, '');
        expect(r.status).toBe(403);
        expect(row(alice.sessionId).revokedAt).toBeNull();
    });

    it('can’t choose the account by planting a second cookie', async () => {
        const alice = await signIn(ALICE);
        const mallory = await signIn(MALLORY);
        const r = await post(`${base}/api/auth/refresh`, { Origin: WEB, 'Content-Type': 'application/json', Cookie: `${REFRESH_COOKIE}=${mallory.refreshToken}; ${REFRESH_COOKIE}=${alice.refreshToken}` }, '{}');
        expect(r.status).toBe(401);
        expect(r.body.token).toBeUndefined();
        expect(row(alice.sessionId).counter).toBe(0);
    });

    it('leaves the web app itself signing in with a cookie', async () => {
        const r = await post(`${base}/api/auth/email/verify`, { Origin: WEB, 'Content-Type': 'application/json' }, JSON.stringify({ email: 'mallory@evil.example', code: '123456' }));
        expect(r.status).toBe(200);
        expect(r.body.refreshToken).toBeUndefined();
        expect(cookieValue(r.setCookie)).toMatch(/^rt1\./);
    });
});

// ─── Rate limits ─────────────────────────────────────────────────────────────

describe('an access token leaked long ago', () => {
    it('can’t use up its owner’s rate limit', async () => {
        const now = Math.floor(Date.now() / 1000);
        const ancient = jwt.sign({ userId: ALICE.id, sid: 'gone', role: 'MEMBER', isAdmin: false, typ: 'access', iat: now - 366 * 86400, exp: now - 365 * 86400 }, config.jwtSecret, { algorithm: 'HS256' });
        for (let i = 0; i < 300; i += 50) {
            await Promise.all(Array.from({ length: 50 }, () => fetch(`${limitedBase}/api/private`, { headers: { Authorization: `Bearer ${ancient}`, 'X-Forwarded-For': '198.51.100.66' } })));
        }
        const alice = await signIn(ALICE);
        const r = await fetch(`${limitedBase}/api/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}`, 'X-Forwarded-For': '203.0.113.9' },
            body: JSON.stringify({ refreshToken: alice.refreshToken }),
        });
        expect(r.status).toBe(200);
        expect((await fetch(`${limitedBase}/api/private`, { headers: { Authorization: `Bearer ${alice.token}`, 'X-Forwarded-For': '203.0.113.9' } })).status).toBe(200);
    });
});

// ─── WebSockets ──────────────────────────────────────────────────────────────

describe('a WebSocket', () => {
    const wsUrl = () => base.replace('http', 'ws') + '/ws';
    function open(token: string) {
        const ws = new WebSocket(wsUrl(), [WS_PROTOCOL, token]);
        const closed = new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
        const connected = new Promise<void>((resolve) => ws.on('message', (d) => { if (JSON.parse(String(d)).type === 'connected') resolve(); }));
        return { ws, closed, connected };
    }

    it('closes when its session ends while the connect-time check is running', async () => {
        const alice = await signIn(ALICE);
        db.state.onSessionRead = async (r) => { await revokeSession(r.id, 'logout'); };
        const s = open(alice.token);
        expect(await s.closed).toBe(4003);
        expect(sendToUser(ALICE.id, { type: 'notification', n: 1 })).toBe(0);
    });

    it('closes when the member deletes their account', async () => {
        const alice = await signIn(ALICE);
        const s = open(alice.token);
        await s.connected;
        const del = await fetch(`${base}/api/settings/account`, { method: 'DELETE', headers: { Authorization: `Bearer ${alice.token}` } });
        expect(del.status).toBe(200);
        expect(await s.closed).toBe(4003);
        expect(sendToUser(ALICE.id, { type: 'notification' })).toBe(0);
    });
});

// ─── A logout that fails halfway ─────────────────────────────────────────────

describe('a logout the database fails', () => {
    it('still clears the web cookie, and reports the failure so the app retries', async () => {
        const alice = await signIn(ALICE);
        db.state.failNextWrite = true;
        const out = await post(`${base}/api/auth/logout`, { Origin: WEB, 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}`, Cookie: `${REFRESH_COOKIE}=${encodeURIComponent(alice.refreshToken)}` }, '{}');
        expect(out.status).toBe(500);
        expect(out.setCookie).toMatch(new RegExp(`${REFRESH_COOKIE}=;`));
        // The app's retry, with the access token alone, ends it.
        const retry = await post(`${base}/api/auth/logout`, { Origin: WEB, 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` }, '{}');
        expect(retry.status).toBe(200);
        expect(row(alice.sessionId).revokedReason).toBe('logout');
    });
});

// ─── Legacy tokens ───────────────────────────────────────────────────────────

describe('tokens from before sessions', () => {
    it('are refused by optionalAuth, the WebSocket and logout', async () => {
        const legacy = jwt.sign({ userId: ALICE.id, role: 'MEMBER', isAdmin: false }, config.jwtSecret, { algorithm: 'HS256', expiresIn: '7d' });
        const pub = (await fetch(`${base}/api/public`, { headers: { Authorization: `Bearer ${legacy}` } }).then((r) => r.json())) as { userId: string | null };
        expect(pub.userId).toBeNull();
        const ws = new WebSocket(base.replace('http', 'ws') + '/ws', [WS_PROTOCOL, legacy]);
        expect(await new Promise((r) => ws.on('close', (c) => r(c)))).toBe(4001);
        const alice = await signIn(ALICE);
        await post(`${base}/api/auth/logout`, { 'Content-Type': 'application/json', Authorization: `Bearer ${legacy}` }, '{}');
        expect(row(alice.sessionId).revokedAt).toBeNull();
    });
});
