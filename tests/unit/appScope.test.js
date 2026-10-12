/**
 * The store app's scope (src/config/appScope.js): in the iOS/Android app,
 * runtime flags can switch features off but never on outside the list; the
 * website runs with the flags as they are.
 *
 * Run: npm run test:unit   (node --test; no network)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { scopeFlags, APP_FEATURES } from '../../src/config/appScope.js';
import { DEFAULT_FLAGS, FEATURE_SLUGS } from '../../src/config/featureSlugs.js';

test('the website keeps every flag as it is', () => {
    const flags = { ...DEFAULT_FLAGS, events: true, bounties: false };
    assert.deepEqual(scopeFlags(flags, false), flags);
});

test('the app turns off everything outside its scope', () => {
    const scoped = scopeFlags({ ...DEFAULT_FLAGS }, true);
    for (const slug of FEATURE_SLUGS) {
        assert.equal(scoped[slug], APP_FEATURES.includes(slug), slug);
    }
    assert.equal(scoped.directories, true);
    assert.equal(scoped.events, false);
    assert.equal(scoped.dashboard, false);
});

test('in the app, a feature switched off stays off', () => {
    assert.equal(scopeFlags({ ...DEFAULT_FLAGS, directories: false }, true).directories, false);
});
