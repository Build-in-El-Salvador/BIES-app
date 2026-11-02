/**
 * Edit profile → custom sections (src/utils/profileSections.js): a blank one
 * doesn't show on the profile as an empty box.
 *
 * Run: npm run test:unit   (node --test; no network)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { sectionHasContent } from '../../src/utils/profileSections.js';

test('a text section shows only when it has words', () => {
    assert.equal(sectionHasContent({ type: 'TEXT', title: 'About', body: '<p>Builder in El Zonte</p>' }), true);
    assert.equal(sectionHasContent({ title: '', body: 'Plain words, no type' }), true);
    assert.equal(sectionHasContent({ title: 'Old shape', content: 'From before body' }), true);
    assert.equal(sectionHasContent({ type: 'TEXT', body: '<p><img src="/uploads/a.jpg"></p>' }), true);
    // What the rich-text editor leaves behind when it's cleared.
    assert.equal(sectionHasContent({ type: 'TEXT', title: '', body: '<p></p>' }), false);
    assert.equal(sectionHasContent({ type: 'TEXT', title: '', body: '<p><br></p>' }), false);
    assert.equal(sectionHasContent({ type: 'TEXT', title: '', body: '<p>&nbsp; </p>' }), false);
    assert.equal(sectionHasContent({ type: 'TEXT', title: 'Heading only', body: '' }), false);
});

test('photo, photos and chart sections show only with what they show', () => {
    assert.equal(sectionHasContent({ type: 'PHOTO', imageUrl: '/uploads/a.jpg' }), true);
    assert.equal(sectionHasContent({ type: 'PHOTO', title: 'Me', imageUrl: '' }), false);
    assert.equal(sectionHasContent({ type: 'CAROUSEL', images: ['/uploads/a.jpg'] }), true);
    assert.equal(sectionHasContent({ type: 'CAROUSEL', images: [] }), false);
    assert.equal(sectionHasContent({ type: 'CAROUSEL', images: [''] }), false);
    assert.equal(sectionHasContent({ type: 'GRAPH', dataPoints: [{ label: 'Q1', value: 3 }] }), true);
    assert.equal(sectionHasContent({ type: 'GRAPH', title: 'Growth', dataPoints: [] }), false);
});

test('anything else is left out', () => {
    assert.equal(sectionHasContent(null), false);
    assert.equal(sectionHasContent('text'), false);
    assert.equal(sectionHasContent({ type: 'VIDEO', url: 'x' }), false);
});

test("a new chart's example point alone doesn't count", () => {
    assert.equal(sectionHasContent({ type: 'GRAPH', dataPoints: [{ label: 'Data 1', value: '100' }] }), false);
    assert.equal(sectionHasContent({ type: 'GRAPH', dataPoints: [{ label: 'Data 1', value: '100' }, { label: 'Q2', value: '4' }] }), true);
    assert.equal(sectionHasContent({ type: 'GRAPH', dataPoints: [{ label: 'Data 1', value: '250' }] }), true);
});
