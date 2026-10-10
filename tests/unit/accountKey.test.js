/**
 * "Take your key" on the app's side (src/services/accountKey.js): reading
 * back the key a member saved, whatever form they saved it in, the backup
 * file, and the confirmation the server checks.
 *
 * Run: npm run test:unit   (node --test; no network)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { nip19 } from 'nostr-tools';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import {
    CONFIRMATION_KIND,
    buildBackup,
    keyMatches,
    readKeyInput,
    signConfirmation,
    unlockBackup,
} from '../../src/services/accountKey.js';

const secretKey = generateSecretKey();
const pubkey = getPublicKey(secretKey);
const hex = Buffer.from(secretKey).toString('hex');

/** The bytes inside a bech32 string (checksum not checked). */
function bech32Bytes(text) {
    const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    const data = text.slice(text.lastIndexOf('1') + 1, -6);
    let bits = 0;
    let value = 0;
    const out = [];
    for (const c of data) {
        value = (value << 5) | CHARSET.indexOf(c);
        bits += 5;
        if (bits >= 8) {
            bits -= 8;
            out.push((value >> bits) & 0xff);
        }
    }
    return Uint8Array.from(out);
}

test('reads the key back from an nsec or from hex, however it was pasted', () => {
    for (const input of [nip19.nsecEncode(secretKey), `  ${nip19.nsecEncode(secretKey)}\n`, hex, hex.toUpperCase()]) {
        const read = readKeyInput(input);
        assert.ok(read?.secretKey, input);
        assert.equal(getPublicKey(read.secretKey), pubkey);
    }
});

test('reads an upper-case nsec, as written down or scanned', () => {
    const read = readKeyInput(nip19.nsecEncode(secretKey).toUpperCase());
    assert.equal(getPublicKey(read.secretKey), pubkey);
});

test("reads BIES's old plain-text key files, from before NIP-49 backups", () => {
    // What Signup downloaded as a .txt then (git show 5c2e119:src/pages/Signup.jsx).
    const legacy = `BIES Nostr Keys\n===============\n\nPublic Key (npub) — safe to share:\n${nip19.npubEncode(pubkey)}\n\nSecret Key (nsec) — KEEP THIS PRIVATE:\n${nip19.nsecEncode(secretKey)}\n`;
    const read = readKeyInput(legacy);
    assert.equal(getPublicKey(read.secretKey), pubkey);
});

test('says when a key file comes from a newer version of the app', () => {
    const newer = JSON.stringify({ format: 'nostrkey', version: 2, ncryptsec: 'ncryptsec1qqqq', npub: nip19.npubEncode(pubkey) });
    assert.deepEqual(readKeyInput(newer), { tooNew: true });
});

test('says when it is not a key', () => {
    for (const input of ['', '   ', 'hello', nip19.npubEncode(pubkey), nip19.nsecEncode(secretKey).slice(0, 40), hex.slice(2), '{"format":"nostrkey"}']) {
        assert.equal(readKeyInput(input), null, input);
    }
});

test('backs a key up with a password, flagged as handled by a server', () => {
    const { json, filename, npub } = buildBackup(secretKey, 'correct horse battery');
    assert.equal(npub, nip19.npubEncode(pubkey));
    assert.match(filename, /\.nostrkey$/);

    const file = JSON.parse(json);
    assert.equal(file.format, 'nostrkey');
    assert.ok(!json.includes(hex) && !json.includes(nip19.nsecEncode(secretKey)), 'the key is not in the file in the clear');

    // NIP-49: version, log_n, salt (16), nonce (24), then the key security
    // byte: 0x00 = known to have been handled insecurely.
    const bytes = bech32Bytes(file.ncryptsec);
    assert.equal(bytes[0], 0x02);
    assert.equal(bytes[1 + 1 + 16 + 24], 0x00);
});

test('opens the backup with its password, and only with it', () => {
    const { json } = buildBackup(secretKey, 'correct horse battery');
    for (const saved of [json, JSON.parse(json).ncryptsec]) {
        const read = readKeyInput(saved);
        assert.ok(read?.encrypted, 'needs the password');
        assert.ok(keyMatches(unlockBackup(read.encrypted, 'correct horse battery'), pubkey));
        assert.throws(() => unlockBackup(read.encrypted, 'wrong password'));
    }
});

test('tells the right key from another one', () => {
    assert.equal(keyMatches(secretKey, pubkey), true);
    assert.equal(keyMatches(generateSecretKey(), pubkey), false);
    assert.equal(keyMatches(new Uint8Array(3), pubkey), false);
});

test('signs the confirmation the server checks', () => {
    const challenge = 'ab'.repeat(32);
    const event = signConfirmation(secretKey, 'take_key', challenge, 'I have saved my Nostr key.');
    assert.equal(event.kind, CONFIRMATION_KIND);
    assert.equal(event.pubkey, pubkey);
    assert.deepEqual(event.tags, [['challenge', challenge], ['purpose', 'take_key']]);
    assert.ok(Math.abs(event.created_at - Date.now() / 1000) < 5);
    assert.equal(verifyEvent(event), true);
});
