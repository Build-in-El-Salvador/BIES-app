/**
 * In production the refresh cookie is `__Host-` prefixed: Secure, host-only
 * and on Path=/, so sibling subdomains of buildinelsalvador.com can't set or
 * overwrite it. Its own file, because the config is read once at import.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';

vi.hoisted(() => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'test-secret-for-the-production-cookie-test';
    process.env.ENCRYPTION_SECRET = 'test-encryption-secret-32-chars!';
    process.env.CORS_ORIGIN = 'https://app.example.test';
});

const sessions: Record<string, any>[] = [];
vi.mock('../lib/prisma', () => ({
    default: {
        session: {
            create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
                const row = { id: `sess-${sessions.length + 1}`, counter: 0, ...data };
                sessions.push(row);
                return row;
            }),
        },
    },
}));

import { REFRESH_COOKIE, startSession } from '../services/session.service';

let server: Server;
let base: string;

beforeAll(async () => {
    const app = express();
    app.post('/api/auth/sign-in-test', async (req, res) => {
        res.json(await startSession(req, res, { id: 'u-1', role: 'MEMBER', isAdmin: false }));
    });
    await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${address.port}`;
});

afterAll(() => { server?.close(); });

describe('production refresh cookie', () => {
    it('is __Host- prefixed, Secure, httpOnly, Strict, on Path=/ with no Domain', async () => {
        const res = await fetch(`${base}/api/auth/sign-in-test`, { method: 'POST', headers: { Origin: 'https://app.example.test' } });
        const cookie = res.headers.get('set-cookie') ?? '';
        expect(REFRESH_COOKIE).toBe('__Host-bies_rt');
        expect(cookie).toMatch(/^__Host-bies_rt=rt1\./);
        expect(cookie).toMatch(/; Path=\/(;|$)/);
        expect(cookie).toMatch(/; Secure/i);
        expect(cookie).toMatch(/; HttpOnly/i);
        expect(cookie).toMatch(/; SameSite=Strict/i);
        expect(cookie).not.toMatch(/Domain=/i);
    });
});
