/**
 * Event import reads a page's JSON-LD blocks with a linear scan, so a page
 * made of unclosed tags can't hold the server up.
 */
import { describe, it, expect } from 'vitest';
import { jsonLdBlocks } from '../controllers/eventImport.controller';

describe('jsonLdBlocks', () => {
    it('finds the JSON-LD blocks of a normal page', () => {
        const page = '<html><head><script src="/app.js"></script>'
            + '<SCRIPT type="application/ld+json">{"@type":"Event","name":"Launch"}</SCRIPT>'
            + '<script type=\'application/ld+json\' id="b">[{"@type":"Place"}]</script></head></html>';
        expect(jsonLdBlocks(page)).toEqual(['{"@type":"Event","name":"Launch"}', '[{"@type":"Place"}]']);
    });

    it('stays fast on a 2 MB page of unclosed tags', () => {
        // About a second alone; a scan that went back over the page from each
        // tag would take minutes. 5 seconds leaves room for a busy machine:
        // the other test files run at the same time, ffmpeg's among them.
        for (const piece of ['<script type="application/ld+json">', '<script ', '<script type="application/ld+json">x</scrip']) {
            const page = piece.repeat(Math.ceil((2 * 1024 * 1024) / piece.length));
            const started = Date.now();
            jsonLdBlocks(page);
            expect(Date.now() - started, piece).toBeLessThan(5000);
        }
    });
});
