/**
 * Unit tests for signerError — normalising NIP-46 remote-signer rejections
 * (nostr-tools rejects a signer error with a bare string) into Errors the
 * login screen can explain.
 *
 * Run with the built-in Node test runner:
 *   npm run test:unit        (or: node --test src/services/)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toSignerError, isDeadSessionError, signerErrorKey, SIGNER_ERROR } from './signerError.js';

test('Bunker46 permission denial keeps the refused kind', () => {
    const err = toSignerError('Permission denied for sign_event kind:27235');
    assert.ok(err instanceof Error);
    assert.equal(err.message, 'Permission denied for sign_event kind:27235');
    assert.equal(err.code, SIGNER_ERROR.PERMISSION_DENIED);
    assert.equal(err.kind, 27235);
    assert.equal(isDeadSessionError(err), false);
    assert.deepEqual(signerErrorKey(err), { key: 'login.signerPermissionDeniedKind', params: { kind: 27235 } });
});

test('generic refusal without a kind', () => {
    const err = toSignerError('user rejected');
    assert.equal(err.code, SIGNER_ERROR.PERMISSION_DENIED);
    assert.equal(err.kind, undefined);
    assert.equal(signerErrorKey(err).key, 'login.signerPermissionDenied');
});

test('spent or unknown bunker link is a dead session', () => {
    for (const msg of ['Unknown client', 'No matching pending secret', 'invalid secret']) {
        const err = toSignerError(msg);
        assert.equal(err.code, SIGNER_ERROR.LINK_USED, msg);
        assert.equal(isDeadSessionError(err), true, msg);
    }
});

test('revoked connection is a dead session', () => {
    const err = toSignerError('Connection revoked');
    assert.equal(err.code, SIGNER_ERROR.REVOKED);
    assert.equal(isDeadSessionError(err), true);
});

test('Error objects pass through untouched', () => {
    const original = new Error('Connection timed out.');
    assert.equal(toSignerError(original), original);
    assert.equal(signerErrorKey(original), null);
});

test('unknown signer text is kept, capped and never empty', () => {
    assert.equal(toSignerError('something odd').message, 'something odd');
    assert.equal(signerErrorKey(toSignerError('something odd')), null);
    assert.equal(toSignerError('x'.repeat(1000)).message.length, 200);
    assert.ok(toSignerError('').message.length > 0);
    assert.ok(toSignerError(undefined).message.length > 0);
});
