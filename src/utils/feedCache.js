/**
 * The BIES feed as this session last showed it (the members' feed, and each
 * profile's posts), kept in memory so going back to it draws the posts at
 * once; the page then asks the relay only for posts newer than the newest
 * kept (pages/Feed.jsx). Keyed by account and view. Never written to
 * storage, and cleared at sign-out (authService.clearLocalSecrets), like
 * utils/listCache.js: these are members-only posts.
 */
const feeds = new Map();
const MAX_FEEDS = 10;

/** The cache key of one view of the feed: the BIES feed, or a member's posts. */
export function feedCacheKey(accountId, author) {
    return `${accountId || ''}:${author || 'bies'}`;
}

/** The feed last shown for this key, or undefined. */
export function cachedFeed(key) {
    return feeds.get(key);
}

/** Keep a feed for next time; the oldest go first past MAX_FEEDS. */
export function rememberFeed(key, value) {
    feeds.delete(key);
    feeds.set(key, value);
    if (feeds.size > MAX_FEEDS) feeds.delete(feeds.keys().next().value);
}

export function clearFeeds() {
    feeds.clear();
}
