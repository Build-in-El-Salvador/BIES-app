/**
 * An investment's status and its project's raised total: the total moves
 * when an investment becomes COMPLETED and when it stops being COMPLETED,
 * once each way, however often the same status is sent. Real routes against
 * a real SQLite database built from the repo's migrations.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const env = vi.hoisted(() => {
    const dir = `${process.env.TMPDIR || '/tmp'}/bies-investments-test-${process.pid}-${Date.now()}`;
    process.env.DATABASE_URL = `file:${dir}/test.db`;
    process.env.RELAY_WHITELIST_PATH = `${dir}/relay/whitelist.txt`;
    process.env.UPLOAD_DIR = `${dir}/uploads`;
    process.env.APP_PUBLIC_URL = 'https://app.example.test';
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
import investmentRoutes from '../routes/investment.routes';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { createSession, signAccessToken } from '../services/session.service';

let server: http.Server;
let base: string;

beforeAll(async () => {
    fs.mkdirSync(env.dir, { recursive: true });
    execSync('npx prisma migrate deploy', { cwd: path.resolve(__dirname, '../..'), env: process.env, stdio: 'pipe' });
    const app = express();
    app.use(express.json());
    app.use('/api/investments', investmentRoutes);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 120_000);

afterAll(async () => {
    server?.close();
    await prisma.$disconnect();
    fs.rmSync(env.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

type Member = { id: string; token: string };
let counter = 0;
async function member(): Promise<Member> {
    const user = await prisma.user.create({
        data: { nostrPubkey: getPublicKey(generateSecretKey()), termsVersion: '2026-10', termsAcceptedAt: new Date(), profile: { create: { name: `Member ${++counter}` } } },
    });
    const session = await createSession(user.id, 'native');
    return { id: user.id, token: signAccessToken({ id: user.id, role: 'MEMBER', isAdmin: false }, session.sessionId) };
}

async function put(id: string, token: string, body: Record<string, unknown>) {
    const res = await fetch(`${base}/api/investments/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function setUp() {
    const builder = await member();
    const investor = await member();
    const project = await prisma.project.create({ data: { ownerId: builder.id, title: `Project ${++counter}`, description: 'What it is.' } });
    const investment = await prisma.investment.create({ data: { projectId: project.id, investorId: investor.id, amount: 500 } });
    const raised = async () => (await prisma.project.findUnique({ where: { id: project.id } }))!.raisedAmount;
    return { builder, investor, investment, raised };
}

describe("an investment's status and its project's raised total", () => {
    it('adds the amount once when it completes, however often COMPLETED is sent', async () => {
        const { builder, investment, raised } = await setUp();
        expect((await put(investment.id, builder.token, { status: 'COMPLETED' })).status).toBe(200);
        expect(await raised()).toBe(500);
        for (let i = 0; i < 3; i++) expect((await put(investment.id, builder.token, { status: 'COMPLETED' })).status).toBe(200);
        expect(await raised()).toBe(500);
    });

    it('takes it off again when it stops being completed, whatever it becomes', async () => {
        const { builder, investment, raised } = await setUp();
        await put(investment.id, builder.token, { status: 'COMPLETED' });
        expect((await put(investment.id, builder.token, { status: 'PENDING' })).status).toBe(200);
        expect(await raised()).toBe(0);
        await put(investment.id, builder.token, { status: 'COMPLETED' });
        await put(investment.id, builder.token, { status: 'WITHDRAWN' });
        expect(await raised()).toBe(0);
        expect((await prisma.investment.findUnique({ where: { id: investment.id } }))!.status).toBe('WITHDRAWN');
    });

    it('lets the investor edit their notes with the status as it is, but not change the status', async () => {
        const { investor, investment, raised } = await setUp();
        const notes = await put(investment.id, investor.token, { status: 'PENDING', notes: 'Happy to talk next week.' });
        expect(notes.status).toBe(200);
        expect(notes.body.notes).toBe('Happy to talk next week.');
        expect((await put(investment.id, investor.token, { status: 'COMPLETED' })).status).toBe(403);
        expect(await raised()).toBe(0);
    });
});
