/**
 * Pages this session opened (a business or farm, an opportunity, a member),
 * kept in memory like the lists (listCache.js): opening one again shows it at
 * once while it's fetched again. A fetch started early (a finger on a card) is
 * shared, so the page waits on it instead of asking twice. Never written to
 * storage, and cleared at sign-out (authService.clearLocalSecrets).
 */
const pages = new Map();
const pending = new Map();
const MAX_PAGES = 50;

/** The page last shown for this key, or undefined. */
export function cachedDetail(key) {
    return pages.get(key);
}

/** Keep a page for next time; the oldest go first past MAX_PAGES. */
export function rememberDetail(key, value) {
    pages.delete(key);
    pages.set(key, value);
    if (pages.size > MAX_PAGES) pages.delete(pages.keys().next().value);
}

/**
 * `load()` for this key, kept once it answers. While one is on its way, the
 * same promise: a page opened just after its card was touched gets that answer.
 */
export function fetchDetail(key, load) {
    if (pending.has(key)) return pending.get(key);
    const request = Promise.resolve()
        .then(load)
        .then((value) => {
            rememberDetail(key, value);
            return value;
        })
        .finally(() => pending.delete(key));
    pending.set(key, request);
    return request;
}

/** Start fetching a page ahead of time (a finger on its card); errors are the page's to show. */
export function prefetchDetail(key, load) {
    if (pages.has(key)) return;
    fetchDetail(key, load).catch(() => {});
}

export function forgetDetail(key) {
    pages.delete(key);
}

export function clearDetails() {
    pages.clear();
    pending.clear();
}
