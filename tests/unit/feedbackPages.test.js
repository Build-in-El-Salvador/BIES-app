/**
 * Report / Feedback's page list (src/config/feedbackPages.js): the form
 * starts on the page a member came from, and every page has a name in both
 * languages.
 *
 * Run: npm run test:unit   (node --test; no network)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FEEDBACK_PAGES, FEEDBACK_PAGE_IDS, pageFromPath } from '../../src/config/feedbackPages.js';
import { rememberPage, lastPage } from '../../src/utils/lastPage.js';

const locale = (lang) => JSON.parse(readFileSync(new URL(`../../src/i18n/locales/${lang}.json`, import.meta.url), 'utf8'));

test('a path is part of the page it starts with', () => {
    assert.equal(pageFromPath('/farms'), 'farms');
    assert.equal(pageFromPath('/farms/abc123/edit'), 'farms');
    assert.equal(pageFromPath('/trusted/new'), 'trusted');
    assert.equal(pageFromPath('/talents/t1'), 'talent');
    assert.equal(pageFromPath('/opportunities/o1/edit'), 'opportunities');
    assert.equal(pageFromPath('/members/u1/followers'), 'members');
    assert.equal(pageFromPath('/builder/u1'), 'members');
    assert.equal(pageFromPath('/albums/a1'), 'profile');
    assert.equal(pageFromPath('/settings/notifications'), 'settings');
    assert.equal(pageFromPath('/join/CODE'), 'signin');
});

test('the longest path wins', () => {
    assert.equal(pageFromPath('/discover'), 'members');
    assert.equal(pageFromPath('/discover/farms/x'), 'farms');
    assert.equal(pageFromPath('/discover/certified/x'), 'trusted');
});

test('only whole parts of a path match', () => {
    assert.equal(pageFromPath('/farmsville'), '');
    assert.equal(pageFromPath('/profile-setup'), '');
    assert.equal(pageFromPath('/homepage'), '');
});

test('a path that is no page, or none, is no page', () => {
    assert.equal(pageFromPath('/'), '');
    assert.equal(pageFromPath('/admin/feedback'), '');
    assert.equal(pageFromPath(''), '');
    assert.equal(pageFromPath(undefined), '');
});

test('ids are of the shape the server takes, and none repeats', () => {
    for (const id of FEEDBACK_PAGE_IDS) assert.match(id, /^[a-z][a-z-]{0,39}$/);
    assert.equal(new Set(FEEDBACK_PAGE_IDS).size, FEEDBACK_PAGE_IDS.length);
    assert.equal(FEEDBACK_PAGES.at(-1).id, 'other');
});

test('every page has a name in English and Spanish', () => {
    for (const lang of ['en', 'es']) {
        const names = locale(lang).feedback.pages;
        for (const id of FEEDBACK_PAGE_IDS) assert.ok(names[id], `${lang}: feedback.pages.${id}`);
    }
});

test('the page before Report / Feedback is the one remembered', () => {
    rememberPage('/farms/f1');
    rememberPage('/feedback');
    assert.equal(lastPage(), '/farms/f1');
    rememberPage('/talents');
    assert.equal(lastPage(), '/talents');
});
