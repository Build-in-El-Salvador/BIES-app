/**
 * Round 4 (20 Oct 2026): the content filter's time grows in step with the
 * text, whatever the text. Its tag regexes took time growing with the square
 * of the text on many "<" and no ">": 200 KB held the server for about 19 s.
 * And the in-memory cache keeps to a budget.
 */
import { describe, it, expect } from 'vitest';
import { findObjectionable, objectionableField } from '../services/contentFilter';

const MB = 1_000_000;
const ATTACKS: Array<[string, string]> = [
    ['many "<" and no ">"', '<'.repeat(MB)],
    ['many inline tag openings and no ">"', '<b'.repeat(MB / 2)],
    ['many closing tag openings and no ">"', '</strong'.repeat(MB / 8)],
    ['"<" and spaces', '<a <'.repeat(MB / 4)],
    ['tags and invisible characters', '<i>​'.repeat(MB / 4)],
];

describe('the content filter on big hostile text', () => {
    for (const [what, text] of ATTACKS) {
        it(`is quick: ${what}`, () => {
            const started = performance.now();
            findObjectionable(text);
            objectionableField({ name: text, sections: [{ body: text }] });
            expect(performance.now() - started).toBeLessThan(1000);
        });
    }
    it('still finds words through tags', () => {
        expect(findObjectionable('<b>ni</b>gger')).toBe('nigger');
        expect(findObjectionable('<p>hijo</p> de <i>puta</i>')).toBe('puta');
        expect(findObjectionable('a <x with no close puta')).toBe('puta');
    });
});
