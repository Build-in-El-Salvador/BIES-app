/**
 * What happens to an upload before it is stored (services/mediaProcessing.ts):
 * photos come out upright, at most 1600px a side, without their location
 * and camera details; phone videos lose their metadata boxes and keep
 * everything else; GIFs and WebM pass through once checked.
 */

import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { MAX_SIDE, prepareMedia, stripVideoMetadata, UnreadableMediaError } from '../services/mediaProcessing';

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

describe('videos', () => {
    it('lose their location and other metadata; nothing else moves', async () => {
        const input = phoneVideo();
        const out = await prepareMedia(Buffer.from(input), 'video/quicktime');
        expect(out.buffer.length).toBe(input.length);
        expect(out.buffer.includes(PLACE)).toBe(false);
        expect(out.buffer.includes('com.apple.quicktime.location')).toBe(false);
        for (const kept of ['ftyp', 'wide', 'moov', 'mvhd', 'trak', 'tkhd', 'mdat', 'the frames themselves']) {
            expect(out.buffer.indexOf(kept), kept).toBe(input.indexOf(kept));
        }
        const frees = out.buffer.toString('latin1').split('free').length - 1;
        expect(frees).toBe(4); // moov/udta, trak/meta, moov/meta, the XMP
    });

    it('a file that isn\'t a movie, or is cut short, is turned away', () => {
        expect(() => stripVideoMetadata(Buffer.from('just some text, no boxes'))).toThrow(UnreadableMediaError);
        const cut = phoneVideo().subarray(0, 60);
        expect(() => stripVideoMetadata(Buffer.from(cut))).toThrow(UnreadableMediaError);
        expect(() => stripVideoMetadata(box('ftyp', latin1('isom')))).toThrow(UnreadableMediaError); // no movie in it
    });

    it('WebM passes through', async () => {
        const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), latin1('rest of it')]);
        expect((await prepareMedia(webm, 'video/webm')).buffer.equals(webm)).toBe(true);
    });
});
