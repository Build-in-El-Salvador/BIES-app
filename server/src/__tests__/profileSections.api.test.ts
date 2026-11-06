/**
 * A member's profile as the profile pages read it: custom sections' photos
 * come back as full links, so the phone app (on its own origin) shows them.
 * Real routes against a real SQLite database built from the repo's migrations.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const env = vi.hoisted(() => {
    const dir = `${process.env.TMPDIR || '/tmp'}/bies-profile-sections-test-${process.pid}-${Date.now()}`;
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
import profileRoutes from '../routes/profile.routes';
import uploadRoutes from '../routes/upload.routes';
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
    app.use('/api/upload', uploadRoutes);
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
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

type Member = { id: string; token: string };

let counter = 0;
async function member(fields: Record<string, unknown> = {}): Promise<Member> {
    const user = await prisma.user.create({
        data: {
            nostrPubkey: getPublicKey(generateSecretKey()),
            termsVersion: '2026-10',
            termsAcceptedAt: new Date(),
            profile: { create: { name: `Member ${++counter}`, ...fields } },
        },
    });
    const session = await createSession(user.id, 'native');
    return { id: user.id, token: signAccessToken({ id: user.id, role: 'MEMBER', isAdmin: false }, session.sessionId) };
}

let seed = 0;
/** A photo this member uploaded: its link as stored (/uploads/public/...). */
async function uploaded(m: Member): Promise<string> {
    const file = await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 40 + (++seed % 200), g: 120, b: 90 } } }).jpeg().toBuffer();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(file)], { type: 'image/jpeg' }), 'photo.jpg');
    const res = await fetch(`${base}/api/upload/media`, { method: 'POST', headers: { Authorization: `Bearer ${m.token}` }, body: form });
    const body = (await res.json()) as any;
    if (res.status !== 200) throw new Error(`upload failed: ${res.status} ${JSON.stringify(body)}`);
    return body.url as string;
}

const full = (link: string) => `https://app.example.test${link}`;

// ─── Section photos ───────────────────────────────────────────────────────────

describe("a profile's section photos", () => {
    it('come back as full links wherever the profile is read, and are saved as sent', async () => {
        const owner = await member();
        const viewer = await member();
        const one = await uploaded(owner);
        const two = await uploaded(owner);
        expect(one.startsWith('/uploads/public/')).toBe(true);

        const saved = await call('PUT', '/api/profiles/me', {
            token: owner.token,
            body: {
                customSections: [
                    { title: 'Photo', type: 'PHOTO', imageUrl: one },
                    { title: 'Photos', type: 'CAROUSEL', images: [one, two] },
                    { title: 'Elsewhere', type: 'PHOTO', imageUrl: 'https://images.example.org/a.jpg' },
                    { title: 'Words', type: 'TEXT', body: '<p>Hi</p>' },
                ],
            },
        });
        expect(saved.status).toBe(200);

        const expected = (sections: any[]) => {
            expect(sections[0].imageUrl).toBe(full(one));
            expect(sections[1].images).toEqual([full(one), full(two)]);
            expect(sections[2].imageUrl).toBe('https://images.example.org/a.jpg');
            expect(sections[3].imageUrl).toBeUndefined();
        };
        expected(saved.body.customSections);
        expected((await call('GET', '/api/profiles/me', { token: owner.token })).body.customSections);
        expected((await call('GET', `/api/profiles/${owner.id}`, { token: viewer.token })).body.customSections);

        // Stored as they were sent: the link is only completed on the way out.
        const row = await prisma.profile.findUnique({ where: { userId: owner.id }, select: { customSections: true } });
        expect(JSON.parse(row!.customSections)[0].imageUrl).toBe(one);
    });

    it('saved back as full links (an edit after reading them) still count as the member\'s uploads', async () => {
        const owner = await member();
        const photo = await uploaded(owner);
        await call('PUT', '/api/profiles/me', { token: owner.token, body: { customSections: [{ title: 'P', type: 'PHOTO', imageUrl: photo }] } });
        const read = (await call('GET', '/api/profiles/me', { token: owner.token })).body.customSections;
        const again = await call('PUT', '/api/profiles/me', { token: owner.token, body: { customSections: read } });
        expect(again.status).toBe(200);
        expect(again.body.customSections[0].imageUrl).toBe(full(photo));
        // The file is still there to serve.
        const name = photo.split('/').pop()!;
        expect(fs.existsSync(path.join(env.dir, 'uploads', 'public', name))).toBe(true);
    });

    it('leave a profile with no sections, or broken saved JSON, as an empty list', async () => {
        const plain = await member();
        expect((await call('GET', '/api/profiles/me', { token: plain.token })).body.customSections).toEqual([]);
        const broken = await member({ customSections: '{not json' });
        const viewer = await member();
        const res = await call('GET', `/api/profiles/${broken.id}`, { token: viewer.token });
        expect(res.status).toBe(200);
        expect(res.body.customSections).toEqual([]);
    });
});

// ─── Edit profile fields (services/profileFields.ts) ───────────────────────────

describe('first and last name', () => {
    it('are kept as typed, make the name, and open as they were saved', async () => {
        const m = await member();
        const saved = await call('PUT', '/api/profiles/me', { token: m.token, body: { firstName: ' Mary Ann ', lastName: 'Smith' } });
        expect(saved.status).toBe(200);
        expect(saved.body.name).toBe('Mary Ann Smith');
        const me = (await call('GET', '/api/profiles/me', { token: m.token })).body;
        expect([me.firstName, me.lastName]).toEqual(['Mary Ann', 'Smith']);
    });

    it('a last name is optional, and a name is never emptied', async () => {
        const m = await member();
        expect((await call('PUT', '/api/profiles/me', { token: m.token, body: { firstName: 'Murphslife', lastName: '' } })).body.name).toBe('Murphslife');
        const blank = await call('PUT', '/api/profiles/me', { token: m.token, body: { firstName: '', lastName: '' } });
        expect(blank.body.name).toBe('Murphslife');
        expect(blank.body.firstName).toBe('Murphslife');
    });

    it('an app from before them: the same name keeps the parts, a new one is split', async () => {
        const m = await member();
        await call('PUT', '/api/profiles/me', { token: m.token, body: { firstName: 'Mary Ann', lastName: 'Smith' } });
        await call('PUT', '/api/profiles/me', { token: m.token, body: { name: 'Mary Ann Smith', bio: 'Hi' } });
        let me = (await call('GET', '/api/profiles/me', { token: m.token })).body;
        expect([me.firstName, me.lastName]).toEqual(['Mary Ann', 'Smith']);
        await call('PUT', '/api/profiles/me', { token: m.token, body: { name: 'Ana Beltrán López' } });
        me = (await call('GET', '/api/profiles/me', { token: m.token })).body;
        expect([me.name, me.firstName, me.lastName]).toEqual(['Ana Beltrán López', 'Ana', 'Beltrán López']);
    });

    it('a name changed elsewhere is split again, and a sign-in placeholder opens empty', async () => {
        const renamed = await member({ name: 'Diego Ramos', firstName: 'Old', lastName: 'Name' });
        const me = (await call('GET', '/api/profiles/me', { token: renamed.token })).body;
        expect([me.firstName, me.lastName]).toEqual(['Diego', 'Ramos']);
        const placeholder = await member({ name: 'nostr:1a2b3c4d' });
        const p = (await call('GET', '/api/profiles/me', { token: placeholder.token })).body;
        expect([p.firstName, p.lastName]).toEqual(['', '']);
    });

    it('a long name from sign-up saves back from Edit profile', async () => {
        const m = await member();
        const name = 'María José de los Ángeles Fernández-Castellanos y Rodríguez de la Santísima';
        await call('PUT', '/api/profiles/me', { token: m.token, body: { name } });
        const me = (await call('GET', '/api/profiles/me', { token: m.token })).body;
        expect(me.lastName.length).toBeGreaterThan(50);
        const again = await call('PUT', '/api/profiles/me', { token: m.token, body: { firstName: me.firstName, lastName: me.lastName, bio: 'Hola' } });
        expect(again.status).toBe(200);
        expect(again.body.name).toBe(name);
    });
});

describe('what you do (roles)', () => {
    it('the first is the headline; the rest are kept and found by search', async () => {
        const m = await member();
        const viewer = await member();
        const saved = await call('PUT', '/api/profiles/me', {
            token: m.token,
            body: { roles: [{ title: ' Founder ', company: 'Café Cumbre' }, { title: '', company: '' }, { title: 'Mentor', company: 'Zebralab Studio' }] },
        });
        expect(saved.status).toBe(200);
        expect(saved.body.roles).toEqual([{ title: 'Founder', company: 'Café Cumbre' }, { title: 'Mentor', company: 'Zebralab Studio' }]);
        expect([saved.body.title, saved.body.company]).toEqual(['Founder', 'Café Cumbre']);

        const found = await call('GET', '/api/profiles?search=zebralab', { token: viewer.token });
        expect(found.body.data.map((p: any) => p.userId)).toContain(m.id);
        // Signed out: the headline only (Settings → Privacy), and search finds them by it alone.
        const anyone = await call('GET', `/api/profiles/${m.id}`);
        expect(anyone.body.roles).toEqual([{ title: 'Founder', company: 'Café Cumbre' }]);
        const notFound = await call('GET', '/api/profiles?search=zebralab');
        expect(notFound.body.data.map((p: any) => p.userId)).not.toContain(m.id);
    });

    it('an app from before roles changes the first one only', async () => {
        const m = await member();
        await call('PUT', '/api/profiles/me', { token: m.token, body: { roles: [{ title: 'Founder', company: 'A' }, { title: 'Mentor', company: 'B' }] } });
        const old = await call('PUT', '/api/profiles/me', { token: m.token, body: { title: 'CEO', company: 'A' } });
        expect(old.body.roles).toEqual([{ title: 'CEO', company: 'A' }, { title: 'Mentor', company: 'B' }]);
        // Cleared there: the next role is the headline, on cards too.
        const cleared = await call('PUT', '/api/profiles/me', { token: m.token, body: { title: '', company: '' } });
        expect(cleared.body.roles).toEqual([{ title: 'Mentor', company: 'B' }]);
        expect([cleared.body.title, cleared.body.company]).toEqual(['Mentor', 'B']);
    });

    it('a profile from before roles reads its title and company as its one role', async () => {
        const m = await member({ title: 'Architect', company: 'Estudio' });
        expect((await call('GET', '/api/profiles/me', { token: m.token })).body.roles).toEqual([{ title: 'Architect', company: 'Estudio' }]);
        const none = await member();
        expect((await call('GET', '/api/profiles/me', { token: none.token })).body.roles).toEqual([]);
    });

    it('takes ten at most', async () => {
        const m = await member();
        const roles = Array.from({ length: 11 }, (_, i) => ({ title: `Role ${i}`, company: '' }));
        expect((await call('PUT', '/api/profiles/me', { token: m.token, body: { roles } })).status).toBe(400);
    });
});

describe('Instagram and your own links', () => {
    it('are saved, completed with https, and refused when not a web link', async () => {
        const m = await member();
        const saved = await call('PUT', '/api/profiles/me', {
            token: m.token,
            body: { instagram: ' @cafecumbre ', customLinks: [{ label: 'YouTube', url: 'youtube.com/@cafecumbre' }] },
        });
        expect(saved.status).toBe(200);
        expect(saved.body.instagram).toBe('@cafecumbre');
        // A username, from the handle or the member's instagram.com link; any other link is refused.
        const link = await call('PUT', '/api/profiles/me', { token: m.token, body: { instagram: 'https://www.instagram.com/cafe.cumbre/' } });
        expect(link.body.instagram).toBe('@cafe.cumbre');
        for (const instagram of ['https://example.org/cafecumbre', 'instagram.com.example.org/cafe', 'cafe cumbre']) {
            const bad = await call('PUT', '/api/profiles/me', { token: m.token, body: { instagram } });
            expect(bad.status, instagram).toBe(400);
        }
        const cleared = await call('PUT', '/api/profiles/me', { token: m.token, body: { instagram: '' } });
        expect(cleared.body.instagram).toBe('');
        expect(saved.body.customLinks).toEqual([{ label: 'YouTube', url: 'https://youtube.com/@cafecumbre' }]);
        for (const url of ['javascript://%0aalert(1)', 'data://text/html,hi', 'ftp://files.example.org/a']) {
            const bad = await call('PUT', '/api/profiles/me', { token: m.token, body: { customLinks: [{ label: 'x', url }] } });
            expect(bad.status, url).toBe(400);
        }
    });

    it('follow Settings → Privacy → Links, and a signed-out visitor never gets them', async () => {
        const m = await member();
        const viewer = await member();
        await call('PUT', '/api/profiles/me', { token: m.token, body: { instagram: '@ana', customLinks: [{ label: 'Blog', url: 'https://blog.example.org' }] } });
        expect((await call('GET', `/api/profiles/${m.id}`, { token: viewer.token })).body.instagram).toBe('@ana');
        const anyone = (await call('GET', `/api/profiles/${m.id}`)).body;
        expect(anyone.instagram).toBeUndefined();
        expect(anyone.customLinks).toBeUndefined();

        // Links: Only me (set before anyone reads the profile; Settings → Privacy clears the cache itself).
        const quiet = await member({ privacy: JSON.stringify({ links: 'ONLY_ME' }) });
        await call('PUT', '/api/profiles/me', { token: quiet.token, body: { instagram: '@quiet', customLinks: [{ label: 'Blog', url: 'https://blog.example.org' }] } });
        const seen = (await call('GET', `/api/profiles/${quiet.id}`, { token: viewer.token })).body;
        expect(seen.instagram).toBe('');
        expect(seen.customLinks).toEqual([]);
        expect((await call('GET', '/api/profiles/me', { token: quiet.token })).body.instagram).toBe('@quiet');
    });
});

describe('sections switched off', () => {
    it('are hidden from everyone else and kept for their member', async () => {
        const m = await member();
        const viewer = await member();
        const photo = await uploaded(m);
        const body = {
            website: 'https://cafecumbre.example', twitter: '@ana', instagram: '@ana',
            customLinks: [{ label: 'Blog', url: 'https://blog.example.org' }],
            tags: ['coffee'], experience: [{ title: 'Lead', company: 'Finca', date: '2019 - 2023' }],
            biesProjects: [{ id: 'p1', name: 'Co-op' }],
            customSections: [{ title: 'P', type: 'PHOTO', imageUrl: photo }],
            location: 'El Zonte',
        };
        await call('PUT', '/api/profiles/me', { token: m.token, body: { ...body, hiddenSections: ['links', 'tags', 'custom', 'projects', 'nonsense'] } });
        // An unknown section isn't saved (it's refused).
        const refused = await call('PUT', '/api/profiles/me', { token: m.token, body: { hiddenSections: ['nonsense'] } });
        expect(refused.status).toBe(400);
        await call('PUT', '/api/profiles/me', { token: m.token, body: { ...body, hiddenSections: ['links', 'tags', 'custom', 'projects'], showExperience: false } });

        const seen = (await call('GET', `/api/profiles/${m.id}`, { token: viewer.token })).body;
        expect([seen.website, seen.twitter, seen.instagram]).toEqual(['', '', '']);
        expect(seen.customLinks).toEqual([]);
        expect(seen.tags).toEqual([]);
        expect(seen.customSections).toEqual([]);
        expect(seen.biesProjects).toEqual([]);
        expect(seen.experience).toEqual([]);
        expect(seen.location).toBe('El Zonte'); // not a section

        const own = (await call('GET', '/api/profiles/me', { token: m.token })).body;
        expect(own.hiddenSections.sort()).toEqual(['custom', 'links', 'projects', 'tags']);
        expect(own.website).toBe('https://cafecumbre.example');
        expect(own.tags).toEqual(['coffee']);
        expect(own.experience).toHaveLength(1);

        // Switched back on: all there again.
        await call('PUT', '/api/profiles/me', { token: m.token, body: { hiddenSections: [], showExperience: true } });
        const again = (await call('GET', `/api/profiles/${m.id}`, { token: viewer.token })).body;
        expect(again.website).toBe('https://cafecumbre.example');
        expect(again.customSections).toHaveLength(1);
        expect(again.experience).toHaveLength(1);
    });

    it('a member search no longer finds them by a hidden tag-free field, but by role still', async () => {
        const m = await member();
        const viewer = await member();
        await call('PUT', '/api/profiles/me', { token: m.token, body: { roles: [{ title: 'Quokkaologist', company: '' }], hiddenSections: ['links'] } });
        const found = await call('GET', '/api/profiles?search=quokkaolog', { token: viewer.token });
        expect(found.body.data.map((p: any) => p.userId)).toContain(m.id);
    });
});
