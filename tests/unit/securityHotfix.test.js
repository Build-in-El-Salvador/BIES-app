/**
 * The app side of the 2026-10-13 security hotfix (node --test, no network):
 * member-written links are only links when they're http(s); an invoice's
 * amount is read exactly, so a zap pays only what was asked; a repost shows
 * the post it shares only if that post is genuinely signed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { safeHref } from '../../src/utils/safeUrl.js';
import { bolt11Msats } from '../../src/utils/bolt11.js';
import { isGenuineRepost } from '../../src/utils/repost.js';

test('safeHref keeps web links and drops scripts', () => {
    assert.equal(safeHref('https://tickets.example/x'), 'https://tickets.example/x');
    assert.equal(safeHref('  http://example.org '), 'http://example.org');
    for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,<script>', 'vbscript:x', '//evil.example', '', null, undefined, 42]) {
        assert.equal(safeHref(bad), undefined, String(bad));
    }
});

test('bolt11Msats reads the amount an invoice asks for', () => {
    assert.equal(bolt11Msats('lnbc210n1pjdummy'), 21_000);          // 21 sats
    assert.equal(bolt11Msats('lnbc10u1pjdummy'), 1_000_000);        // 1,000 sats
    assert.equal(bolt11Msats('lnbc5m1pjdummy'), 500_000_000);       // 500,000 sats
    assert.equal(bolt11Msats('LNBC2500N1PJDUMMY'), 250_000);
    assert.equal(bolt11Msats('lnbc1pvjluezdummy'), null);           // no amount
    assert.equal(bolt11Msats('lnbc1p1dummy'), null);                // a tenth of a millisat
    assert.equal(bolt11Msats('not an invoice'), null);
});

test('a repost shows its post only when that post is genuinely signed', () => {
    const author = generateSecretKey();
    const original = finalizeEvent({ kind: 1, created_at: 1760000000, tags: [], content: 'Harvest day' }, author);
    const repost = { tags: [['e', original.id], ['p', original.pubkey]] };
    assert.equal(isGenuineRepost(repost, { ...original }), true);
    assert.equal(isGenuineRepost(repost, { ...original, content: 'Words they never wrote' }), false);
    assert.equal(isGenuineRepost({ tags: [['e', 'f'.repeat(64)]] }, { ...original }), false);
    assert.equal(isGenuineRepost(repost, { ...original, kind: 0 }), false);
    assert.equal(isGenuineRepost(repost, { id: original.id, pubkey: original.pubkey, content: 'x', kind: 1 }), false);
    assert.equal(isGenuineRepost(repost, null), false);
});
