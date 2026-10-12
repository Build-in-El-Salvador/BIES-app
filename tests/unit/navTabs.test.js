/**
 * The bottom bar's tabs (src/config/navPages.js): pages whose feature is off
 * drop out, and the default bar fills the slots they leave.
 *
 * Run: npm run test:unit   (node --test; no network)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleTabs, DEFAULT_BOTTOM_NAV, sanitizeTabs } from '../../src/config/navPages.js';

const ids = (pages) => pages.map((p) => p.id);
const allOn = () => true;
const offFlags = (...flags) => (p) => !p.flag || !flags.includes(p.flag);

test('the default bar is Feed, Members, Farms, Trusted, Profile', () => {
    assert.deepEqual(DEFAULT_BOTTOM_NAV, ['feed', 'members', 'farms', 'trusted', 'profile']);
    assert.deepEqual(ids(visibleTabs(DEFAULT_BOTTOM_NAV, allOn)), DEFAULT_BOTTOM_NAV);
    assert.deepEqual(sanitizeTabs(undefined), DEFAULT_BOTTOM_NAV);
});

test("a member's own bar stays as they set it while its features are on", () => {
    const bar = ['discover', 'events', 'media'];
    assert.deepEqual(ids(visibleTabs(bar, allOn)), bar);
});

test('switched-off pages give their slots to the default bar', () => {
    // The old default bar, in the store app (projects, events, media, dashboard off)
    const bar = ['feed', 'discover', 'events', 'media', 'dashboard'];
    const shown = ids(visibleTabs(bar, offFlags('projects', 'events', 'media', 'dashboard')));
    assert.deepEqual(shown, ['feed', 'members', 'farms', 'trusted', 'profile']);
});

test('a deliberately short bar is not padded', () => {
    assert.deepEqual(ids(visibleTabs(['farms', 'trusted'], allOn)), ['farms', 'trusted']);
    assert.deepEqual(ids(visibleTabs(['farms', 'events'], offFlags('events'))), ['farms', 'feed']);
});
