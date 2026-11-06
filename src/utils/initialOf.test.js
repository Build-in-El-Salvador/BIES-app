import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialOf } from './initialOf.js';

test("a member's initial is the first letter of their name, upper-cased", () => {
    assert.equal(initialOf('Marco Guzmán'), 'M');
    assert.equal(initialOf('  lucía mendoza'), 'L');
    assert.equal(initialOf('Ángel'), 'Á');
    assert.equal(initialOf('ñandú'), 'Ñ');
    assert.equal(initialOf('42 Labs'), '4');
});

test('no name, a Nostr placeholder or a leading symbol: no letter (a person figure)', () => {
    assert.equal(initialOf(''), '');
    assert.equal(initialOf(null), '');
    assert.equal(initialOf(undefined), '');
    assert.equal(initialOf('   '), '');
    assert.equal(initialOf('nostr:1a2b3c4d'), '');
    assert.equal(initialOf('@marco'), '');
    assert.equal(initialOf('🌋 Volcán'), '');
});

test('a name that is not text, or a key shown in its place: no letter, and no crash', () => {
    for (const odd of [42, true, ['Ana'], { name: 'Ana' }]) assert.equal(initialOf(odd), '');
    assert.equal(initialOf('npub1qy88wumn8ghj7mn0wvhxcmmv9uq3amnwvaz7tmwdaehgu3wvf5hgcm0d9h'), '');
    assert.equal(initialOf('3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d'), '');
    assert.equal(initialOf('Deadbeef Café'), 'D'); // a word that happens to be hex, then more: still a name
});
