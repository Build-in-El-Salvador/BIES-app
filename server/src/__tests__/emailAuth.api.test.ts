/**
 * Integration tests for email-code sign-in: the real auth router, validation
 * and emailCode.service, against an in-memory stand-in for the two Prisma
 * tables involved, with email sending mocked out.
 *
 * Covers: codes stored only as hashes, no account enumeration, the per-address
 * / per-IP / daily limits (also under parallel requests), the sign-in rate
 * limiter (also with `//` in the path), expiry, 5 tries per code, single use,
 * no code usable before its email is sent, a failed send keeping the previous
 * code, account creation with a key BIES holds (and the key never reaching
 * the client), banned and deleted accounts, the App Review address, and the
 * removal of the password endpoints.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';

const db = vi.hoisted(() => {
    process.env.REVIEW_LOGIN_EMAIL = 'Review@BIES.test';
    process.env.REVIEW_LOGIN_CODE = '424242';
    process.env.EMAIL_CODES_MAX_PER_DAY = '1000';

    type Row = Record<string, any>;
    const state = { codes: [] as Row[], users: [] as Row[], seq: 0 };

    // Just enough of Prisma's `where` semantics for the queries under test.
    function matches(row: Row, where: Row): boolean {
        return Object.entries(where).every(([key, cond]) => {
            const value = row[key];
            if (cond === null) return value === null || value === undefined;
            if (typeof cond !== 'object' || cond instanceof Date) return value === cond;
            return Object.entries(cond).every(([op, arg]) => {
                switch (op) {
                    case 'gte': return value >= (arg as any);
                    case 'gt': return value > (arg as any);
                    case 'lt': return value < (arg as any);
                    case 'not': return value !== arg;
                    default: throw new Error(`fake prisma: unsupported operator ${op}`);
                }
            });
        });
    }

    function sorted(rows: Row[], orderBy?: Row): Row[] {
        const dir = orderBy?.createdAt === 'desc' ? -1 : 1;
        return [...rows].sort((a, b) =>
            dir * (a.createdAt.getTime() - b.createdAt.getTime() || a._seq - b._seq));
    }

    const clone = (row: Row | undefined) => (row ? { ...row } : null);

    // Real databases answer asynchronously, so parallel requests interleave
    // between queries. Yield a turn of the event loop on every call so the
    // fake does too; without it, races can't show up in these tests.
    const io = () => new Promise<void>((resolve) => setImmediate(resolve));

    const emailCode = {
        deleteMany: vi.fn(async ({ where }: Row) => {
            await io();
            const before = state.codes.length;
            state.codes = state.codes.filter((r) => !matches(r, where));
            return { count: before - state.codes.length };
        }),
        findMany: vi.fn(async ({ where, orderBy }: Row) => {
            await io();
            return sorted(state.codes.filter((r) => matches(r, where)), orderBy).map(clone);
        }),
        findFirst: vi.fn(async ({ where, orderBy }: Row) => {
            await io();
            return clone(sorted(state.codes.filter((r) => matches(r, where)), orderBy)[0]);
        }),
        count: vi.fn(async ({ where }: Row) => {
            await io();
            return state.codes.filter((r) => matches(r, where)).length;
        }),
        create: vi.fn(async ({ data }: Row) => {
            await io();
            const row = {
                id: `code-${++state.seq}`, _seq: state.seq, attempts: 0, consumedAt: null,
                ipHash: null, createdAt: new Date(), ...data,
            };
            state.codes.push(row);
            return clone(row);
        }),
        delete: vi.fn(async ({ where }: Row) => {
            await io();
            state.codes = state.codes.filter((r) => r.id !== where.id);
        }),
        update: vi.fn(async ({ where, data }: Row) => {
            await io();
            const row = state.codes.find((r) => r.id === where.id);
            if (!row) throw new Error('fake prisma: no row to update');
            Object.assign(row, data);
            return clone(row);
        }),
        updateMany: vi.fn(async ({ where, data }: Row) => {
            await io();
            let count = 0;
            for (const row of state.codes) {
                if (!matches(row, where)) continue;
                count++;
                for (const [key, value] of Object.entries(data)) {
                    row[key] = value && typeof value === 'object' && 'increment' in value
                        ? row[key] + (value as { increment: number }).increment
                        : value;
                }
            }
            return { count };
        }),
    };

    const user = {
        findUnique: vi.fn(async ({ where }: Row) => {
            const found = state.users.find((u) =>
                (where.id && u.id === where.id) || (where.email && u.email === where.email));
            return found ? { ...found, profile: found.profile ? { ...found.profile } : null } : null;
        }),
        create: vi.fn(async ({ data }: Row) => {
            if (state.users.some((u) => u.email === data.email)) {
                throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
            }
            const id = `user-${++state.seq}`;
            const { profile, ...fields } = data;
            const row = {
                id, isAdmin: false, isBanned: false, deletedAt: null, ...fields,
                profile: { id: `profile-${id}`, userId: id, name: '', nip05Name: null, ...profile.create },
            };
            state.users.push(row);
            return { ...row, profile: { ...row.profile } };
        }),
    };

    const profile = {
        findFirst: vi.fn(async ({ where }: Row) =>
            state.users.map((u) => u.profile).find((p) => p.nip05Name === where.nip05Name) ?? null),
        update: vi.fn(async ({ where, data }: Row) => {
            const owner = state.users.find((u) => u.profile.id === where.id);
            Object.assign(owner!.profile, data);
            return { ...owner!.profile };
        }),
    };

    function reset() {
        state.codes = [];
        state.users = [];
    }

    return { state, emailCode, user, profile, reset };
});

vi.mock('../lib/prisma', () => ({
    default: { emailCode: db.emailCode, user: db.user, profile: db.profile },
}));
vi.mock('../services/email.service', () => ({ sendEmail: vi.fn() }));
vi.mock('../services/nostr.service', () => ({ publishRelayList: vi.fn().mockResolvedValue(null) }));
vi.mock('../services/voucher.service', () => ({ recordOnboardingRedemption: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/relayWhitelist.service', () => ({
    HEX_PUBKEY_RE: /^[0-9a-f]{64}$/,
    addToRelayWhitelist: vi.fn(),
}));

import { getPublicKey } from 'nostr-tools/pure';
import authRoutes from '../routes/auth.routes';
import { config } from '../config';
import { sendEmail } from '../services/email.service';
import { publishRelayList } from '../services/nostr.service';
import { recordOnboardingRedemption } from '../services/voucher.service';
import { addToRelayWhitelist } from '../services/relayWhitelist.service';
import { decryptPrivateKey } from '../services/crypto.service';
import { renderCodeEmail } from '../services/emailCode.service';

const mockedSend = sendEmail as ReturnType<typeof vi.fn>;

// ─── Ephemeral app (same mount as index.ts) ──────────────────────────────────

let server: Server;
let base: string;

beforeAll(async () => {
    const app = express();
    // Each test speaks from its own IP (X-Forwarded-For), so per-IP limits
    // and the sign-in rate limiter don't carry over between tests.
    app.set('trust proxy', true);
    app.use(express.json());
    app.use('/api/auth', authRoutes);
    await new Promise<void>((resolve) => {
        server = app.listen(0, resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
    server?.close();
});

let clock = Date.parse('2026-10-12T15:00:00Z');
let ipCounter = 0;
let clientIp = '10.0.0.1';

beforeEach(() => {
    vi.clearAllMocks();
    db.reset();
    mockedSend.mockResolvedValue(undefined);
    // Only Date is faked, so the HTTP server's own timers keep working.
    vi.useFakeTimers({ toFake: ['Date'] });
    clock += 7 * 24 * 60 * 60 * 1000;
    vi.setSystemTime(clock);
    ipCounter++;
    clientIp = `10.0.${ipCounter >> 8}.${ipCounter & 255}`;
});

afterEach(() => {
    vi.useRealTimers();
});

function advance(ms: number) {
    clock += ms;
    vi.setSystemTime(clock);
}

async function post(path: string, body: unknown) {
    const res = await fetch(`${base}/api/auth${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': clientIp },
        body: JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, body: (await res.json().catch(() => null)) as any };
}

/** The code in the most recent email sent. */
function lastCode(): string {
    const message = mockedSend.mock.calls.at(-1)?.[0];
    const match = message?.text.match(/\b(\d{6})\b/);
    if (!match) throw new Error('no code was emailed');
    return match[1];
}

async function requestCode(email: string) {
    const res = await post('/email/start', { email });
    expect(res.status).toBe(200);
    return lastCode();
}

// ─── Sending ─────────────────────────────────────────────────────────────────

describe('POST /api/auth/email/start', () => {
    it('emails a 6-digit code and stores only hashes', async () => {
        const res = await post('/email/start', { email: '  Alice@Example.COM ', lang: 'es' });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, expiresInSeconds: 600, resendAfterSeconds: 60 });
        expect(mockedSend).toHaveBeenCalledTimes(1);
        const message = mockedSend.mock.calls[0][0];
        expect(message.to).toBe('alice@example.com');
        expect(message.subject).toMatch(/^Su código para iniciar sesión en BIES: \d{6}$/);

        const code = lastCode();
        const stored = JSON.stringify(db.state.codes);
        expect(db.state.codes).toHaveLength(1);
        expect(stored).not.toContain(code);
        expect(stored).not.toContain('alice@example.com');
        expect(stored).not.toContain(clientIp);
    });

    it('answers the same whether or not an account exists', async () => {
        await db.user.create({ data: { email: 'member@example.com', nostrPubkey: 'a'.repeat(64), role: 'MEMBER', profile: { create: {} } } });

        const known = await post('/email/start', { email: 'member@example.com' });
        const unknown = await post('/email/start', { email: 'stranger@example.com' });

        expect(known.status).toBe(unknown.status);
        expect(known.body).toEqual(unknown.body);
        expect(mockedSend).toHaveBeenCalledTimes(2);
    });

    it('rejects an invalid address', async () => {
        const res = await post('/email/start', { email: 'not-an-email' });
        expect(res.status).toBe(400);
        expect(mockedSend).not.toHaveBeenCalled();
    });

    it('allows one code a minute per address', async () => {
        await requestCode('bob@example.com');

        const again = await post('/email/start', { email: 'bob@example.com' });
        expect(again.status).toBe(429);
        expect(again.body.reason).toBe('rate_limited');
        expect(again.body.retryAfterSeconds).toBe(60);
        expect(again.headers.get('retry-after')).toBe('60');

        advance(61_000);
        expect((await post('/email/start', { email: 'bob@example.com' })).status).toBe(200);
    });

    it('allows 5 codes an hour and 10 a day per address', async () => {
        for (let i = 0; i < 5; i++) {
            expect((await post('/email/start', { email: 'carol@example.com' })).status).toBe(200);
            advance(61_000);
        }
        const sixth = await post('/email/start', { email: 'carol@example.com' });
        expect(sixth.status).toBe(429);
        // The first of the five, sent 5 × 61 s ago, leaves the window first.
        expect(sixth.body.retryAfterSeconds).toBe(60 * 60 - 5 * 61);

        advance(60 * 60 * 1000);
        for (let i = 0; i < 5; i++) {
            expect((await post('/email/start', { email: 'carol@example.com' })).status).toBe(200);
            advance(61_000);
        }
        advance(60 * 60 * 1000);
        const eleventh = await post('/email/start', { email: 'carol@example.com' });
        expect(eleventh.status).toBe(429);
        expect(eleventh.body.retryAfterSeconds).toBeGreaterThan(20 * 60 * 60);
        expect(mockedSend).toHaveBeenCalledTimes(10);
    });

    it('allows 50 codes an hour per IP', async () => {
        for (let i = 0; i < 50; i++) {
            expect((await post('/email/start', { email: `guest${i}@example.com` })).status).toBe(200);
        }
        const res = await post('/email/start', { email: 'guest50@example.com' });
        expect(res.status).toBe(429);
        expect(res.body.reason).toBe('rate_limited');
    });

    it('stops at the daily ceiling, except for the App Review address', async () => {
        const saved = config.email.maxCodesPerDay;
        config.email.maxCodesPerDay = 2;
        try {
            await requestCode('one@example.com');
            await requestCode('two@example.com');
            const third = await post('/email/start', { email: 'three@example.com' });
            expect(third.status).toBe(429);
            expect(third.body.reason).toBe('busy');

            expect((await post('/email/start', { email: 'review@bies.test' })).status).toBe(200);
        } finally {
            config.email.maxCodesPerDay = saved;
        }
    });

    it('reports a failed send, does not count it, and keeps the earlier code', async () => {
        const first = await requestCode('dave@example.com');
        advance(61_000);

        mockedSend.mockRejectedValueOnce(new Error('Resend down'));
        const failed = await post('/email/start', { email: 'dave@example.com' });
        expect(failed.status).toBe(503);
        expect(failed.body.reason).toBe('send_failed');
        expect(db.state.codes).toHaveLength(1);

        // No cooldown from the failed attempt.
        expect((await post('/email/start', { email: 'erin@example.com' })).status).toBe(200);

        const res = await post('/email/verify', { email: 'dave@example.com', code: first });
        expect(res.status).toBe(201);
    });

    it('leaves no usable code behind when the send fails', async () => {
        mockedSend.mockRejectedValueOnce(new Error('Resend down'));
        expect((await post('/email/start', { email: 'fay@example.com' })).status).toBe(503);
        const code = lastCode();

        const res = await post('/email/verify', { email: 'fay@example.com', code });
        expect(res.status).toBe(400);
        expect(res.body.reason).toBe('code_expired');
    });

    it('does not accept a code until its email has gone out', async () => {
        let finishSending: () => void = () => {};
        mockedSend.mockImplementationOnce(() => new Promise<void>((resolve) => { finishSending = resolve; }));

        const starting = post('/email/start', { email: 'gus@example.com' });
        await vi.waitFor(() => expect(mockedSend).toHaveBeenCalledTimes(1));
        const code = lastCode();

        const early = await post('/email/verify', { email: 'gus@example.com', code });
        expect(early.body.reason).toBe('code_expired');

        finishSending();
        expect((await starting).status).toBe(200);
        expect((await post('/email/verify', { email: 'gus@example.com', code })).status).toBe(201);
    });

    it('holds the limits under parallel requests', async () => {
        const sameAddress = await Promise.all(
            Array.from({ length: 20 }, () => post('/email/start', { email: 'rush@example.com' })));
        expect(sameAddress.filter((r) => r.status === 200)).toHaveLength(1);
        expect(mockedSend).toHaveBeenCalledTimes(1);

        // The one code that went out still works.
        expect((await post('/email/verify', { email: 'rush@example.com', code: lastCode() })).status).toBe(201);

        const saved = config.email.maxCodesPerDay;
        config.email.maxCodesPerDay = 5;
        try {
            const many = await Promise.all(
                Array.from({ length: 12 }, (_, i) => post('/email/start', { email: `crowd${i}@example.com` })));
            // 1 code already sent today in this test, so 4 more fit.
            expect(many.filter((r) => r.status === 200)).toHaveLength(4);
        } finally {
            config.email.maxCodesPerDay = saved;
        }
    });

    it('rate limits sign-in requests per IP, whatever the path looks like', async () => {
        const res = await fetch(`${base}/api/auth//email/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': clientIp },
            body: JSON.stringify({ email: 'slash@example.com' }),
        });
        expect(res.headers.get('ratelimit-limit')).toBe('100');

        const burst = await Promise.all(
            Array.from({ length: 100 }, () => post('/email/verify', { email: 'slash@example.com', code: '123456' })));
        expect(burst.some((r) => r.status === 429)).toBe(true);
    });
});

// ─── Verifying ───────────────────────────────────────────────────────────────

describe('POST /api/auth/email/verify', () => {
    it('creates an account with a key BIES holds, and never returns the key', async () => {
        const code = await requestCode('New.Member@Example.com');

        const res = await post('/email/verify', { email: 'new.member@example.com', code, voucherCode: 'LAUNCH' });

        expect(res.status).toBe(201);
        expect(res.body.isNewUser).toBe(true);
        expect(typeof res.body.token).toBe('string');
        expect(res.body.user).toMatchObject({ email: 'new.member@example.com', role: 'MEMBER', isAdmin: false, hostedKey: true });
        expect(JSON.stringify(res.body)).not.toMatch(/nsec|encryptedPrivkey|privkey/i);

        const created = db.state.users[0];
        expect(created.email).toBe('new.member@example.com');
        // The stored key decrypts to the account's own pubkey.
        const secret = Uint8Array.from(Buffer.from(decryptPrivateKey(created.encryptedPrivkey), 'hex'));
        expect(getPublicKey(secret)).toBe(created.nostrPubkey);
        // The NIP-05 name comes from the pubkey, not the email address.
        expect(created.profile.nip05Name).toBe(`nostr-${created.nostrPubkey.slice(0, 8)}`);
        expect(created.profile.name).toBe('');

        expect(addToRelayWhitelist).toHaveBeenCalledWith(created.nostrPubkey);
        expect(publishRelayList).toHaveBeenCalledWith(created.id);
        expect(recordOnboardingRedemption).toHaveBeenCalledWith('LAUNCH', created.id, expect.any(String));
    });

    it('signs in an existing account without creating another', async () => {
        await db.user.create({ data: { email: 'member@example.com', nostrPubkey: 'b'.repeat(64), encryptedPrivkey: 'x', role: 'BUILDER', profile: { create: { name: 'M' } } } });
        db.user.create.mockClear();
        const code = await requestCode('member@example.com');

        const res = await post('/email/verify', { email: 'member@example.com', code });

        expect(res.status).toBe(200);
        expect(res.body.isNewUser).toBe(false);
        expect(res.body.user).toMatchObject({ role: 'BUILDER', hostedKey: true });
        expect(db.user.create).not.toHaveBeenCalled();
        expect(publishRelayList).not.toHaveBeenCalled();
        expect(addToRelayWhitelist).toHaveBeenCalledWith('b'.repeat(64));
    });

    it('allows 5 tries per code', async () => {
        const code = await requestCode('frank@example.com');
        const wrong = code === '000000' ? '111111' : '000000';

        for (const left of [4, 3, 2, 1]) {
            const res = await post('/email/verify', { email: 'frank@example.com', code: wrong });
            expect(res.status).toBe(400);
            expect(res.body).toMatchObject({ reason: 'invalid_code', attemptsLeft: left });
        }
        const fifth = await post('/email/verify', { email: 'frank@example.com', code: wrong });
        expect(fifth.body).toMatchObject({ reason: 'invalid_code', attemptsLeft: 0 });

        const right = await post('/email/verify', { email: 'frank@example.com', code });
        expect(right.status).toBe(400);
        expect(right.body.reason).toBe('code_expired');
        expect(db.state.users).toHaveLength(0);
    });

    it('works once per code', async () => {
        const code = await requestCode('gina@example.com');
        expect((await post('/email/verify', { email: 'gina@example.com', code })).status).toBe(201);

        const again = await post('/email/verify', { email: 'gina@example.com', code });
        expect(again.status).toBe(400);
        expect(again.body.reason).toBe('code_expired');
    });

    it('expires a code after 10 minutes', async () => {
        const code = await requestCode('hank@example.com');
        advance(10 * 60 * 1000 + 1000);

        const res = await post('/email/verify', { email: 'hank@example.com', code });
        expect(res.status).toBe(400);
        expect(res.body.reason).toBe('code_expired');
    });

    it('replaces an earlier code with a newer one', async () => {
        const older = await requestCode('ivy@example.com');
        advance(61_000);
        const newer = await requestCode('ivy@example.com');

        if (older !== newer) {
            const stale = await post('/email/verify', { email: 'ivy@example.com', code: older });
            expect(stale.status).toBe(400);
        }
        expect((await post('/email/verify', { email: 'ivy@example.com', code: newer })).status).toBe(201);
    });

    it('does not accept a code sent to a different address', async () => {
        const code = await requestCode('jack@example.com');
        await requestCode('kate@example.com');

        const res = await post('/email/verify', { email: 'kate@example.com', code });
        // Unless the two random codes happen to collide.
        if (code !== lastCode()) expect(res.status).toBe(400);
    });

    it('turns away banned and deleted accounts', async () => {
        await db.user.create({ data: { email: 'banned@example.com', nostrPubkey: 'c'.repeat(64), role: 'MEMBER', isBanned: true, profile: { create: {} } } });
        await db.user.create({ data: { email: 'gone@example.com', nostrPubkey: 'd'.repeat(64), role: 'MEMBER', deletedAt: new Date(), profile: { create: {} } } });

        const banned = await post('/email/verify', { email: 'banned@example.com', code: await requestCode('banned@example.com') });
        expect(banned.status).toBe(403);
        expect(banned.body.reason).toBe('suspended');
        expect(banned.body.token).toBeUndefined();

        const gone = await post('/email/verify', { email: 'gone@example.com', code: await requestCode('gone@example.com') });
        expect(gone.status).toBe(403);
        expect(gone.body.reason).toBe('deleted');
    });

    it('rejects a code that is not 6 digits', async () => {
        for (const code of ['12345', '1234567', 'abcdef']) {
            const res = await post('/email/verify', { email: 'liz@example.com', code });
            expect(res.status).toBe(400);
            expect(res.body.error).toBe('Validation failed');
        }
    });
});

// ─── App Review address ──────────────────────────────────────────────────────

describe('App Review sign-in', () => {
    it('uses the fixed code from the environment and sends no email', async () => {
        expect((await post('/email/start', { email: 'review@bies.test' })).status).toBe(200);
        expect(mockedSend).not.toHaveBeenCalled();

        const res = await post('/email/verify', { email: 'REVIEW@bies.test', code: '424242' });
        expect(res.status).toBe(201);
        expect(res.body.user.email).toBe('review@bies.test');
    });

    it('still needs the code requested first, and still limits tries', async () => {
        expect((await post('/email/verify', { email: 'review@bies.test', code: '424242' })).status).toBe(400);

        await post('/email/start', { email: 'review@bies.test' });
        for (let i = 0; i < 5; i++) await post('/email/verify', { email: 'review@bies.test', code: '000000' });
        expect((await post('/email/verify', { email: 'review@bies.test', code: '424242' })).status).toBe(400);
    });

    it('is the only address the fixed code works for', async () => {
        await requestCode('mallory@example.com');
        const res = await post('/email/verify', { email: 'mallory@example.com', code: '424242' });
        if (lastCode() !== '424242') expect(res.status).toBe(400);
    });
});

// ─── Session ─────────────────────────────────────────────────────────────────

describe('after signing in', () => {
    it('/auth/me reports a hosted key without sending it', async () => {
        const code = await requestCode('nina@example.com');
        const { body } = await post('/email/verify', { email: 'nina@example.com', code });

        const res = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${body.token}` } });
        const me = (await res.json()) as any;

        expect(res.status).toBe(200);
        expect(me).toMatchObject({ email: 'nina@example.com', hostedKey: true });
        expect(me.nostrNsec).toBeUndefined();
        expect(JSON.stringify(me)).not.toMatch(/nsec|encryptedPrivkey/i);
    });

    it('the password endpoints are gone', async () => {
        expect((await post('/register', { email: 'x@example.com', password: 'password123' })).status).toBe(404);
        expect((await post('/login', { email: 'x@example.com', password: 'password123' })).status).toBe(404);
    });
});

// ─── Email content ───────────────────────────────────────────────────────────

describe('renderCodeEmail', () => {
    it('contains the code and nothing the requester typed', () => {
        const en = renderCodeEmail('someone@example.com', '123456');
        expect(en.subject).toBe('Your BIES sign-in code: 123456');
        expect(en.text).toContain('123456');
        expect(en.html).toContain('123456');
        expect(en.text + en.html).not.toContain('someone@example.com');

        const es = renderCodeEmail('someone@example.com', '654321', 'es');
        expect(es.text).toContain('Vence en 10 minutos');
        expect(es.html).toContain('lang="es"');
    });
});
