/**
 * Small copies of public photos for lists: a member's photo in the Members
 * grid is 72px, but the photo itself is up to 1600px (mediaProcessing.ts).
 * The copy is 320px at most, as a JPEG, in uploads/public/t/ under the
 * original's name (storage.service.ts thumbFileName), so its address follows
 * from the photo's. The app asks for it and falls back to the photo when
 * there's none (src/utils/thumbnail.js).
 *
 * Only for this server's disk. Private files never get one: only public
 * photos, which anyone with the address can already see.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import { MAX_INPUT_PIXELS } from './mediaProcessing';
import { THUMB_DIR, thumbFileName, usesObjectStorage } from './storage.service';

export const THUMB_SIDE = 320;

/**
 * Make the small copy of a public photo, from its (already processed) bytes.
 * Never fails the caller: without a copy the app shows the photo itself.
 * @returns whether a copy was made
 */
export async function makeThumbnail(name: string, photo: Buffer): Promise<boolean> {
    const thumb = thumbFileName(name);
    if (!thumb || usesObjectStorage()) return false;
    const target = path.join(THUMB_DIR, thumb);
    // Written beside it, then renamed: a half-written file is never served.
    const part = `${target}.${crypto.randomBytes(4).toString('hex')}.part`;
    try {
        await sharp(photo, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS, animated: false })
            .resize({ width: THUMB_SIDE, height: THUMB_SIDE, fit: 'inside', withoutEnlargement: true })
            .flatten({ background: '#ffffff' })
            .jpeg({ quality: 78, mozjpeg: true })
            .toFile(part);
        await fs.promises.rename(part, target);
        return true;
    } catch (error) {
        fs.rm(part, { force: true }, () => {});
        console.warn(`[Thumbnails] No small copy of ${name}:`, (error as Error).message);
        return false;
    }
}
