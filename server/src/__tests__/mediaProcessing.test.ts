/**
 * What happens to an upload before it is stored (services/mediaProcessing.ts):
 * photos come out upright, at most 1600px a side, without their location
 * and camera details; videos are made again as a smaller 720p MP4 without
 * their metadata; GIFs pass through once checked.
 *
 * The video tests need ffmpeg (CI installs it; FFMPEG_PATH and FFPROBE_PATH
 * point elsewhere) and are skipped without it.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import {
    MAX_SIDE, MAX_VIDEO_SECONDS, MediaToolError, prepareMedia, stripVideoMetadata, UnreadableMediaError, VideoTooLongError,
} from '../services/mediaProcessing';
import { FFMPEG, FFPROBE, HAS_FFMPEG } from './helpers/videos';

const solid = (width: number, height: number, channels: 3 | 4 = 3) =>
    sharp({ create: { width, height, channels, background: { r: 120, g: 160, b: 80, alpha: 0.5 } } });

/** A phone photo: landscape pixels shown portrait (orientation 6), with GPS and camera details. */
const phonePhoto = () => solid(4000, 3000).jpeg()
    .withExif({
        IFD0: { Make: 'TestPhone', Model: 'X1' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '13/1 41/1 34/1', GPSMapDatum: 'WGS-84' },
    })
    .withMetadata({ orientation: 6 })
    .toBuffer();

describe('photos', () => {
    it('come out upright, shrunk to fit, and without location or camera details', async () => {
        const input = await phonePhoto();
        expect(input.includes('WGS-84')).toBe(true);

        const out = await prepareMedia(input, 'image/jpeg');
        expect(out.mimeType).toBe('image/jpeg');
        // Turned upright: what showed as 3000x4000, fitted into 1600.
        expect({ width: out.width, height: out.height }).toEqual({ width: 1200, height: MAX_SIDE });
        const meta = await sharp(out.buffer).metadata();
        expect({ width: meta.width, height: meta.height, format: meta.format }).toEqual({ width: 1200, height: 1600, format: 'jpeg' });
        expect(meta.exif).toBeUndefined();
        expect(meta.orientation).toBeUndefined();
        expect(out.buffer.includes('WGS-84')).toBe(false);
        expect(out.buffer.includes('TestPhone')).toBe(false);
        expect(out.buffer.length).toBeLessThan(input.length);
    });

    it('small photos keep their size; PNGs stay PNGs, transparency and all', async () => {
        const small = await prepareMedia(await solid(800, 600).jpeg().toBuffer(), 'image/jpeg');
        expect({ width: small.width, height: small.height }).toEqual({ width: 800, height: 600 });

        const png = await prepareMedia(await solid(3000, 1000, 4).png().toBuffer(), 'image/png');
        const meta = await sharp(png.buffer).metadata();
        expect({ format: meta.format, width: meta.width, height: meta.height, hasAlpha: meta.hasAlpha }).toEqual({ format: 'png', width: 1600, height: 533, hasAlpha: true });
        expect(png.mimeType).toBe('image/png');
    });

    it('WebP stays WebP', async () => {
        const out = await prepareMedia(await solid(2500, 2500).webp().toBuffer(), 'image/webp');
        expect(out.mimeType).toBe('image/webp');
        expect((await sharp(out.buffer).metadata()).format).toBe('webp');
        expect(out.width).toBe(1600);
    });

    it('a file that isn\'t the photo it says is turned away', async () => {
        await expect(prepareMedia(Buffer.from('<html><script>alert(1)</script></html>'), 'image/jpeg')).rejects.toBeInstanceOf(UnreadableMediaError);
        await expect(prepareMedia(Buffer.from('not a gif at all'), 'image/gif')).rejects.toBeInstanceOf(UnreadableMediaError);
        await expect(prepareMedia(Buffer.from('not webm'), 'video/webm')).rejects.toBeInstanceOf(UnreadableMediaError);
        await expect(prepareMedia(Buffer.from('%PDF-1.7'), 'application/pdf')).rejects.toBeInstanceOf(UnreadableMediaError);
    });

    it('GIFs are kept as they are', async () => {
        const gif = await solid(40, 30).gif().toBuffer();
        const out = await prepareMedia(gif, 'image/gif');
        expect(out.buffer.equals(gif)).toBe(true);
        expect({ width: out.width, height: out.height }).toEqual({ width: 40, height: 30 });
    });
});

// ─── Videos ───────────────────────────────────────────────────────────────────

const latin1 = (text: string) => Buffer.from(text, 'latin1');
function box(type: string, ...children: Buffer[]): Buffer {
    const body = Buffer.concat(children);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + body.length, 0);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, body]);
}
/** A box with a 64-bit size, as big media data uses. */
function largeBox(type: string, body: Buffer): Buffer {
    const head = Buffer.alloc(16);
    head.writeUInt32BE(1, 0);
    head.write(type, 4, 'latin1');
    head.writeBigUInt64BE(BigInt(16 + body.length), 8);
    return Buffer.concat([head, body]);
}

const PLACE = '+13.6929-089.2182/';
/** What phones record: Android's ©xyz in moov/udta, Apple's keys in moov/meta, and track metadata. */
const phoneVideo = () => Buffer.concat([
    box('ftyp', latin1('qt  '), Buffer.alloc(4), latin1('qt  ')),
    box('wide'),
    box('moov',
        box('mvhd', Buffer.alloc(100, 1)),
        box('udta', box('\xa9xyz', latin1(PLACE))),
        box('trak', box('tkhd', Buffer.alloc(84, 2)), box('meta', latin1(`hdlrmdta${PLACE}`))),
        box('meta', box('keys', latin1('mdtacom.apple.quicktime.location.ISO6709')), box('ilst', latin1(PLACE))),
    ),
    box('uuid', Buffer.from('be7acfcb97a942e89c71999491e3afac', 'hex'), latin1(`<x:xmpmeta>${PLACE}</x:xmpmeta>`)),
    largeBox('mdat', latin1('the frames themselves')),
]);

describe('video metadata boxes', () => {
    it('are blanked: the location and other metadata go, nothing else moves', () => {
        const input = phoneVideo();
        const out = Buffer.from(input);
        stripVideoMetadata(out);
        expect(out.length).toBe(input.length);
        expect(out.includes(PLACE)).toBe(false);
        expect(out.includes('com.apple.quicktime.location')).toBe(false);
        for (const kept of ['ftyp', 'wide', 'moov', 'mvhd', 'trak', 'tkhd', 'mdat', 'the frames themselves']) {
            expect(out.indexOf(kept), kept).toBe(input.indexOf(kept));
        }
        const frees = out.toString('latin1').split('free').length - 1;
        expect(frees).toBe(4); // moov/udta, trak/meta, moov/meta, the XMP
    });

    it('a file that isn\'t a movie, or is cut short, is turned away before ffmpeg sees it', async () => {
        expect(() => stripVideoMetadata(Buffer.from('just some text, no boxes'))).toThrow(UnreadableMediaError);
        const cut = phoneVideo().subarray(0, 60);
        expect(() => stripVideoMetadata(Buffer.from(cut))).toThrow(UnreadableMediaError);
        expect(() => stripVideoMetadata(box('ftyp', latin1('isom')))).toThrow(UnreadableMediaError); // no movie in it
        await expect(prepareMedia(Buffer.from('<html><script>alert(1)</script></html>'), 'video/mp4')).rejects.toBeInstanceOf(UnreadableMediaError);
        await expect(prepareMedia(latin1('not a WebM at all'), 'video/webm')).rejects.toBeInstanceOf(UnreadableMediaError);
    });

    it('without ffmpeg, a video fails as the server\'s problem, not the member\'s file', async () => {
        const before = process.env.FFPROBE_PATH;
        process.env.FFPROBE_PATH = path.join(os.tmpdir(), 'no-ffprobe-here');
        try {
            await expect(prepareMedia(phoneVideo(), 'video/quicktime')).rejects.toBeInstanceOf(MediaToolError);
        } finally {
            if (before === undefined) delete process.env.FFPROBE_PATH;
            else process.env.FFPROBE_PATH = before;
        }
    });
});

// ─── Videos, made again ───────────────────────────────────────────────────────

const scratch = (name: string) => path.join(os.tmpdir(), `bies-media-test-${process.pid}-${name}`);

/** A made-up clip from ffmpeg's test pattern; `remux` runs over it again (to turn it, say). */
function clip(name: string, args: string[], remux?: string[]): Buffer {
    const file = scratch(name);
    execFileSync(FFMPEG, ['-v', 'error', '-y', ...args, '-threads', '1', file]);
    if (remux) {
        const turned = scratch(`turned-${name}`);
        execFileSync(FFMPEG, ['-v', 'error', '-y', ...remux, '-i', file, '-c', 'copy', '-movflags', 'use_metadata_tags', turned]);
        fs.renameSync(turned, file);
    }
    const buffer = fs.readFileSync(file);
    fs.rmSync(file, { force: true });
    return buffer;
}

/** What ffprobe says of a stored video. */
function probe(buffer: Buffer): { streams: any[]; format: any } {
    const file = scratch('probe.mp4');
    fs.writeFileSync(file, buffer);
    try {
        return JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]).toString());
    } finally {
        fs.rmSync(file, { force: true });
    }
}
const pictureOf = (info: { streams: any[] }) => info.streams.find((s) => s.codec_type === 'video');
const PATTERN = (size: string, rate: number) => ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}`];
const TONE = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'];

/** An iPhone-like clip: bigger than 720p, 60 frames a second, shown portrait, with where and when it was taken. */
const phoneClip = () => clip('phone.mov',
    [...PATTERN('1600x900', 60), ...TONE, '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
        '-metadata', `location=${PLACE}`, '-metadata', 'com.apple.quicktime.make=TestPhone', '-metadata', 'title=Ana at the beach',
        '-metadata', 'creation_time=2026-01-02T03:04:05Z', '-movflags', 'use_metadata_tags', '-f', 'mov'],
    ['-display_rotation', '90']);

// ffmpeg makes each video: more than the usual 5 seconds on a busy machine.
describe.skipIf(!HAS_FFMPEG)('videos', { timeout: 60_000 }, () => {
    it('come out as a smaller 720p MP4, upright, at most 30 frames a second, without where or when they were taken', async () => {
        const input = phoneClip();
        expect(input.includes(PLACE)).toBe(true);
        expect(input.includes('TestPhone')).toBe(true);
        expect(input.includes('Ana at the beach')).toBe(true);

        const out = await prepareMedia(Buffer.from(input), 'video/quicktime');
        expect(out.mimeType).toBe('video/mp4');
        expect({ width: out.width, height: out.height }).toEqual({ width: 720, height: 1280 });
        expect(out.duration).toBeCloseTo(2, 0);
        expect(out.buffer.length).toBeLessThan(input.length);
        expect(out.buffer.includes(PLACE)).toBe(false);
        expect(out.buffer.includes('TestPhone')).toBe(false);
        expect(out.buffer.includes('Ana at the beach')).toBe(false);
        expect(out.poster).toBeUndefined();

        const info = probe(out.buffer);
        const picture = pictureOf(info);
        expect({ codec: picture.codec_name, width: picture.width, height: picture.height, pixels: picture.pix_fmt })
            .toEqual({ codec: 'h264', width: 720, height: 1280, pixels: 'yuv420p' });
        const [frames, per] = String(picture.r_frame_rate).split('/').map(Number);
        expect(frames / per).toBeLessThanOrEqual(30);
        // Turned already: nothing left for a player to turn.
        expect((picture.side_data_list ?? []).some((d: any) => d.side_data_type === 'Display Matrix')).toBe(false);
        expect(info.streams.some((s) => s.codec_type === 'audio' && s.codec_name === 'aac')).toBe(true);
        expect(info.format.tags?.location).toBeUndefined();
        expect(info.format.tags?.title).toBeUndefined();
        expect(info.format.tags?.creation_time).toBeUndefined(); // when it was filmed
    });

    it('a still from it comes too when asked for: a JPEG poster the size of the video', async () => {
        const out = await prepareMedia(phoneClip(), 'video/quicktime', { poster: true });
        expect(out.poster?.mimeType).toBe('image/jpeg');
        expect({ width: out.poster?.width, height: out.poster?.height }).toEqual({ width: 720, height: 1280 });
        const meta = await sharp(out.poster!.buffer).metadata();
        expect(meta.format).toBe('jpeg');
        expect(meta.exif).toBeUndefined();
    });

    it('HDR (HLG, what iPhones record) comes out in ordinary colour; a silent one stays silent', async () => {
        const hdr = clip('hdr.mp4', [...PATTERN('640x360', 30), '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
            '-vf', 'setparams=color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc', '-f', 'mp4']);
        expect(pictureOf(probe(hdr)).color_transfer).toBe('arib-std-b67');

        const info = probe((await prepareMedia(hdr, 'video/mp4')).buffer);
        const picture = pictureOf(info);
        expect({ transfer: picture.color_transfer, primaries: picture.color_primaries, pixels: picture.pix_fmt })
            .toEqual({ transfer: 'bt709', primaries: 'bt709', pixels: 'yuv420p' });
        expect(info.streams.some((s) => s.codec_type === 'audio')).toBe(false);
    });

    it('WebM, what browsers record, becomes an MP4 too; a small one keeps its size', async () => {
        const webm = clip('browser.webm', [...PATTERN('640x360', 30), ...TONE, '-t', '1',
            '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '500k', '-c:a', 'libopus', '-f', 'webm']);
        const out = await prepareMedia(webm, 'video/webm');
        expect(out.mimeType).toBe('video/mp4');
        expect({ width: out.width, height: out.height }).toEqual({ width: 640, height: 360 });
        expect(pictureOf(probe(out.buffer)).codec_name).toBe('h264');
    });

    it(`longer than ${MAX_VIDEO_SECONDS / 60} minutes is turned away`, async () => {
        const long = clip('long.mp4', ['-f', 'lavfi', '-i', 'color=c=gray:size=32x32:rate=1', '-t', String(MAX_VIDEO_SECONDS + 5),
            '-c:v', 'libx264', '-preset', 'ultrafast', '-f', 'mp4']);
        await expect(prepareMedia(long, 'video/mp4')).rejects.toBeInstanceOf(VideoTooLongError);
    });

    it('a movie with no picture in it is turned away', async () => {
        await expect(prepareMedia(phoneVideo(), 'video/quicktime')).rejects.toBeInstanceOf(UnreadableMediaError);
    });
});
