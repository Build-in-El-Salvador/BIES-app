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
