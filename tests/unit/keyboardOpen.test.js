/**
 * Which focused fields bring up the on-screen keyboard (and hide the bottom
 * bar while it's up).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bringsKeyboard } from '../../src/hooks/useKeyboardOpen.js';

const input = (type, extra = {}) => ({ tagName: 'INPUT', type, ...extra });

test('typing fields bring up the keyboard', () => {
    for (const type of ['text', 'search', 'email', 'url', 'tel', 'number', 'password', 'TEXT', undefined]) {
        assert.equal(bringsKeyboard(input(type)), true, String(type));
    }
    assert.equal(bringsKeyboard({ tagName: 'TEXTAREA' }), true);
    assert.equal(bringsKeyboard({ tagName: 'DIV', isContentEditable: true }), true);
});

test('buttons, choices, pickers and files do not', () => {
    for (const type of ['checkbox', 'radio', 'range', 'file', 'button', 'submit', 'date', 'time', 'color']) {
        assert.equal(bringsKeyboard(input(type)), false, type);
    }
    assert.equal(bringsKeyboard({ tagName: 'SELECT' }), false);
    assert.equal(bringsKeyboard({ tagName: 'BUTTON' }), false);
    assert.equal(bringsKeyboard(null), false);
});

test('a field that cannot be typed into does not', () => {
    assert.equal(bringsKeyboard(input('text', { disabled: true })), false);
    assert.equal(bringsKeyboard(input('text', { readOnly: true })), false);
    assert.equal(bringsKeyboard({ tagName: 'TEXTAREA', readOnly: true }), false);
});
