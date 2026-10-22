/**
 * The feed kept in memory (src/utils/feedCache.js): one per account and
 * view (the BIES feed, a member's posts), the oldest dropped past ten, all
 * cleared at sign-out.
 *
 * Run: npm run test:unit   (node --test; no network)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cachedFeed, rememberFeed, clearFeeds, feedCacheKey } from '../../src/utils/feedCache.js';

test('a feed is kept per account and view, and cleared at sign-out', () => {
    const feed = feedCacheKey('acct1', null);
    const profile = feedCacheKey('acct1', 'ab'.repeat(32));
    assert.notEqual(feed, profile);
    assert.notEqual(feed, feedCacheKey('acct2', null));
    rememberFeed(feed, { posts: [1] });
    rememberFeed(profile, { posts: [2] });
    assert.deepEqual(cachedFeed(feed), { posts: [1] });
    assert.deepEqual(cachedFeed(profile), { posts: [2] });
    assert.equal(cachedFeed(feedCacheKey('acct2', null)), undefined);
    clearFeeds();
    assert.equal(cachedFeed(feed), undefined);
    assert.equal(cachedFeed(profile), undefined);
});

test('only the ten most recently shown are kept', () => {
    for (let i = 0; i < 12; i++) rememberFeed(feedCacheKey('acct', `p${i}`), i);
    assert.equal(cachedFeed(feedCacheKey('acct', 'p0')), undefined);
    assert.equal(cachedFeed(feedCacheKey('acct', 'p1')), undefined);
    rememberFeed(feedCacheKey('acct', 'p2'), 2); // shown again: kept longer
    rememberFeed(feedCacheKey('acct', 'p12'), 12);
    assert.equal(cachedFeed(feedCacheKey('acct', 'p2')), 2);
    assert.equal(cachedFeed(feedCacheKey('acct', 'p3')), undefined);
    assert.equal(cachedFeed(feedCacheKey('acct', 'p12')), 12);
    clearFeeds();
});
