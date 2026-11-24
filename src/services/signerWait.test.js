/**
 * Unit tests for signerWait — how long a login waits for a remote signer to
 * sign: a slow-wait hint at the soft limit, a give-up at the hard one, and a
 * late approval kept in between.
 *
 * Run with the built-in Node test runner:
 *   npm run test:unit        (or: node --test src/services/)
 */
import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { awaitSignature, SIGNER_SIGN_SOFT_MS, SIGNER_SIGN_HARD_MS } from './signerWait.js';
import { SIGNER_ERROR, signerErrorKey } from './signerError.js';

const SOFT = 1_000;
const HARD = 4_000;

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

/** Let promise callbacks run after a mocked tick. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
afterEach(() => mock.timers.reset());

test('the defaults keep the signed event inside the server window', () => {
    // auth.controller.ts: challenge 5 min, created_at within 300 s.
    assert.ok(SIGNER_SIGN_SOFT_MS < SIGNER_SIGN_HARD_MS);
    assert.ok(SIGNER_SIGN_HARD_MS <= 240_000);
    assert.ok(SIGNER_SIGN_HARD_MS < 300_000 - 30_000);
});

test('a prompt answer resolves and never reports a slow wait', async () => {
    const request = deferred();
    let slow = 0;
    const wait = awaitSignature(request.promise, { softMs: SOFT, hardMs: HARD, onSlow: () => { slow++; } });
    request.resolve('signed');
    assert.equal(await wait, 'signed');
    mock.timers.tick(HARD * 2);
    await flush();
    assert.equal(slow, 0);
});

test('past the soft limit the wait goes on, once, and a late approval still counts', async () => {
    const request = deferred();
    let slow = 0;
    const wait = awaitSignature(request.promise, { softMs: SOFT, hardMs: HARD, onSlow: () => { slow++; } });

    mock.timers.tick(SOFT + 10);
    await flush();
    assert.equal(slow, 1);

    mock.timers.tick(HARD / 2);
    await flush();
    assert.equal(slow, 1, 'the slow notice is sent once');

    // The signer's person approves late, but inside the hard limit.
    request.resolve('signed late');
    assert.equal(await wait, 'signed late');
});

test('at the hard limit it gives up with signer_no_response, and a later answer is ignored', async () => {
    const request = deferred();
    const wait = awaitSignature(request.promise, { softMs: SOFT, hardMs: HARD });
    const settled = assert.rejects(wait, (err) => {
        assert.equal(err.code, SIGNER_ERROR.NO_RESPONSE);
        assert.equal(signerErrorKey(err).key, 'login.signerNoResponse');
        return true;
    });

    mock.timers.tick(HARD + 1);
    await settled;

    // Too late: nothing throws, nothing resolves.
    request.resolve('signed too late');
    await flush();
});

test("the signer's own refusal passes through unchanged and stops the timers", async () => {
    const request = deferred();
    let slow = 0;
    const wait = awaitSignature(request.promise, { softMs: SOFT, hardMs: HARD, onSlow: () => { slow++; } });
    request.reject('Permission denied for sign_event kind:27235');
    await assert.rejects(wait, (err) => err === 'Permission denied for sign_event kind:27235');

    mock.timers.tick(HARD * 2);
    await flush();
    assert.equal(slow, 0);
});

test('an abort rejects with AbortError and a later answer is ignored', async () => {
    const request = deferred();
    const controller = new AbortController();
    const wait = awaitSignature(request.promise, { softMs: SOFT, hardMs: HARD, signal: controller.signal });
    const settled = assert.rejects(wait, (err) => err.name === 'AbortError');

    controller.abort();
    await settled;

    request.resolve('signed after cancel');
    await flush();
});

test('a signal that is already aborted rejects at once, without leaking a rejection', async () => {
    const request = deferred();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
        awaitSignature(request.promise, { softMs: SOFT, hardMs: HARD, signal: controller.signal }),
        (err) => err.name === 'AbortError',
    );
    // The request fails later: handled, so Node does not see an unhandled rejection.
    request.reject('late failure');
    await flush();
});

test('a soft limit at or past the hard one never reports a slow wait', async () => {
    const request = deferred();
    let slow = 0;
    const wait = awaitSignature(request.promise, { softMs: HARD, hardMs: HARD, onSlow: () => { slow++; } });
    const settled = assert.rejects(wait, (err) => err.code === SIGNER_ERROR.NO_RESPONSE);
    mock.timers.tick(HARD + 1);
    await settled;
    assert.equal(slow, 0);
});
