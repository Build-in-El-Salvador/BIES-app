/**
 * The bottom bar's tabs (src/config/navPages.js): pages whose feature is off
 * drop out, and the default bar fills the slots they leave.
 *
 * Run: npm run test:unit   (node --test; no network)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleTabs, DEFAULT_BOTTOM_NAV, NAV_PAGES, NAV_PAGES_BY_ID, MENU_PAGES, MENU_BOTTOM_PAGES, menuPages, sanitizeTabs, restoreTabs, savedTabs } from '../../src/config/navPages.js';

const ids = (pages) => pages.map((p) => p.id);
const allOn = () => true;
const offFlags = (...flags) => (p) => !p.flag || !flags.includes(p.flag);

test('the default bar is Home, Businesses, Farms, Opportunities, Feed', () => {
    assert.deepEqual(DEFAULT_BOTTOM_NAV, ['home', 'trusted', 'farms', 'opportunities', 'feed']);
    assert.deepEqual(ids(visibleTabs(DEFAULT_BOTTOM_NAV, allOn)), DEFAULT_BOTTOM_NAV);
    assert.deepEqual(sanitizeTabs(undefined), DEFAULT_BOTTOM_NAV);
});

test("a member's own bar stays as they set it while its features are on", () => {
    const bar = ['opportunities', 'events', 'media'];
    assert.deepEqual(ids(visibleTabs(bar, allOn)), bar);
});

test('switched-off pages give their slots to the default bar', () => {
    // The old default bar (its Discover is Opportunities now), in the store app (projects, events, media, dashboard off)
    const bar = sanitizeTabs(['feed', 'discover', 'events', 'media', 'dashboard']);
    const shown = ids(visibleTabs(bar, offFlags('projects', 'events', 'media', 'dashboard')));
    assert.deepEqual(shown, ['feed', 'home', 'trusted', 'farms', 'members']);
});

test('with Opportunities switched off, the default bar shows Members in its place', () => {
    assert.deepEqual(ids(visibleTabs(DEFAULT_BOTTOM_NAV, offFlags('projects'))), ['home', 'trusted', 'farms', 'feed', 'members']);
});

test('a deliberately short bar is not padded', () => {
    assert.deepEqual(ids(visibleTabs(['farms', 'trusted'], allOn)), ['farms', 'trusted']);
    assert.deepEqual(ids(visibleTabs(['farms', 'events'], offFlags('events'))), ['farms', 'home']);
});

test('an old saved default bar becomes the new one; one chosen since is kept', () => {
    const old = ['feed', 'members', 'farms', 'trusted', 'profile'];
    assert.deepEqual(restoreTabs(old), DEFAULT_BOTTOM_NAV);
    // Picking those tabs now: kept as they are, then and when read back.
    assert.deepEqual(sanitizeTabs(old), old);
    assert.deepEqual(restoreTabs(savedTabs(old)), old);
    assert.deepEqual(restoreTabs(savedTabs(['home', 'talent'])), ['home', 'talent']);
});

test('Profile is a tab members can choose, not in the default bar', () => {
    assert.equal(DEFAULT_BOTTOM_NAV.includes('profile'), false);
    assert.deepEqual(sanitizeTabs(['farms', 'profile', 'feed']), ['farms', 'profile', 'feed']);
    assert.deepEqual(sanitizeTabs(['home', 'profile']), ['home', 'profile']);
    assert.equal(NAV_PAGES_BY_ID.profile.path, '/profile');
});

test('a saved Discover tab is the Opportunities tab now', () => {
    assert.equal(NAV_PAGES_BY_ID.opportunities.path, '/opportunities');
    assert.equal(NAV_PAGES_BY_ID.opportunities.flag, 'projects');
    assert.equal(NAV_PAGES_BY_ID.discover, undefined);
    assert.deepEqual(sanitizeTabs(['feed', 'discover', 'members']), ['feed', 'opportunities', 'members']);
    assert.deepEqual(restoreTabs(savedTabs(['discover', 'talent'])), ['opportunities', 'talent']);
    // Once, not twice, when both are there.
    assert.deepEqual(sanitizeTabs(['discover', 'opportunities', 'feed']), ['opportunities', 'feed']);
});

test('Talents is a tab members can choose, at /talents', () => {
    assert.equal(NAV_PAGES_BY_ID.talent.path, '/talents');
    assert.deepEqual(sanitizeTabs(['talent', 'profile']), ['talent', 'profile']);
});

test('every page the bottom bar can hold is in the side menu too, once', () => {
    const inMenu = [...MENU_PAGES, ...MENU_BOTTOM_PAGES];
    for (const page of NAV_PAGES) assert.ok(inMenu.includes(page.id), `${page.id} is missing from the side menu`);
    assert.equal(new Set(inMenu).size, inMenu.length);
    assert.ok(MENU_PAGES.includes('members'));
});

test("the side menu leaves out pages whose feature is off", () => {
    const shown = ids(menuPages(MENU_PAGES, offFlags('events', 'media', 'news', 'messages', 'zaps', 'points', 'dashboard', 'courses', 'cowork', 'marketplace', 'bounties')));
    assert.deepEqual(shown, ['profile', 'home', 'feed', 'members', 'trusted', 'farms', 'talent', 'opportunities', 'notifications']);
});
