/**
 * The request sanitizer (middleware/sanitize.ts) takes out what it always
 * took out: tags from plain text, and script, style, iframe, object, embed
 * and form tags, event handlers and script links from rich text. Checked
 * against the regular expressions it used to run, on made-up text.
 */
import { describe, it, expect } from 'vitest';
import type express from 'express';
import { sanitize } from '../middleware/sanitize';

// What the sanitizer used to run.
function previousPlain(str: string): string {
    let prev = '';
    let result = str;
    while (result !== prev) {
        prev = result;
        result = result
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, '');
    }
    return result;
}

function previousRich(str: string): string {
    let result = str
        .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/&#(\d+);?/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
        .replace(/&tab;|&newline;/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
        .replace(/<object[\s\S]*?>/gi, '')
        .replace(/<embed[\s\S]*?>/gi, '')
        .replace(/<form[\s\S]*?<\/form>/gi, '')
        .replace(/<form[\s\S]*?>/gi, '')
        .replace(/[\s/"']on\w+\s*=\s*"[^"]*"/gi, ' ')
        .replace(/[\s/"']on\w+\s*=\s*'[^']*'/gi, ' ')
        .replace(/[\s/"']on\w+\s*=\s*[^\s>]*/gi, ' ');
    result = result.replace(/javascript\s*:/gi, '');
    result = result.replace(/vbscript\s*:/gi, '').replace(/data\s*:[^,]*;base64/gi, '');
    return result.trim();
}

/** The sanitizer on one field of a request body. */
function sanitized(key: string, value: string): string {
    const req = { path: '/api/profiles/me', body: { [key]: value }, query: {}, params: {} } as unknown as express.Request;
    sanitize(req, {} as express.Response, () => {});
    return String((req.body as Record<string, unknown>)[key]);
}

// Pieces of HTML, and of text that looks like it, in every case.
const PIECES = [
    '<', '>', '<>', '</', '<script', '<SCRIPT', '</script>', '</Script>', '<style', '</style>', '<iframe', '</iframe>',
    '<object', '<embed', '<form', '</form>', '<b>', '</b>', '<p>', '<img src=x', ' onerror=', ' onclick="', '"', "'",
    '=', '/', 'javascript:', 'JavaScript :', 'vbscript:', 'data:', 'data :', 'DATA:', ';base64', ';BASE64', ',', '&#106;',
    '&#x6f;', '&tab;', 'text/html', 'a', 'bc', ' ', '\n', '\t', 'x',
];

// The same made-up text every run (a fixed seed), so a failure can be repeated.
function randomText(rand: () => number): string {
    const length = Math.floor(rand() * 40);
    let text = '';
    for (let i = 0; i < length; i++) text += PIECES[Math.floor(rand() * PIECES.length)];
    return text;
}

// mulberry32
function seeded(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe('the request sanitizer', () => {
    it('takes the tags out of plain text as it always did', () => {
        const rand = seeded(17);
        for (let i = 0; i < 5000; i++) {
            const text = randomText(rand);
            expect(sanitized('title', text), JSON.stringify(text)).toBe(previousPlain(text.trim()));
        }
    });

    it('takes what could run out of rich text as it always did', () => {
        const rand = seeded(29);
        for (let i = 0; i < 5000; i++) {
            const text = randomText(rand);
            expect(sanitized('description', text), JSON.stringify(text)).toBe(previousRich(text));
        }
    });

    it('keeps ordinary text and formatting', () => {
        expect(sanitized('title', 'Coffee & cacao, 2 < 3')).toBe('Coffee & cacao, 2 < 3');
        expect(sanitized('title', 'Hello <b>world</b>')).toBe('Hello world');
        expect(sanitized('description', '<p>Coffee <strong>rows</strong></p>')).toBe('<p>Coffee <strong>rows</strong></p>');
    });
});
