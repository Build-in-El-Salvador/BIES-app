/**
 * A Feed notification is sent only for what's on BIES's relay: the post or
 * comment is the told member's, and the actor's like or reply is there. A
 * reply's words come from the reply.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Ev = { id: string; pubkey: string; kind: number; created_at: number; content: string; tags: string[][] };
const relay = vi.hoisted(() => ({ events: [] as Ev[], configured: true, fail: false }));

vi.mock('../services/nostr.service', () => ({
    queryPrivateRelay: vi.fn(async (filter: { ids?: string[]; kinds?: number[]; authors?: string[]; '#e'?: string[] }) => {
        if (!relay.configured) return null;
        if (relay.fail) throw new Error('relay down');
        return relay.events.filter((e) =>
            (!filter.ids || filter.ids.includes(e.id))
            && (!filter.kinds || filter.kinds.includes(e.kind))
            && (!filter.authors || filter.authors.includes(e.pubkey))
            && (!filter['#e'] || e.tags.some((t) => t[0] === 'e' && filter['#e']!.includes(t[1]))));
    }),
}));

import { checkFeedInteraction } from '../services/feedInteraction.service';

const hex = (c: string) => c.repeat(64);
const ANA = hex('a');
const BEN = hex('b');
const POST = hex('1');
const COMMENT = hex('2');
let n = 0;
const ev = (kind: number, pubkey: string, content: string, tags: string[][] = []): Ev =>
    ({ id: (++n).toString(16).padStart(64, '0'), pubkey, kind, created_at: 1_700_000_000 + n, content, tags });

beforeEach(() => {
    relay.configured = true;
    relay.fail = false;
    relay.events = [
        { ...ev(1, ANA, 'Our new farm stand'), id: POST },
        { ...ev(1, ANA, 'A comment by Ana', [['e', POST, '', 'root']]), id: COMMENT },
    ];
});

describe('checkFeedInteraction', () => {
    it('a like counts only when the actor\'s like is there, on the told member\'s post', async () => {
        const claim = { type: 'POST_LIKE' as const, actorPubkey: BEN, targetPubkey: ANA, eventId: POST };
        expect(await checkFeedInteraction(claim)).toBeNull();
        relay.events.push(ev(7, BEN, '+', [['e', POST], ['p', ANA]]));
        expect(await checkFeedInteraction(claim)).toEqual({});
        // Someone else's post, or a post that isn't there.
        expect(await checkFeedInteraction({ ...claim, targetPubkey: BEN })).toBeNull();
        expect(await checkFeedInteraction({ ...claim, eventId: hex('9') })).toBeNull();
    });

    it("a reply's words come from the reply, never from the request", async () => {
        const claim = { type: 'POST_COMMENT' as const, actorPubkey: BEN, targetPubkey: ANA, eventId: POST, claimedText: 'Renew your account at https://evil.example' };
        expect(await checkFeedInteraction(claim)).toBeNull();
        relay.events.push(ev(1, BEN, 'When can I visit?', [['e', POST, '', 'root'], ['p', ANA]]));
        relay.events.push(ev(1, BEN, 'Is Saturday open?', [['e', POST, '', 'root'], ['p', ANA]]));
        expect(await checkFeedInteraction(claim)).toEqual({ text: 'Is Saturday open?' });
    });

    it('a reply to a comment tells the comment\'s author, when the reply names that comment', async () => {
        const claim = { type: 'COMMENT_REPLY' as const, actorPubkey: BEN, targetPubkey: ANA, eventId: COMMENT };
        relay.events.push(ev(1, BEN, 'On the post only', [['e', POST, '', 'root']]));
        expect(await checkFeedInteraction(claim)).toBeNull();
        relay.events.push(ev(1, BEN, 'Agreed!', [['e', POST, '', 'root'], ['e', COMMENT, '', 'reply'], ['p', ANA]]));
        expect(await checkFeedInteraction(claim)).toEqual({ text: 'Agreed!' });
    });

    it('a relay that fails tells no one; with no relay set up (development) the claim stands', async () => {
        relay.fail = true;
        expect(await checkFeedInteraction({ type: 'POST_LIKE', actorPubkey: BEN, targetPubkey: ANA, eventId: POST })).toBeNull();
        relay.configured = false;
        expect(await checkFeedInteraction({ type: 'POST_COMMENT', actorPubkey: BEN, targetPubkey: ANA, eventId: POST, claimedText: 'Hi' })).toEqual({ text: 'Hi' });
        expect(await checkFeedInteraction({ type: 'POST_LIKE', actorPubkey: BEN, targetPubkey: ANA, eventId: POST })).toEqual({ text: undefined });
    });
});
