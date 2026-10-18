/**
 * The request sanitizer (middleware/sanitize.ts) runs on every JSON body,
 * before sign-in and the rate limiter, so its time must grow in step with the
 * text, whatever the text. The regular expressions it used before took
 * quadratic time on an opening with no close (40,000 "<" took 0.76 s, so 1 MB
 * held the server for minutes), and the first one-pass version still did on
 * "data:," repeated. Each case here is about 1 MB.
 */
import { describe, it, expect } from 'vitest';
import type express from 'express';
import { sanitize } from '../middleware/sanitize';

function timeOf(key: string, value: string): number {
    const req = { path: '/api/auth/anything', body: { [key]: value }, query: {}, params: {} } as unknown as express.Request;
    const started = performance.now();
    sanitize(req, {} as express.Response, () => {});
    return performance.now() - started;
}

const MB = 1_000_000;
const ATTACKS: Array<[string, string]> = [
    ['many "<" and no ">"', '<'.repeat(MB)],
    ['many "<script" and no close', '<script'.repeat(MB / 7)],
    ['many "<style" and no close', '<style'.repeat(MB / 6)],
    ['many "<iframe" and no close', '<iframe'.repeat(MB / 7)],
    ['many "<object" and no ">"', '<object'.repeat(MB / 7)],
    ['many "<embed" and no ">"', '<embed'.repeat(MB / 6)],
    ['many "<form" and no close', '<form'.repeat(MB / 5)],
    ['many "data:" and no ";base64"', 'data:'.repeat(MB / 5)],
    // Each "data:" once searched to the end of the text for ";base64".
    ['many "data:," and no ";base64"', 'data:,'.repeat(MB / 6)],
    ['many "data:x," and ";base64" only at the end', 'data:x,'.repeat(MB / 7) + ';base64'],
    ['many near misses ";base6,"', 'data:;base6,'.repeat(MB / 12)],
    ['many matches', 'data:;base64,'.repeat(MB / 13)],
    ['handler with no closing quote', ' onx="' + 'a'.repeat(MB)],
    ['many handlers', ' onx="'.repeat(MB / 6)],
    ['handler and spaces', ' onx=' + ' '.repeat(MB)],
    ['script link and spaces', 'javascript' + ' '.repeat(MB)],
    ['entities', '&#x' + '1'.repeat(MB)],
];

describe('the request sanitizer on big hostile text', () => {
    for (const [what, text] of ATTACKS) {
        it(`is quick: ${what}`, () => {
            expect(timeOf('title', text), 'plain').toBeLessThan(500);
            expect(timeOf('description', text), 'rich').toBeLessThan(500);
        });
    }
});
