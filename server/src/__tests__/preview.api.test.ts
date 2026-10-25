/**
 * Shared pages for people not signed in (preview.controller.ts): what a
 * business, farm, opportunity or talent's preview shows and keeps for
 * members, when there is none, and the link card crawlers read. Real routes
 * against a real SQLite database built from the repo's migrations.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const env = vi.hoisted(() => {
    const dir = `${process.env.TMPDIR || '/tmp'}/bies-preview-test-${process.pid}-${Date.now()}`;
    process.env.DATABASE_URL = `file:${dir}/test.db`;
    process.env.RELAY_WHITELIST_PATH = `${dir}/relay/whitelist.txt`;
    process.env.APP_PUBLIC_URL = 'https://app.example.test';
    return { dir };
});

vi.mock('nostr-tools/pool', () => ({
    SimplePool: class {
        publish(urls: string[]) { return urls.map(() => Promise.resolve('')); }
        async querySync() { return []; }
        async get() { return null; }
    },
}));

import { execSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import express from 'express';
import prisma from '../lib/prisma';
import previewRoutes from '../routes/preview.routes';
import { setFlags } from '../services/featureFlags.service';
import { summary } from '../controllers/preview.controller';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';

let server: http.Server;
let base: string;

beforeAll(async () => {
    fs.mkdirSync(env.dir, { recursive: true });
    execSync('npx prisma migrate deploy', { cwd: path.resolve(__dirname, '../..'), env: process.env, stdio: 'pipe' });
    const app = express();
    app.use('/api/preview', previewRoutes);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 120_000);

afterAll(async () => {
    server?.close();
    await prisma.$disconnect();
    fs.rmSync(env.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function get(url: string) {
    const res = await fetch(`${base}${url}`);
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* the link card is HTML */ }
    return { status: res.status, body, text };
}

const member = (name: string, extra: Record<string, unknown> = {}) => prisma.user.create({
    data: { nostrPubkey: getPublicKey(generateSecretKey()), role: 'MEMBER', profile: { create: { name } }, ...extra },
});

const business = async (extra: Record<string, unknown> = {}) => {
    const owner = await member('Owner');
    return prisma.directoryListing.create({
        data: {
            type: 'PROVIDER', name: 'Casa Fuego', category: 'food', status: 'active', ownerId: owner.id,
            about: 'Wood-fired pizza by the lake. '.repeat(20), location: 'Coatepeque',
            photo: '/uploads/public/cover.jpg', photos: JSON.stringify(['/uploads/public/cover.jpg', '/uploads/public/2.jpg', '/uploads/public/3.jpg']),
            phone: '+503 7000 0000', whatsapp: '+503 7000 0001', email: 'hola@casafuego.test', website: 'https://casafuego.test',
            hours: 'Tue–Sun 12–9', mapUrl: 'https://maps.test/casa', pricing: '$$', btcAccepted: true, vouchCount: 3,
            ...extra,
        },
    });
};

describe('a shared business or farm', () => {
    it('shows what entices and only names what members see', async () => {
        const listing = await business();
        const fan = await member('Fan');
        await prisma.directoryEndorsement.create({ data: { listingId: listing.id, userId: fan.id, vote: 1, comment: 'Best pizza around' } });

        const res = await get(`/api/preview/trusted/${listing.id}`);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            section: 'trusted', name: 'Casa Fuego', category: 'food', location: 'Coatepeque', photo: '/uploads/public/cover.jpg',
            vouchCount: 3, btcAccepted: true, pricing: '$$',
            members: { contact: true, links: true, hours: true, map: true, morePhotos: 2, reviews: 1, fullText: true },
        });
        expect(res.body.about.length).toBeLessThanOrEqual(241);
        expect(res.body.about.endsWith('…')).toBe(true);
        const shown = JSON.stringify(res.body);
        // The numbers as written ('7000 000…'): a bare '7000' can turn up inside a generated id.
        for (const kept of ['7000 000', 'hola@', 'casafuego.test', 'Tue–Sun', 'maps.test', 'Best pizza', 'Owner', 'Fan', listing.ownerId]) {
            expect(shown, kept).not.toContain(kept);
        }
    });

    it('none for a listing that is unpublished, not yet active, or run by a suspended member', async () => {
        const unpublished = await business({ isPublished: false });
        const pending = await business({ status: 'pending-review' });
        const banned = await member('Banned', { isBanned: true });
        const theirs = await business({ ownerId: banned.id });
        for (const l of [unpublished, pending, theirs]) {
            expect((await get(`/api/preview/trusted/${l.id}`)).status).toBe(404);
        }
        expect((await get('/api/preview/trusted/no-such-id')).status).toBe(404);
        expect((await get('/api/preview/somewhere/abc')).status).toBe(404);
    });

    it('a farm, under its own section', async () => {
        const owner = await member('Farmer');
        const farm = await prisma.directoryListing.create({
            data: { type: 'FARM', name: 'Finca Luz', status: 'active', ownerId: owner.id, products: JSON.stringify([{ label: 'Coffee' }, { label: 'Honey' }]) },
        });
        const res = await get(`/api/preview/farms/${farm.id}`);
        expect(res.body).toMatchObject({ section: 'farms', name: 'Finca Luz', products: ['Coffee', 'Honey'], pricing: '', members: { contact: false, morePhotos: 0 } });
    });
});

describe('a shared opportunity', () => {
    it('its type, words and photo; not the poster, amounts or how to reach them', async () => {
        const owner = await member('Poster');
        const job = await prisma.project.create({
            data: {
                type: 'job', kind: 'full-time', title: 'Barista', description: '<p>Make <b>great</b> coffee.</p>', location: 'El Tunco',
                pay: '$900 a month', whatsapp: '+503 7111 1111', email: 'jobs@cafe.test', thumbnail: '/uploads/public/job.jpg',
                status: 'active', ownerId: owner.id, closesOn: '2099-12-31',
            },
        });
        const res = await get(`/api/preview/opportunities/${job.id}`);
        expect(res.body).toMatchObject({
            section: 'opportunities', type: 'job', kind: 'full-time', name: 'Barista', about: 'Make great coffee.',
            location: 'El Tunco', photo: '/uploads/public/job.jpg', isOpen: true, closesOn: '2099-12-31', members: { contact: true, fullText: false },
        });
        const shown = JSON.stringify(res.body);
        for (const kept of ['$900', '7111', 'jobs@', 'Poster', owner.id]) expect(shown, kept).not.toContain(kept);

        const closed = await prisma.project.create({ data: { title: 'Old', description: 'x', ownerId: owner.id, closedAt: new Date() } });
        expect((await get(`/api/preview/opportunities/${closed.id}`)).body.isOpen).toBe(false);
        const takenDown = await prisma.project.create({ data: { title: 'Gone', description: 'x', ownerId: owner.id, isPublished: false } });
        expect((await get(`/api/preview/opportunities/${takenDown.id}`)).status).toBe(404);
    });

    it('none while Opportunities is switched off', async () => {
        const owner = await member('Poster 2');
        const p = await prisma.project.create({ data: { title: 'Grant', description: 'x', ownerId: owner.id } });
        await setFlags({ projects: false });
        try {
            expect((await get(`/api/preview/opportunities/${p.id}`)).status).toBe(404);
        } finally {
            await setFlags({ projects: true });
        }
    });
});

describe('a shared talent', () => {
    it('what they offer; not who, their rates or contact', async () => {
        const user = await member('Talented');
        const talent = await prisma.talentListing.create({
            data: {
                userId: user.id, title: 'Wedding photographer', category: 'media', about: 'Weddings and events.', rate: '$300 a day',
                email: 'me@photo.test', available: true, works: JSON.stringify([{ title: 'A wedding', media: [{ url: '/uploads/public/w1.jpg' }] }]),
            },
        });
        const res = await get(`/api/preview/talents/${talent.id}`);
        expect(res.body).toMatchObject({
            section: 'talents', name: 'Wedding photographer', category: 'media', available: true, photo: '/uploads/public/w1.jpg',
            members: { contact: true, rate: true, works: 1 },
        });
        const shown = JSON.stringify(res.body);
        for (const kept of ['$300', 'me@photo', 'Talented', user.id]) expect(shown, kept).not.toContain(kept);
    });
});

describe('the link card', () => {
    it('the listing\'s name, words and photo, escaped, and not for search engines', async () => {
        const listing = await business({ name: 'Tacos <script>alert(1)</script> "El Rey"', photo: '/uploads/public/tacos.jpg', photos: '[]' });
        const res = await get(`/api/preview/trusted/${listing.id}/og`);
        expect(res.status).toBe(200);
        expect(res.text).toContain('<meta name="robots" content="noindex" />');
        expect(res.text).toContain('content="Tacos &lt;script&gt;alert(1)&lt;/script&gt; &quot;El Rey&quot; | BIES"');
        expect(res.text).not.toContain('<script>alert');
        expect(res.text).toContain('content="https://app.example.test/uploads/public/tacos.jpg"');
        expect(res.text).toContain(`content="https://app.example.test/trusted/${listing.id}"`);
        expect(res.text).toContain('Coatepeque · Recommended by 3 members');
        expect(res.text).not.toContain('7000 000');
    });

    it('the BIES card when there is nothing to show; a bad link is refused', async () => {
        const res = await get('/api/preview/farms/nothing-here/og');
        expect(res.status).toBe(200);
        expect(res.text).toContain('content="BIES | Build in El Salvador"');
        expect((await get('/api/preview/trusted/a%22b/og')).status).toBe(400);
    });
});

describe('summary', () => {
    it('plain text, cut at a word with …', () => {
        expect(summary('<p>Hello <b>there</b></p>')).toEqual({ text: 'Hello there', cut: false });
        const cut = summary('word '.repeat(100), 30);
        expect(cut.cut).toBe(true);
        expect(cut.text).toBe('word word word word word word…');
    });
});
