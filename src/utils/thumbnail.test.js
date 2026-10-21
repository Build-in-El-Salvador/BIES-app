import { test } from 'node:test';
import assert from 'node:assert/strict';
import { thumbnailUrl } from './thumbnail.js';

const NAME = '1792420291927-941c97ef590adc592d0c4a0d7f575d56';

test('a BIES photo has a small copy beside it', () => {
    assert.equal(thumbnailUrl(`https://app.buildinelsalvador.com/uploads/public/${NAME}.webp`),
        `https://app.buildinelsalvador.com/uploads/public/t/${NAME}.jpg`);
    assert.equal(thumbnailUrl(`/uploads/public/${NAME}.png`), `/uploads/public/t/${NAME}.jpg`);
    assert.equal(thumbnailUrl(`/uploads/public/${NAME}.JPG`), `/uploads/public/t/${NAME}.jpg`);
});

test('anything else has none', () => {
    assert.equal(thumbnailUrl(`/uploads/public/${NAME}.mp4`), null);
    assert.equal(thumbnailUrl(`/uploads/public/t/${NAME}.jpg`), null);
    assert.equal(thumbnailUrl('https://blossom.primal.net/abc.jpg'), null);
    assert.equal(thumbnailUrl(`/uploads/private/${NAME}.jpg`), null);
    assert.equal(thumbnailUrl(''), null);
    assert.equal(thumbnailUrl(undefined), null);
});
