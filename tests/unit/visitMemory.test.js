/**
 * What a list page was showing on each visit (src/utils/visitMemory.js), for
 * hooks/useVisitState.js: Back to a visit finds its search and filters as they
 * were; a new visit starts from the page's defaults.
 *
 * Run: npm run test:unit   (node --test; no network)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { clearVisits, keepVisitValue, visitValue } from '../../src/utils/visitMemory.js';

test('a visit gets back what it kept; another visit starts afresh', () => {
    clearVisits();
    keepVisitValue('visit-1', 'directory.category', 'food');
    keepVisitValue('visit-1', 'directory.search', 'café');
    assert.equal(visitValue('visit-1', 'directory.category', ''), 'food');
    assert.equal(visitValue('visit-1', 'directory.search', ''), 'café');
    assert.equal(visitValue('visit-2', 'directory.category', ''), '');
    assert.deepEqual(visitValue('visit-2', 'directory.practices', () => []), []);
});

test('false and empty values count as kept', () => {
    clearVisits();
    keepVisitValue('v', 'directory.filtersOpen', false);
    assert.equal(visitValue('v', 'directory.filtersOpen', true), false);
});

test('only the newest 50 visits are kept, and sign-out forgets them all', () => {
    clearVisits();
    for (let i = 0; i < 51; i++) keepVisitValue(`v${i}`, 'q', `search ${i}`);
    assert.equal(visitValue('v0', 'q', ''), '');
    assert.equal(visitValue('v50', 'q', ''), 'search 50');
    // Kept again: it becomes the newest, so it outlasts the others.
    keepVisitValue('v1', 'q', 'again');
    for (let i = 51; i < 99; i++) keepVisitValue(`v${i}`, 'q', 'x');
    assert.equal(visitValue('v1', 'q', ''), 'again');
    clearVisits();
    assert.equal(visitValue('v50', 'q', ''), '');
});
