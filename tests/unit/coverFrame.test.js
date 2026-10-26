/**
 * Cover positions (src/utils/coverFrame.js): what's stored, where the page
 * draws the photo so the chosen part shows, and the positioning screen's
 * sums.
 *
 * Run: npm run test:unit   (node --test; no network)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    parseFrame, formatFrame, focusOf, placeFrame, leavesSpace,
    zoomRange, keepInOutline, frameFromCrop, cropFromFrame,
} from '../../src/utils/coverFrame.js';

const near = (actual, expected, label) => {
    for (const key of Object.keys(expected)) assert.ok(Math.abs(actual[key] - expected[key]) < 0.01, `${label || ''} ${key}: ${actual[key]} ≠ ${expected[key]}`);
};

test('a stored position reads back, and anything else reads as none', () => {
    assert.deepEqual(parseFrame('-80.5,0,261,100'), { x: -80.5, y: 0, w: 261, h: 100 });
    assert.deepEqual(parseFrame('0,5.25,100,37.5'), { x: 0, y: 5.25, w: 100, h: 37.5 });
    for (const bad of [undefined, null, '', '1,2,3', '0,0,0,50', '100,0,50,50', '-60,0,50,50', '1e2,0,5,5', 'a,b,c,d', '0,0,50,50;x']) {
        assert.equal(parseFrame(bad), null, String(bad));
    }
});

test('a position is stored with two decimals, inside what the server takes', () => {
    assert.equal(formatFrame({ x: -0.0001, y: 12.3456, w: 50, h: 31.25 }), '0,12.35,50,31.25');
    assert.equal(formatFrame({ x: -2500, y: 0, w: 4000, h: 100 }), '-1999.99,0,2000,100');
    assert.deepEqual(parseFrame(formatFrame({ x: -80.499, y: 0.001, w: 260.996, h: 100 })), { x: -80.5, y: 0, w: 261, h: 100 });
});

test('cards keep the chosen part in view', () => {
    assert.equal(focusOf(null), '50% 50%');
    assert.equal(focusOf({ x: 0, y: 0, w: 100, h: 40 }), '50% 20%');
    assert.equal(focusOf({ x: -80, y: 0, w: 260, h: 100 }), '50% 50%');
    assert.equal(focusOf({ x: 70, y: 80, w: 60, h: 60 }), '100% 100%');
});

test('in a box of the outline’s shape the page shows exactly the chosen part', () => {
    // A 1600×1000 photo, its top-left quarter chosen, in a 16:10 box.
    const place = placeFrame({ x: 0, y: 0, w: 50, h: 50 }, { width: 1600, height: 1000 }, { width: 400, height: 250 });
    near(place, { left: 0, top: 0, width: 800, height: 500 });
    assert.equal(leavesSpace(place, { width: 400, height: 250 }), false);
});

test('a flyer zoomed out to show all of it sits in the middle, with space either side', () => {
    // A portrait flyer (800×1000) in a 16:10 outline: the outline is 2× the flyer's width.
    const frame = { x: -50, y: 0, w: 200, h: 100 };
    const box = { width: 320, height: 200 };
    const place = placeFrame(frame, { width: 800, height: 1000 }, box);
    near(place, { left: 80, top: 0, width: 160, height: 200 });
    assert.equal(leavesSpace(place, box), true);
});

test('in a wider box the whole chosen part still shows, and the photo fills the space it can', () => {
    // The bottom strip of a 1000×1000 photo chosen at 2:1, shown in a 3:1 box.
    const frame = { x: 0, y: 50, w: 100, h: 50 };
    const box = { width: 300, height: 100 };
    const place = placeFrame(frame, { width: 1000, height: 1000 }, box);
    // Scaled so the chosen part's height fills the box: 200×200, centred across.
    near(place, { left: 50, top: -100, width: 200, height: 200 });
    // All of the chosen part (y 100–200 of the 200px photo) is in the box.
    assert.ok(place.top + 0.5 * place.height >= -0.01 && place.top + place.height <= box.height + 0.01);
});

test('the photo slides to leave no gap it could fill', () => {
    // The right edge of a wide photo chosen, in a box wider than the outline:
    // centred, the photo would end before the box does, so it slides right.
    const frame = { x: 75, y: 0, w: 25, h: 100 };
    const place = placeFrame(frame, { width: 2000, height: 500 }, { width: 400, height: 100 });
    assert.ok(Math.abs(place.left + place.width - 400) < 0.01);
    assert.equal(leavesSpace(place, { width: 400, height: 100 }), false);
});

test('the positioning screen turns a zoom and a move into a frame, and back', () => {
    const media = { width: 300, height: 400 }; // the photo fitted in the editor
    const outline = { width: 320, height: 200 };
    const { min, fill, max } = zoomRange(media, outline);
    near({ min, fill, max }, { min: 0.5, fill: 320 / 300, max: (320 / 300) * 4 });

    // Filling the outline, centred: the middle band of the photo, full width
    // (drawn 320×426.67, the outline's 200px is 46.875% of its height).
    near(frameFromCrop({ x: 0, y: 0 }, fill, media, outline), { x: 0, y: 26.5625, w: 100, h: 46.875 });
    // All of it: drawn 150×200, the photo's full height, centred across 320px.
    near(frameFromCrop({ x: 0, y: 0 }, min, media, outline), { x: -170 / 3, y: 0, w: 640 / 3, h: 100 });

    for (const [crop, zoom] of [[{ x: 0, y: 0 }, fill], [{ x: -6, y: 40 }, 1.5], [{ x: 30, y: 0 }, min]]) {
        const frame = frameFromCrop(crop, zoom, media, outline);
        const back = cropFromFrame(frame, media, outline);
        near({ zoom: back.zoom, ...back.crop }, { zoom, ...crop }, 'round trip');
    }
});

test('the positioning screen keeps the photo where it can be seen', () => {
    const media = { width: 300, height: 400 };
    const outline = { width: 320, height: 200 };
    // Filling the outline: no further than the photo's edges.
    const fill = 320 / 300;
    near(keepInOutline({ x: 500, y: -500 }, media, outline, fill), { x: 0, y: -(400 * fill - 200) / 2 });
    // Zoomed out: the photo stays inside the outline.
    near(keepInOutline({ x: 500, y: 0 }, media, outline, 0.5), { x: (320 - 150) / 2, y: 0 });
});
