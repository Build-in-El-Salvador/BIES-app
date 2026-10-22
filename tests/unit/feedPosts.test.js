/**
 * The BIES feed's posts (src/utils/feedPosts.js): which relay events show,
 * how new ones join the list (a first load, posts newer than a kept feed),
 * and the likes, reposts and replies counted for them.
 *
 * Run: npm run test:unit   (node --test; no network)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { feedPostOf, addFeedPosts, mergePosts, tallyCounts, markIds, byFeedTime } from '../../src/utils/feedPosts.js';

const alice = generateSecretKey();
const bob = generateSecretKey();
const me = generateSecretKey();
const T = 1_700_000_000;

const note = (sk, at, content = `note at ${at}`, tags = []) => finalizeEvent({ kind: 1, created_at: at, tags, content }, sk);
const repost = (sk, original, at) => finalizeEvent({ kind: 6, created_at: at, tags: [['e', original.id, ''], ['p', original.pubkey]], content: JSON.stringify(original) }, sk);
const like = (sk, target, at = T + 100) => finalizeEvent({ kind: 7, created_at: at, tags: [['e', target.id], ['p', target.pubkey]], content: '+' }, sk);
const ids = (posts) => posts.map(p => p.id);

test('a root note shows; replies, machine-generated notes and other kinds do not', () => {
    const root = note(alice, T);
    assert.equal(feedPostOf(root), root);
    assert.equal(feedPostOf(note(bob, T + 1, 'a reply', [['e', root.id, '', 'root']])), null);
    assert.equal(feedPostOf(note(bob, T + 2, '{"name":"metadata"}')), null);
    assert.equal(feedPostOf(like(bob, root)), null);
});

test('a repost shows as the post it shares, with who reposted it; a forged one does not', () => {
    const original = note(alice, T);
    const r = repost(bob, original, T + 50);
    const post = feedPostOf(r);
    assert.equal(post.id, original.id);
    assert.equal(post._repostTime, T + 50);
    assert.deepEqual(post._reposters, [{ pubkey: getPublicKey(bob), timestamp: T + 50, repostId: r.id }]);
    const forged = finalizeEvent({ kind: 6, created_at: T + 60, tags: [['e', original.id]], content: JSON.stringify({ ...original, content: 'changed' }) }, bob);
    assert.equal(feedPostOf(forged), null);
});

test('posts arriving together join newest first, and nothing new keeps the same list', () => {
    const a = note(alice, T), b = note(bob, T + 10), c = note(alice, T + 20);
    const posts = addFeedPosts([], [a, c, b]);
    assert.deepEqual(ids(posts), [c.id, b.id, a.id]);
    assert.equal(addFeedPosts(posts, [b]), posts);
});

test('a repost of a post shown adds its reposter and moves it up, once', () => {
    const old = note(alice, T), newer = note(bob, T + 10);
    let posts = addFeedPosts([], [old, newer]);
    const r = repost(me, old, T + 20);
    posts = addFeedPosts(posts, [feedPostOf(r)]);
    assert.deepEqual(ids(posts), [old.id, newer.id]);
    assert.equal(posts[0]._reposters.length, 1);
    assert.equal(addFeedPosts(posts, [feedPostOf(r)]), posts, 'the same repost again');
    const again = repost(me, old, T + 30);
    assert.equal(addFeedPosts(posts, [feedPostOf(again)]), posts, 'the same member reposting again');
});

test('the note arriving after a repost of it keeps who reposted it', () => {
    const original = note(alice, T);
    const posts = addFeedPosts([], [feedPostOf(repost(bob, original, T + 40))]);
    const next = addFeedPosts(posts, [original]);
    assert.equal(next.length, 1);
    assert.equal(next[0]._repostTime, T + 40);
    assert.equal(next[0]._reposters[0].pubkey, getPublicKey(bob));
});

test('a kept feed with newer posts merged in keeps every kept post', () => {
    const kept = addFeedPosts([], Array.from({ length: 50 }, (_, i) => note(i % 2 ? alice : bob, T - i * 600)));
    // The relay's answer to `since` the newest kept event: that event again, and newer ones.
    const fresh = [kept[0], note(alice, T + 300), note(bob, T + 900)];
    const posts = addFeedPosts(kept, fresh.map(feedPostOf));
    assert.equal(posts.length, 52);
    assert.deepEqual(ids(posts.slice(2)), ids(kept));
    assert.deepEqual([...posts].sort(byFeedTime), posts);
});

test('older pages add only posts not shown yet', () => {
    const a = note(alice, T), b = note(bob, T - 10);
    const posts = [a];
    assert.equal(mergePosts(posts, [a]), posts);
    assert.deepEqual(ids(mergePosts(posts, [b, a])), [a.id, b.id]);
});

test('counts cover every post asked about, zeros included, and mark my own likes and reposts', () => {
    const a = note(alice, T), b = note(bob, T + 10), c = note(alice, T + 20);
    const reply = note(bob, T + 30, 'reply', [['e', a.id, '', 'root'], ['p', a.pubkey]]);
    const mine = like(me, a);
    const events = [like(bob, a), mine, mine, reply, repost(me, b, T + 40), like(alice, note(bob, T + 50))];
    const { stats, liked, reposted, deleted } = tallyCounts(events, [a, b, c], getPublicKey(me));
    assert.deepEqual(stats[a.id], { likes: 2, reposts: 0, replies: 1 });
    assert.deepEqual(stats[b.id], { likes: 0, reposts: 1, replies: 0 });
    assert.deepEqual(stats[c.id], { likes: 0, reposts: 0, replies: 0 });
    assert.equal(Object.keys(stats).length, 3);
    assert.deepEqual([...liked], [a.id]);
    assert.deepEqual([...reposted], [b.id]);
    assert.equal(deleted.size, 0);
});

test('a post its author deleted is found; a deletion by someone else is not', () => {
    const a = note(alice, T), b = note(bob, T + 10);
    const byAuthor = finalizeEvent({ kind: 5, created_at: T + 60, tags: [['e', a.id]], content: '' }, alice);
    const byOther = finalizeEvent({ kind: 5, created_at: T + 60, tags: [['e', b.id]], content: '' }, alice);
    const { deleted } = tallyCounts([byAuthor, byOther], [a, b], null);
    assert.deepEqual([...deleted], [a.id]);
});

test('my likes are set for the posts asked about, and only those', () => {
    const before = new Set(['x', 'y']);
    const after = markIds(before, ['x', 'z'], new Set(['z']));
    assert.deepEqual([...after].sort(), ['y', 'z']);
    assert.equal(markIds(before, ['x'], new Set(['x'])), before);
});
