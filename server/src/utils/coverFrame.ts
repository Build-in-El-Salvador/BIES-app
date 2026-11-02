/**
 * How a cover photo shows on its page: the part of the photo its member
 * chose when they positioned it, as "x,y,w,h", each a percentage of the
 * photo (x,y its top-left corner). Below 0 or past 100 when they zoomed out
 * past the photo's edges to show all of it. Empty: the photo centred, as it
 * was before. The app draws it (src/utils/coverFrame.js); the photo itself is
 * stored whole, so tapping a cover still opens all of it.
 */

import { z } from 'zod';

const NUMBER = String.raw`-?\d{1,4}(?:\.\d{1,2})?`;
const FRAME = new RegExp(`^${NUMBER}(?:,${NUMBER}){3}$`);

/** "x,y,w,h" with a size and a part of the photo inside it. */
export function isCoverFrame(text: string): boolean {
    if (!FRAME.test(text)) return false;
    const [x, y, w, h] = text.split(',').map(Number);
    return w > 0 && h > 0 && w <= 2000 && h <= 2000 && x < 100 && y < 100 && x + w > 0 && y + h > 0;
}

export const coverFrameSchema = z.string().max(40).refine((text) => text === '' || isCoverFrame(text), 'Not a cover position');

/**
 * A new cover sent without its own framing starts centred: the old photo's
 * framing doesn't fit it. (An app from before framing sends the photo alone.)
 */
export function frameNewCover(data: Record<string, unknown>, cover: string, oldCover: string | null | undefined): void {
    if (data[cover] !== undefined && data[cover] !== (oldCover ?? '') && data.coverFrame === undefined) data.coverFrame = '';
}

export interface Frame { x: number; y: number; w: number; h: number }
export interface Size { width: number; height: number }

/** A stored position as { x, y, w, h }, or null for none (or one that makes no sense). */
export function parseFrame(text: string | null | undefined): Frame | null {
    if (typeof text !== 'string' || !isCoverFrame(text)) return null;
    const [x, y, w, h] = text.split(',').map(Number);
    return { x, y, w, h };
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

// On one axis: an image at least as big as the box leaves no gap at either
// edge; a smaller one stays inside the box.
function inBox(offset: number, size: number, box: number): number {
    return size >= box ? clamp(offset, box - size, 0) : clamp(offset, 0, box - size);
}

/**
 * Where to draw the photo (px, in the box) so the chosen part shows, as the
 * app's placeFrame (src/utils/coverFrame.js) does: in a box of the outline's
 * shape exactly what the member saw; in another shape all of the chosen part,
 * with more of the photo around it.
 */
export function placeFrame(frame: Frame, natural: Size, box: Size): { left: number; top: number; width: number; height: number } {
    const scale = Math.min(box.width / ((frame.w / 100) * natural.width), box.height / ((frame.h / 100) * natural.height));
    const width = natural.width * scale;
    const height = natural.height * scale;
    const left = box.width / 2 - ((frame.x + frame.w / 2) / 100) * width;
    const top = box.height / 2 - ((frame.y + frame.h / 2) / 100) * height;
    return { left: inBox(left, width, box.width), top: inBox(top, height, box.height), width, height };
}

/** The photo centred and cropped to fill the box: how a cover without a position shows. */
export function fillBox(natural: Size, box: Size): { left: number; top: number; width: number; height: number } {
    const scale = Math.max(box.width / natural.width, box.height / natural.height);
    const width = natural.width * scale;
    const height = natural.height * scale;
    return { left: (box.width - width) / 2, top: (box.height - height) / 2, width, height };
}

/** Whether a placed photo leaves space in the box (filled with a blurred copy). Half a pixel is no gap. */
export function leavesSpace(place: { left: number; top: number; width: number; height: number }, box: Size): boolean {
    return place.left > 0.5 || place.top > 0.5 || place.left + place.width < box.width - 0.5 || place.top + place.height < box.height - 0.5;
}
