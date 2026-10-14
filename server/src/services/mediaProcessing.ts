/**
 * Getting what members upload ready to keep (upload.controller.ts uploadMedia).
 *
 * Photos are turned upright, shrunk to fit MAX_SIDE, and saved again without
 * their metadata. A phone photo can carry where it was taken (GPS), when, and
 * the phone's make and model, which anyone with the link could read. A
 * 12-megapixel phone photo (4–5 MB) comes out at about 500 KB, so it loads
 * quickly on mobile data and the disk fills slowly; 1600px is still more
 * than a phone screen is wide.
 *
 * Videos are kept at their size. MP4 and QuickTime files, what phones record,
 * have their metadata boxes blanked, which takes out the location iPhones and
 * Android phones record. WebM, what browsers record, carries no location, and
 * a GIF can't hold one: both are kept as they are, once checked to be what
 * they say.
 */

import sharp from 'sharp';

/** The longest side of a stored photo, in pixels. */
export const MAX_SIDE = 1600;

// A small file can claim a huge picture (a PNG of one colour compresses to
// almost nothing), and decoding it takes memory by its pixels, not its bytes.
// 50 megapixels holds a 48-megapixel phone photo; anything bigger is refused.
// Photos are done one at a time and libvips keeps no cache, so a few uploads
// at once can't take the server past its memory limit.
export const MAX_INPUT_PIXELS = 50_000_000;
sharp.cache(false);

let photoQueue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
    const run = photoQueue.then(task, task);
    photoQueue = run.catch(() => undefined);
    return run;
}

/** Not a photo or video we can read, whatever its type said. */
export class UnreadableMediaError extends Error {
    constructor(message = "That file isn't a photo or video we can read") {
        super(message);
        this.name = 'UnreadableMediaError';
    }
}

export interface PreparedMedia {
    buffer: Buffer;
    mimeType: string;
    width?: number;
    height?: number;
}

const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export async function prepareMedia(input: Buffer, mimeType: string): Promise<PreparedMedia> {
    if (PHOTO_TYPES.has(mimeType)) return oneAtATime(() => preparePhoto(input, mimeType));
    switch (mimeType) {
        case 'image/gif': {
            if (input.toString('latin1', 0, 4) !== 'GIF8') throw new UnreadableMediaError();
            const { width, height, pageHeight } = await readMetadata(input);
            return { buffer: input, mimeType, width, height: pageHeight ?? height };
        }
        case 'video/mp4':
        case 'video/quicktime':
            stripVideoMetadata(input);
            return { buffer: input, mimeType };
        case 'video/webm':
            // The EBML header every Matroska/WebM file starts with.
            if (input.length < 4 || input.readUInt32BE(0) !== 0x1a45dfa3) throw new UnreadableMediaError();
            return { buffer: input, mimeType };
        default:
            throw new UnreadableMediaError();
    }
}

async function readMetadata(input: Buffer) {
    try {
        return await sharp(input).metadata();
    } catch {
        throw new UnreadableMediaError();
    }
}

async function preparePhoto(input: Buffer, mimeType: string): Promise<PreparedMedia> {
    // An animated WebP keeps its frames. 'error' rather than sharp's stricter
    // 'warning': phones write JPEGs that libjpeg warns about but reads fine.
    let pipeline = sharp(input, { autoOrient: true, animated: mimeType === 'image/webp', failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS })
        .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true });
    // Without withMetadata(), sharp writes no metadata and converts to sRGB.
    if (mimeType === 'image/png') pipeline = pipeline.png({ compressionLevel: 9 });
    else if (mimeType === 'image/webp') pipeline = pipeline.webp({ quality: 82 });
    else pipeline = pipeline.jpeg({ quality: 82, mozjpeg: true });
    try {
        const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
        return { buffer: data, mimeType, width: info.width, height: info.pageHeight ?? info.height };
    } catch {
        throw new UnreadableMediaError();
    }
}

// ─── Video metadata ───────────────────────────────────────────────────────────

// Where MP4 and QuickTime files keep metadata, as opposed to the media: user
// data (udta, where Android phones put the location as ©xyz) and metadata
// (meta, where iPhones put it, com.apple.quicktime.location.ISO6709), at the
// top, in the movie (moov) and in each track (trak). Plus XMP, which editors
// write in a uuid box with this id.
const METADATA_BOXES = new Set(['udta', 'meta']);
const CONTAINER_BOXES = new Set(['moov', 'trak']);
const XMP_UUID = 'be7acfcb97a942e89c71999491e3afac';

/**
 * Blank an MP4 or QuickTime file's metadata, in place. Each metadata box is
 * renamed `free` (padding, which players skip) and its contents zeroed, so
 * nothing moves: the offsets that point into the media stay right, and the
 * video plays as before. Throws UnreadableMediaError when the file isn't a
 * well-formed MP4 or QuickTime movie.
 */
export function stripVideoMetadata(buffer: Buffer): void {
    let movie = false;
    const walk = (start: number, end: number, depth: number) => {
        let pos = start;
        while (end - pos >= 8) {
            let size = buffer.readUInt32BE(pos);
            const type = buffer.toString('latin1', pos + 4, pos + 8);
            let header = 8;
            if (size === 1) {
                if (end - pos < 16) throw new UnreadableMediaError();
                const large = buffer.readBigUInt64BE(pos + 8);
                if (large > BigInt(end - pos)) throw new UnreadableMediaError();
                size = Number(large);
                header = 16;
            } else if (size === 0) {
                size = end - pos; // to the end of the file (or of its parent)
            }
            if (size < header || size > end - pos) throw new UnreadableMediaError();

            if (type === 'moov' && depth === 0) movie = true;
            const isXmp = type === 'uuid' && size >= header + 16
                && buffer.toString('hex', pos + header, pos + header + 16) === XMP_UUID;
            if (METADATA_BOXES.has(type) || isXmp) {
                buffer.write('free', pos + 4, 'latin1');
                buffer.fill(0, pos + header, pos + size);
            } else if (CONTAINER_BOXES.has(type) && depth < 2) {
                walk(pos + header, pos + size, depth + 1);
            }
            pos += size;
        }
        // Fewer than 8 bytes left over: padding some writers leave at the end.
    };
    walk(0, buffer.length, 0);
    if (!movie) throw new UnreadableMediaError();
}
