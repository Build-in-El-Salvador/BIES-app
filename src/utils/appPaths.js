/**
 * Whether one of the app's pages is there in this copy of the app: each
 * section needs its feature switched on (App.jsx's FeatureRoute flags), and
 * the store app has only those in APP_FEATURES (config/appScope.js), so a
 * notification about messages, points or bounties has nowhere to go there.
 * Links to such a page open the notifications instead.
 *
 * Pure module (no browser globals at import) so it runs under `node --test`.
 */

// The section, and the feature it needs. A page under several (the
// dashboard's messages) needs them all.
const SECTIONS = [
    ['/farms', 'directories'],
    ['/trusted', 'directories'],
    ['/discover/directory', 'directories'],
    ['/talents', 'talent'],
    ['/opportunities', 'projects'],
    ['/events', 'events'],
    ['/dashboard/events', 'events'],
    ['/leaderboard', 'points'],
    ['/media', 'media'],
    ['/news', 'news'],
    ['/messages', 'messages'],
    ['/dashboard/messages', 'messages'],
    ['/wallet', 'zaps'],
    ['/access', 'zaps'],
    ['/join', 'zaps'],
    ['/feedback', 'feedback'],
    ['/cowork', 'cowork'],
    ['/market', 'marketplace'],
    ['/bounties', 'bounties'],
    ['/dashboard', 'dashboard'],
    ['/courses', 'courses'],
];

/** Where a notification goes when its page isn't in this copy of the app. */
export const NOTIFICATIONS_PATH = '/notifications';

/** An in-app path ("/feed?post=…"), not another site's address or "//host". */
export const isAppPath = (path) => typeof path === 'string' && /^\/(?![/\\])/.test(path);

/**
 * Whether the page at this path is in this copy of the app.
 * @param {string} path - "/bounties/abc", with any query or hash
 * @param {Record<string, boolean>} flags - the app's flags (useFeatureFlags().flags; missing ⇒ on)
 */
export function pathAvailable(path, flags = {}) {
    if (!isAppPath(path)) return false;
    const pathname = path.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
    return SECTIONS.every(([prefix, slug]) =>
        !(pathname === prefix || pathname.startsWith(`${prefix}/`)) || flags[slug] !== false);
}

/** The path when its page is here; else the notifications. */
export function pathOrNotifications(path, flags = {}) {
    return pathAvailable(path, flags) ? path : NOTIFICATIONS_PATH;
}
