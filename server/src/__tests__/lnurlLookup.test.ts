/**
 * Looking up a member's Lightning address (zapReceipt.ts): a name@domain
 * address or a bech32 lnurl1…, both fetched through safeGetJson. A failed
 * lookup isn't repeated for a few minutes, callers asking for the same
 * address at once share one lookup, and at most four run at a time. The
 * fetch itself is stubbed: what it is asked for is what's checked.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const fetches = vi.hoisted(() => ({
    pending: [] as Array<{ url: string; answer: (body: unknown) => void }>,
    reply: 'wait' as 'wait' | 'none' | 'pay',
}));
vi.mock('../utils/safeFetch', () => ({
    safeGetJson: vi.fn((url: string) => {
        if (fetches.reply === 'none') return Promise.resolve(null);
        if (fetches.reply === 'pay') return Promise.resolve(payRequest);
        return new Promise((answer) => fetches.pending.push({ url, answer }));
    }),
}));

import { safeGetJson } from '../utils/safeFetch';
import { getLnurlPayMetadata, lnurlPayUrl } from '../services/zapReceipt';

const ZAPPER = 'a'.repeat(64);
const payRequest = { tag: 'payRequest', callback: 'https://pay.example.test/cb', allowsNostr: true, nostrPubkey: ZAPPER, minSendable: 1000, maxSendable: 1e11 };
const fetched = () => vi.mocked(safeGetJson).mock.calls.map(([url]) => url);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function lnurlFor(url: string): Promise<string> {
    const { bech32 } = await import('@scure/base');
    return bech32.encode('lnurl', bech32.toWords(new TextEncoder().encode(url)), 2000).toUpperCase();
}

afterEach(() => {
    vi.mocked(safeGetJson).mockClear();
    vi.restoreAllMocks();
    fetches.pending.length = 0;
    fetches.reply = 'wait';
});

describe('a member\'s Lightning address', () => {
    it('name@domain is looked up at its well-known address', async () => {
        expect(await lnurlPayUrl(' Satoshi@Pay.Example.Test ')).toBe('https://Pay.Example.Test/.well-known/lnurlp/Satoshi');
        fetches.reply = 'pay';
        expect(await getLnurlPayMetadata('satoshi@pay.example.test')).toMatchObject({ allowsNostr: true, nostrPubkey: ZAPPER });
        expect(fetched()).toEqual(['https://pay.example.test/.well-known/lnurlp/satoshi']);
    });

    it('an lnurl1… is looked up at the address it stands for', async () => {
        const url = 'https://pay.example.test/lnurlp/abc123?amount=any';
        const lnurl = await lnurlFor(url);
        expect(await lnurlPayUrl(lnurl)).toBe(url);
        expect(await lnurlPayUrl(`lightning:${lnurl.toLowerCase()}`)).toBe(url);
        fetches.reply = 'pay';
        expect(await getLnurlPayMetadata(lnurl)).toMatchObject({ callback: payRequest.callback, nostrPubkey: ZAPPER });
        expect(fetched()).toEqual([url]);
    });

    it('anything else is not looked up', async () => {
        for (const address of ['', 'satoshi', 'lnurl1', 'lnurl1qqqq', 'lnbc1qqqq', 'https://pay.example.test/x']) {
            expect(await lnurlPayUrl(address), address).toBeNull();
            expect(await getLnurlPayMetadata(address), address).toBeNull();
        }
        expect(fetched()).toEqual([]);
    });

    it('a failed lookup is not repeated for five minutes', async () => {
        fetches.reply = 'none';
        const now = Date.now();
        expect(await getLnurlPayMetadata('down@pay.example.test')).toBeNull();
        expect(await getLnurlPayMetadata('down@pay.example.test')).toBeNull();
        expect(fetched()).toHaveLength(1);
        vi.spyOn(Date, 'now').mockReturnValue(now + 5 * 60_000 + 1000);
        fetches.reply = 'pay';
        expect(await getLnurlPayMetadata('down@pay.example.test')).toMatchObject({ nostrPubkey: ZAPPER });
        expect(fetched()).toHaveLength(2);
    });

    it('callers asking for the same address at once share one lookup', async () => {
        const answers = Promise.all([1, 2, 3].map(() => getLnurlPayMetadata('busy@pay.example.test')));
        await settle();
        expect(fetched()).toHaveLength(1);
        fetches.pending[0].answer(payRequest);
        expect((await answers).map((m) => m?.nostrPubkey)).toEqual([ZAPPER, ZAPPER, ZAPPER]);
        // And it is remembered.
        expect(await getLnurlPayMetadata('busy@pay.example.test')).toMatchObject({ nostrPubkey: ZAPPER });
        expect(fetched()).toHaveLength(1);
    });

    it('looks up at most four addresses at a time', async () => {
        const answers = Promise.all([1, 2, 3, 4, 5, 6].map((n) => getLnurlPayMetadata(`m${n}@pay.example.test`)));
        await settle();
        expect(fetched()).toHaveLength(4);
        fetches.pending.shift()!.answer(payRequest);
        await settle();
        expect(fetched()).toHaveLength(5);
        while (fetches.pending.length > 0) {
            fetches.pending.shift()!.answer(payRequest);
            await settle();
        }
        expect(fetched()).toHaveLength(6);
        expect((await answers).every((m) => m?.nostrPubkey === ZAPPER)).toBe(true);
    });
});
