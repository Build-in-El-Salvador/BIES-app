/**
 * The app signs only a plain profile when BIES asks it to publish one
 * (services/profileTemplate.js).
 *
 * Run with the built-in Node test runner: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isProfileTemplate, profileToSign } from './profileTemplate.js';

const profile = { kind: 0, created_at: 1_800_000_000, tags: [], content: '{"name":"ana"}' };

test('a plain profile is fit to sign', () => {
    assert.equal(isProfileTemplate(profile), true);
});

test('anything else is not', () => {
    assert.equal(isProfileTemplate(null), false);
    assert.equal(isProfileTemplate({ ...profile, kind: 1 }), false);
    assert.equal(isProfileTemplate({ ...profile, kind: '0' }), false);
    assert.equal(isProfileTemplate({ ...profile, tags: [['p', 'a'.repeat(64)]] }), false);
    assert.equal(isProfileTemplate({ ...profile, tags: undefined }), false);
    assert.equal(isProfileTemplate({ ...profile, content: 'not json' }), false);
    assert.equal(isProfileTemplate({ ...profile, content: '[1]' }), false);
    assert.equal(isProfileTemplate({ ...profile, created_at: 'soon' }), false);
});

test('only the profile fields are signed', () => {
    assert.deepEqual(profileToSign({ ...profile, pubkey: 'b'.repeat(64), extra: 'x' }), profile);
});
