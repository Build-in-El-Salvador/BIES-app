/**
 * The phone app's own networking (src/services/nativeResponse.js): what
 * CapacitorHttp answers becomes a fetch Response the API client reads as
 * before, and JSON bodies go to the plugin the way it takes them.
 *
 * Run: npm run test:unit   (node --test; no network)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { asData, asResponse } from '../../src/services/nativeResponse.js';

test('an answer is a Response: status, headers, and the body as text', async () => {
    const res = asResponse({ status: 200, headers: { 'Content-Type': 'application/json' }, data: '{"ok":true}' });
    assert.equal(res.ok, true);
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.deepEqual(await res.json(), { ok: true });
});

test('JSON the plugin already parsed reads the same', async () => {
    const res = asResponse({ status: 401, headers: {}, data: { reason: 'token_expired' } });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.clone().json(), { reason: 'token_expired' }); // sendAuthorized reads a clone
    assert.deepEqual(await res.json(), { reason: 'token_expired' });
});

test('a 204 has no body, and a missing body is empty', async () => {
    assert.equal(asResponse({ status: 204, headers: {}, data: '' }).body, null);
    assert.equal(await asResponse({ status: 200, headers: {}, data: null }).text(), '');
});

test('repeated headers are joined', () => {
    const res = asResponse({ status: 200, headers: { Vary: ['Origin', 'Accept'] }, data: '' });
    assert.equal(res.headers.get('vary'), 'Origin, Accept');
});

test('a JSON body goes to the plugin as an object; nothing stays nothing', () => {
    assert.deepEqual(asData('{"vote":1}', { 'Content-Type': 'application/json' }), { vote: 1 });
    assert.equal(asData('plain', { 'Content-Type': 'text/plain' }), 'plain');
    assert.equal(asData(undefined, {}), undefined);
    assert.equal(asData('not json', { 'content-type': 'application/json' }), 'not json');
});
