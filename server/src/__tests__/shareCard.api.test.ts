/**
 * The picture on a shared event's link card (WhatsApp, iMessage and the like):
 * a BIES event's cover as it is, square; every other event a smaller wide card
 * with its name, when and where; drawn once for what's on it, again when that
 * changes. Its host positions the cover for it (shareFrame). Real routes
 * against a real SQLite database built from the repo's migrations.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const env = vi.hoisted(() => {
    const dir = `${process.env.TMPDIR || '/tmp'}/bies-share-card-test-${process.pid}-${Date.now()}`;
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
import eventRoutes from '../routes/events.routes';
import uploadRoutes from '../routes/upload.routes';
import previewRoutes from '../routes/preview.routes';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { createSession, signAccessToken } from '../services/session.service';
import { pathToFileURL } from 'url';
import { eventCardSpec, summary } from '../controllers/preview.controller';
import {
    capped, cardDate, cardLayout, drawable, drawCard, fitLine, fetchableCover, isPhoto, MAX_LETTERS, oneAtATime, overlaySvg, placedPhoto,
    shareCardSpec, SQUARE, sweepCards, textWidth, WIDE, wrapLines, type Box,
} from '../services/shareCard.service';
import { deleteAccount } from '../services/account.service';
import { safeGet } from '../utils/safeFetch';
import { placeFrame } from '../utils/coverFrame';
import opentype from 'opentype.js';

let server: http.Server;
let base: string;
const CARDS = () => path.join(process.env.UPLOAD_DIR!, 'cards');

beforeAll(async () => {
    fs.mkdirSync(env.dir, { recursive: true });
    execSync('npx prisma migrate deploy', { cwd: path.resolve(__dirname, '../..'), env: process.env, stdio: 'pipe' });

    const app = express();
    app.use(express.json());
    app.use('/api/events', eventRoutes);
    app.use('/api/upload', uploadRoutes);
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function call(method: string, url: string, { token, body }: { token?: string; body?: unknown } = {}) {
    const res = await fetch(`${base}${url}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: any = {};
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text, headers: res.headers };
}

async function picture(url: string) {
    const res = await fetch(`${base}${url}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    return { status: res.status, type: res.headers.get('content-type'), cache: res.headers.get('cache-control'), bytes };
}

type Member = { id: string; token: string };

let counter = 0;
async function member(): Promise<Member> {
    const user = await prisma.user.create({
        data: {
            nostrPubkey: getPublicKey(generateSecretKey()),
            termsVersion: '2026-10',
            termsAcceptedAt: new Date(),
            profile: { create: { name: `Member ${++counter}` } },
        },
    });
    const session = await createSession(user.id, 'native');
    return { id: user.id, token: signAccessToken({ id: user.id, role: 'MEMBER', isAdmin: false }, session.sessionId) };
}

/** A photo this member uploaded (a tall flyer's shape), as stored: /uploads/public/... */
async function uploaded(m: Member): Promise<string> {
    const file = await sharp({ create: { width: 800, height: 1000, channels: 3, background: { r: 30, g: 110 + (++counter % 100), b: 70 } } }).jpeg().toBuffer();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(file)], { type: 'image/jpeg' }), 'cover.jpg');
    const res = await fetch(`${base}/api/upload/media`, { method: 'POST', headers: { Authorization: `Bearer ${m.token}` }, body: form });
    const body = (await res.json()) as any;
    if (res.status !== 200) throw new Error(`upload failed: ${res.status} ${JSON.stringify(body)}`);
    return body.url as string;
}

// Sat 14 Nov 2026, 7:00 PM in El Salvador (UTC-6).
const NIGHT = '2026-11-15T01:00:00.000Z';

async function event(host: Member, body: Record<string, unknown> = {}) {
    const res = await call('POST', '/api/events', {
        token: host.token,
        body: { title: `Event ${++counter}`, description: '<p>BIES Networking night</p><p>Just a room full of interesting people.</p>', startDate: NIGHT, nostrPublish: 'none', locationName: 'Rooftop venue', ...body },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
}

/** The picture the event's link card points to, from the card page crawlers read. */
async function cardLink(id: string) {
    const og = (await call('GET', `/api/preview/events/${id}/og`)).text;
    const image = og.match(/<meta property="og:image" content="([^"]+)"/)?.[1] ?? '';
    const width = og.match(/og:image:width" content="(\d+)"/)?.[1];
    const height = og.match(/og:image:height" content="(\d+)"/)?.[1];
    return { og, image, path: image.replace('https://app.example.test', ''), width: Number(width), height: Number(height) };
}

/** An event hosted as BIES's own page: the host runs it, an admin marked it. */
async function biesPage(host: Member) {
    const listing = await prisma.directoryListing.create({
        data: { type: 'PROVIDER', name: `Build in El Salvador ${++counter}`, category: 'community', ownerId: host.id, isOwnBusiness: true, isOfficial: true, status: 'active', isPublished: true },
    });
    return listing.id;
}

// ─── The card ─────────────────────────────────────────────────────────────────

describe("a community event's link card", () => {
    it('points to a wide card drawn for it, with the day in its name and the words joined right', async () => {
        const host = await member();
        const id = await event(host, { title: 'BIES Networking Night', thumbnail: await uploaded(host) });
        const link = await cardLink(id);
        expect(link.image).toMatch(new RegExp(`^https://app\\.example\\.test/api/preview/events/${id}/card\\.jpg\\?v=[0-9a-f]{16}$`));
        expect([link.width, link.height]).toEqual([1200, 630]);
        expect(link.og).toContain('content="BIES Networking Night · Sat 14 Nov"');
        expect(link.og).toContain('7:00 PM · Rooftop venue — BIES Networking night. Just a room full of interesting people.');
        expect(link.og).not.toContain('| BIES');

        const card = await picture(link.path);
        expect(card.status).toBe(200);
        expect(card.type).toBe('image/jpeg');
        expect(card.cache).toBe('public, max-age=86400');
        const meta = await sharp(card.bytes).metadata();
        expect([meta.width, meta.height, meta.format]).toEqual([1200, 630, 'jpeg']);
        expect(card.bytes.length).toBeLessThan(300_000); // WhatsApp drops big pictures

        // Asked for without its name, it's kept only a few minutes.
        expect((await picture(`/api/preview/events/${id}/card.jpg`)).cache).toBe('public, max-age=300');
    });

    it('is drawn once, and again when what is on it changes; the old one goes', async () => {
        const host = await member();
        const id = await event(host, { thumbnail: await uploaded(host) });
        const first = await cardLink(id);
        await picture(first.path);
        await picture(first.path);
        const files = () => fs.readdirSync(CARDS()).filter((n) => n.startsWith(`${id}.`));
        expect(files()).toHaveLength(1);

        expect((await call('PUT', `/api/events/${id}`, { token: host.token, body: { title: 'Renamed night' } })).status).toBe(200);
        const second = await cardLink(id);
        expect(second.image).not.toBe(first.image);
        await picture(second.path);
        expect(files()).toEqual([`${id}.${new URL(second.image).searchParams.get('v')}.jpg`]);
    });

    it('a private event, or one that is not there, has no picture', async () => {
        const host = await member();
        const priv = await event(host, { visibility: 'PRIVATE' });
        expect((await picture(`/api/preview/events/${priv}/card.jpg`)).status).toBe(404);
        expect((await picture('/api/preview/events/nothing-here/card.jpg')).status).toBe(404);
        expect((await picture('/api/preview/events/..%2F..%2Fetc/card.jpg')).status).toBe(404);
    });

    it('without a cover, still a card: the words on navy', async () => {
        const host = await member();
        const id = await event(host);
        const card = await picture((await cardLink(id)).path);
        expect(card.status).toBe(200);
        expect((await sharp(card.bytes).metadata()).width).toBe(1200);
    });
});

describe("a BIES event's link card", () => {
    it('is its cover, square', async () => {
        const host = await member();
        const id = await event(host, { hostListingId: await biesPage(host), thumbnail: await uploaded(host) });
        const link = await cardLink(id);
        expect([link.width, link.height]).toEqual([1080, 1080]);
        const meta = await sharp((await picture(link.path)).bytes).metadata();
        expect([meta.width, meta.height]).toEqual([1080, 1080]);
    });
});

describe('positioning the cover for the link card', () => {
    it('is kept, changes the picture, and starts again with a new cover', async () => {
        const host = await member();
        const id = await event(host, { thumbnail: await uploaded(host), shareFrame: '-60,0,220,100' });
        expect((await call('GET', `/api/events/${id}`, { token: host.token })).body.shareFrame).toBe('-60,0,220,100');
        expect((await call('GET', `/api/preview/events/${id}`)).body.shareFrame).toBe('-60,0,220,100');
        const before = (await cardLink(id)).image;

        expect((await call('PUT', `/api/events/${id}`, { token: host.token, body: { shareFrame: '0,10,100,60' } })).status).toBe(200);
        expect((await cardLink(id)).image).not.toBe(before);

        expect((await call('PUT', `/api/events/${id}`, { token: host.token, body: { shareFrame: 'url(javascript:alert(1))' } })).status).toBe(400);
        expect((await call('PUT', `/api/events/${id}`, { token: host.token, body: { shareFrame: '0,0,0,0' } })).status).toBe(400);

        // Another photo: positioned for the old one, so it starts centred.
        expect((await call('PUT', `/api/events/${id}`, { token: host.token, body: { thumbnail: await uploaded(host) } })).status).toBe(200);
        expect((await call('GET', `/api/events/${id}`, { token: host.token })).body.shareFrame).toBe('');
    });
});

describe("a proposed meetup's link card", () => {
    it('says it is proposed, and what it needs to go ahead', async () => {
        const host = await member();
        const id = await event(host, { decideBy: '2026-11-14T01:00:00.000Z', minAttendees: 4, description: '' });
        const preview = (await call('GET', `/api/preview/events/${id}`)).body;
        expect(preview).toMatchObject({ stage: 'proposed', minAttendees: 4 });
        expect((await cardLink(id)).og).toContain('7:00 PM · Proposed meetup · Rooftop venue');
        expect(shareCardSpec(preview)).toMatchObject({ format: 'wide', label: 'proposed', extra: 'Goes ahead with 4 people' });
    });
});

// ─── The parts ────────────────────────────────────────────────────────────────

describe('what the card says', () => {
    it('a BIES event gets no label; others say what kind they are', () => {
        const ev = { name: 'Soccer', startDate: NIGHT, location: 'Field', photo: '', repeatText: 'Every other Saturday' };
        expect(shareCardSpec({ ...ev, isOfficial: true })).toMatchObject({ format: 'square', label: '' });
        expect(shareCardSpec({ ...ev, isOfficial: false })).toMatchObject({ format: 'wide', label: 'community', extra: 'Every other Saturday', frame: '' });
        // Positioned for the card, or else as on its page.
        expect(shareCardSpec({ ...ev, isOfficial: false, photo: '/x.jpg', coverFrame: '1,2,3,4' }).frame).toBe('1,2,3,4');
        expect(shareCardSpec({ ...ev, isOfficial: false, photo: '/x.jpg', coverFrame: '1,2,3,4', shareFrame: '5,6,7,8' }).frame).toBe('5,6,7,8');
    });

    it('says when as the BIES posters do, in El Salvador', () => {
        expect(cardDate(NIGHT)).toBe('Saturday, November 14 · 7 PM');
        expect(cardDate('2026-11-07T14:30:00.000Z')).toBe('Saturday, November 7 · 8:30 AM');
    });

    it('runs a description\'s lines on with spaces, and a full stop after a heading', () => {
        expect(summary('<p>BIES Networking night</p><p>Just a room.</p><p>Whether you\'re new…</p>').text).toBe('BIES Networking night. Just a room. Whether you\'re new…');
        expect(summary('<p>One line<br>and the next</p>').text).toBe('One line. and the next');
        expect(summary('<p>Hello <b>there</b></p>').text).toBe('Hello there');
    });

    it('cuts a long name at a word, with …', () => {
        const bytes = fs.readFileSync(path.join(__dirname, '../../assets/fonts/DMSerifDisplay-Regular.ttf'));
        const font = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        const name = 'Padel doubles at the club with a really long name';
        const line = fitLine(font, name, 60, 600);
        const kept = line.slice(0, -1);
        expect(line.endsWith('…')).toBe(true);
        expect(name.startsWith(kept) && name[kept.length] === ' ').toBe(true); // whole words
        expect(textWidth(font, line, 60)).toBeLessThanOrEqual(600);
        const wrapped = wrapLines(font, 'Bitcoin Farmers Market', 80, 640, 2);
        expect(wrapped).toEqual({ lines: ['Bitcoin Farmers', 'Market'], overflow: false });
        expect(wrapLines(font, 'One two three four five six seven eight nine ten eleven twelve', 89, 300, 2).overflow).toBe(true);
    });

    it('places a cover as the app does (src/utils/coverFrame.js gives these)', () => {
        const natural = { width: 800, height: 1000 };
        const box = { width: 792, height: 630 };
        const cases: [Parameters<typeof placeFrame>[0], number[]][] = [
            [{ x: -60, y: 0, w: 220, h: 100 }, [216, 90, 360, 450]], // a flyer zoomed out: all of it, in the middle
            [{ x: 0, y: 10, w: 100, h: 60 }, [0, -81, 792, 990]],
            [{ x: 20, y: 20, w: 30, h: 30 }, [-192, -420, 1680, 2100]],
        ];
        for (const [frame, [left, top, width, height]] of cases) {
            const place = placeFrame(frame, natural, box);
            expect(place.left).toBeCloseTo(left, 6);
            expect(place.top).toBeCloseTo(top, 6);
            expect(place.width).toBeCloseTo(width, 6);
            expect(place.height).toBeCloseTo(height, 6);
        }
    });

    it('draws a cover zoomed far in without making a huge picture', async () => {
        const cover = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#335577' } }).jpeg().toBuffer();
        const spec = shareCardSpec({ isOfficial: false, name: 'Close up', startDate: NIGHT, location: '', photo: '/x.jpg', shareFrame: '50,50,0.5,0.5' });
        const meta = await sharp(await drawCard(spec, cover)).metadata();
        expect([meta.width, meta.height]).toEqual([1200, 630]);
    });

    it('a cover that is not a picture is left out', async () => {
        const spec = shareCardSpec({ isOfficial: true, name: 'Broken', startDate: NIGHT, location: '', photo: '/x.jpg' });
        const meta = await sharp(await drawCard(spec, Buffer.from('not a picture'))).metadata();
        expect([meta.width, meta.height]).toEqual([1080, 1080]);
    });
});

// ─── Review fixes ─────────────────────────────────────────────────────────────

function fontAt(file: string) {
    const bytes = fs.readFileSync(path.join(__dirname, '../../assets/fonts', file));
    return opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
const serif = fontAt('DMSerifDisplay-Regular.ttf');
const semi = fontAt('Inter-SemiBold.otf');
const bold = fontAt('Inter-ExtraBold.otf');

const files = (id: string) => fs.readdirSync(CARDS()).filter((n) => n.startsWith(`${id}.`));

/** Waits until `check` is true (a card drawn in the background), or gives up. */
async function until(check: () => boolean, ms = 5000) {
    const end = Date.now() + ms;
    while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    return check();
}

describe('emoji and letters the fonts lack', () => {
    it('are left out, not drawn as crossed boxes', () => {
        expect(drawable(serif, '🎉 Party 🇸🇻 time 👍🏽 ❤️ ☕')).toBe('Party time');
        expect(drawable(serif, 'Café\nPlaya  1️⃣ 👨‍👩‍👧')).toBe('Café Playa 1');
        expect(drawable(serif, 'Café 中文 Ñandú')).toBe('Café Ñandú'); // put together first; no Chinese letters
        expect(drawable(semi, '★ STAR ❤')).toBe('★ STAR ❤'); // Inter has these
        for (const [font, text] of [[serif, '🎉 Fiesta ñ ¿qué? — “sí” 🇸🇻'], [semi, 'SAT · 7 PM ✨'], [bold, 'EVERY 👍🏽 SATURDAY']] as const) {
            for (const ch of drawable(font, text)) expect(font.charToGlyphIndex(ch), ch).toBeGreaterThan(0);
        }
    });

    it("the app's preview leaves out the same as the server", async () => {
        const app = await import(pathToFileURL(path.resolve(__dirname, '../../../src/utils/shareCard.js')).href);
        // Every letter up to the CJK block, alone and between others: the app
        // keeps exactly what the card's serif can draw.
        for (let cp = 0x20; cp < 0x3000; cp++) {
            const text = `a${String.fromCodePoint(cp)}b`;
            expect(app.cardText(text), `U+${cp.toString(16)}`).toBe(drawable(serif, text));
        }
        for (const text of ['🎉 Party 🇸🇻 time 👍🏽 ❤️ ☕', 'Café\nPlaya  1️⃣', '  Soccer 👨‍👩‍👧 night  ', 'Café']) {
            expect(app.cardText(text)).toBe(drawable(serif, text));
        }
    });

    it('a title of nothing but emoji draws the card without one', async () => {
        const spec = shareCardSpec({ isOfficial: false, name: '🎉🎉🎉', startDate: NIGHT, location: '🌴', photo: '' });
        expect(cardLayout(spec, WIDE, false).blocks.map((b) => b.name)).toEqual(['logo', 'rule', 'date']);
        expect((await sharp(await drawCard(spec, null)).metadata()).width).toBe(1200);
    });
});

describe('measuring the words', () => {
    it('measures a line as opentype.js draws it', () => {
        for (const [font, spacing] of [[serif, 0], [semi, 0.14], [bold, 0.12]] as const) {
            for (const text of ['Bitcoin Farmers Market', 'AVATAR WAVE To. Yo', 'ffi fl Ñandú — “sí”', 'x🎉y', 'W', '']) {
                const expected = text ? font.getAdvanceWidth(text, 60, { kerning: true, letterSpacing: spacing } as opentype.RenderOptions) - spacing * 60 : 0;
                expect(textWidth(font, text, 60, spacing)).toBeCloseTo(expected, 6);
            }
        }
    });

    it('lays out a 200-letter name with no spaces in a few milliseconds', () => {
        overlaySvg(shareCardSpec({ isOfficial: false, name: 'Warm up', startDate: NIGHT, location: '', photo: '' }), WIDE, false);
        const started = performance.now();
        for (const isOfficial of [false, true]) {
            const spec = shareCardSpec({ isOfficial, name: 'W'.repeat(200), startDate: NIGHT, location: 'M'.repeat(200), photo: '', repeatText: 'Every other Saturday' });
            overlaySvg(spec, isOfficial ? SQUARE : WIDE, false);
        }
        expect(performance.now() - started).toBeLessThan(200);
    });

    it('lays out at most MAX_LETTERS of a name or place, with …', () => {
        expect(capped('a'.repeat(MAX_LETTERS))).toBe('a'.repeat(MAX_LETTERS));
        expect(capped(`${'a'.repeat(MAX_LETTERS - 1)} and more`)).toBe(`${'a'.repeat(MAX_LETTERS - 1)}…`);
        expect(Array.from(capped('é'.repeat(500)))).toHaveLength(MAX_LETTERS + 1);
    });

    it('draws cards one at a time, and one that fails does not hold up the next', async () => {
        const order: string[] = [];
        const slow = (name: string) => async () => {
            order.push(`${name} starts`);
            await new Promise((r) => setTimeout(r, 20));
            order.push(`${name} ends`);
        };
        await Promise.all([oneAtATime(slow('a')), oneAtATime(slow('b'))]);
        expect(order).toEqual(['a starts', 'a ends', 'b starts', 'b ends']);
        await expect(oneAtATime(async () => { throw new Error('broken'); })).rejects.toThrow('broken');
        await expect(oneAtATime(async () => 'next')).resolves.toBe('next');
    });
});

describe('the ring on a card without a cover', () => {
    const clearOf = (ring: { cx: number; cy: number; r: number }, width: number, box: Box) => {
        const dx = Math.max(box.left - ring.cx, 0, ring.cx - box.right);
        const dy = Math.max(box.top - ring.cy, 0, ring.cy - box.bottom);
        return Math.hypot(dx, dy) - ring.r - width / 2;
    };

    it('keeps clear of a long name and place, in its corner', () => {
        for (const name of ['BIES Soccer', 'BIES Networking Night at the Beach House with Friends', 'W'.repeat(200)]) {
            const spec = shareCardSpec({ isOfficial: true, name, startDate: NIGHT, location: 'Rooftop venue in San Salvador centro', photo: '', repeatText: 'Every other Saturday' });
            const { blocks, ring, ringWidth } = cardLayout(spec, SQUARE, false);
            expect(ring, name).not.toBeNull();
            expect(ring!.r).toBe(330); // its size kept
            for (const { box, name: block } of blocks) expect(clearOf(ring!, ringWidth, box), `${name}: ${block}`).toBeGreaterThan(0);
        }
    });

    it('stays where it was designed on the wide card', () => {
        const spec = shareCardSpec({ isOfficial: false, name: 'W'.repeat(200), startDate: NIGHT, location: 'M'.repeat(200), photo: '' });
        expect(cardLayout(spec, WIDE, false).ring).toEqual({ cx: 1044, cy: 546, r: 263 });
        expect(cardLayout(spec, WIDE, true).ring).toBeNull(); // a cover: no ring
    });
});

describe('how a repeating event says it repeats', () => {
    it('is said from the date its rule makes, not one moved to another day', async () => {
        const host = await member();
        const id = await event(host, { title: 'Soccer', repeat: 'WEEKLY' });
        // Its first date (Saturday 14 Nov) is moved to Sunday 15 Nov, 7 PM.
        await prisma.eventDateChange.create({ data: { eventId: id, occurrenceStart: new Date(NIGHT), startDate: new Date('2026-11-16T01:00:00.000Z') } });
        const preview = (await call('GET', `/api/preview/events/${id}`)).body;
        expect(preview.occurrence).toBe(NIGHT);
        expect(eventCardSpec(preview).extra).toBe('Every Saturday');
        const og = (await cardLink(id)).og;
        expect(og).toContain('content="Soccer · Sun 15 Nov"');
        expect(og).toContain('7:00 PM · Every Saturday · Rooftop venue');
        expect(og).not.toContain('Every Sunday');
    });
});

describe('keeping cards', () => {
    it('is drawn when the card page is read, before the picture is asked for', async () => {
        const host = await member();
        const id = await event(host, { thumbnail: await uploaded(host) });
        const key = new URL((await cardLink(id)).image).searchParams.get('v');
        expect(await until(() => files(id).includes(`${id}.${key}.jpg`))).toBe(true);
    });

    it('goes when the event is deleted', async () => {
        const host = await member();
        const id = await event(host, { thumbnail: await uploaded(host) });
        await picture((await cardLink(id)).path);
        expect(files(id)).toHaveLength(1);
        expect((await call('DELETE', `/api/events/${id}`, { token: host.token })).status).toBe(200);
        expect(files(id)).toEqual([]);
    });

    it('goes when the event is made private or a draft, or gets another cover', async () => {
        const host = await member();
        for (const change of [{ visibility: 'PRIVATE' }, { visibility: 'DRAFT' }, { thumbnail: 'another' }]) {
            const id = await event(host, { thumbnail: await uploaded(host) });
            await picture((await cardLink(id)).path);
            expect(files(id), JSON.stringify(change)).toHaveLength(1);
            const body = change.thumbnail ? { thumbnail: await uploaded(host) } : change;
            expect((await call('PUT', `/api/events/${id}`, { token: host.token, body })).status).toBe(200);
            expect(files(id), JSON.stringify(change)).toEqual([]);
        }
    });

    it("goes with its host's account", async () => {
        const host = await member();
        const id = await event(host, { thumbnail: await uploaded(host) });
        await picture((await cardLink(id)).path);
        expect(files(id)).toHaveLength(1);
        await deleteAccount(host.id, { notify: false, retract: false });
        expect(await prisma.event.findUnique({ where: { id } })).toBeNull();
        expect(files(id)).toEqual([]);
    });

    it("the sweep deletes cards of events no longer shared, and half-written ones left over", async () => {
        const host = await member();
        const shared = await event(host);
        const hidden = await event(host, { visibility: 'PRIVATE' });
        const put = (name: string, ageMs = 0) => {
            const file = path.join(CARDS(), name);
            fs.writeFileSync(file, 'x');
            if (ageMs) fs.utimesSync(file, new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));
        };
        put(`${shared}.aaaa.jpg`);
        put(`${hidden}.aaaa.jpg`);
        put('no-such-event.aaaa.jpg');
        put(`${shared}.bbbb.jpg.0011.part`, 2 * 60 * 60_000);
        put(`${shared}.cccc.jpg.2233.part`);
        await sweepCards();
        expect(files(shared).sort()).toEqual([`${shared}.aaaa.jpg`, `${shared}.cccc.jpg.2233.part`]);
        expect(files(hidden)).toEqual([]);
        expect(files('no-such-event')).toEqual([]);
    });
});

describe('a cover that cannot be had', () => {
    it("is not kept: the card is sent without it, and drawn again next time", async () => {
        const host = await member();
        // A page of this server's own: never fetched for a cover.
        const id = await event(host, { thumbnail: 'https://app.example.test/api/preview/events/other/card.jpg' });
        const link = await cardLink(id);
        for (let i = 0; i < 2; i++) {
            const card = await picture(link.path);
            expect(card.status).toBe(200);
            expect(card.cache).toBe('no-store');
            expect((await sharp(card.bytes).metadata()).width).toBe(1200);
        }
        expect(files(id)).toEqual([]);
    });
});

describe('what a cover may be', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="red"/></svg>');

    it('only a JPEG, PNG or WebP photo; never SVG', async () => {
        const photo = sharp({ create: { width: 40, height: 30, channels: 3, background: '#336699' } });
        expect(await isPhoto(await photo.clone().jpeg().toBuffer())).toBe(true);
        expect(await isPhoto(await photo.clone().png().toBuffer())).toBe(true);
        expect(await isPhoto(await photo.clone().webp().toBuffer())).toBe(true);
        expect(await isPhoto(await photo.clone().gif().toBuffer())).toBe(false);
        expect(await isPhoto(svg)).toBe(false);
        expect(await isPhoto(Buffer.from('not a picture'))).toBe(false);
        await expect(placedPhoto(svg, '', WIDE, 0.42)).rejects.toThrow('Not a JPEG, PNG or WebP photo');
        // The card is drawn as if it had none.
        const spec = shareCardSpec({ isOfficial: true, name: 'Vector', startDate: NIGHT, location: '', photo: '/x.svg' });
        expect((await sharp(await drawCard(spec, svg)).metadata()).width).toBe(1080);
    });

    it("is never fetched from this server's own pages, only its uploads", async () => {
        expect(fetchableCover(new URL('https://app.example.test/api/preview/events/x/card.jpg'))).toBe(false);
        expect(fetchableCover(new URL('https://APP.example.test./api/preview/events/x/og'))).toBe(false);
        expect(fetchableCover(new URL('https://app.example.test:8443/api/x'))).toBe(false);
        expect(fetchableCover(new URL('https://app.example.test/uploads/%2e%2e/api/x'))).toBe(false);
        expect(fetchableCover(new URL('https://app.example.test/uploads/public/1700000000000-0123456789abcdef0123456789abcdef.jpg'))).toBe(true);
        expect(fetchableCover(new URL('https://images.example.org/cover.jpg'))).toBe(true);
        // Asked before anything is fetched.
        const asked: string[] = [];
        expect(await safeGet('https://images.example.invalid/cover.jpg', { timeoutMs: 1000, allow: (url) => { asked.push(url.href); return false; } })).toBeNull();
        expect(asked).toEqual(['https://images.example.invalid/cover.jpg']);
    });
});

describe('a link card with no picture of its own', () => {
    it('shows the BIES icon at its own size', async () => {
        const link = await cardLink('nothing-here');
        expect(link.image).toBe('https://app.example.test/icons/icon-512.png');
        expect([link.width, link.height]).toEqual([512, 512]);
        expect(link.og).toContain('og:image:type" content="image/png"');
    });
});
