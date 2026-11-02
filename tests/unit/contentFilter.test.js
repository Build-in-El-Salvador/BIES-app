// The word filter Feed posts and replies go through (src/utils/contentFilter.js
// in the app, relay-proxy/contentFilter.js in the relay's proxy), and the
// proxy's check on what a client sends (relay-proxy/noteFilter.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { findObjectionable } from '../../src/utils/contentFilter.js';
import { refusal, REFUSED } from '../../relay-proxy/noteFilter.js';

const note = (content, extra = {}) => ({ id: 'a'.repeat(64), pubkey: 'b'.repeat(64), kind: 1, created_at: 1, tags: [], content, sig: 'c'.repeat(128), ...extra });

test('the app and the proxy have the same filter, byte for byte', () => {
    const app = fs.readFileSync(new URL('../../src/utils/contentFilter.js', import.meta.url), 'utf8');
    const proxy = fs.readFileSync(new URL('../../relay-proxy/contentFilter.js', import.meta.url), 'utf8');
    assert.equal(proxy, app);
});

test('finds slurs and insults in English and Spanish, however they are disguised', () => {
    assert.equal(findObjectionable('you are a whore'), 'whore');
    assert.equal(findObjectionable('F4GG0T'), 'faggot');
    assert.equal(findObjectionable('eres un maricón'), 'maricon');
    assert.equal(findObjectionable('hijo de puta'), 'puta');
    assert.equal(findObjectionable('just kill   yourself'), 'kill yourself');
    assert.equal(findObjectionable('<b>ni</b>gger'), 'nigger');
    assert.equal(findObjectionable('wh​ore'), 'whore');
    assert.equal(findObjectionable('рuta'), 'puta'); // Cyrillic р
});

test('leaves everyday words alone', () => {
    for (const fine of ['A negro coffee, please', 'Vergón el evento!', 'Kike is coming', '$500 for the matate', 'Disputa resuelta', 'computadora', '']) {
        assert.equal(findObjectionable(fine), null, fine);
    }
    assert.equal(findObjectionable(null), null);
});

test('the proxy refuses a post or reply with them, telling the client why', () => {
    const bad = note('eres una puta');
    assert.deepEqual(refusal(['EVENT', bad]), ['OK', bad.id, false, REFUSED]);
    assert.equal(REFUSED, 'blocked: objectionable content');
    // A reply is a kind 1 too.
    assert.equal(refusal(['EVENT', note('kys', { tags: [['e', 'd'.repeat(64), '', 'root']] })])[2], false);
});

test('the proxy passes everything else on', () => {
    assert.equal(refusal(['EVENT', note('Great meetup tonight!')]), null);
    assert.equal(refusal(['EVENT', note('puta', { kind: 7 })]), null); // a reaction
    assert.equal(refusal(['EVENT', { kind: 1 }]), null); // no text: the relay decides
    assert.equal(refusal(['EVENT', null]), null);
    assert.equal(refusal(['REQ', 'sub', { kinds: [1] }]), null);
    assert.equal(refusal(['AUTH', note('puta', { kind: 22242 })]), null);
    assert.equal(refusal('not a message'), null);
    // An id that isn't a string isn't echoed back.
    assert.deepEqual(refusal(['EVENT', { kind: 1, content: 'puta', id: 5 }]), ['OK', '', false, REFUSED]);
});
