/**
 * Whether a page is in this copy of the app (src/utils/appPaths.js): a
 * notification about a page the store app leaves out (messages, points,
 * bounties) opens the notifications instead.
 *
 * Run: npm run test:unit   (node --test; no network)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathAvailable, pathOrNotifications, isAppPath, NOTIFICATIONS_PATH } from '../../src/utils/appPaths.js';
import { scopeFlags } from '../../src/config/appScope.js';
import { DEFAULT_FLAGS } from '../../src/config/featureSlugs.js';

const app = scopeFlags({ ...DEFAULT_FLAGS }, true);
const web = { ...DEFAULT_FLAGS };

test('in the store app, its own pages open', () => {
    for (const path of ['/feed?post=abc', '/builder/123', '/farms/x', '/trusted/y', '/talents/z', '/opportunities/p',
        '/events/e', '/events', '/notifications', '/settings/notifications', '/admin/reports', '/albums/a', '/home']) {
        assert.equal(pathAvailable(path, app), true, path);
        assert.equal(pathOrNotifications(path, app), path);
    }
});

test('in the store app, pages it leaves out open the notifications', () => {
    for (const path of ['/messages', '/leaderboard', '/bounties', '/bounties/b1', '/wallet', '/access/CODE', '/join/CODE',
        '/dashboard', '/dashboard/messages', '/media', '/news/x', '/market/n', '/courses/c', '/cowork']) {
        assert.equal(pathAvailable(path, app), false, path);
        assert.equal(pathOrNotifications(path, app), NOTIFICATIONS_PATH, path);
    }
});

test('on the website, every page whose feature is on', () => {
    assert.equal(pathOrNotifications('/bounties/b1', web), '/bounties/b1');
    assert.equal(pathOrNotifications('/messages', web), '/messages');
    assert.equal(pathOrNotifications('/bounties/b1', { ...web, bounties: false }), NOTIFICATIONS_PATH);
    // A page under two sections needs both.
    assert.equal(pathAvailable('/dashboard/messages', { ...web, messages: false }), false);
    assert.equal(pathAvailable('/dashboard/events', { ...web, events: false }), false);
    assert.equal(pathAvailable('/dashboard/following', web), true);
});

test('a section is matched whole, with any query, hash or trailing slash', () => {
    assert.equal(pathAvailable('/eventsx', { ...web, events: false }), true);
    assert.equal(pathAvailable('/events/?tab=mine', { ...web, events: false }), false);
    assert.equal(pathAvailable('/events#top', { ...web, events: false }), false);
    assert.equal(pathAvailable('/messages/', app), false);
});

test('only in-app paths', () => {
    for (const bad of ['https://evil.example/x', '//evil.example/x', '/\\evil.example', 'feed', '', null, undefined, 42]) {
        assert.equal(isAppPath(bad), false, String(bad));
        assert.equal(pathOrNotifications(bad, web), NOTIFICATIONS_PATH);
    }
});
