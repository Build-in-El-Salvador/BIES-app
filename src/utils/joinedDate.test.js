import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinedDate } from './joinedDate.js';

test('the month and year they joined, in the app language', () => {
    assert.equal(joinedDate('2026-10-15T18:00:00.000Z', 'en'), 'October 2026');
    assert.equal(joinedDate('2026-10-15T18:00:00.000Z', 'es'), 'octubre de 2026');
});

test('nothing without a date', () => {
    assert.equal(joinedDate(undefined, 'en'), null);
    assert.equal(joinedDate('', 'en'), null);
    assert.equal(joinedDate('not a date', 'en'), null);
});
