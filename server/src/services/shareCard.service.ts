/**
 * The picture a shared event link shows in WhatsApp, iMessage and the like
 * (its og:image), drawn here so every event posted in a group looks alike.
 *
 * - A BIES event: its cover as it is, square, the way the team's posters
 *   look. Nothing is written on it: the poster has its own words.
 * - Any other event, or a proposed meetup: a smaller, wide card after the
 *   BIES posters. The logo, what kind of event it is, its name, when and
 *   where sit on the dark left; the cover fills the right, fading into it.
 *   No cover: the same words on navy, with the orange ring.
 *
 * The cover shows as its host positioned it for the preview (events.share_frame,
 * square or the card's photo side, src/utils/coverFrame.js COVER_ASPECT), or
 * else as it shows on its page. Words are drawn as shapes from the fonts in
 * server/assets/fonts, so the server needs no fonts of its own. A card is
 * kept in uploads/cards, named after everything on it, and drawn again only
 * when that changes.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import opentype from 'opentype.js';
import { MAX_INPUT_PIXELS } from './mediaProcessing';
import { CARD_DIR, PUBLIC_DIR, usesObjectStorage } from './storage.service';
import { uploadNameOf } from './uploads.service';
import { fillBox, leavesSpace, parseFrame, placeFrame, type Size } from '../utils/coverFrame';
import { OUTBOUND_HEADERS, safeGet } from '../utils/safeFetch';

/** Raised when the card's design changes, so every card is drawn again. */
export const CARD_VERSION = 1;

/** A BIES event's poster, and every other event's card (WhatsApp shows them at the bubble's width). */
export const SQUARE: Size = { width: 1080, height: 1080 };
export const WIDE: Size = { width: 1200, height: 630 };
/** The cover's side of the wide card: its right two thirds. */
export const PHOTO_LEFT = 408;
export const PHOTO_BOX: Size = { width: WIDE.width - PHOTO_LEFT, height: WIDE.height };

const NIGHT = '#0B0E18';
const WHITE = '#FFFFFF';
const GOLD = '#F6CE85';
const ORANGE = '#FF5B00';

// server/assets, beside src/; in the image, beside dist/src (Dockerfile). A
// dist/ built and run here finds it one folder further up.
const ASSETS = [path.join(__dirname, '..', '..', 'assets'), path.join(__dirname, '..', '..', '..', 'assets')]
    .find((dir) => fs.existsSync(path.join(dir, 'fonts'))) ?? path.join(__dirname, '..', '..', 'assets');

export interface CardSpec {
    format: 'square' | 'wide';
    /** What kind of event, on a community card: none on a BIES event's. */
    label: '' | 'community' | 'proposed';
    title: string;
    /** "Saturday, November 7 · 8 AM" */
    date: string;
    venue: string;
    /** How it repeats, or what a proposed meetup needs. */
    extra: string;
    cover: string;
    frame: string;
}

/** What the card for an event shows, from its public preview (preview.controller.ts eventTeaser). */
export function shareCardSpec(event: {
    isOfficial: boolean; stage?: string | null; minAttendees?: number | null; name: string; startDate: Date | string;
    location: string; repeat?: string; repeatText?: string; photo: string; shareFrame?: string; coverFrame?: string;
}): CardSpec {
    const proposed = event.stage === 'proposed';
    const cover = event.photo || '';
    return {
        format: event.isOfficial ? 'square' : 'wide',
        label: event.isOfficial ? '' : proposed ? 'proposed' : 'community',
        title: event.name.trim(),
        date: cardDate(event.startDate),
        venue: (event.location || '').trim(),
        extra: proposed && event.minAttendees ? `Goes ahead with ${event.minAttendees} people` : event.repeatText || '',
        cover,
        frame: cover ? (event.shareFrame || event.coverFrame || '') : '',
    };
}

/** When it starts, in El Salvador, the way the BIES posters say it: "Saturday, November 7 · 8 AM". */
export function cardDate(date: Date | string): string {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/El_Salvador', weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }).formatToParts(new Date(date)).map((p) => [p.type, p.value]));
    const time = parts.minute === '00' ? `${parts.hour} ${parts.dayPeriod}` : `${parts.hour}:${parts.minute} ${parts.dayPeriod}`;
    return `${parts.weekday}, ${parts.month} ${parts.day} · ${time}`;
}

/** The card's name: changes with anything on it. */
export function cardKey(spec: CardSpec): string {
    return crypto.createHash('sha256').update(JSON.stringify({ v: CARD_VERSION, ...spec })).digest('hex').slice(0, 16);
}

// ─── Words as shapes ──────────────────────────────────────────────────────────

type Font = opentype.Font;
let fonts: { serif: Font; semi: Font; bold: Font } | null = null;
let logo: string | null = null;

function loadFonts() {
    if (!fonts) {
        const read = (file: string) => {
            const bytes = fs.readFileSync(path.join(ASSETS, 'fonts', file));
            return opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        };
        fonts = { serif: read('DMSerifDisplay-Regular.ttf'), semi: read('Inter-SemiBold.otf'), bold: read('Inter-ExtraBold.otf') };
    }
    return fonts;
}

/** The white BIES logo's shapes (viewBox 0 0 1080 412), its class turned into a fill. */
function logoShapes(): string {
    if (logo === null) {
        const svg = fs.readFileSync(path.join(ASSETS, 'share', 'bies-logo-white.svg'), 'utf8');
        logo = svg
            .replace(/^[\s\S]*?<svg[^>]*>/, '')
            .replace(/<\/svg>\s*$/, '')
            .replace(/<defs>[\s\S]*?<\/defs>/, '')
            .replace(/class="cls-1"/g, 'fill="#F9F5F4"');
    }
    return logo;
}

// letterSpacing is in em; opentype.js adds it after every letter, the last too.
const OPTIONS = (letterSpacing = 0) => ({ kerning: true, letterSpacing } as opentype.RenderOptions);

export function textWidth(font: Font, text: string, size: number, letterSpacing = 0): number {
    return font.getAdvanceWidth(text, size, OPTIONS(letterSpacing)) - (text ? letterSpacing * size : 0);
}

function shape(font: Font, text: string, x: number, baseline: number, size: number, fill: string, letterSpacing = 0, opacity = 1): string {
    const d = font.getPath(text, x, baseline, size, OPTIONS(letterSpacing)).toPathData(2);
    return d ? `<path d="${d}" fill="${fill}"${opacity < 1 ? ` fill-opacity="${opacity}"` : ''}/>` : '';
}

/** The text cut to fit the width, with … where it's cut: after a whole word when one fits. */
export function fitLine(font: Font, text: string, size: number, maxWidth: number, letterSpacing = 0): string {
    if (textWidth(font, text, size, letterSpacing) <= maxWidth) return text;
    const fits = (t: string) => textWidth(font, `${t}…`, size, letterSpacing) <= maxWidth;
    const words = text.replace(/…$/, '').split(' ');
    for (let n = words.length - 1; n > 0; n--) {
        const t = words.slice(0, n).join(' ').replace(/[\s,.;:–-]+$/, '');
        if (fits(t)) return `${t}…`;
    }
    let cut = text.length;
    while (cut > 1 && !fits(text.slice(0, cut).trimEnd())) cut--;
    return `${text.slice(0, cut).trimEnd()}…`;
}

/** The largest size from `max` down to `min` at which the text fits on its line. */
function sizeToFit(font: Font, text: string, max: number, min: number, maxWidth: number, letterSpacing = 0): number {
    for (let size = max; size > min; size -= 1) if (textWidth(font, text, size, letterSpacing) <= maxWidth) return size;
    return min;
}

/** The words in lines of at most `maxWidth`; `overflow` when they need more than `maxLines`. */
export function wrapLines(font: Font, text: string, size: number, maxWidth: number, maxLines: number): { lines: string[]; overflow: boolean } {
    const lines: string[] = [];
    let line = '';
    const words = text.split(/\s+/).filter(Boolean);
    for (const word of words) {
        const longer = line ? `${line} ${word}` : word;
        if (textWidth(font, longer, size) <= maxWidth) { line = longer; continue; }
        if (line) lines.push(line);
        // A word wider than a line on its own is broken where it reaches the edge.
        let rest = word;
        while (textWidth(font, rest, size) > maxWidth && rest.length > 1) {
            let cut = rest.length - 1;
            while (cut > 1 && textWidth(font, rest.slice(0, cut), size) > maxWidth) cut--;
            lines.push(rest.slice(0, cut));
            rest = rest.slice(cut);
        }
        line = rest;
    }
    if (line) lines.push(line);
    return lines.length > maxLines ? { lines: lines.slice(0, maxLines), overflow: true } : { lines, overflow: false };
}

/** The title at the largest size that fits its lines, else the smallest with … on its last line. */
function fitTitle(font: Font, text: string, max: number, min: number, maxWidth: number, maxLines: number) {
    for (let size = max; size >= min; size -= 3) {
        const { lines, overflow } = wrapLines(font, text, size, maxWidth, maxLines);
        if (!overflow) return { size, lines };
    }
    const { lines } = wrapLines(font, text, min, maxWidth, maxLines + 1);
    const last = lines.slice(maxLines - 1).join(' ');
    return { size: min, lines: [...lines.slice(0, maxLines - 1), fitLine(font, `${last} …`, min, maxWidth)] };
}

/**
 * Sizes in px: the wide card's, and the square one's (a BIES event with no
 * poster). WhatsApp shows the wide card about a quarter of this size, so
 * nothing is smaller than 22px. The name and place keep to the dark side
 * (`maxWidth`); the date and the line under it may run a little further.
 */
const LAYOUT = {
    wide: {
        x: 60, maxWidth: 560, smallWidth: 660, logo: 62, label: 19, labelPad: [14, 10], labelGap: 24, topGap: 34,
        title: [89, 60], titleLines: 2, ruleGap: 24, rule: [360, 2], date: [26, 22], venueGap: 14, venue: [54, 38], extraGap: 20, extra: [22, 18], border: 2,
        ring: { cx: 1044, cy: 546, r: 263, width: 26 },
    },
    square: {
        x: 86, maxWidth: 860, smallWidth: 900, logo: 88, label: 26, labelPad: [20, 13], labelGap: 34, topGap: 54,
        title: [130, 84], titleLines: 3, ruleGap: 37, rule: [475, 2.5], date: [36, 28], venueGap: 20, venue: [76, 50], extraGap: 30, extra: [30, 24], border: 2.6,
        ring: { cx: 972, cy: 972, r: 330, width: 32 },
    },
} as const;

const CAP = 0.727; // Inter's capital height, in em

/** Everything drawn over the photo (or the navy): the shade, the ring, the logo and the words. */
export function overlaySvg(spec: CardSpec, size: Size, withPhoto: boolean): string {
    const { serif, semi, bold } = loadFonts();
    const L = LAYOUT[spec.format];
    const parts: string[] = [];
    const defs: string[] = [];

    if (withPhoto) {
        defs.push(`<linearGradient id="shade" x1="0" y1="0" x2="1" y2="0">${[[0, 1], [0.34, 1], [0.46, 0.62], [0.66, 0.14], [0.8, 0]]
            .map(([at, a]) => `<stop offset="${at}" stop-color="${NIGHT}" stop-opacity="${a}"/>`).join('')}</linearGradient>`);
        parts.push(`<rect width="${size.width}" height="${size.height}" fill="url(#shade)"/>`);
    } else {
        defs.push(`<radialGradient id="bg" cx="${size.width}" cy="0" r="${size.width * 1.25}" gradientUnits="userSpaceOnUse">`
            + '<stop offset="0" stop-color="#24306F"/><stop offset="0.42" stop-color="#121E5A"/><stop offset="1" stop-color="#0A0F2E"/></radialGradient>');
        parts.push(`<rect width="${size.width}" height="${size.height}" fill="url(#bg)"/>`);
        parts.push(`<circle cx="${L.ring.cx}" cy="${L.ring.cy}" r="${L.ring.r}" fill="none" stroke="${ORANGE}" stroke-width="${L.ring.width}"/>`);
    }

    // Laid out top to bottom, then centred on the card.
    const title = fitTitle(serif, spec.title, L.title[0], L.title[1], L.maxWidth, L.titleLines);
    const titleLead = title.size * 0.98;
    const venueSize = sizeToFit(serif, spec.venue, L.venue[0], L.venue[1], L.maxWidth);
    const date = spec.date.toUpperCase();
    const dateSize = sizeToFit(semi, date, L.date[0], L.date[1], L.smallWidth, 0.14);
    const extra = spec.extra.toUpperCase();
    const extraSize = sizeToFit(bold, extra, L.extra[0], L.extra[1], L.smallWidth, 0.12);
    const blocks: { height: number; gap: number; draw: (top: number) => string }[] = [];
    const logoWidth = L.logo * (1080 / 412);
    const labelText = spec.label === 'proposed' ? 'PROPOSED MEETUP' : spec.label === 'community' ? 'COMMUNITY EVENT' : '';
    blocks.push({
        height: L.logo, gap: 0, draw: (top) => {
            let out = `<svg x="${L.x}" y="${top}" width="${logoWidth.toFixed(1)}" height="${L.logo}" viewBox="0 0 1080 412">${logoShapes()}</svg>`;
            if (labelText) {
                const [padX, padY] = L.labelPad;
                const boxW = textWidth(bold, labelText, L.label, 0.14) + padX * 2;
                const boxH = L.label * CAP + padY * 2;
                const boxX = L.x + logoWidth + L.labelGap;
                const boxY = top + (L.logo - boxH) / 2;
                const colour = spec.label === 'proposed' ? ORANGE : WHITE;
                out += `<rect x="${boxX.toFixed(1)}" y="${boxY.toFixed(1)}" width="${boxW.toFixed(1)}" height="${boxH.toFixed(1)}" fill="none" stroke="${colour}" stroke-opacity="${spec.label === 'proposed' ? 1 : 0.72}" stroke-width="${L.border}"/>`;
                out += shape(bold, labelText, boxX + padX, boxY + padY + L.label * CAP, L.label, colour, 0.14);
            }
            return out;
        },
    });
    blocks.push({
        height: title.lines.length * titleLead, gap: L.topGap,
        draw: (top) => title.lines.map((line, i) => shape(serif, line, L.x, top + title.size * 0.78 + i * titleLead, title.size, WHITE)).join(''),
    });
    blocks.push({
        height: L.rule[1], gap: L.ruleGap,
        draw: (top) => `<rect x="${L.x}" y="${top}" width="${L.rule[0]}" height="${L.rule[1]}" fill="${GOLD}" fill-opacity="0.75"/>`,
    });
    blocks.push({
        height: dateSize * CAP, gap: L.ruleGap,
        draw: (top) => shape(semi, fitLine(semi, date, dateSize, L.smallWidth, 0.14), L.x, top + dateSize * CAP, dateSize, WHITE, 0.14),
    });
    if (spec.venue) {
        blocks.push({
            height: venueSize * 0.98, gap: L.venueGap,
            draw: (top) => shape(serif, fitLine(serif, spec.venue, venueSize, L.maxWidth), L.x, top + venueSize * 0.8, venueSize, GOLD),
        });
    }
    if (extra) {
        blocks.push({
            height: extraSize * CAP, gap: L.extraGap,
            draw: (top) => shape(bold, fitLine(bold, extra, extraSize, L.smallWidth, 0.12), L.x, top + extraSize * CAP, extraSize, ORANGE, 0.12),
        });
    }
    const total = blocks.reduce((sum, b) => sum + b.gap + b.height, 0);
    let top = (size.height - total) / 2;
    for (const block of blocks) {
        top += block.gap;
        parts.push(block.draw(top));
        top += block.height;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}"><defs>${defs.join('')}</defs>${parts.join('')}</svg>`;
}

// ─── The photo ───────────────────────────────────────────────────────────────

/**
 * The cover in a box as its host positioned it (or centred and filling it),
 * any space it leaves filled with a blurred copy, `dim` as bright.
 */
export async function placedPhoto(input: Buffer, frameText: string, box: Size, dim: number): Promise<Buffer> {
    const { data, info } = await sharp(input, { autoOrient: true, failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS, animated: false })
        .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
        .toBuffer({ resolveWithObject: true });
    const natural = { width: info.width, height: info.height };
    const frame = parseFrame(frameText);
    const place = frame ? placeFrame(frame, natural, box) : fillBox(natural, box);
    const layers: sharp.OverlayOptions[] = [];
    if (leavesSpace(place, box)) {
        layers.push({ input: await sharp(data).resize(box.width, box.height, { fit: 'cover' }).blur(28).modulate({ brightness: dim }).toBuffer(), left: 0, top: 0 });
    }
    // Only the part inside the box is cut out and sized, so a photo zoomed far in stays small.
    const x0 = Math.max(0, Math.round(place.left));
    const y0 = Math.max(0, Math.round(place.top));
    const x1 = Math.min(box.width, Math.round(place.left + place.width));
    const y1 = Math.min(box.height, Math.round(place.top + place.height));
    if (x1 > x0 && y1 > y0) {
        const scale = place.width / natural.width;
        const sx = Math.min(natural.width - 1, Math.max(0, Math.floor((x0 - place.left) / scale)));
        const sy = Math.min(natural.height - 1, Math.max(0, Math.floor((y0 - place.top) / scale)));
        const sw = Math.max(1, Math.min(natural.width - sx, Math.round((x1 - x0) / scale)));
        const sh = Math.max(1, Math.min(natural.height - sy, Math.round((y1 - y0) / scale)));
        const part = await sharp(data).extract({ left: sx, top: sy, width: sw, height: sh }).resize(x1 - x0, y1 - y0, { fit: 'fill' }).toBuffer();
        layers.push({ input: part, left: x0, top: y0 });
    }
    return sharp({ create: { width: box.width, height: box.height, channels: 3, background: NIGHT } }).composite(layers).png().toBuffer();
}

/** As a JPEG small enough that WhatsApp shows it (it drops big ones). */
async function asJpeg(image: sharp.Sharp): Promise<Buffer> {
    const png = await image.png().toBuffer();
    const best = await sharp(png).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    return best.length <= 290_000 ? best : sharp(png).jpeg({ quality: 68, mozjpeg: true }).toBuffer();
}

/** The card itself. A cover that can't be read is left out, as if there were none. */
export async function drawCard(spec: CardSpec, cover: Buffer | null): Promise<Buffer> {
    const size = spec.format === 'square' ? SQUARE : WIDE;
    let photo: Buffer | null = null;
    if (cover) {
        try {
            photo = await placedPhoto(cover, spec.frame, spec.format === 'square' ? SQUARE : PHOTO_BOX, spec.format === 'square' ? 0.85 : 0.42);
        } catch (error) {
            console.warn('[Share card] Cover left out:', (error as Error).message);
        }
    }
    if (photo && spec.format === 'square') return asJpeg(sharp(photo));
    const layers: sharp.OverlayOptions[] = [];
    if (photo) layers.push({ input: photo, left: PHOTO_LEFT, top: 0 });
    layers.push({ input: Buffer.from(overlaySvg(spec, size, !!photo)), left: 0, top: 0 });
    return asJpeg(sharp({ create: { width: size.width, height: size.height, channels: 3, background: NIGHT } }).composite(layers));
}

/** The cover's bytes: from this server's uploads, or (an imported event's) from its https link. */
async function coverBytes(src: string): Promise<Buffer | null> {
    if (!src) return null;
    const name = uploadNameOf(src);
    if (name && !usesObjectStorage()) {
        try { return await fs.promises.readFile(path.join(PUBLIC_DIR, name)); } catch { return null; }
    }
    if (!/^https:\/\//i.test(src)) return null;
    const res = await safeGet(src, { timeoutMs: 8000, maxBytes: 12 * 1024 * 1024, headers: { ...OUTBOUND_HEADERS, Accept: 'image/*' } });
    return res && /^image\//i.test(res.contentType) ? res.body : null;
}

const drawing = new Map<string, Promise<string | null>>();

/**
 * The card's file, drawn if it isn't there yet (once, however many crawlers
 * ask at the same time). The event's older cards go once a new one is there.
 * Null when it can't be drawn.
 */
export function cardFile(eventId: string, spec: CardSpec): Promise<string | null> {
    const name = `${eventId}.${cardKey(spec)}.jpg`;
    const file = path.join(CARD_DIR, name);
    const running = drawing.get(name);
    if (running) return running;
    const job = (async () => {
        try {
            await fs.promises.access(file);
            return file;
        } catch { /* not drawn yet */ }
        const bytes = await drawCard(spec, await coverBytes(spec.cover).catch(() => null));
        // Written beside it, then renamed: a half-written card is never sent.
        const part = `${file}.${crypto.randomBytes(4).toString('hex')}.part`;
        await fs.promises.writeFile(part, bytes);
        await fs.promises.rename(part, file);
        const older = (await fs.promises.readdir(CARD_DIR)).filter((n) => n.startsWith(`${eventId}.`) && n.endsWith('.jpg') && n !== name);
        await Promise.all(older.map((n) => fs.promises.rm(path.join(CARD_DIR, n), { force: true })));
        return file;
    })().catch((error) => {
        console.warn(`[Share card] Not drawn for ${eventId}:`, (error as Error).message);
        return null;
    }).finally(() => drawing.delete(name));
    drawing.set(name, job);
    return job;
}
