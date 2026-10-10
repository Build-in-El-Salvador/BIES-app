/**
 * The general rate limit is per account for signed-in requests and per IP
 * otherwise, so people sharing a network (event Wi-Fi) don't share a limit.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import type { Server } from 'http';
import { signAccessToken } from '../../services/session.service';
import { rateLimitKey } from '../rateLimitKey';
import { config } from '../../config';

let server: Server;
let base: string;

beforeAll(async () => {
    const app = express();
    app.set('trust proxy', 1);
    app.use(rateLimit({ windowMs: 60_000, max: 2, keyGenerator: rateLimitKey, standardHeaders: true, legacyHeaders: false }));
    app.get('/ping', (_req, res) => { res.json({ ok: true }); });
    await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${address.port}`;
});

afterAll(() => { server?.close(); });

const ping = (ip: string, token?: string) => fetch(`${base}/ping`, {
    headers: { 'X-Forwarded-For': ip, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
}).then((r) => r.status);

describe('rateLimitKey', () => {
    it('gives each signed-in account on one IP its own limit', async () => {
        const alice = signAccessToken({ id: 'u-alice', role: 'MEMBER', isAdmin: false }, 's-alice');
        const bob = signAccessToken({ id: 'u-bob', role: 'MEMBER', isAdmin: false }, 's-bob');
        expect(await ping('203.0.113.1', alice)).toBe(200);
        expect(await ping('203.0.113.1', alice)).toBe(200);
        expect(await ping('203.0.113.1', alice)).toBe(429);
        // Same IP, different account: unaffected.
        expect(await ping('203.0.113.1', bob)).toBe(200);
    });

    it('keeps counting an expired token against its account', async () => {
        // The app refreshes with its expired access token attached, so a room
        // renewing sessions together is limited per person, not per Wi-Fi.
        const expired = jwt.sign(
            { userId: 'u-carol', sid: 's-carol', role: 'MEMBER', isAdmin: false, typ: 'access' },
            config.jwtSecret,
            { algorithm: 'HS256', expiresIn: -60 },
        );
        const dave = signAccessToken({ id: 'u-dave', role: 'MEMBER', isAdmin: false }, 's-dave');
        expect(await ping('203.0.113.4', expired)).toBe(200);
        expect(await ping('203.0.113.4', expired)).toBe(200);
        expect(await ping('203.0.113.4', expired)).toBe(429);
        expect(await ping('203.0.113.4', dave)).toBe(200);
    });

    it('limits requests without a valid token by IP', async () => {
        const forged = jwt.sign({ userId: 'u-alice' }, 'not-the-secret', { algorithm: 'HS256' });
        expect(await ping('203.0.113.2')).toBe(200);
        expect(await ping('203.0.113.2', forged)).toBe(200);
        // A forged token shares the IP's bucket, not alice's.
        expect(await ping('203.0.113.2', 'garbage')).toBe(429);
        expect(await ping('203.0.113.3')).toBe(200);
    });
});
