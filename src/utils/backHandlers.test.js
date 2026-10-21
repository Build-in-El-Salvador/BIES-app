import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addBackHandler, runBackHandler } from './backHandlers.js';

test('with nothing open, Back is left to the page', () => {
    assert.equal(runBackHandler(), false);
});

test('Back closes the newest open thing first', () => {
    const closed = [];
    const removeMenu = addBackHandler(() => closed.push('menu'));
    const removeSheet = addBackHandler(() => closed.push('sheet'));
    assert.equal(runBackHandler(), true);
    assert.deepEqual(closed, ['sheet']);
    removeSheet();
    assert.equal(runBackHandler(), true);
    assert.deepEqual(closed, ['sheet', 'menu']);
    removeMenu();
    assert.equal(runBackHandler(), false);
});

test('removing a handler twice removes nothing else', () => {
    const closed = [];
    const removeA = addBackHandler(() => closed.push('a'));
    const removeB = addBackHandler(() => closed.push('b'));
    removeB();
    removeB();
    runBackHandler();
    assert.deepEqual(closed, ['a']);
    removeA();
});
