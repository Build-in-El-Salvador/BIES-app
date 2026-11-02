/**
 * Settings → Nostr: claiming, changing and removing a BIES address (what
 * makes a member verified), names kept for BIES and names held after they
 * were given up, and the public Nostr profile: off until switched on, built
 * from the one already on public relays, as Settings → Privacy allows,
 * signed by BIES for keys it holds and by the member's device otherwise,
 * and kept up to date once published, with the parts that were published.
 * Real routes against a real SQLite database built from the repo's
 * migrations; relays are stand-ins that keep what was sent.
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

// The public relays: the newest profile of each key (what was published
// lands there too), whether enough of them answer, whether they take what's sent.
const relays = vi.hoisted(() => ({
    publicProfiles: new Map<string, Record<string, unknown> | null>(),
    createdAt: new Map<string, number>(),
    sent: [] as { id: string; pubkey: string; kind: number; content: string; created_at: number; tags: string[][] }[],
    accept: true,
    reachable: true,
}));
const discarded = vi.hoisted(() => [] as string[]);

vi.mock('nostr-tools/pool', () => ({
    SimplePool: class {
        publish(urls: string[]) { return urls.map(() => Promise.resolve('')); }
        async querySync() { return []; }
        async get() { return null; }
    },
}));
vi.mock('../services/email.service', () => ({ sendEmail: vi.fn(async () => {}) }));
vi.mock('../services/uploads.service', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/uploads.service')>()),
    discardUploads: vi.fn(async (urls: Iterable<string>) => { discarded.push(...urls); return 0; }),
}));
vi.mock('../services/nostr.service', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/nostr.service')>()),
    publishProfileUpdate: vi.fn(async () => null),
    publishAnnouncement: vi.fn(async () => null),
    fetchPublicProfile: vi.fn(async (pubkey: string) => {
        if (!relays.reachable) return { found: null, reachable: false };
        const content = relays.publicProfiles.get(pubkey);
        return { found: content ? { content, createdAt: relays.createdAt.get(pubkey) ?? 1_700_000_000 } : null, reachable: true };
    }),
    publishToPublicRelays: vi.fn(async (event: { id: string; pubkey: string; kind: number; content: string; created_at: number; tags: string[][] }) => {
        if (!relays.accept) return 0;
        relays.sent.push(event);
        relays.publicProfiles.set(event.pubkey, JSON.parse(event.content));
        relays.createdAt.set(event.pubkey, event.created_at);
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
import nip05Routes from '../routes/nip05.routes';
import adminRoutes from '../routes/admin.routes';
import { sanitize } from '../middleware/sanitize';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { encryptPrivateKey } from '../services/crypto.service';
import { createSession, signAccessToken } from '../services/session.service';
import { deleteAccount } from '../services/account.service';
import { setFollowUpGapForTests } from '../controllers/publicNostr.controller';

let server: http.Server;
let base: string;

beforeAll(async () => {
    fs.mkdirSync(env.dir, { recursive: true });
    execSync('npx prisma migrate deploy', { cwd: path.resolve(__dirname, '../..'), env: process.env, stdio: 'pipe' });
    const app = express();
    app.use(express.json());
    app.use(sanitize); // as in index.ts: a signed event must get through it unchanged
    app.use('/api/profiles', profileRoutes);
    app.use('/api/settings', settingsRoutes);
    app.use('/api/signer', signerRoutes);
    app.use('/.well-known', nip05Routes);
    app.use('/api/admin', adminRoutes);
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
    relays.createdAt.clear();
    relays.sent.length = 0;
    relays.accept = true;
    relays.reachable = true;
    discarded.length = 0;
    setFollowUpGapForTests(0);
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

/**
 * A member. A BIES address given in `profile` counts as claimed (as the
 * migration marked names members chose), unless it looks given at sign-up
 * or `nip05ClaimedAt` says otherwise.
 */
async function member(name: string, { hosted = false, role = 'MEMBER', isAdmin = false, profile = {} as Record<string, unknown> } = {}): Promise<Member> {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const claimed = typeof profile.nip05Name === 'string' && !/^nostr-/.test(profile.nip05Name) && !('nip05ClaimedAt' in profile);
    const user = await prisma.user.create({
        data: {
            nostrPubkey: pubkey, role, isAdmin, termsVersion: '2026-10', termsAcceptedAt: new Date(),
            ...(hosted ? { email: `${name.toLowerCase()}-${pubkey.slice(0, 6)}@example.com`, encryptedPrivkey: encryptPrivateKey(Buffer.from(secret).toString('hex')) } : {}),
            profile: { create: { name, bio: `${name}'s bio`, ...(claimed ? { nip05ClaimedAt: new Date() } : {}), ...profile } },
        },
    });
    const session = await createSession(user.id, 'web');
    return { id: user.id, pubkey, secret, token: signAccessToken({ id: user.id, role, isAdmin }, session.sessionId) };
}

let adminToken = '';
async function admin() {
    if (!adminToken) adminToken = (await member('Admin', { isAdmin: true })).token;
    return adminToken;
}

/** Switched on with these parts and published (a key BIES holds, or signed here for one on the device). */
async function published(m: Member, parts?: string[]) {
    expect((await call('PUT', '/api/settings/nostr', { token: m.token, body: { on: true, ...(parts ? { parts } : {}) } })).status).toBe(200);
    const first = await call('POST', '/api/settings/nostr/publish', { token: m.token, body: {} });
    expect(first.status).toBe(200);
    if (first.body.published) return first.body;
    const sent = await call('POST', '/api/settings/nostr/publish', { token: m.token, body: { event: finalizeEvent(first.body.template, m.secret) } });
    expect(sent.status).toBe(200);
    return sent.body;
}

const lastSent = () => JSON.parse(relays.sent[relays.sent.length - 1].content);
const settle = () => new Promise((r) => setTimeout(r, 250));

describe('BIES address', () => {
    it('is claimed by choosing a name, which makes the member verified', async () => {
        const ana = await member('Ana');
        expect((await call('GET', '/api/profiles/me', { token: ana.token })).body.verified).toBe(false);

        const saved = await call('PUT', '/api/profiles/me', { token: ana.token, body: { nip05Name: 'Ana.B' } });
        expect(saved.status).toBe(200);
        expect(saved.body.nip05Name).toBe('ana.b');
        expect(saved.body.verified).toBe(true);
        expect(saved.body).not.toHaveProperty('user');

        const me = await call('GET', '/api/profiles/me', { token: ana.token });
        expect(me.body.verified).toBe(true);
        const other = await member('Other');
        const seen = await call('GET', `/api/profiles/${ana.id}`, { token: other.token });
        expect(seen.body.verified).toBe(true);
        expect(seen.body).not.toHaveProperty('publicNostr');
        expect(seen.body).not.toHaveProperty('nip05ClaimedAt');
    });

    it('can be removed', async () => {
        const ben = await member('Ben', { profile: { nip05Name: 'ben' } });
        expect((await call('GET', '/api/profiles/me', { token: ben.token })).body.verified).toBe(true);
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

    it('keeps names that would pass for BIES itself', async () => {
        const rae = await member('Rae');
        for (const name of ['biessupport', 'officialbies', 'buildinelsalvadorteam', 'teambies', 'biesadmin']) {
            const res = await call('PUT', '/api/profiles/me', { token: rae.token, body: { nip05Name: name } });
            expect(res.status, name).toBe(409);
        }
    });

    it("keeps the team's names, however they're written, for admins alone (not moderators)", async () => {
        const fan = await member('Fan');
        for (const name of ['mike', 'm1ke', 'mi.ke', 'luis', 'bukele', 'soporte', 'biesoficial', 'equipo_bies', '0ficial']) {
            const res = await call('PUT', '/api/profiles/me', { token: fan.token, body: { nip05Name: name } });
            expect(res.status, name).toBe(409);
            expect(res.body.reason, name).toBe('reserved');
        }
        expect((await call('GET', '/api/profiles/check-nip05?name=m1ke', { token: fan.token })).body).toMatchObject({ available: false, reason: 'reserved' });

        const mod = await member('Mod', { role: 'MOD' });
        expect((await call('PUT', '/api/profiles/me', { token: mod.token, body: { nip05Name: 'ayuda' } })).status).toBe(409);
        expect((await call('GET', '/api/profiles/check-nip05?name=ayuda', { token: mod.token })).body.available).toBe(false);

        const boss = await member('Boss', { isAdmin: true });
        expect((await call('GET', '/api/profiles/check-nip05?name=ayuda', { token: boss.token })).body.available).toBe(true);
        const claimed = await call('PUT', '/api/profiles/me', { token: boss.token, body: { nip05Name: 'ayuda' } });
        expect(claimed.status).toBe(200);
        expect(claimed.body.verified).toBe(true);
    });

    it('a name taken under the old rules, or by staff, keeps working for its holder', async () => {
        const early = await member('Early', { role: 'MOD', profile: { nip05Name: 'soporte' } });
        const kept = await call('PUT', '/api/profiles/me', { token: early.token, body: { nip05Name: 'soporte', bio: 'Still here' } });
        expect(kept.status).toBe(200);
        expect(kept.body.verified).toBe(true);
        expect((await call('GET', '/.well-known/nostr.json?name=soporte')).body.names).toEqual({ soporte: early.pubkey });
    });

    it('a sign-up address still works but is not verified, and saving it again changes nothing', async () => {
        const dan = await member('Dan', { profile: { nip05Name: 'nostr-0a1b2c3d' } });
        expect((await call('GET', '/api/profiles/me', { token: dan.token })).body.verified).toBe(false);
        const kept = await call('PUT', '/api/profiles/me', { token: dan.token, body: { nip05Name: 'nostr-0a1b2c3d' } });
        expect(kept.status).toBe(200);
        expect(kept.body.verified).toBe(false);
    });

    it('a name not claimed in Settings (set by older code) is not verified, even sent again', async () => {
        const old = await member('Old', { profile: { nip05Name: 'old.email', nip05ClaimedAt: null } });
        expect((await call('GET', '/api/profiles/me', { token: old.token })).body.verified).toBe(false);
        expect((await call('PUT', '/api/profiles/me', { token: old.token, body: { nip05Name: 'old.email', bio: 'x' } })).body.verified).toBe(false);
        // Published or not, the address isn't put on public Nostr either.
        await call('PUT', '/api/settings/nostr', { token: old.token, body: { on: true, parts: ['nip05'] } });
        const asked = await call('POST', '/api/settings/nostr/publish', { token: old.token, body: {} });
        expect(JSON.parse(asked.body.template.content)).not.toHaveProperty('nip05');
    });

    it('names members chose before claims were recorded are marked claimed by the migration; given ones are not', async () => {
        const rows = [
            await member('Cam', { profile: { nip05Name: 'cam', nip05ClaimedAt: null } }),
            await member('Jay', { profile: { nip05Name: 'buildyjay', nip05ClaimedAt: null } }),
            await member('Lookalike', { profile: { nip05Name: 'nostr-deadbeefx', nip05ClaimedAt: null } }),
            await member('Given', { profile: { nip05Name: 'nostr-0a0b0c0d', nip05ClaimedAt: null } }),
            await member('Given2', { profile: { nip05Name: 'nostr-0a0b0c0e2', nip05ClaimedAt: null } }),
            await member('None', { profile: { nip05ClaimedAt: null } }),
        ];
        const sql = fs.readFileSync(path.resolve(__dirname, '../../prisma/migrations/20261102150000_bies_address_claims/migration.sql'), 'utf8');
        const backfill = sql.match(/UPDATE "profiles"[\s\S]*?;/)![0].replace(/;$/, '');
        await prisma.$executeRawUnsafe(`${backfill} AND "user_id" IN (${rows.map((r) => `'${r.id}'`).join(', ')})`);

        const verified = [];
        for (const r of rows) verified.push((await call('GET', '/api/profiles/me', { token: r.token })).body.verified);
        expect(verified).toEqual([true, true, true, false, false, false]);
        const claimedAt = await prisma.profile.findUnique({ where: { userId: rows[0].id }, select: { nip05ClaimedAt: true } });
        expect(Math.abs(claimedAt!.nip05ClaimedAt!.getTime() - Date.now())).toBeLessThan(60_000);
        // "cam" is kept for BIES now, and stays its holder's.
        expect((await call('PUT', '/api/profiles/me', { token: rows[0].token, body: { nip05Name: 'cam', bio: 'Hi' } })).body.verified).toBe(true);
    });

    it('a name given up is held from others for 90 days, but its owner can take it back', async () => {
        const ivo = await member('Ivo', { profile: { nip05Name: 'ivo' } });
        const ken = await member('Ken');
        expect((await call('PUT', '/api/profiles/me', { token: ivo.token, body: { nip05Name: 'ivo.v' } })).status).toBe(200);

        const held = await call('PUT', '/api/profiles/me', { token: ken.token, body: { nip05Name: 'ivo' } });
        expect(held.status).toBe(409);
        expect(held.body.reason).toBe('held');
        expect((await call('GET', '/api/profiles/check-nip05?name=ivo', { token: ken.token })).body).toMatchObject({ available: false, reason: 'held' });
        expect((await call('GET', '/api/profiles/check-nip05?name=ivo')).body).toMatchObject({ available: false, reason: 'held' });
        expect((await call('GET', '/api/profiles/check-nip05?name=ivo', { token: ivo.token })).body.available).toBe(true);

        // Removed outright: held too.
        expect((await call('PUT', '/api/profiles/me', { token: ivo.token, body: { nip05Name: '' } })).status).toBe(200);
        expect((await call('PUT', '/api/profiles/me', { token: ken.token, body: { nip05Name: 'ivo.v' } })).body.reason).toBe('held');

        expect((await call('PUT', '/api/profiles/me', { token: ivo.token, body: { nip05Name: 'ivo' } })).status).toBe(200);
        const row = await prisma.releasedNip05.findUnique({ where: { name: 'ivo.v' } });
        expect(row).toMatchObject({ pubkey: ivo.pubkey, blocked: false });

        // 90 days on, anyone may.
        await prisma.releasedNip05.update({ where: { name: 'ivo.v' }, data: { releasedAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000) } });
        expect((await call('PUT', '/api/profiles/me', { token: ken.token, body: { nip05Name: 'ivo.v' } })).status).toBe(200);
    });

    it('can be removed by an admin, and then nobody can claim the name, its owner neither', async () => {
        const sam = await member('Sam', { profile: { nip05Name: 'samuel' } });
        const other = await member('Other Sam');
        expect((await call('DELETE', `/api/admin/users/${sam.id}/nip05`, { token: sam.token })).status).toBe(403);
        const removed = await call('DELETE', `/api/admin/users/${sam.id}/nip05`, { token: await admin() });
        expect(removed.status).toBe(200);
        expect((await call('GET', '/api/profiles/me', { token: sam.token })).body.verified).toBe(false);
        expect((await call('GET', '/.well-known/nostr.json?name=samuel')).body.names).toEqual({});
        const log = await prisma.auditLog.findFirst({ where: { action: 'USER_NIP05_REMOVED', resource: `user:${sam.id}` } });
        expect(JSON.parse(log!.metadata)).toEqual({ nip05Name: 'samuel' });

        for (const m of [sam, other]) {
            const res = await call('PUT', '/api/profiles/me', { token: m.token, body: { nip05Name: 'samuel' } });
            expect(res.status).toBe(409);
            expect(res.body.reason).toBe('held');
        }
        await prisma.releasedNip05.update({ where: { name: 'samuel' }, data: { releasedAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000) } });
        expect((await call('PUT', '/api/profiles/me', { token: other.token, body: { nip05Name: 'samuel' } })).body.reason).toBe('held');
        // An admin clearing the row frees it.
        await prisma.releasedNip05.delete({ where: { name: 'samuel' } });
        expect((await call('PUT', '/api/profiles/me', { token: other.token, body: { nip05Name: 'samuel' } })).status).toBe(200);
    });

    it("a deleted account's name is held from everyone, and BIES keeps no key with it", async () => {
        const zoe = await member('Zoe', { profile: { nip05Name: 'zoe.z' } });
        expect((await call('PUT', '/api/profiles/me', { token: zoe.token, body: { nip05Name: 'zoe' } })).status).toBe(200);
        await deleteAccount(zoe.id, { notify: false, retract: false });
        expect(await prisma.releasedNip05.findUnique({ where: { name: 'zoe' } })).toMatchObject({ pubkey: null, blocked: false });
        expect(await prisma.releasedNip05.findUnique({ where: { name: 'zoe.z' } })).toMatchObject({ pubkey: null });
        const next = await member('Next');
        expect((await call('PUT', '/api/profiles/me', { token: next.token, body: { nip05Name: 'zoe' } })).body.reason).toBe('held');
    });
});

describe('Public Nostr profile', () => {
    it('is off until switched on, and builds on the profile already on public relays', async () => {
        const eva = await member('Eva', { profile: { nip05Name: 'eva' } });
        relays.publicProfiles.set(eva.pubkey, { name: 'eva_nostr', about: 'From Primal', lud16: 'eva@primal.net' });

        const first = await call('GET', '/api/settings/nostr', { token: eva.token });
        expect(first.status).toBe(200);
        expect(first.body).toMatchObject({ on: false, publishedAt: null, hosted: false, verified: true, nip05Name: 'eva', reachable: true, hiddenParts: [] });
        expect(first.body.current).toEqual({ name: 'eva_nostr', about: 'From Primal', lud16: 'eva@primal.net' });
        expect(first.body.next).toEqual({
            name: 'eva_nostr', display_name: 'Eva', about: "Eva's bio", lud16: 'eva@primal.net', nip05: 'eva@buildinelsalvador.com',
        });

        const off = await call('POST', '/api/settings/nostr/publish', { token: eva.token, body: {} });
        expect(off.status).toBe(409);
        expect(relays.sent).toHaveLength(0);
    });

    it('for a key on the device: BIES returns the profile to sign, checks the signed one and sends it', async () => {
        const fay = await member('Fay', { profile: { bio: 'Bitcoin only = freedom & 5&#8364; javascript: and TS' } });
        relays.publicProfiles.set(fay.pubkey, { name: 'fay', website: 'https://fay.example' });
        expect((await call('PUT', '/api/settings/nostr', { token: fay.token, body: { on: true, parts: ['name', 'about'] } })).status).toBe(200);

        const asked = await call('POST', '/api/settings/nostr/publish', { token: fay.token, body: {} });
        expect(asked.status).toBe(200);
        expect(asked.body.published).toBe(false);
        expect(asked.body.template).toMatchObject({ kind: 0, tags: [] });
        expect(JSON.parse(asked.body.template.content)).toEqual({ name: 'fay', website: 'https://fay.example', display_name: 'Fay', about: 'Bitcoin only = freedom & 5&#8364; javascript: and TS' });

        // Someone else's key, a changed signature, other content or tags signed by the member: refused.
        const stranger = finalizeEvent(asked.body.template, generateSecretKey());
        expect((await call('POST', '/api/settings/nostr/publish', { token: fay.token, body: { event: stranger } })).status).toBe(400);
        const signed = finalizeEvent(asked.body.template, fay.secret);
        const forged = { ...signed, content: '{"name":"someone else"}' };
        expect((await call('POST', '/api/settings/nostr/publish', { token: fay.token, body: { event: forged } })).status).toBe(400);
        const otherContent = finalizeEvent({ ...asked.body.template, content: '{"name":"fay","website":"https://elsewhere.example"}' }, fay.secret);
        expect((await call('POST', '/api/settings/nostr/publish', { token: fay.token, body: { event: otherContent } })).status).toBe(400);
        const withTags = finalizeEvent({ ...asked.body.template, tags: [['i', 'github:someone', 'proof']] }, fay.secret);
        expect((await call('POST', '/api/settings/nostr/publish', { token: fay.token, body: { event: withTags } })).status).toBe(400);
        expect(relays.sent).toHaveLength(0);

        const sent = await call('POST', '/api/settings/nostr/publish', { token: fay.token, body: { event: signed } });
        expect(sent.status).toBe(200);
        expect(sent.body.published).toBe(true);
        expect(sent.body.publishedAt).toBeTruthy();
        expect(sent.body.following).toBe(true);
        expect(relays.sent.map((e) => e.id)).toEqual([signed.id]);
        // Used once.
        expect((await call('POST', '/api/settings/nostr/publish', { token: fay.token, body: { event: signed } })).status).toBe(400);
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

    it('is dated after the profile it replaces, even one dated ahead', async () => {
        const amy = await member('Amy', { hosted: true });
        const ahead = Math.floor(Date.now() / 1000) + 3600;
        relays.publicProfiles.set(amy.pubkey, { name: 'amy' });
        relays.createdAt.set(amy.pubkey, ahead);
        await published(amy, ['about']);
        expect(relays.sent[0].created_at).toBe(ahead + 1);
    });

    it('once published, follows profile changes (key BIES holds)', async () => {
        const hal = await member('Hal', { hosted: true });
        await call('PUT', '/api/settings/nostr', { token: hal.token, body: { on: true } });
        // On but never published: a profile change sends nothing yet.
        await call('PUT', '/api/profiles/me', { token: hal.token, body: { bio: 'First' } });
        await settle();
        expect(relays.sent).toHaveLength(0);

        await call('POST', '/api/settings/nostr/publish', { token: hal.token, body: {} });
        relays.sent.length = 0;

        await call('PUT', '/api/profiles/me', { token: hal.token, body: { bio: 'Second' } });
        await vi.waitFor(() => expect(relays.sent).toHaveLength(1));
        expect(lastSent().about).toBe('Second');
    });

    it('follows with the parts that were published, not ones ticked since', async () => {
        const ian = await member('Ian', { hosted: true, profile: { website: 'https://ian.example' } });
        await published(ian, ['name']);
        relays.sent.length = 0;

        // Ticked but not published: changes to it don't go out.
        await call('PUT', '/api/settings/nostr', { token: ian.token, body: { parts: ['name', 'about', 'website'] } });
        await call('PUT', '/api/profiles/me', { token: ian.token, body: { bio: 'Secret plans' } });
        await settle();
        expect(relays.sent).toHaveLength(0);

        await call('PUT', '/api/profiles/me', { token: ian.token, body: { name: 'Ian R' } });
        await vi.waitFor(() => expect(relays.sent).toHaveLength(1));
        expect(lastSent()).toEqual({ display_name: 'Ian R', name: 'Ian R' });

        // Publish shows them; then they follow.
        await call('POST', '/api/settings/nostr/publish', { token: ian.token, body: {} });
        expect(lastSent()).toMatchObject({ about: 'Secret plans', website: 'https://ian.example' });
    });

    it('stops following when switched off, until the next Publish', async () => {
        const jan = await member('Jan', { hosted: true });
        await published(jan, ['name', 'about']);
        await call('PUT', '/api/settings/nostr', { token: jan.token, body: { on: false } });
        const back = await call('PUT', '/api/settings/nostr', { token: jan.token, body: { on: true } });
        expect(back.body.following).toBe(false);
        relays.sent.length = 0;
        await call('PUT', '/api/profiles/me', { token: jan.token, body: { bio: 'Changed while paused' } });
        await settle();
        expect(relays.sent).toHaveLength(0);

        const again = await call('POST', '/api/settings/nostr/publish', { token: jan.token, body: {} });
        expect(again.body.following).toBe(true);
        await call('PUT', '/api/profiles/me', { token: jan.token, body: { bio: 'Following again' } });
        await vi.waitFor(() => expect(lastSent().about).toBe('Following again'));
    });

    it('sends at most one follow-up at a time and a minute, with the latest profile', async () => {
        setFollowUpGapForTests(400);
        const kai = await member('Kai', { hosted: true });
        await published(kai, ['about']);
        relays.sent.length = 0;
        for (const bio of ['One', 'Two', 'Three']) await call('PUT', '/api/profiles/me', { token: kai.token, body: { bio } });
        await vi.waitFor(() => expect(relays.sent.length).toBeGreaterThanOrEqual(1));
        await new Promise((r) => setTimeout(r, 700));
        expect(relays.sent).toHaveLength(2);
        expect(lastSent().about).toBe('Three');
    });

    it("skips a follow-up when the relays give back an older profile than BIES published", async () => {
        const lea = await member('Lea', { hosted: true });
        await published(lea, ['about']);
        relays.sent.length = 0;
        relays.createdAt.set(lea.pubkey, 1_600_000_000);
        await call('PUT', '/api/profiles/me', { token: lea.token, body: { bio: 'Over an old copy' } });
        await settle();
        expect(relays.sent).toHaveLength(0);
    });

    it("won't build from nothing when the relays don't answer after a first publish", async () => {
        const ivy = await member('Ivy', { hosted: true });
        await published(ivy);
        relays.sent.length = 0;
        relays.publicProfiles.delete(ivy.pubkey); // nothing found now: unreachable, not empty
        const again = await call('POST', '/api/settings/nostr/publish', { token: ivy.token, body: {} });
        expect(again.status).toBe(503);
        expect(again.body.reason).toBe('relays_unreachable');
        expect(relays.sent).toHaveLength(0);
    });

    it("won't publish at all, nor show a preview, when too few relays answer", async () => {
        const una = await member('Una', { hosted: true });
        await call('PUT', '/api/settings/nostr', { token: una.token, body: { on: true } });
        relays.reachable = false;
        const preview = await call('GET', '/api/settings/nostr', { token: una.token });
        expect(preview.body).toMatchObject({ reachable: false, current: null, next: null });
        const first = await call('POST', '/api/settings/nostr/publish', { token: una.token, body: {} });
        expect(first.status).toBe(503);
        expect(first.body.reason).toBe('relays_unreachable');
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

    it('leaves the preview out when asked (the phone apps)', async () => {
        const lia = await member('Lia');
        relays.publicProfiles.set(lia.pubkey, { name: 'lia' });
        const quick = await call('GET', '/api/settings/nostr?preview=0', { token: lia.token });
        expect(quick.status).toBe(200);
        expect(quick.body).toMatchObject({ on: false, current: null, next: null, reachable: null });
    });

    it('points other apps to the public relays once published', async () => {
        const max = await member('Max', { hosted: true, profile: { nip05Name: 'max' } });
        const before = await call('GET', '/.well-known/nostr.json?name=max');
        expect(before.body.relays[max.pubkey]).toEqual(['wss://relay.buildinelsalvador.com']);
        await published(max);
        const after = await call('GET', '/.well-known/nostr.json?name=max');
        expect(after.body.names).toEqual({ max: max.pubkey });
        expect(after.body.relays[max.pubkey]).not.toContain('wss://relay.buildinelsalvador.com');
    });

    it("won't publish over a profile the member saw when the relays now give back less", async () => {
        const ned = await member('Ned', { hosted: true });
        relays.publicProfiles.set(ned.pubkey, { name: 'ned', lud16: 'ned@primal.net' });
        relays.createdAt.set(ned.pubkey, 1_700_000_500);
        await call('PUT', '/api/settings/nostr', { token: ned.token, body: { on: true } });
        const seen = (await call('GET', '/api/settings/nostr', { token: ned.token })).body.currentAt;
        expect(seen).toBe(1_700_000_500);

        relays.publicProfiles.delete(ned.pubkey); // relays time out
        const gone = await call('POST', '/api/settings/nostr/publish', { token: ned.token, body: { seenAt: seen } });
        expect(gone.status).toBe(503);
        relays.publicProfiles.set(ned.pubkey, { name: 'ned' });
        relays.createdAt.set(ned.pubkey, 1_600_000_000); // an older copy
        expect((await call('POST', '/api/settings/nostr/publish', { token: ned.token, body: { seenAt: seen } })).status).toBe(503);
        expect(relays.sent).toHaveLength(0);

        relays.createdAt.set(ned.pubkey, 1_700_000_500);
        expect((await call('POST', '/api/settings/nostr/publish', { token: ned.token, body: { seenAt: seen } })).status).toBe(200);
    });

    it('tells the app to republish only when something published changed (key on the device), and the app follows up with the published parts', async () => {
        const ola = await member('Ola');
        await published(ola, ['about']);

        const same = await call('PUT', '/api/profiles/me', { token: ola.token, body: { name: 'Ola', location: 'Santa Ana' } });
        expect(same.body.publicNostrStale).toBeUndefined();
        const notPublished = await call('PUT', '/api/profiles/me', { token: ola.token, body: { name: 'Ola B' } });
        expect(notPublished.body.publicNostrStale).toBeUndefined();
        const changed = await call('PUT', '/api/profiles/me', { token: ola.token, body: { bio: 'New bio' } });
        expect(changed.body.publicNostrStale).toBe(true);

        await call('PUT', '/api/settings/nostr', { token: ola.token, body: { parts: ['about', 'name'] } });
        const asked = await call('POST', '/api/settings/nostr/publish', { token: ola.token, body: { followUp: true } });
        expect(JSON.parse(asked.body.template.content)).toEqual({ about: 'New bio' });
        const sent = await call('POST', '/api/settings/nostr/publish', { token: ola.token, body: { followUp: true, event: finalizeEvent(asked.body.template, ola.secret) } });
        expect(sent.status).toBe(200);
        // Nothing left to change: nothing to sign.
        expect((await call('POST', '/api/settings/nostr/publish', { token: ola.token, body: { followUp: true } })).body).toMatchObject({ published: false, skipped: true });
    });

    it('keeps the switch as the member left it when a publish finishes later, and no follow-ups', async () => {
        const pia = await member('Pia', { hosted: true });
        await call('PUT', '/api/settings/nostr', { token: pia.token, body: { on: true, parts: ['name'] } });
        const publishing = call('POST', '/api/settings/nostr/publish', { token: pia.token, body: {} });
        await call('PUT', '/api/settings/nostr', { token: pia.token, body: { on: false } });
        await publishing;
        const after = (await call('GET', '/api/settings/nostr?preview=0', { token: pia.token })).body;
        expect(after.on).toBe(false);
        expect(after.parts).toEqual(['name']);
        expect(after.following).toBe(false);
        const stored = await prisma.profile.findUnique({ where: { userId: pia.id }, select: { publicNostr: true } });
        expect(JSON.parse(stored!.publicNostr).publishedParts ?? null).toBeNull();
    });

    it('rejects unknown parts', async () => {
        const kim = await member('Kim');
        expect((await call('PUT', '/api/settings/nostr', { token: kim.token, body: { parts: ['email'] } })).status).toBe(400);
    });
});

describe('Public Nostr profile and Settings → Privacy', () => {
    it('ticks by default only what BIES has and Privacy allows', async () => {
        const quinn = await member('Quinn', { profile: { nip05Name: 'quinn', privacy: JSON.stringify({ bio: 'MEMBERS' }) } });
        expect((await call('GET', '/api/settings/nostr?preview=0', { token: quinn.token })).body.parts).toEqual(['name', 'nip05']);
        const on = await call('PUT', '/api/settings/nostr', { token: quinn.token, body: { on: true } });
        expect(on.body.parts).toEqual(['name', 'nip05']);
        expect(on.body.hiddenParts).toEqual(['about']);
    });

    it('leaves out what Privacy hides, ticked or not', async () => {
        const rex = await member('Rex', {
            hosted: true,
            profile: { nip05Name: 'rex', website: 'https://rex.example', lightningAddress: 'rex@ln.example', privacy: JSON.stringify({ links: 'ONLY_ME', bio: 'MEMBERS' }) },
        });
        const state = await call('PUT', '/api/settings/nostr', { token: rex.token, body: { on: true, parts: ['name', 'about', 'website', 'lightning', 'nip05'] } });
        expect(state.body.hiddenParts).toEqual(['website', 'lightning', 'nip05', 'about']);
        const preview = await call('GET', '/api/settings/nostr', { token: rex.token });
        expect(preview.body.next).toEqual({ display_name: 'Rex', name: 'Rex' });
        await call('POST', '/api/settings/nostr/publish', { token: rex.token, body: {} });
        expect(lastSent()).toEqual({ display_name: 'Rex', name: 'Rex' });
    });

    it('takes off what BIES published when Privacy then hides it, and only that', async () => {
        const sia = await member('Sia', { hosted: true, profile: { nip05Name: 'sia', website: 'https://sia.example' } });
        relays.publicProfiles.set(sia.pubkey, { name: 'sia_btc', lud16: 'sia@primal.net' });
        await published(sia, ['name', 'about', 'website', 'nip05']);
        expect(lastSent()).toMatchObject({ website: 'https://sia.example', nip05: 'sia@buildinelsalvador.com', about: "Sia's bio" });
        relays.sent.length = 0;

        const links = await call('PUT', '/api/settings/privacy', { token: sia.token, body: { links: 'ONLY_ME' } });
        expect(links.status).toBe(200);
        await vi.waitFor(() => expect(relays.sent).toHaveLength(1));
        expect(lastSent()).toEqual({ name: 'sia_btc', display_name: 'Sia', about: "Sia's bio", lud16: 'sia@primal.net' });

        await call('PUT', '/api/settings/privacy', { token: sia.token, body: { bio: 'MEMBERS' } });
        await vi.waitFor(() => expect(relays.sent).toHaveLength(2));
        expect(lastSent()).toEqual({ name: 'sia_btc', display_name: 'Sia', lud16: 'sia@primal.net' });

        // Shown again: back only with the next Publish.
        await call('PUT', '/api/settings/privacy', { token: sia.token, body: { links: 'MEMBERS', bio: 'PUBLIC' } });
        await settle();
        expect(relays.sent).toHaveLength(2);
    });

    it('tells the app to follow up a Privacy change (key on the device)', async () => {
        const tom = await member('Tom', { profile: { website: 'https://tom.example' } });
        await published(tom, ['name', 'website']);
        const res = await call('PUT', '/api/settings/privacy', { token: tom.token, body: { links: 'ONLY_ME' } });
        expect(res.body.publicNostrStale).toBe(true);
        expect(res.body.links).toBe('ONLY_ME');
        const asked = await call('POST', '/api/settings/nostr/publish', { token: tom.token, body: { followUp: true } });
        expect(JSON.parse(asked.body.template.content)).toEqual({ display_name: 'Tom', name: 'Tom' });
        expect((await call('PUT', '/api/settings/privacy', { token: tom.token, body: { location: 'ONLY_ME' } })).body.publicNostrStale).toBeUndefined();
    });

    it('an unticked part loses what BIES put there with the next Publish', async () => {
        const uma = await member('Uma', { hosted: true });
        await published(uma, ['name', 'about']);
        await call('PUT', '/api/settings/nostr', { token: uma.token, body: { parts: ['name'] } });
        await call('POST', '/api/settings/nostr/publish', { token: uma.token, body: {} });
        expect(lastSent()).toEqual({ display_name: 'Uma', name: 'Uma' });
    });
});

describe('Replaced photos', () => {
    it('keeps the one on the public profile BIES published, and discards others as before', async () => {
        const vic = await member('Vic', { hosted: true, profile: { avatar: '/uploads/public/1-vic-a.webp' } });
        await published(vic, ['picture']);
        discarded.length = 0;
        await call('PUT', '/api/profiles/me', { token: vic.token, body: { avatar: '/uploads/public/1-vic-b.webp', banner: '/uploads/public/1-vic-c.webp' } });
        expect(discarded).toEqual([]);
        await vi.waitFor(() => expect(lastSent().picture).toBe('https://app.example.test/uploads/public/1-vic-b.webp'));
        // The cover was never published: replaced, it goes.
        await call('PUT', '/api/profiles/me', { token: vic.token, body: { banner: '/uploads/public/1-vic-d.webp' } });
        expect(discarded).toEqual(['/uploads/public/1-vic-c.webp']);
    });
});
