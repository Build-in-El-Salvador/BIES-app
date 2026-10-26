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
