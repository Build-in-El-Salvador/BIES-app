import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appPathFromUrl } from './appLinks.js';

const ORIGIN = 'https://app.buildinelsalvador.com';

test('a link to an app page becomes its route', () => {
    assert.equal(appPathFromUrl(`${ORIGIN}/farms/abc`, ORIGIN), '/farms/abc');
    assert.equal(appPathFromUrl(`${ORIGIN}/opportunities/42`, ORIGIN), '/opportunities/42');
    assert.equal(appPathFromUrl(`${ORIGIN}/feed?post=note1xyz`, ORIGIN), '/feed?post=note1xyz');
    assert.equal(appPathFromUrl(`${ORIGIN}/talents/7#videos`, ORIGIN), '/talents/7#videos');
    assert.equal(appPathFromUrl(`${ORIGIN}`, ORIGIN), '/');
});

test('links to other sites are not routed', () => {
    assert.equal(appPathFromUrl('https://evil.example/farms/abc', ORIGIN), null);
    assert.equal(appPathFromUrl('https://app.buildinelsalvador.com.evil.example/farms', ORIGIN), null);
    assert.equal(appPathFromUrl('http://app.buildinelsalvador.com/farms/abc', ORIGIN), null);
    assert.equal(appPathFromUrl('https://buildinelsalvador.com/events', ORIGIN), null);
});

test('missing or broken input is ignored', () => {
    assert.equal(appPathFromUrl('', ORIGIN), null);
    assert.equal(appPathFromUrl('not a url', ORIGIN), null);
    assert.equal(appPathFromUrl(`${ORIGIN}/farms/abc`, ''), null);
});
