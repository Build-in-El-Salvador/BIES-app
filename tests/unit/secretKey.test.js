import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nip19, generateSecretKey } from 'nostr-tools';
import { decodeNsec } from '../../src/utils/secretKey.js';

test('decodes a good nsec, spaces around it too', () => {
    const sk = generateSecretKey();
    assert.deepEqual(decodeNsec(`  ${nip19.nsecEncode(sk)}\n`), sk);
});

test('a typo never comes back in the error', () => {
    const nsec = nip19.nsecEncode(generateSecretKey());
    const typo = nsec.slice(0, 20) + (nsec[20] === 'q' ? 'p' : 'q') + nsec.slice(21);
    for (const bad of [typo, nsec.slice(0, -1), nip19.npubEncode('a'.repeat(64)), 'hello', '']) {
        assert.throws(() => decodeNsec(bad), (err) => {
            assert.ok(!err.message.includes(bad.slice(5, 25)) || bad.length < 25, err.message);
            assert.match(err.message, /isn't a valid secret key/);
            return true;
        });
    }
});
