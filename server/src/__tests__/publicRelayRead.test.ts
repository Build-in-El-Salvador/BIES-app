/**
 * Reading a member's profile from public Nostr (nostr.service.ts
 * fetchPublicProfile): "none found" counts only when at least two relays
 * answered in full; the member's own relays (their NIP-65 list) are read
 * too, as far as they're safe to connect to; a read is remembered for a
 * minute, until BIES publishes for that key. Relays are stand-ins.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
    process.env.NOSTR_RELAYS = 'wss://one.example,wss://two.example,wss://three.example';
    process.env.APP_PUBLIC_URL = 'https://app.example.test';
});

type Script = { events?: unknown[]; eose?: boolean; fail?: boolean };
const relays = vi.hoisted(() => ({
    scripts: new Map<string, Script>(),
    // Any relay not scripted (BIES publishes to several more).
    others: { eose: true } as Script,
    asked: [] as string[],
    closed: [] as string[],
    dns: new Map<string, string[]>(),
}));

vi.mock('nostr-tools/pool', () => ({
    SimplePool: class {
        async ensureRelay(url: string) {
            relays.asked.push(url);
            const script = relays.scripts.get(url) ?? relays.others;
            if (script.fail) throw new Error('connection failed');
            return {
                subscribe(_filters: unknown[], params: { onevent: (e: unknown) => void; oneose: () => void }) {
                    queueMicrotask(() => {
                        for (const e of script.events ?? []) params.onevent(e);
                        if (script.eose) params.oneose();
                    });
                    return { close() {} };
                },
            };
        }
        close(urls: string[]) { relays.closed.push(...urls); }
        publish(urls: string[]) { return urls.map(() => Promise.resolve('')); }
    },
}));
vi.mock('dns', async (importOriginal) => {
    const actual = await importOriginal<typeof import('dns')>();
    const promises = {
        ...actual.promises,
        lookup: vi.fn(async (host: string) => {
            const found = relays.dns.get(host);
            if (!found) throw new Error('ENOTFOUND');
            return found.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
        }),
    };
    return { ...actual, default: { ...actual, promises }, promises };
});

import { fetchPublicProfile, publishToPublicRelays } from '../services/nostr.service';

const pubkey = 'a'.repeat(64);
const profile = (createdAt: number, content: Record<string, unknown>) => ({ id: `p${createdAt}`, pubkey, kind: 0, created_at: createdAt, tags: [], content: JSON.stringify(content) });
const relayList = (tags: string[][]) => ({ id: 'list', pubkey, kind: 10002, created_at: 1_700_000_000, tags, content: '' });
let fresh = 0;
const key = () => (++fresh).toString(16).padStart(64, '0');

beforeEach(() => {
    relays.scripts.clear();
    relays.others = { eose: true };
    relays.asked.length = 0;
    relays.closed.length = 0;
    relays.dns.clear();
});

describe('fetchPublicProfile', () => {
    it('finds the newest profile across the relays', async () => {
        relays.scripts.set('wss://one.example', { events: [profile(100, { name: 'old' })], eose: true });
        relays.scripts.set('wss://two.example', { events: [profile(200, { name: 'new' })], eose: true });
        const read = await fetchPublicProfile(pubkey);
        expect(read).toEqual({ found: { content: { name: 'new' }, createdAt: 200 }, reachable: true });
    });

    it('"none found" counts only when two relays answered in full', async () => {
        const nobody = key();
        relays.others = { fail: true };
        relays.scripts.set('wss://one.example', { eose: true });
        relays.scripts.set('wss://two.example', { fail: true });
        relays.scripts.set('wss://three.example', { eose: false }); // never answers
        expect(await fetchPublicProfile(nobody)).toEqual({ found: null, reachable: false });

        const nobodyElse = key();
        relays.scripts.set('wss://two.example', { eose: true });
        expect(await fetchPublicProfile(nobodyElse)).toEqual({ found: null, reachable: true });
    }, 15_000);

    it("reads the member's own write relays too, up to five, safe ones only", async () => {
        const member = key();
        const own = (createdAt: number) => ({ ...profile(createdAt, { name: 'from my relay' }), pubkey: member });
        relays.scripts.set('wss://one.example', {
            events: [{ ...relayList([
                ['r', 'wss://mine.example'],
                ['r', 'wss://read-only.example', 'read'],
                ['r', 'ws://plain.example'],
                ['r', 'wss://127.0.0.1'],
                ['r', 'wss://router.local'],
                ['r', 'wss://inside.example'], // resolves to a private address
                ['r', 'wss://one.example'], // already read
                ['r', 'wss://relay.buildinelsalvador.com'], // BIES's own: its members-only copy
                ['r', 'wss://app.example.test/relay'],
                ['r', 'wss://a.example', 'write'], ['r', 'wss://b.example'], ['r', 'wss://c.example'], ['r', 'wss://d.example'], ['r', 'wss://e.example'],
            ]), pubkey: member }],
            eose: true,
        });
        relays.scripts.set('wss://two.example', { eose: true });
        relays.scripts.set('wss://mine.example', { events: [own(300)], eose: true });
        for (const host of ['mine.example', 'read-only.example', 'plain.example', 'a.example', 'b.example', 'c.example', 'd.example', 'e.example',
            'relay.buildinelsalvador.com', 'app.example.test']) relays.dns.set(host, ['93.184.216.34']);
        relays.dns.set('inside.example', ['10.0.0.5']);

        const read = await fetchPublicProfile(member);
        expect(read.found).toEqual({ content: { name: 'from my relay' }, createdAt: 300 });
        const theirs = ['wss://mine.example', 'wss://a.example', 'wss://b.example', 'wss://c.example', 'wss://d.example'];
        expect(relays.asked.filter((u) => u.endsWith('.example') && !/\/\/(one|two|three)\./.test(u))).toEqual(theirs);
        // Not kept open afterwards.
        expect(relays.closed).toEqual(theirs);
        expect(relays.asked).not.toContain('wss://relay.buildinelsalvador.com');
    }, 15_000);

    it('remembers a read for a minute, until BIES publishes for that key', async () => {
        const member = key();
        relays.scripts.set('wss://one.example', { events: [{ ...profile(100, { name: 'first' }), pubkey: member }], eose: true });
        relays.scripts.set('wss://two.example', { eose: true });
        expect((await fetchPublicProfile(member)).found?.content).toEqual({ name: 'first' });

        relays.scripts.set('wss://one.example', { events: [{ ...profile(200, { name: 'second' }), pubkey: member }], eose: true });
        expect((await fetchPublicProfile(member)).found?.content).toEqual({ name: 'first' });

        await publishToPublicRelays({ ...profile(300, { name: 'published' }), pubkey: member, sig: '' } as never);
        expect((await fetchPublicProfile(member)).found?.content).toEqual({ name: 'second' });
    }, 15_000);
});
