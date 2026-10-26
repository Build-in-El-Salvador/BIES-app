/**
 * How a cover photo shows on its page. When members add a cover they
 * position it (components/CoverFramer.jsx): the part of the photo inside the
 * outline is what the page shows, and the photo itself is kept whole, so
 * tapping the cover still opens all of it. That part is stored with the
 * cover as "x,y,w,h", each a percentage of the photo, x,y its top-left
 * corner (server/src/utils/coverFrame.ts checks it). Zoomed out past the
 * photo's edges, to show all of a flyer, it goes below 0 or past 100, and
 * the page fills the space around with a blurred copy (components/CoverPhoto.jsx).
 * Empty: the photo centred, as before.
 *
 * Pure module (no browser globals) so it runs under `node --test`.
 */

/** Each cover's shape on its page (width / height): the outline members position the photo in. */
export const COVER_ASPECT = {
    event: 16 / 10,
    listing: 16 / 9,
    talent: 16 / 9,
    opportunity: 16 / 9,
    // A member's banner: a strip about as wide as a phone (it stays 150px tall on wider screens).
    banner: 5 / 2,
};

const NUMBER = String.raw`-?\d{1,4}(?:\.\d{1,2})?`;
const FRAME = new RegExp(`^${NUMBER}(?:,${NUMBER}){3}$`);

/** A stored position as { x, y, w, h }, or null for none (or one that makes no sense). */
export function parseFrame(text) {
    if (typeof text !== 'string' || !FRAME.test(text)) return null;
    const [x, y, w, h] = text.split(',').map(Number);
    if (!(w > 0 && h > 0 && w <= 2000 && h <= 2000 && x < 100 && y < 100 && x + w > 0 && y + h > 0)) return null;
    return { x, y, w, h };
}

const round = (n) => Math.round(n * 100) / 100;
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

/** { x, y, w, h } as stored: two decimals at most, inside what the server takes. */
export function formatFrame({ x, y, w, h }) {
    const width = clamp(round(w), 0.01, 2000);
    const height = clamp(round(h), 0.01, 2000);
    const left = clamp(round(x), -1999.99, 99.99);
    const top = clamp(round(y), -1999.99, 99.99);
    return [left, top, width, height].map((n) => String(n === 0 ? 0 : n)).join(',');
}

/**
 * The CSS object-position that keeps the chosen part in view where the photo
 * is cropped to another shape (a card, a square thumbnail). Centred without one.
 */
export function focusOf(frame) {
    if (!frame) return '50% 50%';
    const cx = clamp(round(frame.x + frame.w / 2), 0, 100);
    const cy = clamp(round(frame.y + frame.h / 2), 0, 100);
    return `${cx}% ${cy}%`;
}

// On one axis: an image at least as big as the box leaves no gap at either
// edge; a smaller one stays inside the box.
function inBox(offset, size, box) {
    return size >= box ? clamp(offset, box - size, 0) : clamp(offset, 0, box - size);
}

/**
 * Where to draw the photo (px, in the box) so the chosen part shows. In a box
 * of the outline's shape that's exactly what the member saw. In another shape
 * the whole chosen part still shows, with more of the photo around it, and
 * the photo slides so it leaves no gap it could fill.
 * @param {{x:number,y:number,w:number,h:number}} frame
 * @param {{width:number,height:number}} natural - the photo's own size
 * @param {{width:number,height:number}} box
 */
export function placeFrame(frame, natural, box) {
    const scale = Math.min(box.width / ((frame.w / 100) * natural.width), box.height / ((frame.h / 100) * natural.height));
    const width = natural.width * scale;
    const height = natural.height * scale;
    const left = box.width / 2 - ((frame.x + frame.w / 2) / 100) * width;
    const top = box.height / 2 - ((frame.y + frame.h / 2) / 100) * height;
    return { left: inBox(left, width, box.width), top: inBox(top, height, box.height), width, height };
}

/** Whether a placed photo leaves space in the box (filled with a blurred copy). Half a pixel is no gap. */
export function leavesSpace(place, box) {
    return place.left > 0.5 || place.top > 0.5 || place.left + place.width < box.width - 0.5 || place.top + place.height < box.height - 0.5;
}

// ─── Positioning (CoverFramer) ────────────────────────────────────────────────
// react-easy-crop draws the photo at `zoom` times its size fitted in the
// editor (`media`), moved `crop` px from the centre, under an outline of
// `outline` px. These turn that into a frame and back.

/** The zooms between all of the photo inside the outline and four times filling it. */
export function zoomRange(media, outline) {
    const fit = Math.min(outline.width / media.width, outline.height / media.height);
    const fill = Math.max(outline.width / media.width, outline.height / media.height);
    return { min: fit, fill, max: fill * 4 };
}

/** A move kept so the photo never leaves a gap it could fill, nor slides out of the outline. */
export function keepInOutline(crop, media, outline, zoom) {
    const limit = (size, box) => Math.abs(size * zoom - box) / 2;
    const lx = limit(media.width, outline.width);
    const ly = limit(media.height, outline.height);
    return { x: clamp(crop.x, -lx, lx), y: clamp(crop.y, -ly, ly) };
}

/** The part of the photo inside the outline, in % (react-easy-crop's own sums, without its 0–100 limit). */
export function frameFromCrop(crop, zoom, media, outline) {
    return {
        x: (((media.width - outline.width / zoom) / 2 - crop.x / zoom) / media.width) * 100,
        y: (((media.height - outline.height / zoom) / 2 - crop.y / zoom) / media.height) * 100,
        w: (outline.width / (media.width * zoom)) * 100,
        h: (outline.height / (media.height * zoom)) * 100,
    };
}

/** The zoom and move that show this frame in the outline: frameFromCrop backwards. */
export function cropFromFrame(frame, media, outline) {
    const zoom = outline.width / (media.width * (frame.w / 100));
    return {
        zoom,
        crop: {
            x: (media.width * zoom - outline.width) / 2 - (frame.x / 100) * media.width * zoom,
            y: (media.height * zoom - outline.height) / 2 - (frame.y / 100) * media.height * zoom,
        },
    };
}
