/**
 * Reports, blocks, the terms of use and the content filter (App Store
 * guideline 1.2), end to end: real routes and middleware against a real
 * SQLite database built from the repo's migrations. Email is a stand-in that
 * records what was sent.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const env = vi.hoisted(() => {
    const dir = `${process.env.TMPDIR || '/tmp'}/bies-moderation-test-${process.pid}-${Date.now()}`;
    process.env.DATABASE_URL = `file:${dir}/test.db`;
    process.env.RELAY_WHITELIST_PATH = `${dir}/relay/whitelist.txt`;
    process.env.CORS_ORIGIN = 'https://app.example.test';
    process.env.MODERATION_EMAIL = 'moderators@example.test';
    process.env.APP_PUBLIC_URL = 'https://app.example.test';
    process.env.TERMS_VERSION = '2026-10';
    return { dir };
});

// Nothing in here should reach a relay.
vi.mock('nostr-tools/pool', () => ({
    SimplePool: class {
        publish(urls: string[]) { return urls.map(() => Promise.resolve('')); }
        async querySync() { return []; }
        async get() { return null; }
    },
}));

const mail = vi.hoisted(() => ({ sent: [] as { to: string; subject: string; text: string }[] }));
vi.mock('../services/email.service', () => ({
    sendEmail: vi.fn(async (message: (typeof mail.sent)[number]) => { mail.sent.push(message); }),
}));

import { execSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import express from 'express';
import prisma from '../lib/prisma';
import authRoutes from '../routes/auth.routes';
import accountRoutes from '../routes/account.routes';
import profileRoutes from '../routes/profile.routes';
import directoryRoutes from '../routes/directory.routes';
import searchRoutes from '../routes/search.routes';
import adminRoutes from '../routes/admin.routes';
import moderationRoutes from '../routes/moderation.routes';
import { auditLog } from '../middleware/audit';
import { sanitize } from '../middleware/sanitize';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { createSession, signAccessToken } from '../services/session.service';
import { PURGE_DIR } from '../services/relayWhitelist.service';
import { createNotification } from '../services/notification.service';
import { deleteOldReports } from '../services/moderation.service';

let server: http.Server;
let base: string;

beforeAll(async () => {
    fs.mkdirSync(env.dir, { recursive: true });
    execSync('npx prisma migrate deploy', { cwd: path.resolve(__dirname, '../..'), env: process.env, stdio: 'pipe' });

    const app = express();
    app.set('trust proxy', 1);
    // index.ts's order: body parsing, sanitize, audit, routes.
    app.use(express.json());
    app.use(sanitize);
    app.use(auditLog);
    app.use('/api/auth', authRoutes);
    app.use('/api/account', accountRoutes);
    app.use('/api/profiles', profileRoutes);
    app.use('/api/directory', directoryRoutes);
    app.use('/api/search', searchRoutes);
    app.use('/api/admin', adminRoutes);
    app.use('/api', moderationRoutes);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 120_000);

afterAll(async () => {
    server?.close();
    await prisma.$disconnect();
    fs.rmSync(env.dir, { recursive: true, force: true });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function call(method: string, url: string, { token, body }: { token?: string; body?: unknown } = {}) {
    const res = await fetch(`${base}${url}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            'X-Forwarded-For': '203.0.113.20',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

type Member = { id: string; pubkey: string; secretKey: Uint8Array; token: string; name: string };

/** A signed-in member with a public profile, who accepted the terms unless told otherwise. */
async function member(name: string, { terms = true, role = 'MEMBER', admin = false } = {}): Promise<Member> {
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    const user = await prisma.user.create({
        data: {
            nostrPubkey: pubkey,
            role,
            isAdmin: admin,
            termsVersion: terms ? '2026-10' : null,
            termsAcceptedAt: terms ? new Date() : null,
            profile: { create: { name, bio: `${name} builds things` } },
        },
    });
    const session = await createSession(user.id, 'native');
    const token = signAccessToken({ id: user.id, role, isAdmin: admin }, session.sessionId);
    return { id: user.id, pubkey, secretKey, token, name };
}

/** A Feed post, signed by its author. */
const note = (secretKey: Uint8Array, content: string) =>
    finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content }, secretKey);

async function listing(owner: Member, name: string, extra: { memberUserId?: string } = {}) {
    return prisma.directoryListing.create({
        data: { type: 'PROVIDER', name, ownerId: owner.id, status: 'active', isPublished: true, ...extra },
    });
}

const names = (rows: { name?: string }[]) => rows.map((r) => r.name);

// ─── Terms of use ─────────────────────────────────────────────────────────────

describe('terms of use', () => {
    it('must be accepted before publishing, and say so', async () => {
        const dana = await member('Dana', { terms: false });

        const me = await call('GET', '/api/auth/me', { token: dana.token });
        expect(me.status).toBe(200);
        expect(me.body.termsAccepted ?? me.body.user?.termsAccepted).toBe(false);

        const refused = await call('POST', '/api/directory', { token: dana.token, body: { type: 'FARM', name: 'Finca Dana' } });
        expect(refused.status).toBe(403);
        expect(refused.body).toMatchObject({ reason: 'terms_required', termsVersion: '2026-10' });
        // A profile is public too.
        expect((await call('PUT', '/api/profiles/me', { token: dana.token, body: { bio: 'Hola' } })).body.reason).toBe('terms_required');

        // Terms that changed while the app showed the old ones.
        const stale = await call('POST', '/api/account/terms', { token: dana.token, body: { version: '2025-01' } });
        expect(stale.status).toBe(409);
        expect(stale.body.reason).toBe('terms_changed');

        const accepted = await call('POST', '/api/account/terms', { token: dana.token, body: { version: '2026-10' } });
        expect(accepted.status).toBe(200);
        expect(accepted.body.user.termsAccepted).toBe(true);
        const row = await prisma.user.findUniqueOrThrow({ where: { id: dana.id } });
        expect(row.termsVersion).toBe('2026-10');
        expect(row.termsAcceptedAt).toBeInstanceOf(Date);

        const created = await call('POST', '/api/directory', { token: dana.token, body: { type: 'FARM', name: 'Finca Dana' } });
        expect(created.status).toBe(201);
    });

    it('are not needed to report or block', async () => {
        const erin = await member('Erin', { terms: false });
        const frank = await member('Frank');
        expect((await call('POST', '/api/reports', { token: erin.token, body: { targetType: 'user', targetId: frank.id, reason: 'harassment' } })).status).toBe(201);
        expect((await call('POST', '/api/blocks', { token: erin.token, body: { userId: frank.id } })).status).toBe(201);
    });
});

// ─── Content filter ───────────────────────────────────────────────────────────

describe('the content filter', () => {
    it('refuses slurs in a profile, a listing and a recommendation, and names the field', async () => {
        const gus = await member('Gus');
        const bio = await call('PUT', '/api/profiles/me', { token: gus.token, body: { bio: 'Building with f4gg0ts' } });
        expect(bio.status).toBe(422);
        expect(bio.body).toMatchObject({ reason: 'objectionable_content', field: 'bio' });

        const nested = await call('PUT', '/api/profiles/me', {
            token: gus.token,
            body: { experience: [{ title: 'CEO', description: 'hijo de puta' }] },
        });
        expect(nested.status).toBe(422);
        expect(nested.body.field).toBe('experience');

        const created = await call('POST', '/api/directory', { token: gus.token, body: { type: 'PROVIDER', name: 'Puta Tours' } });
        expect(created.status).toBe(422);
        expect(created.body.field).toBe('name');

        const target = await listing(await member('Hana'), 'Hana Design');
        const endorsement = await call('POST', `/api/directory/${target.id}/endorse`, { token: gus.token, body: { comment: 'kill yourself' } });
        expect(endorsement.status).toBe(422);
        expect(endorsement.body.field).toBe('comment');
    });

    it('lets everyday Salvadoran Spanish through', async () => {
        const ines = await member('Ines');
        const ok = await call('PUT', '/api/profiles/me', {
            token: ines.token,
            body: { bio: 'Café negro de altura, un proyecto vergón. Rapé artesanal.' },
        });
        expect(ok.status).toBe(200);
    });
});

// ─── Reports ──────────────────────────────────────────────────────────────────

describe('reports', () => {
    it('reach the queue and the moderators by email, once per member and thing', async () => {
        const jo = await member('Jo');
        const kai = await member('Kai');
        const before = mail.sent.length;

        const first = await call('POST', '/api/reports', {
            token: jo.token,
            body: { targetType: 'user', targetId: kai.id, reason: 'scam_spam', details: 'Asked me for my seed words' },
        });
        expect(first.status).toBe(201);
        expect(first.body).toEqual({ ok: true, duplicate: false });

        const again = await call('POST', '/api/reports', { token: jo.token, body: { targetType: 'user', targetId: kai.id, reason: 'scam_spam' } });
        expect(again.body.duplicate).toBe(true);

        const rows = await prisma.report.findMany({ where: { reporterId: jo.id } });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ targetType: 'user', targetUserId: kai.id, status: 'OPEN', details: 'Asked me for my seed words' });

        await vi.waitFor(() => expect(mail.sent.length).toBe(before + 1));
        const email = mail.sent[mail.sent.length - 1];
        expect(email.to).toBe('moderators@example.test');
        expect(email.subject).toBe('BIES report: Scam, fraud or spam');
        expect(email.text).toContain('Member profile: Kai');
        expect(email.text).toContain('https://app.example.test/admin/reports');
    });

    it('answer for listings, recommendations and notes, members or not', async () => {
        const lia = await member('Lia');
        const max = await member('Max');
        const staff = await member('Staff');

        // Entered by staff for Max: the report is about Max.
        const entered = await listing(staff, 'Max Plumbing', { memberUserId: max.id });
        await call('POST', '/api/reports', { token: lia.token, body: { targetType: 'listing', targetId: entered.id, reason: 'inaccurate_listing' } });

        const theirs = await listing(lia, 'Lia Cafe');
        const rec = await prisma.directoryEndorsement.create({ data: { listingId: theirs.id, userId: max.id, comment: 'Paid me' } });
        await call('POST', '/api/reports', { token: lia.token, body: { targetType: 'endorsement', targetId: rec.id, reason: 'fake_recommendation' } });

        // A note proves its author: the reporter sends the signed note.
        const strangerKey = generateSecretKey();
        const strangers = note(strangerKey, 'Explicit spam <3 & more');
        expect((await call('POST', '/api/reports', { token: lia.token, body: { targetType: 'note', targetId: strangers.id, reason: 'sexual' } })).status).toBe(400);
        await call('POST', '/api/reports', { token: lia.token, body: { targetType: 'note', targetId: strangers.id, event: strangers, reason: 'sexual' } });
        const maxs = note(max.secretKey, 'You will regret this');
        await call('POST', '/api/reports', { token: lia.token, body: { targetType: 'note', targetId: maxs.id, event: maxs, reason: 'harassment' } });

        // Pinning someone else's name on a note doesn't work.
        const forged = { ...note(strangerKey, 'Pin it on Max'), pubkey: max.pubkey };
        const refused = await call('POST', '/api/reports', { token: lia.token, body: { targetType: 'note', targetId: forged.id, event: forged, reason: 'harassment' } });
        expect(refused.status).toBe(400);
        expect(refused.body.reason).toBe('bad_event');
        const other = note(strangerKey, 'Another note');
        expect((await call('POST', '/api/reports', { token: lia.token, body: { targetType: 'note', targetId: other.id, event: maxs, reason: 'other' } })).body.reason).toBe('bad_event');

        const rows = await prisma.report.findMany({ where: { reporterId: lia.id }, orderBy: { createdAt: 'asc' } });
        expect(rows.map((r) => [r.targetType, r.targetUserId, r.targetPubkey, r.snapshot])).toEqual([
            ['listing', max.id, null, ''],
            ['endorsement', max.id, null, ''],
            ['note', null, getPublicKey(strangerKey), 'Explicit spam <3 & more'],
            ['note', max.id, max.pubkey, 'You will regret this'],
        ]);
    });

    it("refuse what doesn't exist, one's own things, and a flood", async () => {
        const nia = await member('Nia');
        const own = await listing(nia, 'Nia Studio');
        const self = await call('POST', '/api/reports', { token: nia.token, body: { targetType: 'listing', targetId: own.id, reason: 'other' } });
        expect(self.status).toBe(400);
        expect(self.body.reason).toBe('own_content');

        const missing = await call('POST', '/api/reports', { token: nia.token, body: { targetType: 'event', targetId: 'nope', reason: 'other' } });
        expect(missing.status).toBe(404);

        const bad = await call('POST', '/api/reports', { token: nia.token, body: { targetType: 'user', targetId: own.ownerId, reason: 'because' } });
        expect(bad.status).toBe(400);

        for (let i = 0; i < 20; i++) {
            const target = await member(`Target ${i}`);
            expect((await call('POST', '/api/reports', { token: nia.token, body: { targetType: 'user', targetId: target.id, reason: 'other' } })).status).toBe(201);
        }
        const flood = await call('POST', '/api/reports', { token: nia.token, body: { targetType: 'user', targetId: (await member('One more')).id, reason: 'other' } });
        expect(flood.status).toBe(429);
        expect(flood.body.reason).toBe('too_many');
    });

    it('are worked by moderators only, and closed ones leave after a year', async () => {
        const oli = await member('Oli');
        const pat = await member('Pat');
        const mod = await member('Moderator', { role: 'MOD' });
        await call('POST', '/api/reports', { token: oli.token, body: { targetType: 'user', targetId: pat.id, reason: 'impersonation' } });
        const report = await prisma.report.findFirstOrThrow({ where: { reporterId: oli.id } });

        expect((await call('GET', '/api/admin/reports', { token: oli.token })).status).toBe(403);

        const queue = await call('GET', '/api/admin/reports?status=OPEN', { token: mod.token });
        expect(queue.status).toBe(200);
        const row = queue.body.reports.find((r: any) => r.id === report.id);
        expect(row).toMatchObject({
            reasonLabel: 'Impersonation',
            target: 'Member profile: Pat',
            link: `/builder/${pat.id}`,
            targetUser: { id: pat.id, name: 'Pat', isBanned: false, deleted: false },
            reporter: { id: oli.id, name: 'Oli' },
        });
        expect(queue.body.open).toBeGreaterThan(0);

        const resolved = await call('PUT', `/api/admin/reports/${report.id}`, { token: mod.token, body: { status: 'ACTIONED', resolution: 'Asked Pat to change the name' } });
        expect(resolved.status).toBe(200);
        const after = await prisma.report.findUniqueOrThrow({ where: { id: report.id } });
        expect(after).toMatchObject({ status: 'ACTIONED', handledById: mod.id, resolution: 'Asked Pat to change the name' });
        expect(await prisma.auditLog.count({ where: { action: 'REPORT_ACTIONED', resource: `report:${report.id}` } })).toBe(1);

        // A year on: the closed report goes, an old open one stays.
        const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
        await prisma.report.update({ where: { id: report.id }, data: { handledAt: longAgo } });
        const stillOpen = await prisma.report.create({
            data: { reporterId: oli.id, targetType: 'user', targetId: pat.id, targetUserId: pat.id, reason: 'other', createdAt: longAgo },
        });
        expect(await deleteOldReports()).toBeGreaterThanOrEqual(1);
        expect(await prisma.report.findUnique({ where: { id: report.id } })).toBeNull();
        expect(await prisma.report.findUnique({ where: { id: stillOpen.id } })).not.toBeNull();
    });

    it("aren't shown to the moderator they are about; an admin sees them", async () => {
        const mod = await member('Moderator 3', { role: 'MOD' });
        const admin = await member('Admin', { admin: true });
        const reporter = await member('Sol');
        await call('POST', '/api/reports', { token: reporter.token, body: { targetType: 'user', targetId: mod.id, reason: 'harassment', details: 'About the moderator' } });
        const report = await prisma.report.findFirstOrThrow({ where: { reporterId: reporter.id } });

        const modQueue = await call('GET', '/api/admin/reports?status=OPEN&limit=50', { token: mod.token });
        expect(modQueue.body.reports.some((r: any) => r.id === report.id)).toBe(false);
        expect((await call('PUT', `/api/admin/reports/${report.id}`, { token: mod.token, body: { status: 'DISMISSED' } })).status).toBe(404);

        const adminQueue = await call('GET', '/api/admin/reports?status=OPEN&limit=50', { token: admin.token });
        expect(adminQueue.body.reports.some((r: any) => r.id === report.id)).toBe(true);
        expect(adminQueue.body.open).toBe(modQueue.body.open + 1);
        expect((await call('PUT', `/api/admin/reports/${report.id}`, { token: admin.token, body: { status: 'DISMISSED' } })).status).toBe(200);
    });

    it('let a moderator remove a reported post from the BIES relay', async () => {
        const mod = await member('Moderator 4', { role: 'MOD' });
        const ann = await member('Ann');
        const ben = await member('Ben');
        const post = note(ben.secretKey, 'Buy followers here');
        await call('POST', '/api/reports', { token: ann.token, body: { targetType: 'note', targetId: post.id, event: post, reason: 'scam_spam' } });
        const report = await prisma.report.findFirstOrThrow({ where: { reporterId: ann.id } });

        const queue = await call('GET', '/api/admin/reports?status=OPEN&limit=50', { token: mod.token });
        expect(queue.body.reports.find((r: any) => r.id === report.id).target).toContain('Buy followers here');

        expect((await call('DELETE', `/api/admin/reports/${report.id}/note`, { token: ann.token })).status).toBe(403);
        expect((await call('DELETE', `/api/admin/reports/${report.id}/note`, { token: mod.token })).status).toBe(200);
        expect(fs.existsSync(path.join(PURGE_DIR, `event-${post.id}`))).toBe(true);
        expect(await prisma.auditLog.count({ where: { action: 'NOTE_REMOVED', resource: `report:${report.id}` } })).toBe(1);

        // Only notes: a profile report has no post to remove.
        const profileReport = await call('POST', '/api/reports', { token: ann.token, body: { targetType: 'user', targetId: ben.id, reason: 'other' } });
        expect(profileReport.status).toBe(201);
        const row = await prisma.report.findFirstOrThrow({ where: { reporterId: ann.id, targetType: 'user' } });
        expect((await call('DELETE', `/api/admin/reports/${row.id}/note`, { token: mod.token })).status).toBe(404);
    });

    it('email the moderators at most 20 times a day', async () => {
        const target = await member('Busy target');
        const sinceEmails = () => mail.sent.filter((m) => m.to === 'moderators@example.test');
        for (let i = 0; i < 3; i++) {
            const reporter = await member(`Flooder ${i}`);
            for (let j = 0; j < 10; j++) {
                const t = j === 0 ? target : await member(`Flood target ${i}-${j}`);
                await call('POST', '/api/reports', { token: reporter.token, body: { targetType: 'user', targetId: t.id, reason: 'other' } });
            }
        }
        expect(await prisma.report.count()).toBeGreaterThan(20);
        await vi.waitFor(() => expect(sinceEmails().length).toBe(20));
        expect(sinceEmails().filter((m) => m.text.includes('no more emails today'))).toHaveLength(1);
        await new Promise((r) => setTimeout(r, 200));
        expect(sinceEmails().length).toBe(20);
    });

    it('let a moderator remove a recommendation', async () => {
        const mod = await member('Moderator 2', { role: 'MOD' });
        const target = await listing(await member('Quinn'), 'Quinn Solar');
        const rec = await prisma.directoryEndorsement.create({ data: { listingId: target.id, userId: (await member('Rae')).id, comment: 'Spam' } });
        expect((await call('DELETE', `/api/admin/endorsements/${rec.id}`, { token: mod.token })).status).toBe(200);
        expect(await prisma.directoryEndorsement.findUnique({ where: { id: rec.id } })).toBeNull();
        expect((await call('DELETE', `/api/admin/endorsements/${rec.id}`, { token: mod.token })).status).toBe(404);
    });
});

// ─── Blocks ───────────────────────────────────────────────────────────────────

describe('blocking a member', () => {
    it('hides them from the blocker everywhere, ends follows, and stops follows and notifications', async () => {
        const sam = await member('Sam Blocker');
        const tom = await member('Tom Blocked');
        const uma = await member('Uma Bystander');

        expect((await call('POST', `/api/profiles/${tom.id}/follow`, { token: sam.token })).status).toBe(201);
        expect((await call('POST', `/api/profiles/${sam.id}/follow`, { token: tom.token })).status).toBe(201);
        const tomsListing = await listing(tom, 'Tom Tours');
        const umasListing = await listing(uma, 'Uma Yoga');
        await prisma.directoryEndorsement.create({ data: { listingId: umasListing.id, userId: tom.id, comment: 'Great' } });

        // Uma fills the shared caches first: what Sam sees must still leave Tom out.
        expect(names((await call('GET', '/api/profiles?search=Tom', { token: uma.token })).body.data)).toContain('Tom Blocked');
        await call('GET', `/api/profiles/${tom.id}`, { token: uma.token });

        const blocked = await call('POST', '/api/blocks', { token: sam.token, body: { userId: tom.id } });
        expect(blocked.status).toBe(201);
        expect(await prisma.follow.count({ where: { OR: [{ followerId: sam.id, followingId: tom.id }, { followerId: tom.id, followingId: sam.id }] } })).toBe(0);

        // Directory, search and profile.
        expect(names((await call('GET', '/api/profiles?search=Tom', { token: sam.token })).body.data)).not.toContain('Tom Blocked');
        expect(names((await call('GET', '/api/profiles?search=Tom', { token: uma.token })).body.data)).toContain('Tom Blocked');
        expect(names((await call('GET', '/api/search?q=Tom&type=profiles', { token: sam.token })).body.profiles)).not.toContain('Tom Blocked');
        const profile = await call('GET', `/api/profiles/${tom.id}`, { token: sam.token });
        expect(profile.body).toEqual({
            id: expect.any(String),
            userId: tom.id,
            name: 'Tom Blocked',
            avatar: expect.anything(),
            user: { id: tom.id, nostrPubkey: tom.pubkey },
            blocked: true,
        });
        expect((await call('GET', `/api/profiles/${tom.id}`, { token: uma.token })).body.bio).toBe('Tom Blocked builds things');

        // Listings and recommendations.
        const list = await call('GET', '/api/directory?type=PROVIDER&limit=50', { token: sam.token });
        expect(names(list.body.data)).not.toContain('Tom Tours');
        expect(names(list.body.data)).toContain('Uma Yoga');
        const detail = await call('GET', `/api/directory/${tomsListing.id}`, { token: sam.token });
        expect(detail.status).toBe(404);
        expect(detail.body.reason).toBe('blocked');
        expect((await call('GET', `/api/directory/${umasListing.id}`, { token: sam.token })).body.endorsements).toHaveLength(0);
        expect((await call('GET', `/api/directory/${umasListing.id}`, { token: uma.token })).body.endorsements).toHaveLength(1);

        // Tom can't recommend Sam's listing.
        const samsListing = await listing(sam, 'Sam Bakery');
        const rec = await call('POST', `/api/directory/${samsListing.id}/endorse`, { token: tom.token, body: { comment: 'Great' } });
        expect(rec.status).toBe(403);
        expect(rec.body.reason).toBe('blocked');

        // No follows either way.
        for (const [who, whom] of [[sam, tom], [tom, sam]]) {
            const follow = await call('POST', `/api/profiles/${whom.id}/follow`, { token: who.token });
            expect(follow.status).toBe(403);
            expect(follow.body.reason).toBe('blocked');
        }

        // Nothing Tom does reaches Sam as a notification; Uma's still do.
        const already = await prisma.notification.count({ where: { userId: sam.id } }); // Tom's follow, before the block
        await createNotification({ userId: sam.id, type: 'POST_LIKE', title: 't', body: 'b', data: { actorPubkey: tom.pubkey } });
        await createNotification({ userId: sam.id, type: 'PROFILE_VIEW', title: 't', body: 'b', data: { viewerId: tom.id } });
        await createNotification({ userId: sam.id, type: 'PROFILE_VIEW', title: 't', body: 'b', data: { viewerId: uma.id } });
        expect(await prisma.notification.count({ where: { userId: sam.id } })).toBe(already + 1);

        // The list, and unblocking.
        const mine = await call('GET', '/api/blocks', { token: sam.token });
        expect(mine.body.data).toEqual([expect.objectContaining({ id: tom.id, name: 'Tom Blocked', nostrPubkey: tom.pubkey })]);
        expect((await call('DELETE', `/api/blocks/${tom.id}`, { token: sam.token })).status).toBe(200);
        expect((await call('GET', `/api/profiles/${tom.id}`, { token: sam.token })).body.blocked).toBeUndefined();
        expect((await call('POST', `/api/profiles/${tom.id}/follow`, { token: sam.token })).status).toBe(201);
    });

    it("returns who was blocked, so the app can hide their posts at once", async () => {
        const xia = await member('Xia');
        const yan = await member('Yan');
        const res = await call('POST', '/api/blocks', { token: xia.token, body: { pubkey: yan.pubkey } });
        expect(res.body.member).toEqual({ id: yan.id, nostrPubkey: yan.pubkey, name: 'Yan', avatar: expect.any(String) });
    });

    it('works by pubkey, and says when someone is not a member', async () => {
        const vic = await member('Vic');
        const wes = await member('Wes');
        expect((await call('POST', '/api/blocks', { token: vic.token, body: { pubkey: wes.pubkey } })).status).toBe(201);
        const stranger = await call('POST', '/api/blocks', { token: vic.token, body: { pubkey: crypto.randomBytes(32).toString('hex') } });
        expect(stranger.status).toBe(404);
        expect(stranger.body.reason).toBe('not_member');
        expect((await call('POST', '/api/blocks', { token: vic.token, body: { userId: vic.id } })).status).toBe(400);
        expect((await call('POST', '/api/blocks', { token: vic.token, body: { userId: wes.id, pubkey: wes.pubkey } })).status).toBe(400);
    });
});
