/**
 * Who the app asks for a name and photo before anything else
 * (src/utils/profileComplete.js, shown by ProfileGate).
 *
 * Run: npm run test:unit   (node --test; no network)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isPlaceholderName, needsProfile } from '../../src/utils/profileComplete.js';

const member = (name, avatar) => ({ profile: { name, avatar } });

test('asks new members for a name and a photo', () => {
    assert.equal(needsProfile(member('', '')), true);
    assert.equal(needsProfile({ profile: null }), true);
});

test("treats a Nostr sign-in's placeholder as no name", () => {
    assert.equal(isPlaceholderName('nostr:a0fe412a'), true);
    assert.equal(needsProfile(member('nostr:a0fe412a', 'https://x.test/a.jpg')), true);
});

test('still asks for a photo when only the name is there', () => {
    assert.equal(needsProfile(member('Ana Rivas', '')), true);
    assert.equal(needsProfile(member('   ', 'https://x.test/a.jpg')), true);
});

test('leaves finished profiles, and signed-out visitors, alone', () => {
    assert.equal(needsProfile(member('Ana Rivas', 'https://x.test/a.jpg')), false);
    assert.equal(needsProfile(null), false);
});
