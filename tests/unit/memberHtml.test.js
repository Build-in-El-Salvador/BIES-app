import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keptStyle } from '../../src/utils/memberHtml.js';

test("a member's text keeps its alignment and no other inline style", () => {
    assert.equal(keptStyle('text-align: center;'), 'text-align: center');
    assert.equal(keptStyle('color: red; text-align: RIGHT'), 'text-align: right');
    assert.equal(keptStyle('text-align:justify;font-weight:bold'), 'text-align: justify');
    assert.equal(keptStyle('color: red'), '');
    assert.equal(keptStyle('font-size: 40px; background: yellow'), '');
    assert.equal(keptStyle('text-align: center url(x)'), '');
    assert.equal(keptStyle(''), '');
    assert.equal(keptStyle(undefined), '');
});
