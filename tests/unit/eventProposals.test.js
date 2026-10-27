/**
 * Proposed meetups in words (src/utils/eventFormat.js): how many more one
 * needs, the default decide-by day, and where a tagged business's page is.
 *
 * Run: npm run test:unit   (node --test; no network)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dayBefore, fromFormFields, listingPath, proposalNeeds } from '../../src/utils/eventFormat.js';

test('a proposal needs what its number lacks, never less than none', () => {
    assert.equal(proposalNeeds({ minAttendees: 3, goingCount: 2 }), 1);
    assert.equal(proposalNeeds({ minAttendees: 3, goingCount: 5 }), 0);
    assert.equal(proposalNeeds({ minAttendees: 6 }), 6);
    assert.equal(proposalNeeds({}), 0);
});

test('decide-by defaults to the day before, across months and years', () => {
    assert.equal(dayBefore('2026-11-07'), '2026-11-06');
    assert.equal(dayBefore('2026-12-01'), '2026-11-30');
    assert.equal(dayBefore('2027-01-01'), '2026-12-31');
    assert.equal(dayBefore('2028-03-01'), '2028-02-29');
    assert.equal(dayBefore(''), '');
    assert.equal(dayBefore('7 Nov'), '');
});

test('noon on the day before is El Salvador noon', () => {
    assert.equal(fromFormFields(dayBefore('2026-11-07'), '12:00'), '2026-11-06T18:00:00.000Z');
});

test('a tagged business or farm opens its own page', () => {
    assert.equal(listingPath({ id: 'abc', type: 'PROVIDER' }), '/trusted/abc');
    assert.equal(listingPath({ id: 'xyz', type: 'FARM' }), '/farms/xyz');
});
