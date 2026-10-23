/**
 * Each list page's "Sort by" (src/utils/listSorts.js) and the requests it
 * makes (src/utils/listRequests.js): the usual order keeps the request (and
 * cache key) the bottom bar fetches ahead; another order is its own list.
 *
 * Run: npm run test:unit   (node --test; no network)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { directorySorts, MEMBER_SORTS, opportunitySorts, sortOf, TALENT_SORTS } from '../../src/utils/listSorts.js';
import {
    directoryKey, directoryRequest, membersKey, opportunitiesKey, opportunitiesRequest,
} from '../../src/utils/listRequests.js';

test('each page offers its own orders, the usual one first', () => {
    assert.deepEqual(directorySorts('PROVIDER'), ['', 'vouches', 'newest', 'name', 'price-low', 'price-high']);
    assert.deepEqual(directorySorts('FARM'), ['', 'vouches', 'newest', 'name']); // farms price per product, in words
    assert.deepEqual(opportunitySorts(''), ['', 'closing', 'name']);
    assert.deepEqual(opportunitySorts('job'), ['', 'closing', 'name']); // pay is in words
    assert.deepEqual(opportunitySorts('business-for-sale').slice(-2), ['price-low', 'price-high']);
    assert.deepEqual(opportunitySorts('program').slice(-2), ['price-low', 'price-high']);
    assert.equal(TALENT_SORTS[0], '');
    assert.equal(MEMBER_SORTS[0], '');
});

test("an order the page doesn't offer is its usual one", () => {
    assert.equal(sortOf(directorySorts('FARM'), 'price-low'), '');
    assert.equal(sortOf(directorySorts('PROVIDER'), 'price-low'), 'price-low');
    assert.equal(sortOf(opportunitySorts('job'), 'price-high'), '');
    assert.equal(sortOf(TALENT_SORTS, 'whatever'), '');
    assert.equal(sortOf(MEMBER_SORTS, null), '');
});

test('the usual order keeps the request fetched ahead; another is its own list', () => {
    assert.equal(directoryKey(directoryRequest({ type: 'PROVIDER', sort: '' })), directoryKey(directoryRequest({ type: 'PROVIDER' })));
    assert.equal(directoryRequest({ type: 'PROVIDER' }).sort, 'score');
    assert.equal(directoryRequest({ type: 'PROVIDER', sort: 'name' }).sort, 'name');
    assert.notEqual(directoryKey(directoryRequest({ type: 'PROVIDER', sort: 'name' })), directoryKey(directoryRequest({ type: 'PROVIDER' })));

    assert.deepEqual(opportunitiesRequest({ sort: '' }), opportunitiesRequest({}));
    assert.equal(opportunitiesRequest({ sort: 'closing' }).sort, 'closing');
    assert.notEqual(opportunitiesKey(opportunitiesRequest({ sort: 'closing' })), opportunitiesKey(opportunitiesRequest({})));

    assert.equal(membersKey(48, '', ''), membersKey(48));
    assert.notEqual(membersKey(48, '', 'name'), membersKey(48));
});
