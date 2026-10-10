/**
 * The signer's per-tab copy of a pasted key (sessionStorage 'bies_sk_session',
 * src/services/nostrSigner.js) belongs to an nsec sign-in only. A copy left
 * behind after a sign-out or another kind of sign-in in the same tab must
 * never come back as the signing key.
 *
 * Run: npm run test:unit   (node --test, with storage stubbed)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey } from 'nostr-tools/pure';

function storage() {
    const items = new Map();
    return {
        getItem: (k) => (items.has(k) ? items.get(k) : null),
        setItem: (k, v) => items.set(k, String(v)),
        removeItem: (k) => items.delete(k),
    };
}
globalThis.localStorage = storage();
globalThis.sessionStorage = storage();

// The tab as the reviewer found it: an earlier member's key in sessionStorage,
// and someone else since signed in with a browser extension.
const previous = Buffer.from(generateSecretKey()).toString('hex');
sessionStorage.setItem('bies_sk_session', previous);
localStorage.setItem('bies_login_method', 'extension');

const { nostrSigner } = await import('../../src/services/nostrSigner.js');

test('a leftover key is not restored for another sign-in method, and is removed', () => {
    assert.equal(nostrSigner.hasKey, false);
    assert.equal(sessionStorage.getItem('bies_sk_session'), null);
});

test('switching to a signer that holds the key elsewhere forgets the one held here', () => {
    nostrSigner.setNsec(generateSecretKey());
    assert.equal(nostrSigner.hasKey, true);
    assert.ok(sessionStorage.getItem('bies_sk_session'));

    for (const switchTo of [() => nostrSigner.setExtensionMode(), () => nostrSigner.setBunkerMode('b'.repeat(64)), () => nostrSigner.setHostedMode('c'.repeat(64))]) {
        nostrSigner.setNsec(generateSecretKey());
        switchTo();
        assert.equal(nostrSigner.hasKey, false);
        assert.equal(sessionStorage.getItem('bies_sk_session'), null);
    }
});
