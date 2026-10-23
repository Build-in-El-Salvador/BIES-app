/**
 * Opportunities, end to end: members post investments, businesses for sale,
 * jobs, partnerships and programs for members only; each type keeps its own
 * fields and kinds; one is open until its member closes it or its closing
 * day ends in El Salvador; only its member changes it, and staff can remove
 * it; blocks hide it both ways; its photos are the member's own uploads and
 * go with it; any member can ask for an investment's pitch deck; saving is
 * private. Real routes against a real SQLite database built from the repo's
 * migrations, files in a temp folder.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const env = vi.hoisted(() => {
    const dir = `${process.env.TMPDIR || '/tmp'}/bies-opportunities-test-${process.pid}-${Date.now()}`;
    process.env.DATABASE_URL = `file:${dir}/test.db`;
    process.env.RELAY_WHITELIST_PATH = `${dir}/relay/whitelist.txt`;
    process.env.UPLOAD_DIR = `${dir}/uploads`;
    process.env.CORS_ORIGIN = 'https://app.example.test';
    process.env.APP_PUBLIC_URL = 'https://app.example.test';
    process.env.MODERATION_EMAIL = 'moderators@example.test';
    process.env.TERMS_VERSION = '2026-10';
    return { dir };
});

// Nothing in here should reach a relay or send an email.
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
import sharp from 'sharp';
import prisma from '../lib/prisma';
import projectRoutes from '../routes/project.routes';
import uploadRoutes from '../routes/upload.routes';
import watchlistRoutes from '../routes/watchlist.routes';
import moderationRoutes from '../routes/moderation.routes';
import searchRoutes from '../routes/search.routes';
import matchRoutes from '../routes/match.routes';
import profileRoutes from '../routes/profile.routes';
import { setFlags } from '../services/featureFlags.service';
import { deleteAccount } from '../services/account.service';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { createSession, signAccessToken } from '../services/session.service';
import { MAX_OPEN_PER_MEMBER, elSalvadorToday } from '../controllers/project.controller';
import { moveProjectOwnership, syncAccounts } from '../controllers/admin.controller';

let server: http.Server;
let base: string;

beforeAll(async () => {
    fs.mkdirSync(env.dir, { recursive: true });
    execSync('npx prisma migrate deploy', { cwd: path.resolve(__dirname, '../..'), env: process.env, stdio: 'pipe' });

    const app = express();
    app.use(express.json());
    app.use('/api/projects', projectRoutes);
    app.use('/api/upload', uploadRoutes);
    app.use('/api/watchlist', watchlistRoutes);
    app.use('/api', moderationRoutes);
    app.use('/api/search', searchRoutes);
    app.use('/api/match', matchRoutes);
    app.use('/api/profiles', profileRoutes);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 120_000);

afterAll(async () => {
    server?.close();
    await prisma.$disconnect();
    fs.rmSync(env.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); // a late write can race the delete (ENOTEMPTY)
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function call(method: string, url: string, { token, body }: { token?: string; body?: unknown } = {}) {
    const res = await fetch(`${base}${url}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

type Member = { id: string; token: string };

let counter = 0;
async function member({ name = `Member ${++counter}`, role = 'MEMBER', isAdmin = false } = {}): Promise<Member> {
    const user = await prisma.user.create({
        data: {
            nostrPubkey: getPublicKey(generateSecretKey()),
            role,
            isAdmin,
            termsVersion: '2026-10',
            termsAcceptedAt: new Date(),
            profile: { create: { name } },
        },
    });
    const session = await createSession(user.id, 'native');
    return { id: user.id, token: signAccessToken({ id: user.id, role, isAdmin }, session.sessionId) };
}

const CONTACT = { description: 'All the details.', whatsapp: '+503 7000 0000' };
const JOB = { type: 'job', title: 'Bartender', kind: 'full-time', ...CONTACT };
// A project (the `investment` type, shown as a Project): no raise or amounts.
const INVESTMENT = { type: 'investment', title: 'Solar farm', stage: 'MVP', ...CONTACT };
const SALE = { type: 'business-for-sale', title: 'Hostel in El Zonte', price: 180000, ...CONTACT };
const PARTNERSHIP = { type: 'partnership', title: 'Technical co-founder', kind: 'co-founder', ...CONTACT };
const PROGRAM = { type: 'program', title: 'Builders grant', kind: 'grant', price: 10000, ...CONTACT };

async function post(m: Member, body: Record<string, unknown>) {
    const res = await call('POST', '/api/projects', { token: m.token, body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
}

let seed = 0;
/** A photo this member uploaded: its link as stored (/uploads/public/...). */
async function uploaded(m: Member): Promise<string> {
    const file = await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 40 + (++seed % 200), g: 120, b: 90 } } }).jpeg().toBuffer();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(file)], { type: 'image/jpeg' }), 'photo.jpg');
    const res = await fetch(`${base}/api/upload/media`, { method: 'POST', headers: { Authorization: `Bearer ${m.token}` }, body: form });
    const body = (await res.json()) as any;
    if (res.status !== 200) throw new Error(`upload failed: ${res.status} ${JSON.stringify(body)}`);
    return body.url as string;
}
const stored = (url: string) => fs.existsSync(path.join(env.dir, 'uploads', 'public', url.split('/').pop()!));

const ids = (res: { body: any }) => (res.body.data as { id: string }[]).map((o) => o.id).sort();
const sorted = (...list: string[]) => [...list].sort();

/** The El Salvador day `days` from today, as YYYY-MM-DD. */
const dayFromToday = (days: number) => elSalvadorToday(new Date(Date.now() + days * 24 * 60 * 60 * 1000));

/** Time passing: its closing day becomes `days` from today (a past one, as no member can set). */
const passDays = (id: string, days: number) => prisma.project.update({ where: { id }, data: { closesOn: dayFromToday(days) } });

// ─── Posting ──────────────────────────────────────────────────────────────────

describe('posting an opportunity', () => {
    it('a member posts a job, and other members see it; the list leaves out the WhatsApp and email', async () => {
        const ana = await member({ name: 'Ana Hostel' });
        const ben = await member();
        const job = await post(ana, {
            ...JOB,
            pay: '$900 a month',
            location: 'El Tunco',
            remote: false,
            btcAccepted: true,
            email: 'jobs@example.com',
            websiteUrl: 'https://example.com/apply',
            closesOn: dayFromToday(10),
        });
        expect(job).toMatchObject({ type: 'job', kind: 'full-time', pay: '$900 a month', btcAccepted: true, isOpen: true, status: 'active' });

        const list = await call('GET', `/api/projects?ownerId=${ana.id}`, { token: ben.token });
        expect(list.status).toBe(200);
        const listed = list.body.data.find((o: any) => o.id === job.id);
        expect(listed).toMatchObject({ title: 'Bartender', owner: { id: ana.id, profile: { name: 'Ana Hostel' } } });
        expect(listed.whatsapp).toBeUndefined();
        expect(listed.email).toBeUndefined();

        const seen = await call('GET', `/api/projects/${job.id}`, { token: ben.token });
        expect(seen.status).toBe(200);
        expect(seen.body).toMatchObject({ whatsapp: '+503 7000 0000', email: 'jobs@example.com', saved: false, deckAccess: null, isOpen: true });
    });

    it('is for members: signed out there is nothing to see', async () => {
        const ana = await member();
        const job = await post(ana, JOB);
        expect((await call('GET', '/api/projects')).status).toBe(401);
        expect((await call('GET', `/api/projects/${job.id}`)).status).toBe(401);
    });

    it('keeps only the fields of its type', async () => {
        const ana = await member();
        const job = await post(ana, { ...JOB, fundingGoal: 5000, price: 10, stage: 'GROWTH', requiresDeckApproval: false });
        expect(job).toMatchObject({ fundingGoal: null, price: null, stage: 'IDEA', requiresDeckApproval: true });
        // A project keeps no raise, amounts or bitcoin.
        const raise = await post(ana, { ...INVESTMENT, pay: '$10 an hour', remote: true, price: 99, fundingGoal: 250000, raisedAmount: 5000, btcAccepted: true });
        expect(raise).toMatchObject({ pay: '', remote: false, price: null, fundingGoal: null, raisedAmount: 0, btcAccepted: false, stage: 'MVP' });
        const sale = await post(ana, { ...SALE, revenue: 60000, btcAccepted: true, remote: true });
        expect(sale).toMatchObject({ price: 180000, revenue: 60000, btcAccepted: true, remote: false });
    });

    it('says its kind when its type has them, and only one of its own', async () => {
        const ana = await member();
        const bad = async (body: Record<string, unknown>, field: string) => {
            const res = await call('POST', '/api/projects', { token: ana.token, body });
            expect(res.status, JSON.stringify(res.body)).toBe(400);
            expect(res.body.field).toBe(field);
        };
        await bad({ ...JOB, kind: 'equity' }, 'kind');
        await bad({ ...JOB, kind: '' }, 'kind');
        await bad({ ...PARTNERSHIP, kind: undefined }, 'kind');
        await bad({ ...PROGRAM, kind: 'full-time' }, 'kind');
        await bad({ ...SALE, kind: 'grant' }, 'kind');
        // Who a project is looking for is optional; a deal isn't a kind of project.
        await post(ana, INVESTMENT);
        await post(ana, { ...INVESTMENT, kind: 'investors' });
        await bad({ ...INVESTMENT, kind: 'revenue-share' }, 'kind');
    });

    it("an older project, with a deal that isn't a kind any more, can still be edited", async () => {
        const ana = await member();
        const old = await post(ana, INVESTMENT);
        await prisma.project.update({ where: { id: old.id }, data: { kind: 'equity', fundingGoal: 250000 } });
        // Sent back as it was, the deal doesn't stop the edit; a new deal does.
        const edited = await call('PUT', `/api/projects/${old.id}`, { token: ana.token, body: { kind: 'equity', title: 'Solar farm, phase two' } });
        expect(edited.status, JSON.stringify(edited.body)).toBe(200);
        const changed = await call('PUT', `/api/projects/${old.id}`, { token: ana.token, body: { kind: 'loan' } });
        expect(changed.status).toBe(400);
        expect(changed.body.field).toBe('kind');
        // Who it's looking for replaces it.
        expect((await call('PUT', `/api/projects/${old.id}`, { token: ana.token, body: { kind: 'investors' } })).status).toBe(200);
    });

    it('has a way to reach its member', async () => {
        const ana = await member();
        const res = await call('POST', '/api/projects', { token: ana.token, body: { ...JOB, whatsapp: '' } });
        expect(res.status).toBe(400);
        expect(res.body.field).toBe('contact');
        await post(ana, { ...JOB, whatsapp: '', email: 'me@example.com' });
        await post(ana, { ...JOB, whatsapp: '', websiteUrl: 'https://example.com/jobs/1' });
    });

    it('takes only real days, known industries, web links and its own type', async () => {
        const ana = await member();
        for (const body of [
            { ...JOB, closesOn: '2026-02-30' },
            { ...JOB, closesOn: 'next week' },
            { ...JOB, category: 'WEB3' },
            { ...JOB, websiteUrl: 'javascript:alert(1)' },
            { ...JOB, type: 'raffle' },
            { ...JOB, title: 'x'.repeat(121) },
        ]) {
            expect((await call('POST', '/api/projects', { token: ana.token, body })).status, JSON.stringify(body)).toBe(400);
        }
    });

    it('needs the terms of use accepted', async () => {
        const user = await prisma.user.create({ data: { nostrPubkey: getPublicKey(generateSecretKey()), profile: { create: { name: 'New' } } } });
        const session = await createSession(user.id, 'native');
        const token = signAccessToken({ id: user.id, role: 'MEMBER', isAdmin: false }, session.sessionId);
        const res = await call('POST', '/api/projects', { token, body: JOB });
        expect(res.status).toBe(403);
        expect(res.body.reason).toBe('terms_required');
    });
});

// ─── Finding ──────────────────────────────────────────────────────────────────

describe('finding opportunities', () => {
    it('filters by type, kind, stage, industry, remote, bitcoin, amount and words', async () => {
        const viewer = await member();
        const ana = await member({ name: 'Ana Filters' });
        const tag = `Q${Date.now()}`;
        const job = await post(ana, { ...JOB, title: `Barista ${tag}`, kind: 'part-time', remote: true, btcAccepted: true, category: 'FOOD', location: 'Santa Tecla' });
        const raise = await post(ana, { ...INVESTMENT, title: `Solar ${tag}`, category: 'ENERGY', stage: 'GROWTH' });
        const sale = await post(ana, { ...SALE, title: `Hostel ${tag}`, category: 'TOURISM', btcAccepted: true });
        const partner = await post(ana, { ...PARTNERSHIP, title: `Partner ${tag}`, kind: 'distributor' });
        const grant = await post(ana, { ...PROGRAM, title: `Grant ${tag}` });

        const find = async (query: string) => ids(await call('GET', `/api/projects?search=${tag}&${query}`, { token: viewer.token }));
        expect(await find('')).toEqual(sorted(job.id, raise.id, sale.id, partner.id, grant.id));
        expect(await find('type=job')).toEqual([job.id]);
        expect(await find('type=job&kind=full-time')).toEqual([]);
        // Only some types, as the phone app can ask; a type outside them finds none.
        expect(await find('types=business-for-sale,job,partnership,program')).toEqual(sorted(job.id, sale.id, partner.id, grant.id));
        expect(await find('types=job,program&type=investment')).toEqual([]);
        expect(await find('types=business-for-sale,job&minAmount=100000')).toEqual([sale.id]);
        expect(await find('type=partnership&kind=distributor')).toEqual([partner.id]);
        expect(await find('type=investment&stage=GROWTH')).toEqual([raise.id]);
        expect(await find('type=investment&stage=IDEA')).toEqual([]);
        expect(await find('category=TOURISM')).toEqual([sale.id]);
        expect(await find('remote=true')).toEqual([job.id]);
        expect(await find('btc=true')).toEqual(sorted(job.id, sale.id));
        // Its price, or the most it gives; projects have no amounts.
        expect(await find('type=business-for-sale&maxAmount=100000')).toEqual([]);
        expect(await find('minAmount=100000')).toEqual([sale.id]);
        expect(await find('maxAmount=50000')).toEqual([grant.id]);

        // Words in its place and its member's name count too.
        expect(ids(await call('GET', '/api/projects?search=Santa Tecla', { token: viewer.token }))).toContain(job.id);
        expect(ids(await call('GET', '/api/projects?search=Ana Filters', { token: viewer.token }))).toEqual(sorted(job.id, raise.id, sale.id, partner.id, grant.id));
    });

    it('sorts by the soonest closing day, A–Z or price, those without one last', async () => {
        const viewer = await member();
        const [a, b, c, d, e] = await Promise.all([1, 2, 3, 4, 5].map(() => member()));
        const tag = `S${Date.now()}`;
        const later = await post(a, { ...JOB, title: `Zumba teacher ${tag}`, closesOn: dayFromToday(20) });
        const soon = await post(b, { ...JOB, title: `árbol care ${tag}`, closesOn: dayFromToday(3) });
        const open = await post(c, { ...JOB, title: `Baker ${tag}` });
        const cheap = await post(d, { ...SALE, title: `Cafe ${tag}`, price: 50000 });
        const dear = await post(e, { ...SALE, title: `Hotel ${tag}`, price: 900000 });

        // The list's own order, not sorted for comparing.
        const find = async (query: string) => (await call('GET', `/api/projects?search=${tag}&${query}`, { token: viewer.token })).body.data.map((o: any) => o.id);
        expect((await find('type=job&sort=closing'))).toEqual([soon.id, later.id, open.id]);
        expect(await find('type=job&sort=name')).toEqual([soon.id, open.id, later.id]);
        expect(await find('type=business-for-sale&sort=price-low')).toEqual([cheap.id, dear.id]);
        expect(await find('type=business-for-sale&sort=price-high')).toEqual([dear.id, cheap.id]);
        // Without a price (jobs), last either way.
        expect((await find('sort=price-high')).slice(0, 2)).toEqual([dear.id, cheap.id]);
        expect(await find('sort=newest')).toEqual([dear.id, cheap.id, open.id, soon.id, later.id]);
    });

    it('a closed one is gone from the list, but not from its member\'s own', async () => {
        const ana = await member();
        const ben = await member();
        const job = await post(ana, JOB);
        const closed = await call('PUT', `/api/projects/${job.id}`, { token: ana.token, body: { closed: true } });
        expect(closed.status).toBe(200);
        expect(closed.body.isOpen).toBe(false);
        expect(closed.body.closedAt).toBeTruthy();

        expect(ids(await call('GET', `/api/projects?ownerId=${ana.id}`, { token: ben.token }))).toEqual([]);
        expect(ids(await call('GET', `/api/projects?ownerId=${ana.id}`, { token: ana.token }))).toEqual([job.id]);
        // Its page still opens, marked closed.
        const page = await call('GET', `/api/projects/${job.id}`, { token: ben.token });
        expect(page.status).toBe(200);
        expect(page.body.isOpen).toBe(false);

        const reopened = await call('PUT', `/api/projects/${job.id}`, { token: ana.token, body: { closed: false } });
        expect(reopened.body).toMatchObject({ isOpen: true, closedAt: null });
        expect(ids(await call('GET', `/api/projects?ownerId=${ana.id}`, { token: ben.token }))).toEqual([job.id]);
    });

    it('is open through its closing day in El Salvador, and gone after it', async () => {
        const ana = await member();
        const ben = await member();
        const today = await post(ana, { ...JOB, title: 'Closes today', closesOn: dayFromToday(0) });
        const yesterday = await post(ana, { ...JOB, title: 'Closed yesterday', closesOn: dayFromToday(1) });
        await passDays(yesterday.id, -1);
        expect(today.isOpen).toBe(true);
        expect((await call('GET', `/api/projects/${yesterday.id}`, { token: ana.token })).body.isOpen).toBe(false);
        expect(ids(await call('GET', `/api/projects?ownerId=${ana.id}`, { token: ben.token }))).toEqual([today.id]);
    });

    it("a closing day that's over can't be set, but one that passed can stay as it was", async () => {
        const ana = await member();
        const past = await call('POST', '/api/projects', { token: ana.token, body: { ...JOB, closesOn: dayFromToday(-1) } });
        expect(past.status).toBe(400);
        expect(past.body).toMatchObject({ reason: 'invalid', field: 'closesOn' });

        const job = await post(ana, { ...JOB, closesOn: dayFromToday(3) });
        expect((await call('PUT', `/api/projects/${job.id}`, { token: ana.token, body: { closesOn: dayFromToday(-3) } })).body.field).toBe('closesOn');
        await passDays(job.id, -2);
        // Edited as it is, its closing day sent back unchanged.
        const edited = await call('PUT', `/api/projects/${job.id}`, { token: ana.token, body: { title: 'Head bartender', closesOn: dayFromToday(-2) } });
        expect(edited.status, JSON.stringify(edited.body)).toBe(200);
        expect(edited.body).toMatchObject({ title: 'Head bartender', isOpen: false });
        // Opened again with that day: it says why it can't.
        const reopen = await call('PUT', `/api/projects/${job.id}`, { token: ana.token, body: { closed: false, closesOn: dayFromToday(-2) } });
        expect(reopen.body.field).toBe('closesOn');
    });

    it('a member has up to the limit open at once; closed ones make room', async () => {
        const ana = await member();
        const open = [];
        for (let i = 0; i < MAX_OPEN_PER_MEMBER; i++) open.push(await post(ana, { ...JOB, title: `Job ${i}` }));
        const over = await call('POST', '/api/projects', { token: ana.token, body: JOB });
        expect(over.status).toBe(409);
        expect(over.body).toMatchObject({ reason: 'too_many', max: MAX_OPEN_PER_MEMBER });

        expect((await call('PUT', `/api/projects/${open[0].id}`, { token: ana.token, body: { closed: true } })).status).toBe(200);
        await post(ana, { ...JOB, title: 'One more' });
        // Back at the limit: the closed one can't open again.
        const reopen = await call('PUT', `/api/projects/${open[0].id}`, { token: ana.token, body: { closed: false } });
        expect(reopen.status).toBe(409);
        expect(reopen.body.reason).toBe('too_many');
        // Nor by moving a closing day that passed.
        await passDays(open[1].id, -1);
        await post(ana, { ...JOB, title: 'And another' });
        const later = await call('PUT', `/api/projects/${open[1].id}`, { token: ana.token, body: { closesOn: dayFromToday(5) } });
        expect(later.body.reason).toBe('too_many');

        // One staff took down doesn't count.
        await prisma.project.update({ where: { id: open[2].id }, data: { isPublished: false } });
        await post(ana, { ...JOB, title: 'Room again' });
    });

    it('opening several again at once still keeps to the limit', async () => {
        const ana = await member();
        for (let i = 0; i < MAX_OPEN_PER_MEMBER - 1; i++) await post(ana, { ...JOB, title: `Job ${i}` });
        const closed = [];
        for (let i = 0; i < 3; i++) {
            const job = await post(ana, { ...JOB, title: `Closed ${i}` });
            if (i < 2) await call('PUT', `/api/projects/${job.id}`, { token: ana.token, body: { closed: true } });
            closed.push(job);
        }
        await call('PUT', `/api/projects/${closed[2].id}`, { token: ana.token, body: { closed: true } });
        const results = await Promise.all(closed.map((job) => call('PUT', `/api/projects/${job.id}`, { token: ana.token, body: { closed: false } })));
        expect(results.filter((r) => r.status === 409).length).toBeGreaterThanOrEqual(2);
        expect(await prisma.project.count({ where: { ownerId: ana.id, closedAt: null } })).toBeLessThanOrEqual(MAX_OPEN_PER_MEMBER);
    });

    it('opened again after its closing day, it loses that day', async () => {
        const ana = await member();
        const ben = await member();
        const late = await post(ana, { ...JOB, closesOn: dayFromToday(2) });
        await passDays(late.id, -2);
        const reopened = await call('PUT', `/api/projects/${late.id}`, { token: ana.token, body: { closed: false } });
        expect(reopened.body).toMatchObject({ isOpen: true, closesOn: '' });
        // A new day sent with it stays.
        await call('PUT', `/api/projects/${late.id}`, { token: ana.token, body: { closed: true } });
        const later = await call('PUT', `/api/projects/${late.id}`, { token: ana.token, body: { closed: false, closesOn: dayFromToday(7) } });
        expect(later.body).toMatchObject({ isOpen: true, closesOn: dayFromToday(7) });
        expect(ids(await call('GET', `/api/projects?ownerId=${ana.id}`, { token: ben.token }))).toEqual([late.id]);
    });

    it('search finds open ones for members only, and never across a block', async () => {
        const ana = await member();
        const ben = await member();
        const carl = await member();
        const tag = `Zq${Date.now()}`;
        const open = await post(ana, { ...SALE, title: `Hostel ${tag}` });
        const closed = await post(ana, { ...JOB, title: `Cook ${tag}` });
        await call('PUT', `/api/projects/${closed.id}`, { token: ana.token, body: { closed: true } });

        const signedOut = await call('GET', `/api/search?q=${tag}&type=projects`);
        expect(signedOut.body.projects).toEqual([]);
        const found = await call('GET', `/api/search?q=${tag}&type=projects`, { token: ben.token });
        expect(found.body.projects.map((p: any) => p.id)).toEqual([open.id]);
        expect(found.body.projects[0]).toMatchObject({ type: 'business-for-sale' });
        expect(found.body.projects[0].whatsapp).toBeUndefined();
        // From the cache too: signed out still gets none.
        expect((await call('GET', `/api/search?q=${tag}&type=projects`)).body.projects).toEqual([]);
        const suggested = await call('GET', `/api/search/suggestions?q=${tag}`, { token: ben.token });
        expect(suggested.body.suggestions.map((s: any) => s.id)).toEqual([open.id]);
        expect((await call('GET', `/api/search/suggestions?q=${tag}`)).body.suggestions).toEqual([]);

        expect((await call('POST', '/api/blocks', { token: ana.token, body: { userId: carl.id } })).status).toBe(201);
        expect((await call('GET', `/api/search?q=${tag}&type=projects`, { token: carl.token })).body.projects).toEqual([]);
        expect((await call('GET', `/api/search/suggestions?q=${tag}`, { token: carl.token })).body.suggestions).toEqual([]);
    });

    it('an older project, from before opportunities, can still be closed as it is', async () => {
        const ana = await member();
        const old = await prisma.project.create({ data: { title: 'Old project', description: 'x', ownerId: ana.id } });
        const res = await call('PUT', `/api/projects/${old.id}`, { token: ana.token, body: { closed: true } });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body).toMatchObject({ type: 'investment', isOpen: false });
    });
});

// ─── Changing and removing ────────────────────────────────────────────────────

describe('changing and removing an opportunity', () => {
    it('only its member changes it, not other members or staff; its type stays', async () => {
        const ana = await member();
        const ben = await member();
        const mod = await member({ role: 'MOD' });
        const job = await post(ana, JOB);

        expect((await call('PUT', `/api/projects/${job.id}`, { token: ben.token, body: { title: 'Scam' } })).status).toBe(403);
        expect((await call('PUT', `/api/projects/${job.id}`, { token: mod.token, body: { title: 'Edited' } })).status).toBe(403);

        const changed = await call('PUT', `/api/projects/${job.id}`, { token: ana.token, body: { type: 'investment', kind: 'part-time', pay: '$5 an hour' } });
        expect(changed.status).toBe(200);
        expect(changed.body).toMatchObject({ type: 'job', kind: 'part-time', pay: '$5 an hour', title: 'Bartender' });
        const wrongKind = await call('PUT', `/api/projects/${job.id}`, { token: ana.token, body: { kind: 'grant' } });
        expect(wrongKind.status).toBe(400);
        const noContact = await call('PUT', `/api/projects/${job.id}`, { token: ana.token, body: { whatsapp: '' } });
        expect(noContact.body.field).toBe('contact');
    });

    it('its member or staff can remove it, and staff removals are logged', async () => {
        const ana = await member();
        const ben = await member();
        const mod = await member({ role: 'MOD' });
        const mine = await post(ana, JOB);
        const reported = await post(ana, SALE);

        expect((await call('DELETE', `/api/projects/${mine.id}`, { token: ben.token })).status).toBe(403);
        expect((await call('DELETE', `/api/projects/${mine.id}`, { token: ana.token })).status).toBe(200);
        expect((await call('DELETE', `/api/projects/${reported.id}`, { token: mod.token })).status).toBe(200);
        expect(await prisma.project.count({ where: { ownerId: ana.id } })).toBe(0);

        const logged = await prisma.auditLog.findMany({ where: { action: 'OPPORTUNITY_REMOVED' } });
        expect(logged.map((l) => l.resource)).toEqual([`project:${reported.id}`]);
        expect(logged[0].userId).toBe(mod.id);
    });

    it('a suspended member\'s opportunities are gone for others', async () => {
        const ana = await member();
        const ben = await member();
        const job = await post(ana, JOB);
        await prisma.user.update({ where: { id: ana.id }, data: { isBanned: true } });
        expect(ids(await call('GET', `/api/projects?ownerId=${ana.id}`, { token: ben.token }))).toEqual([]);
        expect((await call('GET', `/api/projects/${job.id}`, { token: ben.token })).status).toBe(404);
    });
});

// ─── Photos ───────────────────────────────────────────────────────────────────

describe("an opportunity's photos", () => {
    it("are the member's own uploads; the first is the cover; those taken off go, and the rest go with it", async () => {
        const ana = await member();
        const ben = await member();
        const bens = await uploaded(ben);
        const first = await uploaded(ana);
        const second = await uploaded(ana);

        const notYours = await call('POST', '/api/projects', { token: ana.token, body: { ...SALE, photos: [bens] } });
        expect(notYours.status).toBe(400);
        expect(notYours.body.reason).toBe('not_your_photo');

        const sale = await post(ana, { ...SALE, photos: [first, second, first] });
        expect(sale.photos).toEqual([first, second]);
        expect(sale.thumbnail).toBe(first);

        const edited = await call('PUT', `/api/projects/${sale.id}`, { token: ana.token, body: { photos: [second] } });
        expect(edited.body).toMatchObject({ photos: [second], thumbnail: second });
        expect(stored(first)).toBe(false);
        expect(stored(second)).toBe(true);

        expect((await call('DELETE', `/api/projects/${sale.id}`, { token: ana.token })).status).toBe(200);
        expect(stored(second)).toBe(false);
    });

    it('move with the account when staff merge two accounts, and go when the account is deleted', async () => {
        const source = await member();
        const target = await member();
        const admin = await member({ role: 'ADMIN', isAdmin: true });
        const cover = await uploaded(source);
        await post(source, { ...SALE, photos: [cover] });
        const res: any = { status(code: number) { this.code = code; return this; }, json(body: unknown) { this.body = body; return this; } };
        await syncAccounts({ body: { sourceUserId: source.id, targetUserId: target.id, deleteSource: false }, user: { id: admin.id, isAdmin: true } } as any, res);
        expect(res.code ?? 200).toBe(200);
        expect((await prisma.upload.findUnique({ where: { name: cover.split('/').pop()! } }))?.userId).toBe(target.id);
        const moved = await prisma.project.findFirstOrThrow({ where: { ownerId: target.id } });
        expect((await call('PUT', `/api/projects/${moved.id}`, { token: target.token, body: { photos: [] } })).status).toBe(200);
        expect(stored(cover)).toBe(false);

        const ana = await member();
        const photo = await uploaded(ana);
        await post(ana, { ...JOB, photos: [photo] });
        await deleteAccount(ana.id, { notify: false });
        expect(await prisma.project.count({ where: { ownerId: ana.id } })).toBe(0);
        expect(stored(photo)).toBe(false);
    });
});

// ─── Pitch decks ──────────────────────────────────────────────────────────────

async function uploadDeck(m: Member, projectId: string): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(Buffer.from('%PDF-1.7 the deck'))], { type: 'application/pdf' }), 'deck.pdf');
    const res = await fetch(`${base}/api/upload/deck?projectId=${projectId}`, { method: 'POST', headers: { Authorization: `Bearer ${m.token}` }, body: form });
    const body = (await res.json()) as any;
    if (res.status !== 200) throw new Error(`deck upload failed: ${res.status} ${JSON.stringify(body)}`);
    return body.key as string;
}
const deckStored = (key: string) => fs.existsSync(path.join(env.dir, 'uploads', 'private', key.split('/').pop()!));

describe("an investment's pitch deck", () => {
    it('any member can ask for it; its member says yes; then they can open it', async () => {
        const ana = await member({ name: 'Ana Founder' });
        const ben = await member({ name: 'Ben Investor' });
        const raise = await post(ana, INVESTMENT);
        const key = await uploadDeck(ana, raise.id);

        const before = await call('GET', `/api/projects/${raise.id}`, { token: ben.token });
        expect(before.body).toMatchObject({ hasDeck: true, deckAccess: 'ask' });
        expect(before.body.deckKey).toBeUndefined();
        expect((await call('GET', `/api/projects/${raise.id}/deck`, { token: ben.token })).status).toBe(403);

        expect((await call('POST', `/api/projects/${raise.id}/deck/request`, { token: ben.token, body: { message: 'Keen to see it' } })).status).toBe(201);
        const pending = await call('GET', `/api/projects/${raise.id}/deck`, { token: ben.token });
        expect(pending.body.requestStatus).toBe('PENDING');
        expect((await call('GET', `/api/projects/${raise.id}`, { token: ben.token })).body.deckAccess).toBe('pending');
        const told = await prisma.notification.findFirst({ where: { userId: ana.id, type: 'DECK_REQUEST' } });
        expect(told?.title).toContain('Ben Investor');

        const requests = await call('GET', `/api/projects/${raise.id}/deck/requests`, { token: ana.token });
        expect(requests.body.data.map((r: any) => r.investorId)).toEqual([ben.id]);
        expect((await call('PUT', `/api/projects/${raise.id}/deck/requests/${requests.body.data[0].id}`, { token: ana.token, body: { status: 'APPROVED' } })).status).toBe(200);

        expect((await call('GET', `/api/projects/${raise.id}`, { token: ben.token })).body.deckAccess).toBe('approved');
        const link = await call('GET', `/api/projects/${raise.id}/deck`, { token: ben.token });
        expect(link.status).toBe(200);
        const file = await fetch(`${base}${link.body.url}`);
        expect(await file.text()).toBe('%PDF-1.7 the deck');

        // Its member's own view, and the deck going with it.
        expect((await call('GET', `/api/projects/${raise.id}`, { token: ana.token })).body.deckAccess).toBe('own');
        expect(deckStored(key)).toBe(true);
        expect((await call('DELETE', `/api/projects/${raise.id}`, { token: ana.token })).status).toBe(200);
        expect(deckStored(key)).toBe(false);
    });

    it('opens at once when shared with every member, and never across a block', async () => {
        const ana = await member();
        const ben = await member();
        const carl = await member();
        const raise = await post(ana, { ...INVESTMENT, requiresDeckApproval: false });
        await uploadDeck(ana, raise.id);
        expect((await call('GET', `/api/projects/${raise.id}`, { token: ben.token })).body.deckAccess).toBe('open');
        expect((await call('GET', `/api/projects/${raise.id}/deck`, { token: ben.token })).status).toBe(200);

        expect((await call('POST', '/api/blocks', { token: ana.token, body: { userId: carl.id } })).status).toBe(201);
        expect((await call('GET', `/api/projects/${raise.id}/deck`, { token: carl.token })).status).toBe(404);
        expect((await call('POST', `/api/projects/${raise.id}/deck/request`, { token: carl.token, body: {} })).status).toBe(404);
    });
});

// ─── Saving, blocks and reports ───────────────────────────────────────────────

describe('saving, blocks and reports', () => {
    it('a member saves one privately, and finds it under Saved even once it closes', async () => {
        const ana = await member();
        const ben = await member();
        const job = await post(ana, JOB);
        expect((await call('POST', '/api/watchlist', { token: ben.token, body: { projectId: job.id } })).status).toBe(201);
        expect(await prisma.notification.count({ where: { userId: ana.id } })).toBe(0);
        expect((await call('GET', `/api/projects/${job.id}`, { token: ben.token })).body.saved).toBe(true);

        await call('PUT', `/api/projects/${job.id}`, { token: ana.token, body: { closed: true } });
        expect(ids(await call('GET', '/api/projects?saved=true', { token: ben.token }))).toEqual([job.id]);
        expect(ids(await call('GET', '/api/projects?saved=true', { token: ana.token }))).toEqual([]);
    });

    it("a block hides each member's opportunities from the other, and they can't be saved", async () => {
        const ana = await member();
        const ben = await member();
        const anas = await post(ana, JOB);
        const bens = await post(ben, SALE);
        expect((await call('POST', '/api/blocks', { token: ben.token, body: { userId: ana.id } })).status).toBe(201);

        expect(ids(await call('GET', `/api/projects?ownerId=${ana.id}`, { token: ben.token }))).toEqual([]);
        const blocked = await call('GET', `/api/projects/${anas.id}`, { token: ben.token });
        expect(blocked.status).toBe(404);
        expect(blocked.body.reason).toBe('blocked');
        expect((await call('POST', '/api/watchlist', { token: ben.token, body: { projectId: anas.id } })).status).toBe(404);

        // And Ana, whom Ben blocked, doesn't see his (without being told why).
        expect(ids(await call('GET', `/api/projects?ownerId=${ben.id}`, { token: ana.token }))).toEqual([]);
        const hidden = await call('GET', `/api/projects/${bens.id}`, { token: ana.token });
        expect(hidden.status).toBe(404);
        expect(hidden.body.reason).toBeUndefined();
    });

    it('a member can report an opportunity; the report names whose it is', async () => {
        const ana = await member();
        const ben = await member();
        const sale = await post(ana, SALE);
        const report = { targetType: 'opportunity', targetId: sale.id, reason: 'scam_spam', details: 'Asks for a deposit before a visit.' };

        expect((await call('POST', '/api/reports', { token: ben.token, body: report })).status).toBe(201);
        const row = await prisma.report.findFirstOrThrow({ where: { targetType: 'opportunity', targetId: sale.id } });
        expect(row).toMatchObject({ reporterId: ben.id, targetUserId: ana.id, reason: 'scam_spam' });

        const own = await call('POST', '/api/reports', { token: ana.token, body: report });
        expect(own.status).toBe(400);
        expect(own.body.reason).toBe('own_content');
    });
});

// ─── Other ways to an opportunity ─────────────────────────────────────────────

/** An admin action called as the admin routes call it; its status and body. */
async function asAdmin(handler: (req: any, res: any) => Promise<void>, admin: Member, req: Record<string, unknown>) {
    const res: any = { code: 200, status(code: number) { this.code = code; return this; }, json(body: unknown) { this.body = body; return this; } };
    await handler({ ...req, user: { id: admin.id, isAdmin: true, role: 'ADMIN' } }, res);
    return res as { code: number; body: any };
}

const privateFiles = () => {
    const dir = path.join(env.dir, 'uploads', 'private');
    return fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
};

describe('other ways to an opportunity follow the same rules', () => {
    it('the saved list leaves out WhatsApp and email, and what blocks, suspensions and staff hide', async () => {
        const ana = await member();
        const ben = await member();
        const carl = await member();
        const job = await post(ana, { ...JOB, email: 'ana@example.com' });
        const sale = await post(carl, SALE);
        const program = await post(carl, PROGRAM);
        for (const o of [job, sale, program]) {
            expect((await call('POST', '/api/watchlist', { token: ben.token, body: { projectId: o.id } })).status).toBe(201);
        }
        const savedIds = async () => ((await call('GET', '/api/watchlist', { token: ben.token })).body.data as any[]).map((i) => i.project.id).sort();

        const saved = await call('GET', '/api/watchlist', { token: ben.token });
        expect(saved.body.data.map((i: any) => i.project.id).sort()).toEqual(sorted(job.id, sale.id, program.id));
        for (const item of saved.body.data) {
            expect(item.project.whatsapp).toBeUndefined();
            expect(item.project.email).toBeUndefined();
        }

        // Ana blocks Ben; staff take one of Carl's down; then Carl is suspended.
        expect((await call('POST', '/api/blocks', { token: ana.token, body: { userId: ben.id } })).status).toBe(201);
        await prisma.project.update({ where: { id: program.id }, data: { isPublished: false } });
        expect(await savedIds()).toEqual([sale.id]);
        await prisma.user.update({ where: { id: carl.id }, data: { isBanned: true } });
        expect(await savedIds()).toEqual([]);

        // A suspended member's can't be saved either; a note has a length.
        const dan = await member();
        expect((await call('POST', '/api/watchlist', { token: dan.token, body: { projectId: sale.id } })).status).toBe(404);
        const eve = await member();
        const open = await post(eve, JOB);
        expect((await call('POST', '/api/watchlist', { token: dan.token, body: { projectId: open.id } })).status).toBe(201);
        expect((await call('PUT', `/api/watchlist/${open.id}/note`, { token: dan.token, body: { note: 'x'.repeat(501) } })).status).toBe(400);
        expect((await call('PUT', `/api/watchlist/${open.id}/note`, { token: dan.token, body: { note: 'Call on Monday' } })).status).toBe(200);
    });

    it("a suspended member's pitch deck can't be opened or asked for; an answer is sent once, and not across a block", async () => {
        const ana = await member();
        const ben = await member();
        const carl = await member();
        const dan = await member();
        const eve = await member();
        const raise = await post(ana, INVESTMENT);
        await uploadDeck(ana, raise.id);
        const ask = async (who: Member) => {
            expect((await call('POST', `/api/projects/${raise.id}/deck/request`, { token: who.token, body: {} })).status).toBe(201);
        };
        const askers = async () => (await call('GET', `/api/projects/${raise.id}/deck/requests`, { token: ana.token })).body.data;
        const answer = (id: string, status: string) =>
            call('PUT', `/api/projects/${raise.id}/deck/requests/${id}`, { token: ana.token, body: { status } });
        const told = (who: Member, type: string) => prisma.notification.count({ where: { userId: who.id, type } });

        // Told of the first answer only: answering again, either way, tells no one.
        await ask(ben);
        const [bens] = await askers();
        expect((await answer(bens.id, 'APPROVED')).status).toBe(200);
        expect((await answer(bens.id, 'APPROVED')).body.status).toBe('APPROVED');
        expect((await answer(bens.id, 'DENIED')).body.status).toBe('DENIED');
        expect((await answer(bens.id, 'APPROVED')).body.status).toBe('APPROVED');
        expect(await told(ben, 'DECK_APPROVED')).toBe(1);
        expect(await told(ben, 'DECK_DENIED')).toBe(0);

        // Across a block, or once suspended, they're gone from the list; an answer isn't sent across the block.
        await ask(dan);
        await ask(eve);
        const dans = (await askers()).find((r: any) => r.investorId === dan.id);
        expect((await call('POST', '/api/blocks', { token: dan.token, body: { userId: ana.id } })).status).toBe(201);
        await prisma.user.update({ where: { id: eve.id }, data: { isBanned: true } });
        expect((await askers()).map((r: any) => r.investorId)).toEqual([ben.id]);
        expect((await answer(dans.id, 'DENIED')).status).toBe(200);
        expect(await told(dan, 'DECK_DENIED')).toBe(0);

        expect((await call('GET', `/api/projects/${raise.id}/deck`, { token: carl.token })).status).toBe(403);
        await prisma.user.update({ where: { id: ana.id }, data: { isBanned: true } });
        expect((await call('GET', `/api/projects/${raise.id}/deck`, { token: carl.token })).status).toBe(404);
        expect((await call('POST', `/api/projects/${raise.id}/deck/request`, { token: carl.token, body: {} })).status).toBe(404);
    });

    it("a pitch deck goes only on its member's own investment", async () => {
        const ana = await member();
        const ben = await member();
        const job = await post(ana, JOB);
        const raise = await post(ana, INVESTMENT);
        const before = privateFiles();
        await expect(uploadDeck(ana, job.id)).rejects.toThrow(/404/);
        await expect(uploadDeck(ben, raise.id)).rejects.toThrow(/404/);
        expect(privateFiles()).toBe(before);
        expect((await prisma.project.findUniqueOrThrow({ where: { id: job.id } })).deckKey).toBeNull();
    });

    it('the older ways to post updates, show interest or ask for review are gone', async () => {
        const investor = await member({ role: 'INVESTOR' });
        const ana = await member();
        const raise = await post(ana, INVESTMENT);
        expect((await call('POST', `/api/projects/${raise.id}/updates`, { token: ana.token, body: { title: 'News', content: 'More' } })).status).toBe(404);
        expect((await call('POST', `/api/projects/${raise.id}/interest`, { token: investor.token, body: {} })).status).toBe(404);
        expect((await call('PUT', `/api/projects/${raise.id}/submit`, { token: ana.token, body: {} })).status).toBe(404);
        expect((await call('GET', '/api/projects/builder/deck-requests', { token: ana.token })).status).toBe(404);
        expect(await prisma.notification.count({ where: { userId: ana.id } })).toBe(0);
    });

    it('investor recommendations are open investments only, without WhatsApp or email, and never across a block', async () => {
        const investor = await member({ role: 'INVESTOR' });
        await prisma.profile.update({
            where: { userId: investor.id },
            data: { investmentFocus: JSON.stringify(['LOGISTICS']), investmentStage: JSON.stringify(['SCALING']) },
        });
        const ana = await member();
        const carl = await member();
        const fits = { ...INVESTMENT, category: 'LOGISTICS', stage: 'SCALING' };
        const raise = await post(ana, fits);
        const closed = await post(ana, { ...fits, title: 'Raised already' });
        await call('PUT', `/api/projects/${closed.id}`, { token: ana.token, body: { closed: true } });
        await post(ana, { ...JOB, category: 'LOGISTICS' });
        await post(carl, { ...fits, title: 'From someone who blocked them' });
        expect((await call('POST', '/api/blocks', { token: carl.token, body: { userId: investor.id } })).status).toBe(201);

        const recs = await call('GET', '/api/match/investors/recommendations', { token: investor.token });
        expect(recs.status, JSON.stringify(recs.body)).toBe(200);
        const shown = recs.body.data.map((r: any) => r.project);
        expect(shown.map((p: any) => p.id)).toEqual([raise.id]);
        expect(shown[0].whatsapp).toBeUndefined();
        expect(shown[0].email).toBeUndefined();
    });

    it('staff moving one to another member move its photos with it', async () => {
        const ana = await member();
        const ben = await member();
        const admin = await member({ role: 'ADMIN', isAdmin: true });
        const cover = await uploaded(ana);
        const sale = await post(ana, { ...SALE, photos: [cover] });
        const moved = await asAdmin(moveProjectOwnership, admin, { params: { id: sale.id }, body: { newOwnerId: ben.id } });
        expect(moved.code, JSON.stringify(moved.body)).toBe(200);
        expect((await prisma.upload.findUnique({ where: { name: cover.split('/').pop()! } }))?.userId).toBe(ben.id);
        expect((await call('PUT', `/api/projects/${sale.id}`, { token: ben.token, body: { photos: [] } })).status).toBe(200);
        expect(stored(cover)).toBe(false);
    });

    it("a member's profile lists their open opportunities, and none while Opportunities is off", async () => {
        const ana = await member();
        const ben = await member();
        const open = await post(ana, JOB);
        const closed = await post(ana, SALE);
        await call('PUT', `/api/projects/${closed.id}`, { token: ana.token, body: { closed: true } });

        const profile = await call('GET', `/api/profiles/${ana.id}`, { token: ben.token });
        expect(profile.status).toBe(200);
        expect(profile.body.user.projects.map((p: any) => p.id)).toEqual([open.id]);
        await setFlags({ projects: false });
        try {
            expect((await call('GET', `/api/profiles/${ana.id}`, { token: ben.token })).body.user.projects).toEqual([]);
        } finally {
            await setFlags({ projects: true });
        }

        // None from a suspended member: their whole page is gone.
        const carl = await member();
        await post(carl, JOB);
        await prisma.user.update({ where: { id: carl.id }, data: { isBanned: true } });
        expect((await call('GET', `/api/profiles/${carl.id}`, { token: ben.token })).status).toBe(404);
    });
});
