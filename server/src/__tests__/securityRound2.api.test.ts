/**
 * Security review, round 2: moderators moderate (Reports and the Directory)
 * and the rest is for admins; blocking works both ways, as on Facebook; deck
 * requests and investments stay with their own people; decks open only
 * through a short-lived signed link; searches page and count only what the
 * viewer can see. Real routes against a real SQLite database built from the
 * repo's migrations, files in a temp folder.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const env = vi.hoisted(() => {
    const dir = `${process.env.TMPDIR || '/tmp'}/bies-round2-test-${process.pid}-${Date.now()}`;
    process.env.DATABASE_URL = `file:${dir}/test.db`;
    process.env.RELAY_WHITELIST_PATH = `${dir}/relay/whitelist.txt`;
    process.env.UPLOAD_DIR = `${dir}/uploads`;
    process.env.CORS_ORIGIN = 'https://app.example.test';
    process.env.APP_PUBLIC_URL = 'https://app.example.test';
    process.env.MODERATION_EMAIL = 'moderators@example.test';
    process.env.TERMS_VERSION = '2026-10';
    return { dir };
});

vi.mock('nostr-tools/pool', () => ({
    SimplePool: class {
        publish(urls: string[]) { return urls.map(() => Promise.resolve('')); }
        async querySync() { return []; }
        async get() { return null; }
    },
}));
vi.mock('../services/email.service', () => ({ sendEmail: vi.fn(async () => {}) }));

import { execSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import express from 'express';
import prisma from '../lib/prisma';
import profileRoutes from '../routes/profile.routes';
import directoryRoutes from '../routes/directory.routes';
import albumRoutes from '../routes/album.routes';
import adminRoutes from '../routes/admin.routes';
import moderationRoutes from '../routes/moderation.routes';
import projectRoutes from '../routes/project.routes';
import investmentRoutes from '../routes/investment.routes';
import uploadRoutes from '../routes/upload.routes';
import { getPresignedUrl, uploadPrivateFile } from '../services/storage.service';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { createSession, signAccessToken } from '../services/session.service';

let server: http.Server;
let base: string;

beforeAll(async () => {
    fs.mkdirSync(env.dir, { recursive: true });
    execSync('npx prisma migrate deploy', { cwd: path.resolve(__dirname, '../..'), env: process.env, stdio: 'pipe' });
    const app = express();
    app.use(express.json());
    app.use('/api/profiles', profileRoutes);
    app.use('/api/directory', directoryRoutes);
    app.use('/api/albums', albumRoutes);
    app.use('/api/admin', adminRoutes);
    app.use('/api/projects', projectRoutes);
    app.use('/api/investments', investmentRoutes);
    app.use('/api/upload', uploadRoutes);
    app.use('/api', moderationRoutes);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 120_000);

afterAll(async () => {
    server?.close();
    await prisma.$disconnect();
    fs.rmSync(env.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function call(method: string, url: string, { token, body }: { token?: string; body?: unknown } = {}) {
    const res = await fetch(`${base}${url}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

type Member = { id: string; pubkey: string; token: string };
let n = 0;
async function member(name: string, { role = 'MEMBER', admin = false, profile = {} as Record<string, unknown> } = {}): Promise<Member> {
    const pubkey = getPublicKey(generateSecretKey());
    const user = await prisma.user.create({
        data: {
            nostrPubkey: pubkey, role, isAdmin: admin, email: `m${++n}@example.test`,
            termsVersion: '2026-10', termsAcceptedAt: new Date(),
            profile: { create: { name, ...profile } },
        },
    });
    const session = await createSession(user.id, 'native');
    return { id: user.id, pubkey, token: signAccessToken({ id: user.id, role, isAdmin: admin }, session.sessionId) };
}

describe('moderators moderate; the rest is for admins', () => {
    it('a moderator works Reports and the Directory, without members\' emails, IPs, points or roles', async () => {
        const mod = await member('Moderator', { role: 'MOD' });
        const admin = await member('Admin', { admin: true });
        const owner = await member('Owner');
        await prisma.directoryListing.create({ data: { type: 'FARM', name: 'Finca M', ownerId: owner.id, status: 'active' } });

        for (const [method, url, body] of [
            ['GET', '/api/admin/users'], ['GET', '/api/admin/audit-logs'], ['GET', '/api/admin/feedback'],
            ['POST', '/api/admin/points/adjust', { userId: mod.id, points: 100, reason: 'x' }],
            ['PUT', `/api/admin/users/${owner.id}/role`, { role: 'INVESTOR' }],
            ['GET', '/api/admin/projects'], ['POST', '/api/admin/cache/clear'],
        ] as const) {
            expect((await call(method, url, { token: mod.token, body })).status, `${method} ${url}`).toBe(403);
        }
        expect((await call('GET', '/api/admin/reports', { token: mod.token })).status).toBe(200);
        const directory = await call('GET', '/api/admin/directory', { token: mod.token });
        expect(directory.status).toBe(200);
        const row = directory.body.data.find((l: any) => l.name === 'Finca M');
        expect(row.owner.email).toBeUndefined();

        expect((await call('GET', '/api/admin/users', { token: admin.token })).status).toBe(200);
        const asAdmin = await call('GET', '/api/admin/directory', { token: admin.token });
        expect(asAdmin.body.data.find((l: any) => l.name === 'Finca M').owner.email).toMatch(/@example\.test$/);
    });

    it('a moderator can\'t remove a recommendation on their own business', async () => {
        const mod = await member('Moderator B', { role: 'MOD' });
        const critic = await member('Critic');
        const listing = await prisma.directoryListing.create({ data: { type: 'PROVIDER', name: 'Mod Co', ownerId: mod.id, status: 'active' } });
        const review = await prisma.directoryEndorsement.create({ data: { listingId: listing.id, userId: critic.id, vote: -1, comment: 'Slow' } });
        expect((await call('DELETE', `/api/admin/endorsements/${review.id}`, { token: mod.token })).status).toBe(403);
    });
});

describe('blocking works both ways', () => {
    it('the member you block sees nothing of you; you see them only as blocked', async () => {
        const ana = await member('Ana Block', { profile: { isPublic: true } });
        const ben = await member('Ben Block', { profile: { isPublic: true } });
        const farm = await prisma.directoryListing.create({ data: { type: 'FARM', name: 'Finca Ana', ownerId: ana.id, status: 'active' } });
        const album = await prisma.album.create({ data: { userId: ana.id, title: 'Ana\'s', visibility: 'MEMBERS' } });
        expect((await call('POST', '/api/blocks', { token: ana.token, body: { userId: ben.id } })).status).toBeLessThan(300);

        // Ben, blocked: Ana isn't there for him.
        expect((await call('GET', `/api/profiles/${ana.id}`, { token: ben.token })).status).toBe(404);
        expect((await call('GET', `/api/directory/${farm.id}`, { token: ben.token })).status).toBe(404);
        expect((await call('GET', `/api/albums/${album.id}`, { token: ben.token })).status).toBe(404);
        const list = await call('GET', '/api/profiles?limit=50', { token: ben.token });
        expect(list.body.data.some((p: any) => p.userId === ana.id)).toBe(false);
        const listings = await call('GET', '/api/directory?type=FARM&limit=50', { token: ben.token });
        expect(listings.body.data.some((l: any) => l.id === farm.id)).toBe(false);
        // His app hides her posts, without listing her among his blocks.
        const bens = await call('GET', '/api/blocks', { token: ben.token });
        expect(bens.body).toMatchObject({ data: [], hiddenPubkeys: [ana.pubkey] });

        // Ana, who blocked: Ben shows as blocked, so she can unblock him.
        expect((await call('GET', `/api/profiles/${ben.id}`, { token: ana.token })).body).toMatchObject({ blocked: true });
        const anas = await call('GET', '/api/blocks', { token: ana.token });
        expect(anas.body.data.map((m: any) => m.id)).toEqual([ben.id]);
        expect(anas.body.hiddenPubkeys).toEqual([]);
    });
});

describe('projects, decks and investments', () => {
    it('a deck request is approved only on its own project; projects never carry the deck\'s key', async () => {
        const owner = await member('Founder');
        const investor = await member('Investor', { role: 'INVESTOR' });
        const victim = await prisma.project.create({ data: { title: 'Victim', description: 'x', ownerId: owner.id, isPublished: true, deckKey: 'private/1760000000000-' + 'b'.repeat(32) + '.pdf', requiresDeckApproval: true } });
        const own = await prisma.project.create({ data: { title: 'Own', description: 'x', ownerId: investor.id, isPublished: true } });
        const request = await prisma.deckRequest.create({ data: { projectId: victim.id, investorId: investor.id } });

        expect((await call('PUT', `/api/projects/${own.id}/deck/requests/${request.id}`, { token: investor.token, body: { status: 'APPROVED' } })).status).toBe(404);
        expect((await prisma.deckRequest.findUnique({ where: { id: request.id } }))?.status).toBe('PENDING');

        const seen = await call('GET', `/api/projects/${victim.id}`);
        expect(seen.status).toBe(200);
        expect(seen.body.deckKey).toBeUndefined();
        expect(seen.body.hasDeck).toBe(true);
        const listed = await call('GET', '/api/projects?limit=50');
        expect(listed.body.data.every((p: any) => p.deckKey === undefined)).toBe(true);
    });

    it('an unpublished project stays hidden even once cached', async () => {
        const owner = await member('Founder B');
        const draft = await prisma.project.create({ data: { title: 'Draft', description: 'x', ownerId: owner.id, isPublished: false } });
        expect((await call('GET', `/api/projects/${draft.id}`, { token: owner.token })).status).toBe(200); // caches it
        expect((await call('GET', `/api/projects/${draft.id}`)).status).toBe(404);
    });

    it('a member lists only their own investments', async () => {
        const owner = await member('Founder C');
        const a = await member('Investor A', { role: 'INVESTOR' });
        const nosy = await member('Nosy');
        const project = await prisma.project.create({ data: { title: 'Raise', description: 'x', ownerId: owner.id, isPublished: true } });
        await prisma.investment.create({ data: { projectId: project.id, investorId: a.id, amount: 5000 } });
        const res = await call('GET', '/api/investments', { token: nosy.token });
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([]);
    });

    it('a deck opens only through its short-lived signed link', async () => {
        const { key } = await uploadPrivateFile(Buffer.from('%PDF-1.7 deck'), 'application/pdf');
        const link = await getPresignedUrl(key);
        expect(link).toMatch(/^\/api\/upload\/private\/\d{13}-[0-9a-f]{32}\.pdf\?exp=\d+&sig=[0-9a-f]{64}$/);

        const ok = await fetch(`${base}${link}`);
        expect(ok.status).toBe(200);
        expect(await ok.text()).toBe('%PDF-1.7 deck');

        expect((await fetch(`${base}${link.replace(/sig=[0-9a-f]/, 'sig=0')}`)).status).toBe(404);
        const expired = link.replace(/exp=\d+/, `exp=${Date.now() - 1000}`);
        expect((await fetch(`${base}${expired}`)).status).toBe(404);
        expect((await fetch(`${base}/uploads/${key}`)).status).toBe(404);
    });
});

describe('searches count only what the viewer can see', () => {
    it('a hidden location doesn\'t show up in the total', async () => {
        await member('Zelda Hidden', { profile: { isPublic: true, location: 'Ataco', privacy: JSON.stringify({ location: 'ONLY_ME' }) } });
        const viewer = await member('Viewer');
        const res = await call('GET', '/api/profiles?search=Zelda%20Hidden&location=Ataco', { token: viewer.token });
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([]);
        expect(res.body.pagination.total).toBe(0);
        const byName = await call('GET', '/api/profiles?search=Zelda%20Hidden', { token: viewer.token });
        expect(byName.body.pagination.total).toBe(1);
    });
});
