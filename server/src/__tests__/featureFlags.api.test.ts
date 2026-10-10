/**
 * Integration tests for the feature-flag API surface and gate middleware,
 * using the real middleware chain (authenticate → requireRole('MOD') →
 * requireRole('ADMIN') → Zod validate → controller) exactly as mounted in
 * admin.routes.ts / index.ts, against a mocked Prisma client and an
 * ephemeral Express server.
 *
 * Covers the security-critical paths: anonymous PUT → 401, non-admin PUT →
 * 403, MOD PUT → 403 (true-admin-only), admin PUT → 200, unknown-slug PUT →
 * 400, and the featureGate 404 on a disabled prefix.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';

vi.mock('../lib/prisma', () => ({
    default: {
        user: { findUnique: vi.fn() },
        session: { findUnique: vi.fn() },
        siteSettings: { findUnique: vi.fn(), upsert: vi.fn() },
    },
}));

import prisma from '../lib/prisma';
import { authenticate, requireRole } from '../middleware/auth';
import { liveSessionLookup, testToken } from './helpers/session';
import { validate } from '../middleware/validate';
import { featureGate } from '../middleware/featureGate';
import { cache, cacheKey } from '../services/redis.service';
import flagsRoutes from '../routes/flags.routes';
import { updateFeatureFlags, updateFlagsSchema } from '../controllers/featureFlags.controller';

const mockedUserFind = prisma.user.findUnique as ReturnType<typeof vi.fn>;
const mockedSessionFind = prisma.session.findUnique as ReturnType<typeof vi.fn>;
const mockedSettingsFind = prisma.siteSettings.findUnique as ReturnType<typeof vi.fn>;
const mockedSettingsUpsert = prisma.siteSettings.upsert as ReturnType<typeof vi.fn>;

// ─── Fixture users ───────────────────────────────────────────────────────────

const USERS: Record<string, { id: string; email: string | null; nostrPubkey: string; role: string; isAdmin: boolean }> = {
    admin: { id: 'u-admin', email: 'a@t.local', nostrPubkey: 'pk-admin', role: 'MEMBER', isAdmin: true },
    mod: { id: 'u-mod', email: 'm@t.local', nostrPubkey: 'pk-mod', role: 'MOD', isAdmin: false },
    builder: { id: 'u-builder', email: 'b@t.local', nostrPubkey: 'pk-builder', role: 'BUILDER', isAdmin: false },
};

function tokenFor(key: keyof typeof USERS): string {
    return testToken(USERS[key]);
}

// ─── Ephemeral app (mirrors the real mounts) ─────────────────────────────────

let server: Server;
let base: string;

beforeAll(async () => {
    const app = express();
    app.use(express.json());

    // Same chain as index.ts + admin.routes.ts
    app.use('/api/flags', flagsRoutes);
    const admin = express.Router();
    admin.use(authenticate, requireRole('MOD'));
    admin.put('/flags', requireRole('ADMIN'), validate(updateFlagsSchema), updateFeatureFlags);
    app.use('/api/admin', admin);

    // A representative gated prefix (same shape as `/api/directory`).
    app.use('/api/directory', featureGate('directories'), (_req, res) => {
        res.json({ ok: true });
    });
    // The two newest gated prefixes (mirrors index.ts mounts).
    app.use('/api/marketplace', featureGate('marketplace'), (_req, res) => {
        res.json({ ok: true });
    });
    app.use('/api/bounties', featureGate('bounties'), (_req, res) => {
        res.json({ ok: true });
    });

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

beforeEach(async () => {
    vi.clearAllMocks();
    await cache.del(cacheKey.featureFlags());

    mockedUserFind.mockImplementation(({ where }: { where: { id: string } }) => {
        const user = Object.values(USERS).find((u) => u.id === where.id) || null;
        return Promise.resolve(user);
    });
    mockedSessionFind.mockImplementation(liveSessionLookup((id) => Object.values(USERS).find((u) => u.id === id)));
    mockedSettingsFind.mockResolvedValue({ featureFlags: '{}' });
    mockedSettingsUpsert.mockResolvedValue({});
});

// ─── GET /api/flags ──────────────────────────────────────────────────────────

describe('GET /api/flags', () => {
    it('is public and returns every slug enabled by default', async () => {
        const res = await fetch(`${base}/api/flags`);
        expect(res.status).toBe(200);
        const flags = (await res.json()) as Record<string, boolean>;
        expect(flags.directories).toBe(true);
        expect(flags.cowork).toBe(true);
        expect(Object.values(flags).every((v) => v === true)).toBe(true);
    });

    it('reflects a disabled flag from storage', async () => {
        mockedSettingsFind.mockResolvedValue({ featureFlags: '{"points":false}' });
        const res = await fetch(`${base}/api/flags`);
        const flags = (await res.json()) as Record<string, boolean>;
        expect(flags.points).toBe(false);
        expect(flags.news).toBe(true);
    });
});

// ─── PUT /api/admin/flags (authz) ────────────────────────────────────────────

describe('PUT /api/admin/flags', () => {
    const put = (body: unknown, token?: string) =>
        fetch(`${base}/api/admin/flags`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify(body),
        });

    it('rejects anonymous requests (401)', async () => {
        const res = await put({ points: false });
        expect(res.status).toBe(401);
        expect(mockedSettingsUpsert).not.toHaveBeenCalled();
    });

    it('rejects a garbage bearer token (401)', async () => {
        const res = await put({ points: false }, 'not-a-jwt');
        expect(res.status).toBe(401);
    });

    it('rejects regular users (403)', async () => {
        const res = await put({ points: false }, tokenFor('builder'));
        expect(res.status).toBe(403);
        expect(mockedSettingsUpsert).not.toHaveBeenCalled();
    });

    it('rejects MODs — flag mutation is true-admin-only (403)', async () => {
        const res = await put({ points: false }, tokenFor('mod'));
        expect(res.status).toBe(403);
        expect(mockedSettingsUpsert).not.toHaveBeenCalled();
    });

    it('accepts a true admin and persists the update (200)', async () => {
        const res = await put({ points: false, zaps: false }, tokenFor('admin'));
        expect(res.status).toBe(200);
        const flags = (await res.json()) as Record<string, boolean>;
        expect(flags.points).toBe(false);
        expect(flags.zaps).toBe(false);
        expect(flags.news).toBe(true);
        expect(mockedSettingsUpsert).toHaveBeenCalledTimes(1);
    });

    it('rejects unknown slugs with 400 (strict schema)', async () => {
        const res = await put({ hax: true }, tokenFor('admin'));
        expect(res.status).toBe(400);
        expect(mockedSettingsUpsert).not.toHaveBeenCalled();
    });

    it('rejects non-boolean values with 400', async () => {
        const res = await put({ points: 'off' }, tokenFor('admin'));
        expect(res.status).toBe(400);
        expect(mockedSettingsUpsert).not.toHaveBeenCalled();
    });

    it('rejects an empty body with 400', async () => {
        const res = await put({}, tokenFor('admin'));
        expect(res.status).toBe(400);
    });
});

// ─── featureGate middleware ──────────────────────────────────────────────────

describe('featureGate', () => {
    it('passes requests through while the flag is enabled', async () => {
        const res = await fetch(`${base}/api/directory`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
    });

    it('404s the whole prefix while the flag is disabled', async () => {
        mockedSettingsFind.mockResolvedValue({ featureFlags: '{"directories":false}' });
        const res = await fetch(`${base}/api/directory`);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Feature disabled' });
    });

    it('fails open when the flag read itself errors', async () => {
        mockedSettingsFind.mockRejectedValue(new Error('db down'));
        const res = await fetch(`${base}/api/directory`);
        expect(res.status).toBe(200);
    });

    it('re-enabling restores the prefix after cache invalidation', async () => {
        mockedSettingsFind.mockResolvedValue({ featureFlags: '{"directories":false}' });
        expect((await fetch(`${base}/api/directory`)).status).toBe(404);

        // Admin flips it back on (real PUT path invalidates the cache).
        mockedSettingsFind.mockResolvedValue({ featureFlags: '{"directories":false}' });
        const res = await fetch(`${base}/api/admin/flags`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor('admin')}` },
            body: JSON.stringify({ directories: true }),
        });
        expect(res.status).toBe(200);

        mockedSettingsFind.mockResolvedValue({ featureFlags: '{"directories":true}' });
        expect((await fetch(`${base}/api/directory`)).status).toBe(200);
    });
});

describe('featureGate — marketplace & bounties (runtime toggle)', () => {
    // beforeEach clears the flags cache, so each test reads its own mocked state.
    it('marketplace passes through when enabled (default)', async () => {
        expect((await fetch(`${base}/api/marketplace`)).status).toBe(200);
    });

    it('marketplace 404s while disabled', async () => {
        mockedSettingsFind.mockResolvedValue({ featureFlags: '{"marketplace":false}' });
        const res = await fetch(`${base}/api/marketplace`);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Feature disabled' });
    });

    it('bounties passes through when enabled (default)', async () => {
        expect((await fetch(`${base}/api/bounties`)).status).toBe(200);
    });

    it('bounties 404s while disabled', async () => {
        mockedSettingsFind.mockResolvedValue({ featureFlags: '{"bounties":false}' });
        const res = await fetch(`${base}/api/bounties`);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Feature disabled' });
    });

    it('the two toggles are independent — one off leaves the other on', async () => {
        mockedSettingsFind.mockResolvedValue({ featureFlags: '{"bounties":false}' });
        expect((await fetch(`${base}/api/bounties`)).status).toBe(404);
        expect((await fetch(`${base}/api/marketplace`)).status).toBe(200);
    });
});
