import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cachedDetail, clearDetails, fetchDetail, forgetDetail, prefetchDetail, rememberDetail } from './detailCache.js';

test('a page is kept once fetched, and cleared at sign-out', async () => {
    const value = await fetchDetail('listing:1', async () => ({ id: 1 }));
    assert.deepEqual(value, { id: 1 });
    assert.deepEqual(cachedDetail('listing:1'), { id: 1 });
    forgetDetail('listing:1');
    assert.equal(cachedDetail('listing:1'), undefined);
    rememberDetail('listing:2', { id: 2 });
    clearDetails();
    assert.equal(cachedDetail('listing:2'), undefined);
});

test('a fetch on its way is shared: the card touched, then the page opened', async () => {
    let calls = 0;
    let release;
    const load = () => { calls++; return new Promise((resolve) => { release = resolve; }); };
    prefetchDetail('profile:a', load);
    const page = fetchDetail('profile:a', load);
    await Promise.resolve();
    release({ name: 'Ana' });
    assert.deepEqual(await page, { name: 'Ana' });
    assert.equal(calls, 1);
    // Done: the next one asks again (a refresh), and a kept page isn't fetched ahead.
    await fetchDetail('profile:a', async () => { calls++; return { name: 'Ana B' }; });
    assert.equal(calls, 2);
    prefetchDetail('profile:a', async () => { calls++; return {}; });
    assert.equal(calls, 2);
    clearDetails();
});

test('a failed fetch is not kept, and the next one asks again', async () => {
    await assert.rejects(fetchDetail('opp:x', async () => { throw new Error('404'); }));
    assert.equal(cachedDetail('opp:x'), undefined);
    assert.deepEqual(await fetchDetail('opp:x', async () => ({ ok: true })), { ok: true });
    clearDetails();
});

test('only the most recent 50 are kept', () => {
    for (let i = 0; i < 55; i++) rememberDetail(`k${i}`, i);
    assert.equal(cachedDetail('k0'), undefined);
    assert.equal(cachedDetail('k54'), 54);
    clearDetails();
});
