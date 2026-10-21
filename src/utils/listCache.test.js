import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cachedList, rememberList, clearLists } from './listCache.js';

test('a list is kept per request and cleared at sign-out', () => {
    rememberList('farms:{}', [1, 2]);
    rememberList('farms:{"search":"eggs"}', [3]);
    assert.deepEqual(cachedList('farms:{}'), [1, 2]);
    assert.deepEqual(cachedList('farms:{"search":"eggs"}'), [3]);
    clearLists();
    assert.equal(cachedList('farms:{}'), undefined);
});

test('only the most recent 30 are kept', () => {
    for (let i = 0; i < 35; i++) rememberList(`k${i}`, i);
    assert.equal(cachedList('k0'), undefined);
    assert.equal(cachedList('k34'), 34);
    clearLists();
});
