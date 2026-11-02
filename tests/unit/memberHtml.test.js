import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keptStyle, keepsInput, MEMBER_TEXT, DOCUMENT } from '../../src/utils/memberHtml.js';

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

test('member text keeps a short list of tags and attributes: words, formatting, lists, links, alignment', () => {
    assert.deepEqual(new Set(MEMBER_TEXT.ALLOWED_TAGS), new Set([
        'p', 'div', 'span', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del',
        'a', 'ul', 'ol', 'li', 'blockquote', 'h2', 'h3', 'h4', 'code', 'pre',
    ]));
    assert.deepEqual(new Set(MEMBER_TEXT.ALLOWED_ATTR), new Set(['href', 'rel', 'style']));
    assert.equal(MEMBER_TEXT.ALLOW_DATA_ATTR, false);
    assert.equal(MEMBER_TEXT.ALLOW_ARIA_ATTR, false);
    assert.equal(MEMBER_TEXT.SANITIZE_NAMED_PROPS, true);
});

test('documents keep what member text does, and pictures, tables and task lists', () => {
    for (const tag of MEMBER_TEXT.ALLOWED_TAGS) assert.ok(DOCUMENT.ALLOWED_TAGS.includes(tag), tag);
    for (const attr of MEMBER_TEXT.ALLOWED_ATTR) assert.ok(DOCUMENT.ALLOWED_ATTR.includes(attr), attr);
    assert.deepEqual(
        DOCUMENT.ALLOWED_TAGS.filter((tag) => !MEMBER_TEXT.ALLOWED_TAGS.includes(tag)).sort(),
        ['h1', 'h5', 'h6', 'hr', 'img', 'input', 'table', 'tbody', 'td', 'th', 'thead', 'tr'],
    );
    assert.deepEqual(
        DOCUMENT.ALLOWED_ATTR.filter((attr) => !MEMBER_TEXT.ALLOWED_ATTR.includes(attr)).sort(),
        ['align', 'alt', 'checked', 'disabled', 'src', 'start', 'title', 'type'],
    );
    assert.equal(DOCUMENT.ALLOW_DATA_ATTR, false);
    assert.equal(DOCUMENT.SANITIZE_NAMED_PROPS, true);
});

test('of form controls a document keeps only a checkbox', () => {
    assert.equal(keepsInput('checkbox'), true);
    assert.equal(keepsInput('CHECKBOX'), true);
    for (const type of ['text', 'password', 'submit', 'file', '', null, undefined]) assert.equal(keepsInput(type), false, String(type));
});
