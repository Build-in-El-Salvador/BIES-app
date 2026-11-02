/**
 * Settings → Nostr: claiming, changing and removing a BIES address (what
 * makes a member verified), and the public Nostr profile: off until switched
 * on, built from the one already on public relays, signed by BIES for keys it
 * holds and by the member's device otherwise, and kept up to date once
 * published. Real routes against a real SQLite database built from the
 * repo's migrations; relays are stand-ins that record what was sent.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const env = vi.hoisted(() => {
    const dir = `${process.env.TMPDIR || '/tmp'}/bies-nostr-settings-test-${process.pid}-${Date.now()}`;
    process.env.DATABASE_URL = `file:${dir}/test.db`;
    process.env.RELAY_WHITELIST_PATH = `${dir}/relay/whitelist.txt`;
    process.env.CORS_ORIGIN = 'https://app.example.test';
    process.env.APP_PUBLIC_URL = 'https://app.example.test';
    process.env.TERMS_VERSION = '2026-10';
    process.env.UPLOAD_DIR = `${dir}/uploads`;
    return { dir };
});

const relays = vi.hoisted(() => ({
    publicProfiles: new Map<string, Record<string, unknown> | null>(),
    sent: [] as { id: string; pubkey: string; kind: number; content: string }[],
    accept: true,
}));

vi.mock('nostr-tools/pool', () => ({
    SimplePool: class {
        publish(urls: string[]) { return urls.map(() => Promise.resolve('')); }
        async querySync() { return []; }
        async get() { return null; }
    },
}));
vi.mock('../services/email.service', () => ({ sendEmail: vi.fn(async () => {}) }));
vi.mock('../services/nostr.service', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/nostr.service')>()),
    publishProfileUpdate: vi.fn(async () => null),
    publishAnnouncement: vi.fn(async () => null),
    fetchPublicProfile: vi.fn(async (pubkey: string) => relays.publicProfiles.get(pubkey) ?? null),
    publishToPublicRelays: vi.fn(async (event: { id: string; pubkey: string; kind: number; content: string }) => {
        if (!relays.accept) return 0;
        relays.sent.push(event);
        return 5;
    }),
}));

import { execSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import express from 'express';
import prisma from '../lib/prisma';
import profileRoutes from '../routes/profile.routes';
import settingsRoutes from '../routes/settings.routes';
import signerRoutes from '../routes/signer.routes';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { encryptPrivateKey } from '../services/crypto.service';
import { createSession, signAccessToken } from '../services/session.service';

let server: http.Server;
let base: string;

beforeAll(async () => {
    fs.mkdirSync(env.dir, { recursive: true });
    execSync('npx prisma migrate deploy', { cwd: path.resolve(__dirname, '../..'), env: process.env, stdio: 'pipe' });
    const app = express();
    app.use(express.json());
    app.use('/api/profiles', profileRoutes);
    app.use('/api/settings', settingsRoutes);
    app.use('/api/signer', signerRoutes);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 120_000);

afterAll(async () => {
    server?.close();
    await prisma.$disconnect();
    fs.rmSync(env.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

beforeEach(() => {
    relays.publicProfiles.clear();
    relays.sent.length = 0;
    relays.accept = true;
});

async function call(method: string, url: string, { token, body }: { token?: string; body?: unknown } = {}) {
    const res = await fetch(`${base}${url}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

type Member = { id: string; token: string; pubkey: string; secret: Uint8Array };

async function member(name: string, { hosted = false, profile = {} as Record<string, unknown> } = {}): Promise<Member> {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const user = await prisma.user.create({
        data: {
            nostrPubkey: pubkey, role: 'MEMBER', termsVersion: '2026-10', termsAcceptedAt: new Date(),
            ...(hosted ? { email: `${name.toLowerCase()}@example.com`, encryptedPrivkey: encryptPrivateKey(Buffer.from(secret).toString('hex')) } : {}),
            profile: { create: { name, bio: `${name}'s bio`, ...profile } },
        },
    });
    const session = await createSession(user.id, 'web');
    return { id: user.id, pubkey, secret, token: signAccessToken({ id: user.id, role: 'MEMBER', isAdmin: false }, session.sessionId) };
}

describe('BIES address', () => {
    it('is claimed by choosing a name, which makes the member verified', async () => {
        const ana = await member('Ana');
        expect((await call('GET', '/api/profiles/me', { token: ana.token })).body.verified).toBe(false);

        const saved = await call('PUT', '/api/profiles/me', { token: ana.token, body: { nip05Name: 'Ana.B' } });
        expect(saved.status).toBe(200);
        expect(saved.body.nip05Name).toBe('ana.b');

        const me = await call('GET', '/api/profiles/me', { token: ana.token });
        expect(me.body.verified).toBe(true);
        const other = await member('Other');
        const seen = await call('GET', `/api/profiles/${ana.id}`, { token: other.token });
        expect(seen.body.verified).toBe(true);
        expect(seen.body).not.toHaveProperty('publicNostr');
    });

    it('can be removed', async () => {
        const ben = await member('Ben', { profile: { nip05Name: 'ben' } });
        const removed = await call('PUT', '/api/profiles/me', { token: ben.token, body: { nip05Name: '' } });
        expect(removed.status).toBe(200);
        expect(removed.body.nip05Name).toBeNull();
        expect((await call('GET', '/api/profiles/me', { token: ben.token })).body.verified).toBe(false);
    });

    it("can't be a name like the ones sign-up handed out", async () => {
        const cleo = await member('Cleo');
        const taken = await call('PUT', '/api/profiles/me', { token: cleo.token, body: { nip05Name: 'nostr-deadbeef' } });
        expect(taken.status).toBe(409);
        expect(taken.body.reason).toBe('reserved');
        const check = await call('GET', '/api/profiles/check-nip05?name=nostr-deadbeef', { token: cleo.token });
        expect(check.body).toMatchObject({ available: false, reason: 'reserved' });
    });

    it('a sign-up address still works but is not verified, and can be kept on save', async () => {
        const dan = await member('Dan', { profile: { nip05Name: 'nostr-0a1b2c3d' } });
        expect((await call('GET', '/api/profiles/me', { token: dan.token })).body.verified).toBe(false);
        const kept = await call('PUT', '/api/profiles/me', { token: dan.token, body: { nip05Name: 'nostr-0a1b2c3d' } });
        expect(kept.status).toBe(200);
    });
});

describe('Public Nostr profile', () => {
    it('is off until switched on, and builds on the profile already on public relays', async () => {
        const eva = await member('Eva', { profile: { nip05Name: 'eva' } });
        relays.publicProfiles.set(eva.pubkey, { name: 'eva_nostr', about: 'From Primal', lud16: 'eva@primal.net' });

        const first = await call('GET', '/api/settings/nostr', { token: eva.token });
        expect(first.status).toBe(200);
        expect(first.body).toMatchObject({ on: false, publishedAt: null, hosted: false, verified: true, nip05Name: 'eva' });
        expect(first.body.current).toEqual({ name: 'eva_nostr', about: 'From Primal', lud16: 'eva@primal.net' });
        expect(first.body.next).toEqual({
            name: 'eva_nostr', display_name: 'Eva', about: "Eva's bio", lud16: 'eva@primal.net', nip05: 'eva@buildinelsalvador.com',
        });

        const off = await call('POST', '/api/settings/nostr/publish', { token: eva.token, body: {} });
        expect(off.status).toBe(409);
        expect(relays.sent).toHaveLength(0);
    });

    it('for a key on the device: BIES returns the profile to sign, checks the signed one and sends it', async () => {
        const fay = await member('Fay');
        relays.publicProfiles.set(fay.pubkey, { name: 'fay', website: 'https://fay.example' });
        expect((await call('PUT', '/api/settings/nostr', { token: fay.token, body: { on: true, parts: ['name', 'about'] } })).status).toBe(200);

        const asked = await call('POST', '/api/settings/nostr/publish', { token: fay.token, body: {} });
        expect(asked.status).toBe(200);
        expect(asked.body.published).toBe(false);
        expect(asked.body.template.kind).toBe(0);
        expect(JSON.parse(asked.body.template.content)).toEqual({ name: 'fay', website: 'https://fay.example', display_name: 'Fay', about: "Fay's bio" });

        // Someone else's key, or a changed signature: refused.
        const stranger = finalizeEvent(asked.body.template, generateSecretKey());
        expect((await call('POST', '/api/settings/nostr/publish', { token: fay.token, body: { event: stranger } })).status).toBe(400);
        const signed = finalizeEvent(asked.body.template, fay.secret);
        const forged = { ...signed, content: '{"name":"someone else"}' };
        expect((await call('POST', '/api/settings/nostr/publish', { token: fay.token, body: { event: forged } })).status).toBe(400);
        expect(relays.sent).toHaveLength(0);

        const sent = await call('POST', '/api/settings/nostr/publish', { token: fay.token, body: { event: signed } });
        expect(sent.status).toBe(200);
        expect(sent.body.published).toBe(true);
        expect(sent.body.publishedAt).toBeTruthy();
        expect(relays.sent.map((e) => e.id)).toEqual([signed.id]);
    });

    it('for a key BIES holds: BIES signs and sends it, and logs the signature', async () => {
        const gus = await member('Gus', { hosted: true, profile: { avatar: '/uploads/public/1-gus.webp' } });
        await call('PUT', '/api/settings/nostr', { token: gus.token, body: { on: true } });
        const sent = await call('POST', '/api/settings/nostr/publish', { token: gus.token, body: {} });
        expect(sent.status).toBe(200);
        expect(sent.body.published).toBe(true);
        expect(relays.sent).toHaveLength(1);
        expect(relays.sent[0].pubkey).toBe(gus.pubkey);
        expect(JSON.parse(relays.sent[0].content)).toEqual({
            display_name: 'Gus', name: 'Gus', picture: 'https://app.example.test/uploads/public/1-gus.webp', about: "Gus's bio",
        });

        const log = await call('GET', '/api/signer/log?hide=22242,24242', { token: gus.token });
        expect(log.body.signatures.map((s: { kind: number; source: string }) => [s.kind, s.source])).toEqual([[0, 'server']]);
    });

    it('once published, follows profile changes (key BIES holds)', async () => {
        const hal = await member('Hal', { hosted: true });
        await call('PUT', '/api/settings/nostr', { token: hal.token, body: { on: true } });
        // On but never published: a profile change sends nothing yet.
        await call('PUT', '/api/profiles/me', { token: hal.token, body: { bio: 'First' } });
        await new Promise((r) => setTimeout(r, 200));
        expect(relays.sent).toHaveLength(0);

        await call('POST', '/api/settings/nostr/publish', { token: hal.token, body: {} });
        relays.publicProfiles.set(hal.pubkey, JSON.parse(relays.sent[0].content));
        relays.sent.length = 0;

        await call('PUT', '/api/profiles/me', { token: hal.token, body: { bio: 'Second' } });
        await vi.waitFor(() => expect(relays.sent).toHaveLength(1));
        expect(JSON.parse(relays.sent[0].content).about).toBe('Second');
    });

    it("won't build from nothing when the relays don't answer after a first publish", async () => {
        const ivy = await member('Ivy', { hosted: true });
        await call('PUT', '/api/settings/nostr', { token: ivy.token, body: { on: true } });
        expect((await call('POST', '/api/settings/nostr/publish', { token: ivy.token, body: {} })).status).toBe(200);
        relays.sent.length = 0;
        // fetchPublicProfile finds nothing now: unreachable, not empty.
        const again = await call('POST', '/api/settings/nostr/publish', { token: ivy.token, body: {} });
        expect(again.status).toBe(503);
        expect(again.body.reason).toBe('relays_unreachable');
        expect(relays.sent).toHaveLength(0);
    });

    it('says so when the relays refuse it', async () => {
        const jo = await member('Jo', { hosted: true });
        await call('PUT', '/api/settings/nostr', { token: jo.token, body: { on: true } });
        relays.accept = false;
        const refused = await call('POST', '/api/settings/nostr/publish', { token: jo.token, body: {} });
        expect(refused.status).toBe(502);
        expect(refused.body.reason).toBe('relays_refused');
        expect((await call('GET', '/api/settings/nostr', { token: jo.token })).body.publishedAt).toBeNull();
    });

    it('rejects unknown parts', async () => {
        const kim = await member('Kim');
        expect((await call('PUT', '/api/settings/nostr', { token: kim.token, body: { parts: ['email'] } })).status).toBe(400);
    });
});
