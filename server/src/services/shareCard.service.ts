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
 * when that changes. It goes when the event does, stops being shared, gets
 * another cover or loses its host's account; a sweep catches the rest.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import opentype from 'opentype.js';
import prisma from '../lib/prisma';
import { config } from '../config';
import { MAX_INPUT_PIXELS } from './mediaProcessing';
import { CARD_DIR, PUBLIC_DIR, usesObjectStorage } from './storage.service';
import { uploadNameOf } from './uploads.service';
import { fillBox, leavesSpace, parseFrame, placeFrame, type Size } from '../utils/coverFrame';
import { OUTBOUND_HEADERS, safeGet } from '../utils/safeFetch';

/** Raised when the card's design changes, so every card is drawn again. */
export const CARD_VERSION = 2;

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

// Joiners, emoji-style selectors, keycaps, flag letters and tags, and skin
// tones: parts of an emoji, never letters of their own.
const EMOJI_PARTS = /[‍︎️⃣\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]/u;

/**
 * The text as the font can draw it: emoji, and anything else it has no
 * letter for, left out (it would draw a crossed box), spaces collapsed.
 * The app's preview leaves out the same (src/utils/shareCard.js cardText).
 */
export function drawable(font: Font, text: string): string {
    let out = '';
    for (const ch of (text || '').normalize('NFC').replace(/\s+/g, ' ')) {
        if (ch === ' ' || (!EMOJI_PARTS.test(ch) && font.charToGlyphIndex(ch) > 0)) out += ch;
    }
    return out.replace(/ {2,}/g, ' ').trim();
}

/** At most this many letters of a name or place are laid out: no card has room for more. */
export const MAX_LETTERS = 120;

/** The text cut to MAX_LETTERS, with … when it's cut. */
export function capped(text: string, max = MAX_LETTERS): string {
    const chars = Array.from(text);
    return chars.length <= max ? text : `${chars.slice(0, max).join('').trimEnd()}…`;
}

/**
 * A font's letters, each measured once (its glyph and advance, and each
 * pair's kerning), so a line's width is a sum rather than opentype.js laying
 * the line out again. Only letters the font has are kept, so what's kept is
 * no bigger than the font.
 */
type Position = {
    getDefaultScriptName(): string;
    getKerningTables(script: string, language?: string): unknown;
    getKerningValue(tables: unknown, left: number, right: number): number;
};
type Metrics = { glyphs: Map<string, { index: number; advance: number }>; pairs: Map<number, number>; kern: (left: number, right: number) => number };
const metrics = new WeakMap<Font, Metrics>();

function metricsOf(font: Font): Metrics {
    let m = metrics.get(font);
    if (!m) {
        // Kerning as opentype.js applies it (Font.forEachGlyph): the default script's lookups, else the kern table.
        const position = (font as unknown as { position: Position }).position;
        const tables = position.getKerningTables(position.getDefaultScriptName());
        const kern = tables
            ? (left: number, right: number) => position.getKerningValue(tables, left, right)
            : (left: number, right: number) => font.getKerningValue(left, right);
        m = { glyphs: new Map(), pairs: new Map(), kern };
        metrics.set(font, m);
    }
    return m;
}

function glyphOf(font: Font, m: Metrics, ch: string): { index: number; advance: number } {
    const kept = m.glyphs.get(ch);
    if (kept) return kept;
    const index = font.charToGlyphIndex(ch) || 0;
    const glyph = font.glyphs.get(index) || font.glyphs.get(0);
    const found = { index: glyph.index, advance: glyph.advanceWidth || 0 };
    if (index > 0) m.glyphs.set(ch, found);
    return found;
}

function kerning(m: Metrics, left: number, right: number): number {
    const key = left * 65536 + right;
    let value = m.pairs.get(key);
    if (value === undefined) {
        value = m.kern(left, right) || 0;
        m.pairs.set(key, value);
    }
    return value;
}

/** The text's width at a size: what opentype.js draws it at (Font.getAdvanceWidth), without the spacing after its last letter. */
export function textWidth(font: Font, text: string, size: number, letterSpacing = 0): number {
    const m = metricsOf(font);
    let units = 0;
    let count = 0;
    let previous = -1;
    for (const ch of text) {
        const glyph = glyphOf(font, m, ch);
        if (previous >= 0) units += kerning(m, previous, glyph.index);
        units += glyph.advance;
        previous = glyph.index;
        count++;
    }
    return count ? (units * size) / font.unitsPerEm + letterSpacing * size * (count - 1) : 0;
}

function shape(font: Font, text: string, x: number, baseline: number, size: number, fill: string, letterSpacing = 0, opacity = 1): string {
    const d = font.getPath(text, x, baseline, size, OPTIONS(letterSpacing)).toPathData(2);
    return d ? `<path d="${d}" fill="${fill}"${opacity < 1 ? ` fill-opacity="${opacity}"` : ''}/>` : '';
}

/**
 * The most of `count` letters (at least `least`) that pass `fits`: a longer
 * start of a line is never narrower, so halving finds it in a few measures.
 */
function longestFit(count: number, fits: (n: number) => boolean, least = 1): number {
    let lo = least;
    let hi = Math.max(least, count);
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (fits(mid)) lo = mid;
        else hi = mid - 1;
    }
    return lo;
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
    const chars = Array.from(text);
    const start = (n: number) => chars.slice(0, n).join('').trimEnd();
    return `${start(longestFit(chars.length, (n) => fits(start(n))))}…`;
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
        // Past its last line it overflows, whatever comes next.
        if (lines.length > maxLines) break;
        const longer = line ? `${line} ${word}` : word;
        if (textWidth(font, longer, size) <= maxWidth) { line = longer; continue; }
        if (line) lines.push(line);
        // A word wider than a line on its own is broken where it reaches the edge.
        let rest = Array.from(word);
        while (rest.length > 1 && lines.length <= maxLines && textWidth(font, rest.join(''), size) > maxWidth) {
            const part = rest;
            const cut = longestFit(part.length - 1, (n) => textWidth(font, part.slice(0, n).join(''), size) <= maxWidth);
            lines.push(part.slice(0, cut).join(''));
            rest = part.slice(cut);
        }
        line = rest.join('');
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
        ring: { cx: 1044, cy: 546, r: 263, width: 26, gap: 24 },
    },
    square: {
        x: 86, maxWidth: 860, smallWidth: 900, logo: 88, label: 26, labelPad: [20, 13], labelGap: 34, topGap: 54,
        title: [130, 84], titleLines: 3, ruleGap: 37, rule: [475, 2.5], date: [36, 28], venueGap: 20, venue: [76, 50], extraGap: 30, extra: [30, 24], border: 2.6,
        ring: { cx: 972, cy: 972, r: 330, width: 32, gap: 34 },
    },
} as const;

const CAP = 0.727; // Inter's capital height, in em

export type Box = { left: number; top: number; right: number; bottom: number };

type Ring = { cx: number; cy: number; r: number; width: number; gap: number };

/** How far the ring's outer edge is from a block of words (negative: over it). */
function clearance(ring: Ring, cx: number, cy: number, box: Box): number {
    const dx = Math.max(box.left - cx, 0, cx - box.right);
    const dy = Math.max(box.top - cy, 0, cy - box.bottom);
    return Math.hypot(dx, dy) - ring.r - ring.width / 2;
}

/**
 * Where the ring goes: its corner as designed, or pushed further into it
 * (its size kept) until it's `gap` clear of every block of words, as a long
 * title's last lines or a long place come near. Null (no ring) if it would
 * have to leave the card.
 */
export function ringPlace(ring: Ring, boxes: Box[]): { cx: number; cy: number; r: number } | null {
    for (let shift = 0; shift <= ring.r * 0.6; shift += 2) {
        const cx = ring.cx + shift;
        const cy = ring.cy + shift;
        if (boxes.every((box) => clearance(ring, cx, cy, box) >= ring.gap)) return { cx, cy, r: ring.r };
    }
    return null;
}

/** Where everything on a card goes: its blocks of words (and the logo) top to bottom, and the ring's radius (0: none). */
export function cardLayout(spec: CardSpec, size: Size, withPhoto: boolean) {
    const { serif, semi, bold } = loadFonts();
    const L = LAYOUT[spec.format];

    // Only what the fonts can draw, and no more than fits on any card.
    const titleText = capped(drawable(serif, spec.title));
    const venueText = capped(drawable(serif, spec.venue));
    const date = drawable(semi, spec.date.toUpperCase());
    const extra = drawable(bold, spec.extra.toUpperCase());

    // Laid out top to bottom, then centred on the card. Each block knows how
    // wide it is, so the ring can keep clear of it (ringPlace).
    const title = fitTitle(serif, titleText, L.title[0], L.title[1], L.maxWidth, L.titleLines);
    const titleLead = title.size * 0.98;
    const venueSize = sizeToFit(serif, venueText, L.venue[0], L.venue[1], L.maxWidth);
    const dateSize = sizeToFit(semi, date, L.date[0], L.date[1], L.smallWidth, 0.14);
    const extraSize = sizeToFit(bold, extra, L.extra[0], L.extra[1], L.smallWidth, 0.12);
    const blocks: { name: string; height: number; gap: number; width: number; draw: (top: number) => string }[] = [];
    const logoWidth = L.logo * (1080 / 412);
    const labelText = spec.label === 'proposed' ? 'PROPOSED MEETUP' : spec.label === 'community' ? 'COMMUNITY EVENT' : '';
    const labelWidth = labelText ? textWidth(bold, labelText, L.label, 0.14) + L.labelPad[0] * 2 : 0;
    blocks.push({
        name: 'logo', height: L.logo, gap: 0, width: logoWidth + (labelText ? L.labelGap + labelWidth : 0), draw: (top) => {
            let out = `<svg x="${L.x}" y="${top}" width="${logoWidth.toFixed(1)}" height="${L.logo}" viewBox="0 0 1080 412">${logoShapes()}</svg>`;
            if (labelText) {
                const [padX, padY] = L.labelPad;
                const boxH = L.label * CAP + padY * 2;
                const boxX = L.x + logoWidth + L.labelGap;
                const boxY = top + (L.logo - boxH) / 2;
                const colour = spec.label === 'proposed' ? ORANGE : WHITE;
                out += `<rect x="${boxX.toFixed(1)}" y="${boxY.toFixed(1)}" width="${labelWidth.toFixed(1)}" height="${boxH.toFixed(1)}" fill="none" stroke="${colour}" stroke-opacity="${spec.label === 'proposed' ? 1 : 0.72}" stroke-width="${L.border}"/>`;
                out += shape(bold, labelText, boxX + padX, boxY + padY + L.label * CAP, L.label, colour, 0.14);
            }
            return out;
        },
    });
    if (title.lines.length) {
        blocks.push({
            name: 'title', height: title.lines.length * titleLead, gap: L.topGap,
            width: Math.max(...title.lines.map((line) => textWidth(serif, line, title.size))),
            draw: (top) => title.lines.map((line, i) => shape(serif, line, L.x, top + title.size * 0.78 + i * titleLead, title.size, WHITE)).join(''),
        });
    }
    blocks.push({
        name: 'rule', height: L.rule[1], gap: L.ruleGap, width: L.rule[0],
        draw: (top) => `<rect x="${L.x}" y="${top}" width="${L.rule[0]}" height="${L.rule[1]}" fill="${GOLD}" fill-opacity="0.75"/>`,
    });
    if (date) {
        const line = fitLine(semi, date, dateSize, L.smallWidth, 0.14);
        blocks.push({
            name: 'date', height: dateSize * CAP, gap: L.ruleGap, width: textWidth(semi, line, dateSize, 0.14),
            draw: (top) => shape(semi, line, L.x, top + dateSize * CAP, dateSize, WHITE, 0.14),
        });
    }
    if (venueText) {
        const line = fitLine(serif, venueText, venueSize, L.maxWidth);
        blocks.push({
            name: 'venue', height: venueSize * 0.98, gap: L.venueGap, width: textWidth(serif, line, venueSize),
            draw: (top) => shape(serif, line, L.x, top + venueSize * 0.8, venueSize, GOLD),
        });
    }
    if (extra) {
        const line = fitLine(bold, extra, extraSize, L.smallWidth, 0.12);
        blocks.push({
            name: 'extra', height: extraSize * CAP, gap: L.extraGap, width: textWidth(bold, line, extraSize, 0.12),
            draw: (top) => shape(bold, line, L.x, top + extraSize * CAP, extraSize, ORANGE, 0.12),
        });
    }
    const total = blocks.reduce((sum, b) => sum + b.gap + b.height, 0);
    let top = (size.height - total) / 2;
    const placed = blocks.map((block) => {
        top += block.gap;
        const box: Box = { left: L.x, top, right: L.x + block.width, bottom: top + block.height };
        top += block.height;
        return { name: block.name, box, draw: () => block.draw(box.top) };
    });
    // The ring keeps clear of the words.
    const ring = withPhoto ? null : ringPlace(L.ring, placed.map((b) => b.box));
    return { blocks: placed, ring, ringWidth: L.ring.width };
}

/** Everything drawn over the photo (or the navy): the shade, the ring, the logo and the words. */
export function overlaySvg(spec: CardSpec, size: Size, withPhoto: boolean): string {
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
    }
    const layout = cardLayout(spec, size, withPhoto);
    if (layout.ring) {
        parts.push(`<circle cx="${layout.ring.cx}" cy="${layout.ring.cy}" r="${layout.ring.r}" fill="none" stroke="${ORANGE}" stroke-width="${layout.ringWidth}"/>`);
    }
    for (const block of layout.blocks) parts.push(block.draw());
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}"><defs>${defs.join('')}</defs>${parts.join('')}</svg>`;
}

// ─── The photo ───────────────────────────────────────────────────────────────

/** What a cover may be. Never SVG: a member's link is drawn only as a photo. */
const PHOTO_FORMATS = new Set(['jpeg', 'png', 'webp']);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Whether the bytes are a JPEG, PNG or WebP photo: by their first bytes, then as sharp reads them. */
export async function isPhoto(input: Buffer): Promise<boolean> {
    const jpeg = input.length > 3 && input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff;
    const png = input.subarray(0, 8).equals(PNG_SIGNATURE);
    const webp = input.subarray(0, 4).toString('latin1') === 'RIFF' && input.subarray(8, 12).toString('latin1') === 'WEBP';
    if (!jpeg && !png && !webp) return false;
    try {
        const { format } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
        return !!format && PHOTO_FORMATS.has(format);
    } catch {
        return false;
    }
}

/**
 * The cover in a box as its host positioned it (or centred and filling it),
 * any space it leaves filled with a blurred copy, `dim` as bright. Throws
 * for anything but a JPEG, PNG or WebP photo.
 */
export async function placedPhoto(input: Buffer, frameText: string, box: Size, dim: number): Promise<Buffer> {
    if (!(await isPhoto(input))) throw new Error('Not a JPEG, PNG or WebP photo');
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

/** The card, and whether its cover is on it. A cover that can't be read is left out, as if there were none. */
async function renderCard(spec: CardSpec, cover: Buffer | null): Promise<{ bytes: Buffer; withCover: boolean }> {
    const size = spec.format === 'square' ? SQUARE : WIDE;
    let photo: Buffer | null = null;
    if (cover) {
        try {
            photo = await placedPhoto(cover, spec.frame, spec.format === 'square' ? SQUARE : PHOTO_BOX, spec.format === 'square' ? 0.85 : 0.42);
        } catch (error) {
            console.warn('[Share card] Cover left out:', (error as Error).message);
        }
    }
    if (photo && spec.format === 'square') return { bytes: await asJpeg(sharp(photo)), withCover: true };
    const layers: sharp.OverlayOptions[] = [];
    if (photo) layers.push({ input: photo, left: PHOTO_LEFT, top: 0 });
    layers.push({ input: Buffer.from(overlaySvg(spec, size, !!photo)), left: 0, top: 0 });
    const bytes = await asJpeg(sharp({ create: { width: size.width, height: size.height, channels: 3, background: NIGHT } }).composite(layers));
    return { bytes, withCover: !!photo };
}

/** The card itself. A cover that can't be read is left out, as if there were none. */
export async function drawCard(spec: CardSpec, cover: Buffer | null): Promise<Buffer> {
    return (await renderCard(spec, cover)).bytes;
}

/** This server's own host names: the app's and the API's. */
function ownHostnames(): Set<string> {
    const hostname = (u: string) => { try { return new URL(u).hostname.toLowerCase().replace(/\.$/, ''); } catch { return ''; } };
    return new Set([config.appPublicUrl, process.env.API_PUBLIC_URL || ''].map(hostname).filter(Boolean));
}

/**
 * Whether a cover link (or a redirect on the way) may be fetched: anywhere
 * else, and on this server only its uploads, so drawing a card never asks
 * this server for a card, or any other page of its own.
 */
export function fetchableCover(url: URL): boolean {
    if (!ownHostnames().has(url.hostname.toLowerCase().replace(/\.$/, ''))) return true;
    const basePath = (process.env.BASE_PATH || '').replace(/\/+$/, '');
    return url.pathname.startsWith(`${basePath}/uploads/`);
}

/** The cover's bytes: from this server's uploads, or (an imported event's) from its https link. */
async function coverBytes(src: string): Promise<Buffer | null> {
    if (!src) return null;
    const name = uploadNameOf(src);
    if (name && !usesObjectStorage()) {
        try { return await fs.promises.readFile(path.join(PUBLIC_DIR, name)); } catch { return null; }
    }
    if (!/^https:\/\//i.test(src)) return null;
    const res = await safeGet(src, { timeoutMs: 8000, maxBytes: 12 * 1024 * 1024, headers: { ...OUTBOUND_HEADERS, Accept: 'image/*' }, allow: fetchableCover });
    return res && /^image\//i.test(res.contentType) ? res.body : null;
}

// ─── Drawing them, one at a time ─────────────────────────────────────────────

let turn: Promise<unknown> = Promise.resolve();

/**
 * Runs `work` after the work before it is done, so cards are drawn one at a
 * time: a burst of them waits its turn instead of taking over the server.
 */
export function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
    const run = turn.then(work);
    turn = run.then(() => undefined, () => undefined);
    return run;
}

/** At most this many cards are fetched or drawn at once; past that, a card isn't drawn now (the link shows the icon). */
export const MAX_DRAWING = 8;
let drawingNow = 0;

/** A card as it's sent: its kept file, or (when its cover couldn't be had) its bytes, not kept. */
export type Card = { file: string } | { bytes: Buffer };

const drawing = new Map<string, Promise<Card | null>>();

/**
 * The card, drawn if it isn't there yet (once, however many crawlers ask at
 * the same time). The event's older cards go once a new one is there. Null
 * when it can't be drawn.
 */
export function cardImage(eventId: string, spec: CardSpec): Promise<Card | null> {
    const name = `${eventId}.${cardKey(spec)}.jpg`;
    const file = path.join(CARD_DIR, name);
    const running = drawing.get(name);
    if (running) return running;
    const job = (async (): Promise<Card | null> => {
        try {
            await fs.promises.access(file);
            return { file };
        } catch { /* not drawn yet */ }
        if (drawingNow >= MAX_DRAWING) {
            console.warn(`[Share card] Busy: not drawn for ${eventId} now`);
            return null;
        }
        drawingNow++;
        try {
            const cover = await coverBytes(spec.cover).catch(() => null);
            const { bytes, withCover } = await oneAtATime(() => renderCard(spec, cover));
            // Its cover couldn't be had (its link down, too slow, not a photo):
            // sent as it is but not kept, so the next ask tries again.
            if (spec.cover && !withCover) return { bytes };
            // Written beside it, then renamed: a half-written card is never sent.
            const part = `${file}.${crypto.randomBytes(4).toString('hex')}.part`;
            await fs.promises.writeFile(part, bytes);
            await fs.promises.rename(part, file);
            const older = (await fs.promises.readdir(CARD_DIR)).filter((n) => n.startsWith(`${eventId}.`) && n.endsWith('.jpg') && n !== name);
            await Promise.all(older.map((n) => fs.promises.rm(path.join(CARD_DIR, n), { force: true })));
            return { file };
        } finally {
            drawingNow--;
        }
    })().catch((error) => {
        console.warn(`[Share card] Not drawn for ${eventId}:`, (error as Error).message);
        return null;
    }).finally(() => drawing.delete(name));
    drawing.set(name, job);
    return job;
}

// ─── Deleting them ────────────────────────────────────────────────────────────

/** The event a card file is of: `<eventId>.<key>.jpg`, or `<eventId>.<key>.jpg.<random>.part` while it's written. */
const eventOf = (name: string) => name.slice(0, name.indexOf('.'));

async function cardNames(): Promise<string[]> {
    try { return await fs.promises.readdir(CARD_DIR); } catch { return []; }
}

/**
 * Deletes these events' cards: when an event is deleted, stops being shared
 * (private, a draft), gets another cover, or its host's account goes. Never
 * throws: it's cleanup after what was asked is done.
 */
export async function forgetCards(eventIds: string | string[]): Promise<void> {
    const ids = new Set(Array.isArray(eventIds) ? eventIds : [eventIds]);
    if (!ids.size) return;
    const names = (await cardNames()).filter((n) => ids.has(eventOf(n)));
    await Promise.all(names.map((n) => fs.promises.rm(path.join(CARD_DIR, n), { force: true }).catch(() => undefined)));
}

/** What a shared event's preview needs (preview.controller.ts eventTeaser): published, not private or a draft, not called off, its host's account there. */
const SHARED = {
    isPublished: true,
    visibility: { notIn: ['PRIVATE', 'DRAFT'] },
    calledOffAt: null,
    host: { isBanned: false, deletedAt: null },
};

/** A half-written card this old is left over (a restart, a failed write): none takes more than seconds. */
const PART_AGE_MS = 60 * 60_000;

/**
 * Deletes the cards of events no longer shared (gone, private, called off,
 * their host banned) and half-written ones left over. Returns how many went.
 */
export async function sweepCards(now = Date.now()): Promise<number> {
    const names = await cardNames();
    const gone: string[] = [];
    for (const name of names.filter((n) => n.endsWith('.part'))) {
        try {
            if (now - (await fs.promises.stat(path.join(CARD_DIR, name))).mtimeMs > PART_AGE_MS) gone.push(name);
        } catch { /* gone already */ }
    }
    const cards = names.filter((n) => n.endsWith('.jpg'));
    const ids = [...new Set(cards.map(eventOf))];
    const shared = new Set<string>();
    for (let i = 0; i < ids.length; i += 500) {
        const rows = await prisma.event.findMany({ where: { id: { in: ids.slice(i, i + 500) }, ...SHARED }, select: { id: true } });
        for (const row of rows) shared.add(row.id);
    }
    gone.push(...cards.filter((n) => !shared.has(eventOf(n))));
    await Promise.all(gone.map((n) => fs.promises.rm(path.join(CARD_DIR, n), { force: true }).catch(() => undefined)));
    return gone.length;
}

const SWEEP_MS = 6 * 60 * 60_000;

/** Sweeps the cards now, and every six hours. */
export function startCardSweep(): void {
    const sweep = () => sweepCards()
        .then((count) => { if (count) console.log(`[Share card] Deleted ${count} card(s) of events no longer shared`); })
        .catch((err) => console.error('[Share card] Sweep failed:', err));
    sweep();
    setInterval(sweep, SWEEP_MS).unref();
}
