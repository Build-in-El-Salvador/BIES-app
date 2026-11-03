import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    CODE_ALPHABET,
    formatAsTyped,
    formatInviteCode,
    forgetInvite,
    inviteCodeFromHash,
    inviteLink,
    normalizeInviteCode,
    rememberInvite,
    rememberedInvite,
} from '../../src/utils/inviteCode.js';

const memoryStorage = () => {
    const data = new Map();
    return {
        getItem: (k) => (data.has(k) ? data.get(k) : null),
        setItem: (k, v) => data.set(k, String(v)),
        removeItem: (k) => data.delete(k),
    };
};

test('the alphabet matches the server: 31 characters, no look-alikes', () => {
    assert.equal(CODE_ALPHABET, '23456789ABCDEFGHJKMNPQRSTUVWXYZ');
    assert.doesNotMatch(CODE_ALPHABET, /[01ILO]/);
});

test('codes read the way the server reads them', () => {
    assert.equal(normalizeInviteCode('bies-k7m4-q9tx'), 'K7M4Q9TX');
    assert.equal(normalizeInviteCode(' K7M4 Q9TX '), 'K7M4Q9TX');
    assert.equal(formatInviteCode('k7m4q9tx'), 'BIES-K7M4-Q9TX');
    assert.equal(normalizeInviteCode('BIES-K7M4-Q9T0'), null);
    assert.equal(normalizeInviteCode('BIES-K7M4'), null);
    assert.equal(normalizeInviteCode(null), null);
});

test('typing fills in the dashes and drops what a code never has', () => {
    assert.equal(formatAsTyped(''), '');
    assert.equal(formatAsTyped('k'), 'BIES-K');
    assert.equal(formatAsTyped('k7m4'), 'BIES-K7M4');
    assert.equal(formatAsTyped('k7m4q'), 'BIES-K7M4-Q');
    assert.equal(formatAsTyped('BIES-K7M4-Q9TX-EXTRA'), 'BIES-K7M4-Q9TX');
    assert.equal(formatAsTyped('k7o0m4'), 'BIES-K7M4');
});

test('links carry the code after #, and the # reads back', () => {
    const link = inviteLink('https://app.buildinelsalvador.com/', 'k7m4q9tx');
    assert.equal(link, 'https://app.buildinelsalvador.com/invite#BIES-K7M4-Q9TX');
    assert.equal(new URL(link).pathname, '/invite');
    assert.equal(inviteCodeFromHash(new URL(link).hash), 'BIES-K7M4-Q9TX');
    assert.equal(inviteCodeFromHash('#BIES%2DK7M4%2DQ9TX'), 'BIES-K7M4-Q9TX');
    assert.equal(inviteCodeFromHash('#nonsense'), null);
    assert.equal(inviteCodeFromHash(''), null);
});

test('a remembered code lasts until it expires or is forgotten', () => {
    const storage = memoryStorage();
    const now = Date.now();
    rememberInvite(storage, 'bies-k7m4-q9tx', new Date(now + 60_000).toISOString());
    assert.deepEqual(rememberedInvite(storage, now), { code: 'BIES-K7M4-Q9TX', expiresAt: now + 60_000 });
    assert.equal(rememberedInvite(storage, now + 61_000), null);
    assert.equal(storage.getItem('bies_invite'), null);

    rememberInvite(storage, 'BIES-K7M4-Q9TX', new Date(now + 60_000).toISOString());
    forgetInvite(storage);
    assert.equal(rememberedInvite(storage, now), null);

    rememberInvite(storage, 'not a code', new Date(now + 60_000).toISOString());
    assert.equal(rememberedInvite(storage, now), null);
});
