/**
 * Unit tests for the pure keytr guards: the account check on passkey key
 * re-acquisition, and the NIP-09 deletion templates behind "Remove Passkey".
 *
 * Run with the built-in Node test runner (no browser, no extra deps):
 *   npm run test:unit        (or: node --test src/services/)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { buildKeytrEvent, encryptNsec, KEYTR_VERSION, DELETION_EVENT_KIND, KEYTR_EVENT_KIND } from '@sovit.xyz/keytr';
import { assertNsecMatches, buildDeletionTemplates, isHexPubkey, repairPubkey } from './keytrGuards.js';

function account() {
    const sk = generateSecretKey();
    return { sk, nsec: nip19.nsecEncode(sk), pubkey: getPublicKey(sk) };
}

// keytr writes the d-tag with @scure/base's base64url, which keeps the `=`
// padding and refuses input without it. Node's 'base64url' drops it.
function paddedBase64url(bytes) {
    const s = Buffer.from(bytes).toString('base64url');
    return s + '='.repeat((4 - (s.length % 4)) % 4);
}

/** A kind:31777 event as a relay would return it (id/pubkey filled in). */
function keytrEvent(acct, rpId = 'bies.sovit.xyz') {
    const credentialId = new Uint8Array(randomBytes(16));
    const encryptedBlob = encryptNsec({
        nsecBytes: acct.sk,
        keyMaterial: new Uint8Array(randomBytes(32)),
        credentialId,
        version: KEYTR_VERSION,
    });
    const template = buildKeytrEvent({
        credential: {
            credentialId,
            credentialIdBase64url: paddedBase64url(credentialId),
            rpId,
            transports: [],
        },
        encryptedBlob,
        clientName: 'bies',
        version: KEYTR_VERSION,
    });
    return { ...template, pubkey: acct.pubkey, id: randomBytes(32).toString('hex') };
}

test('assertNsecMatches accepts the session account\'s own key', () => {
    const a = account();
    assert.doesNotThrow(() => assertNsecMatches(a.nsec, a.pubkey));
});

test('assertNsecMatches rejects another account\'s key with pubkeyMismatch', () => {
    const a = account();
    const b = account();
    assert.throws(() => assertNsecMatches(b.nsec, a.pubkey), (err) => err.pubkeyMismatch === true);
});

test('assertNsecMatches is a no-op without an expected pubkey (fresh login)', () => {
    assert.doesNotThrow(() => assertNsecMatches(account().nsec, undefined));
});

test('buildDeletionTemplates retracts every gateway\'s event by d-tag and id', () => {
    const a = account();
    const events = [keytrEvent(a, 'bies.sovit.xyz'), keytrEvent(a, 'keytr.org'), keytrEvent(a, 'nostkey.org')];
    const templates = buildDeletionTemplates(events, a.pubkey);
    assert.equal(templates.length, 3);
    templates.forEach((t, i) => {
        assert.equal(t.kind, DELETION_EVENT_KIND);
        const dTag = events[i].tags.find(x => x[0] === 'd')[1];
        assert.deepEqual(t.tags.find(x => x[0] === 'a'), ['a', `${KEYTR_EVENT_KIND}:${a.pubkey}:${dTag}`]);
        assert.deepEqual(t.tags.find(x => x[0] === 'e'), ['e', events[i].id]);
    });
});

test('buildDeletionTemplates skips other authors and unparseable events', () => {
    const a = account();
    const b = account();
    const broken = { ...keytrEvent(a), tags: [] }; // no d / rp tags
    const templates = buildDeletionTemplates([keytrEvent(b), broken, keytrEvent(a)], a.pubkey);
    assert.equal(templates.length, 1);
});

test('isHexPubkey only accepts 64-char lowercase hex strings', () => {
    assert.equal(isHexPubkey(account().pubkey), true);
    // What tier-2 login used to store: a byte array, serialised as an object
    assert.equal(isHexPubkey(JSON.parse(JSON.stringify(new Uint8Array(32)))), false);
    assert.equal(isHexPubkey('ab'.repeat(31)), false);
    assert.equal(isHexPubkey(undefined), false);
});

test('repairPubkey turns a stored byte array back into the hex pubkey', () => {
    const a = account();
    const bytes = new Uint8Array(a.pubkey.match(/.{2}/g).map(h => parseInt(h, 16)));
    assert.equal(repairPubkey(JSON.parse(JSON.stringify(bytes))), a.pubkey);
    assert.equal(repairPubkey(Array.from(bytes)), a.pubkey);
    assert.equal(repairPubkey(a.pubkey), a.pubkey);
    assert.equal(repairPubkey({ 0: 1, 1: 2 }), null);
    assert.equal(repairPubkey(JSON.parse(JSON.stringify(new Uint8Array(32).fill(1))).length), null);
    assert.equal(repairPubkey(undefined), null);
    assert.equal(repairPubkey('not-hex'), null);
});
