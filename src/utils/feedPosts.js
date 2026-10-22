import { isGenuineRepost } from './repost.js';

/**
 * The BIES feed's posts (pages/Feed.jsx): which relay events it shows, how
 * new ones join the list, and the likes, reposts and replies counted for
 * them. Plain functions, so they can be tested (tests/unit/feedPosts.test.js).
 */

/** Newest first; a reposted post by when it was last reposted. */
export const byFeedTime = (a, b) => (b._repostTime || b.created_at) - (a._repostTime || a.created_at);

/**
 * The post an event shows in the feed, or null: a root note (not a reply,
 * not machine-generated JSON), or a repost as the post it shares, with who
 * reposted it.
 */
export function feedPostOf(event) {
    if (event.kind === 6) {
        let original;
        try { original = JSON.parse(event.content); } catch { return null; }
        if (!isGenuineRepost(event, original)) return null;
        return { ...original, _reposters: [{ pubkey: event.pubkey, timestamp: event.created_at, repostId: event.id }], _repostTime: event.created_at };
    }
    if (event.kind !== 1) return null;
    const c = (event.content || '').trimStart();
    if (c.startsWith('{') || c.startsWith('xitchat-') || c.startsWith('[')) return null;
    if (event.tags.some(t => t[0] === 'e')) return null;
    return event;
}

/**
 * Posts with new ones from the relay (feedPostOf) added, newest first. A
 * repost of a post already shown adds its reposter to it; the note itself
 * arriving after a repost of it keeps who reposted it. The same array when
 * nothing changes.
 */
export function addFeedPosts(posts, items) {
    let next = posts;
    let resort = false;
    const edit = () => { if (next === posts) next = [...posts]; };
    for (const item of items) {
        const at = next.findIndex(p => p.id === item.id);
        const reposter = item._reposters?.[0];
        if (reposter) {
            if (next.some(p => p._reposters?.some(r => r.repostId === reposter.repostId))) continue;
            if (at === -1) { edit(); next.push(item); resort = true; continue; }
            const existing = next[at];
            if (existing._reposters?.some(r => r.pubkey === reposter.pubkey)) continue;
            edit();
            next[at] = { ...existing, _reposters: [...(existing._reposters || []), reposter], _repostTime: Math.max(existing._repostTime || 0, item._repostTime) };
            resort = true;
        } else if (at === -1) {
            edit(); next.push(item); resort = true;
        } else if (next[at]._reposters) {
            edit();
            next[at] = { ...item, _reposters: next[at]._reposters, _repostTime: next[at]._repostTime };
        }
    }
    return resort ? next.sort(byFeedTime) : next;
}

/** Posts plus those of `items` not already among them, newest first. */
export function mergePosts(posts, items) {
    const have = new Set(posts.map(p => p.id));
    const add = items.filter(e => !have.has(e.id));
    return add.length ? [...posts, ...add].sort(byFeedTime) : posts;
}

/**
 * Counts for `posts` from the events the relay holds that tag them (kinds 7,
 * 6, 1 and 5): likes, reposts and replies for every post, zeros included so
 * a count that went down shows it; which ones `me` liked or reposted; and
 * which ones their author has since deleted (NIP-09).
 */
export function tallyCounts(events, posts, me) {
    const authorOf = new Map(posts.map(p => [p.id, p.pubkey]));
    const stats = {};
    for (const id of authorOf.keys()) stats[id] = { likes: 0, reposts: 0, replies: 0 };
    const liked = new Set();
    const reposted = new Set();
    const deleted = new Set();
    const seen = new Set();
    for (const event of events) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        if (event.kind === 5) {
            for (const t of event.tags) if (t[0] === 'e' && authorOf.get(t[1]) === event.pubkey) deleted.add(t[1]);
            continue;
        }
        const target = event.tags.find(t => t[0] === 'e')?.[1];
        if (!stats[target]) continue;
        if (event.kind === 7) {
            stats[target].likes++;
            if (me && event.pubkey === me) liked.add(target);
        } else if (event.kind === 6) {
            stats[target].reposts++;
            if (me && event.pubkey === me) reposted.add(target);
        } else if (event.kind === 1) {
            stats[target].replies++;
        }
    }
    return { stats, liked, reposted, deleted };
}

/** `set` with each of `ids` in it if `marked` has it and out if not; the same set when nothing changes. */
export function markIds(set, ids, marked) {
    let next = set;
    for (const id of ids) {
        if (marked.has(id) === set.has(id)) continue;
        if (next === set) next = new Set(set);
        if (marked.has(id)) next.add(id);
        else next.delete(id);
    }
    return next;
}
