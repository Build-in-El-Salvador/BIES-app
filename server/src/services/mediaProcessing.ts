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
 * Videos are made again, smaller, as an MP4 that every phone and browser
 * plays: at most 1280px a side (720p) and 30 frames a second, H.264 with AAC
 * sound, and none of the original's metadata (where and when, the phone). A
 * 19-second iPhone clip of 53 MB comes out at about 4 MB. HDR video, which
 * iPhones record, is brought to ordinary colour, or it would look washed
 * out. ffmpeg does it (in the server image), up to MAX_VIDEO_SECONDS long,
 * one video at a time. On request a still from the video comes back too,
 * a poster to show before it plays.
 *
 * A GIF can't hold a location: it's kept as it is, once checked to be one.
 */

import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';

/** The longest side of a stored photo, in pixels. */
export const MAX_SIDE = 1600;

// A small file can claim a huge picture (a PNG of one colour compresses to
// almost nothing), and decoding it takes memory by its pixels, not its bytes.
// 50 megapixels holds a 48-megapixel phone photo; anything bigger is refused.
// Photos are done one at a time and libvips keeps no cache, so a few uploads
// at once can't take the server past its memory limit.
export const MAX_INPUT_PIXELS = 50_000_000;
const MAX_GIF_BYTES = 15 * 1024 * 1024;
sharp.cache(false);

/** The longest side of a stored video, in pixels: 720p. */
export const VIDEO_MAX_SIDE = 1280;
/** The longest video kept, in seconds. */
export const MAX_VIDEO_SECONDS = 120;
// What a video sent may hold: frames up to 4K (phones record 4K at most, and
// decoding 4K takes ffmpeg about 360 MB), and as many frames as two minutes
// at 120 a second. A file of a few MB can claim far more of either.
export const MAX_VIDEO_PIXELS = 4096 * 2304;
const MAX_VIDEO_FRAMES = MAX_VIDEO_SECONDS * 120;
// A video taking longer than this to make is given up (ffmpeg stuck). A real
// one of 50 MB takes well under a minute.
const VIDEO_TIME_LIMIT_MS = 3 * 60_000;
// Read when used, so a test can point them elsewhere.
const ffmpeg = () => process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = () => process.env.FFPROBE_PATH || 'ffprobe';

/** Each task waits for the one before it to finish. */
function inTurn() {
    let queue: Promise<unknown> = Promise.resolve();
    return <T>(task: () => Promise<T>): Promise<T> => {
        const run = queue.then(task, task);
        queue = run.catch(() => undefined);
        return run;
    };
}
const onePhotoAtATime = inTurn();
// Apart from photos, so a photo needn't wait for a video. A 4K video takes
// ffmpeg about 360 MB; a 1080p one, half that.
const oneVideoAtATime = inTurn();

/** Not a photo or video we can read, whatever its type said. */
export class UnreadableMediaError extends Error {
    constructor(message = "That file isn't a photo or video we can read") {
        super(message);
        this.name = 'UnreadableMediaError';
    }
}

/** A video longer than MAX_VIDEO_SECONDS. */
export class VideoTooLongError extends Error {
    constructor(public seconds: number) {
        super(`Videos can be up to ${MAX_VIDEO_SECONDS / 60} minutes long`);
        this.name = 'VideoTooLongError';
    }
}

/** A video with bigger frames than 4K, or more of them than two minutes holds. */
export class VideoTooLargeError extends Error {
    constructor() {
        super('Videos can be up to 4K, at up to 120 frames a second');
        this.name = 'VideoTooLargeError';
    }
}

/** The member left before their video was made (MediaOptions.signal): it isn't made, or stops. */
export class MediaAbortedError extends Error {
    constructor() {
        super('The upload was left before the video was made');
        this.name = 'MediaAbortedError';
    }
}

/** ffmpeg couldn't be run, or was stopped: the server's problem, not the file's. */
export class MediaToolError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MediaToolError';
    }
}

export interface PreparedMedia {
    buffer: Buffer;
    mimeType: string;
    width?: number;
    height?: number;
    /** A video's length, in seconds. */
    duration?: number;
    /** A still from a video, when asked for. */
    poster?: PreparedMedia;
}

export interface MediaOptions {
    /** For a video: a still from it, to show before it plays. */
    poster?: boolean;
    /** Where a video waits while it's made (storage.service.ts PROCESSING_DIR). */
    workDir?: string;
    /** Aborted when the member leaves: a video still waiting isn't made, one being made stops. */
    signal?: AbortSignal;
}

const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export async function prepareMedia(input: Buffer, mimeType: string, options: MediaOptions = {}): Promise<PreparedMedia> {
    if (PHOTO_TYPES.has(mimeType)) return onePhotoAtATime(() => preparePhoto(input, mimeType));
    switch (mimeType) {
        case 'image/gif': {
            if (input.toString('latin1', 0, 4) !== 'GIF8') throw new UnreadableMediaError();
            // Kept as sent, so it's held to a size: 15 MB, and its frames
            // together no bigger than a photo may be.
            if (input.length > MAX_GIF_BYTES) throw new UnreadableMediaError();
            const { width, height, pageHeight } = await readMetadata(input);
            if (!width || !height || width * height > MAX_INPUT_PIXELS) throw new UnreadableMediaError();
            return { buffer: input, mimeType, width, height: pageHeight ?? height };
        }
        case 'video/mp4':
        case 'video/quicktime':
        case 'video/webm': {
            // Checked first; then it waits for its turn on disk, not in memory.
            const container = checkVideo(input, mimeType);
            const file = path.join(options.workDir ?? os.tmpdir(), `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.in`);
            await fs.promises.writeFile(file, input);
            try {
                return await oneVideoAtATime(() => prepareVideo(file, container, options));
            } finally {
                await fs.promises.rm(file, { force: true });
            }
        }
        default:
            throw new UnreadableMediaError();
    }
}

/**
 * A video an upload left on disk (upload.controller.ts), made in its turn
 * straight from the file, so it never waits in memory. The file stays the
 * caller's to delete.
 */
export async function prepareVideoFile(file: string, mimeType: string, options: MediaOptions = {}): Promise<PreparedMedia> {
    const container = checkVideo(await fs.promises.readFile(file), mimeType);
    return oneVideoAtATime(() => prepareVideo(file, container, options));
}

/**
 * The container a video was sent as, once checked to be one: an MP4 or
 * QuickTime movie's boxes are walked (stripVideoMetadata, on this copy), and
 * a WebM starts with the EBML header every Matroska file does.
 */
function checkVideo(input: Buffer, mimeType: string): Container {
    switch (mimeType) {
        case 'video/mp4':
        case 'video/quicktime':
            stripVideoMetadata(input);
            return 'mov';
        case 'video/webm':
            if (input.length < 4 || input.readUInt32BE(0) !== 0x1a45dfa3) throw new UnreadableMediaError();
            return 'matroska';
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

// ─── Videos ───────────────────────────────────────────────────────────────────

/**
 * ffmpeg reads a file as the container it was checked to be, never guessing
 * from its contents (a playlist, say), and only from local files: nothing a
 * file names elsewhere is fetched or opened.
 */
type Container = 'mov' | 'matroska';
const reading = (container: Container, file: string) => ['-protocol_whitelist', 'file', '-f', container, '-i', file];

/** The stored video (and its poster) made from the file sent, which is left as it is. */
async function prepareVideo(source: string, container: Container, { poster = false, workDir = os.tmpdir(), signal }: MediaOptions): Promise<PreparedMedia> {
    // They left while it waited for its turn: not made.
    if (signal?.aborted) throw new MediaAbortedError();
    const base = path.join(workDir, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`);
    const made = `${base}.mp4`;
    const still = `${base}.jpg`;
    try {
        const original = await probeVideo(source, container, signal);
        // A WebM a browser recorded may not say how long it is (NaN): it's cut at the limit instead (-t).
        if (original.duration > MAX_VIDEO_SECONDS + 1) throw new VideoTooLongError(original.duration);
        if (original.width * original.height > MAX_VIDEO_PIXELS || original.frames > MAX_VIDEO_FRAMES) throw new VideoTooLargeError();
        await run(ffmpeg(), videoArgs(source, container, made, original), signal);

        const buffer = await fs.promises.readFile(made);
        stripVideoMetadata(buffer); // all that's left is ffmpeg's name
        const video = await probeVideo(made, 'mov', signal);
        if (!(video.duration > 0)) throw new UnreadableMediaError();
        const result: PreparedMedia = { buffer, mimeType: 'video/mp4', width: video.width, height: video.height, duration: video.duration };
        if (poster) result.poster = await stillFrom(made, video, still, signal);
        return result;
    } finally {
        await Promise.all([made, still].map((file) => fs.promises.rm(file, { force: true })));
    }
}

/**
 * The poster: a frame a second in (half way through a shorter picture), else
 * the first frame. A video is still kept without one: the app shows a dark
 * tile with a play mark instead.
 */
async function stillFrom(made: string, video: VideoInfo, still: string, signal?: AbortSignal): Promise<PreparedMedia | undefined> {
    const at = Math.min(1, video.pictureDuration / 2);
    for (const seek of at > 0 ? [at, 0] : [0]) {
        try {
            await run(ffmpeg(), ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-ss', String(seek), ...reading('mov', made), '-frames:v', '1', '-q:v', '2', still], signal);
            return await preparePhoto(await fs.promises.readFile(still), 'image/jpeg');
        } catch (err) {
            if (err instanceof MediaAbortedError) throw err;
        }
    }
    console.warn('[media] no poster could be taken from a video');
    return undefined;
}

interface VideoInfo {
    width: number;
    height: number;
    /** Its length in seconds; NaN when the file doesn't say. */
    duration: number;
    /** How long the picture lasts, which can be less than the sound. */
    pictureDuration: number;
    /** How many frames: counted in the file, or worked out from its frame rate. */
    frames: number;
    /** The picture's transfer function: HLG and PQ are HDR. */
    transfer?: string;
}

async function probeVideo(file: string, container: Container, signal?: AbortSignal): Promise<VideoInfo> {
    // As ffmpeg reads it (reading() above); ffprobe takes the file without -i.
    const { stdout } = await run(ffprobe(), ['-v', 'error', '-protocol_whitelist', 'file', '-f', container, '-print_format', 'json', '-show_format', '-show_streams', file], signal);
    let info: any;
    try {
        info = JSON.parse(stdout);
    } catch {
        throw new UnreadableMediaError();
    }
    // The picture, not a cover image some files carry as a video stream.
    const picture = (info.streams ?? []).find((s: any) => s.codec_type === 'video' && !s.disposition?.attached_pic);
    if (!picture || !(picture.width > 0) || !(picture.height > 0)) throw new UnreadableMediaError();
    const duration = Number(info.format?.duration ?? picture.duration);
    const ownDuration = Number(picture.duration);
    const [per, second] = String(picture.avg_frame_rate || '0/0').split('/').map(Number);
    const counted = Number(picture.nb_frames);
    const frames = counted > 0 ? counted : (second > 0 ? per / second : 0) * (duration > 0 ? duration : 0);
    return {
        width: picture.width,
        height: picture.height,
        duration,
        pictureDuration: ownDuration > 0 ? ownDuration : duration,
        frames,
        transfer: picture.color_transfer,
    };
}

const HDR_TRANSFERS = new Set(['arib-std-b67', 'smpte2084']); // HLG (iPhones), PQ

/** ffmpeg's arguments to make the stored video from the original. */
function videoArgs(source: string, container: Container, out: string, original: VideoInfo): string[] {
    // Upright first (ffmpeg turns it as the phone said), then fitted inside
    // 1280x1280 without growing, with even sides as H.264 needs.
    const filters = [`scale=w='min(${VIDEO_MAX_SIDE},iw)':h='min(${VIDEO_MAX_SIDE},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`];
    const hdr = HDR_TRANSFERS.has(original.transfer ?? '');
    if (hdr) {
        // To linear light, tone-mapped into ordinary range, then BT.709 as phones and screens expect.
        filters.push(
            `zscale=tin=${original.transfer}:pin=bt2020:min=bt2020nc:t=linear:npl=100`,
            'format=gbrpf32le',
            'zscale=p=bt709',
            'tonemap=tonemap=hable:desat=0',
            'zscale=t=bt709:m=bt709:r=tv',
        );
    }
    filters.push('format=yuv420p');
    return [
        '-hide_banner', '-nostdin', '-v', 'error', '-y',
        '-threads', '2', ...reading(container, source),
        // The picture and the first sound; no metadata, chapters, subtitles or data tracks.
        '-map', '0:V:0', '-map', '0:a:0?', '-map_metadata', '-1', '-map_chapters', '-1', '-dn', '-sn',
        '-vf', filters.join(','),
        ...(hdr ? ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'] : []),
        '-fpsmax', '30',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-maxrate', '2M', '-bufsize', '4M', '-threads', '2',
        '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
        // Plays while it downloads.
        '-movflags', '+faststart',
        '-t', String(MAX_VIDEO_SECONDS),
        '-f', 'mp4', out,
    ];
}

/**
 * Run ffmpeg or ffprobe, at low priority, and as what goes first if the
 * server runs out of memory, so it's never the server. It gets none of the
 * server's settings (its secrets among them), only where programs are.
 * It ends badly: UnreadableMediaError; it can't run, or is stopped:
 * MediaToolError.
 */
function run(command: string, args: string[], signal?: AbortSignal): Promise<{ stdout: string }> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new MediaAbortedError());
        const env = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME ?? '/' };
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { if (stdout.length < 1_000_000) stdout += chunk; });
        child.stderr.on('data', (chunk) => { if (stderr.length < 10_000) stderr += chunk; });
        const timer = setTimeout(() => child.kill('SIGKILL'), VIDEO_TIME_LIMIT_MS);
        if (child.pid) {
            try { os.setPriority(child.pid, 10); } catch { /* not allowed here: it runs as it is */ }
            fs.writeFile(`/proc/${child.pid}/oom_score_adj`, '1000', () => { /* Linux only */ });
        }
        // 'close' can follow 'error': the first one says how it went.
        let settled = false;
        const settle = (outcome: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            outcome();
        };
        const name = path.basename(command);
        const stop = () => settle(() => {
            child.kill('SIGKILL');
            reject(new MediaAbortedError());
        });
        signal?.addEventListener('abort', stop, { once: true });
        child.on('exit', () => signal?.removeEventListener('abort', stop));
        child.on('error', (err) => settle(() => reject(new MediaToolError(`${name} can't run: ${err.message}`))));
        child.on('close', (code, signal) => settle(() => {
            if (code === 0) return resolve({ stdout });
            const said = stderr.trim().slice(-500);
            if (signal) return reject(new MediaToolError(`${name} stopped (${signal}): ${said}`));
            console.warn(`[media] ${name} couldn't read an upload: ${said}`);
            reject(new UnreadableMediaError());
        }));
    });
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
