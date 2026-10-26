/**
 * BIES Talents' lists and helpers (src/components/talent/talentOptions.js):
 * the app's lists and limits match the server's, a work's videos show their
 * poster, and a talent's cover falls back to the first picture of its proof
 * of work.
 *
 * Run: npm run test:unit   (node --test; no network)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    TALENT_CATEGORIES, WORK_TYPES, MAX_TALENTS, MAX_WORKS, MAX_WORK_MEDIA, MAX_VIDEO_SECONDS,
    coverOf, isVideo, mediaOf, pictureOf, workMedia, asWebLink, shortLink,
} from '../../src/components/talent/talentOptions.js';

const read = (file) => readFileSync(new URL(`../../server/src/${file}`, import.meta.url), 'utf8');
const server = read('controllers/talent.controller.ts');
const serverList = (name) => {
    const body = server.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\]`))[1];
    return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
};
const numberIn = (source, name) => Number(source.match(new RegExp(`export const ${name} = (\\d+);`))[1]);

test("the app's lists and limits are the server's", () => {
    assert.deepEqual(TALENT_CATEGORIES, serverList('TALENT_CATEGORIES'));
    assert.deepEqual(WORK_TYPES, serverList('WORK_TYPES'));
    assert.equal(MAX_TALENTS, numberIn(server, 'MAX_TALENTS_PER_MEMBER'));
    assert.equal(MAX_WORKS, numberIn(server, 'MAX_WORKS'));
    assert.equal(MAX_WORK_MEDIA, numberIn(server, 'MAX_WORK_MEDIA'));
    assert.equal(MAX_VIDEO_SECONDS, numberIn(read('services/mediaProcessing.ts'), 'MAX_VIDEO_SECONDS'));
});

const video = { url: '/uploads/public/1760000000000-aa.mp4', poster: '/uploads/public/1760000000000-ab.jpg' };

test("a video shows its poster; a photo, itself", () => {
    assert.equal(isVideo(video.url), true);
    assert.equal(isVideo('https://app.example/uploads/public/clip.MOV?x=1'), true);
    assert.equal(isVideo('/uploads/public/a.jpg'), false);
    assert.equal(pictureOf(video), video.poster);
    assert.equal(pictureOf({ url: video.url }), '');
    assert.equal(pictureOf({ url: '/uploads/public/a.jpg' }), '/uploads/public/a.jpg');
    assert.deepEqual(mediaOf({ media: [null, { url: '' }, video] }), [video]);
    assert.deepEqual(mediaOf({ title: 'Essay' }), []);
});

test('the cover is the photo chosen, else the first picture of the work', () => {
    const works = [
        { title: 'Logo', media: [] },
        { title: 'Launch film', media: [{ url: '/uploads/public/no-poster.mp4' }, video, { url: '/uploads/public/b.jpg' }] },
    ];
    assert.equal(coverOf({ photo: '/uploads/public/cover.jpg', works }), '/uploads/public/cover.jpg');
    assert.equal(coverOf({ photo: '', works }), video.poster);
    assert.equal(coverOf({ works: [{ title: 'Essay' }] }), '');
    assert.equal(coverOf(null), '');
    assert.deepEqual(workMedia({ works }).map((m) => m.url), ['/uploads/public/no-poster.mp4', video.url, '/uploads/public/b.jpg']);
});

test('links typed without https get it', () => {
    assert.equal(asWebLink(' example.com/portfolio '), 'https://example.com/portfolio');
    assert.equal(asWebLink('http://example.com'), 'http://example.com');
    // Another scheme is kept as typed (the server says if it can't be a link), never https://ftp://….
    assert.equal(asWebLink('ftp://files.example.com'), 'ftp://files.example.com');
    assert.equal(asWebLink(''), '');
    assert.equal(asWebLink('javascript://example.com/%0Aalert(1)'), '');
    assert.equal(asWebLink('JavaScript://x'), '');
    assert.equal(shortLink('https://www.example.com/work/'), 'example.com/work');
});
