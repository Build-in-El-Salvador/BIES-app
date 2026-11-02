/**
 * The one-off maintenance script (scripts/recleanRichText.ts) runs saved
 * formatted text through keepAlignmentOnly again: what changes, what stays.
 */
import { describe, it, expect } from 'vitest';
import { recleaned, recleanedJson } from '../scripts/recleanRichText';

describe('recleaning saved formatted text', () => {
    it('keeps alignment, drops other inline styles, and leaves plain text as it is', () => {
        expect(recleaned('<p style="color: red; text-align: center">Hi</p>')).toBe('<p style="text-align: center">Hi</p>');
        expect(recleaned('<p style="color: red">Hi</p>')).toBe('<p >Hi</p>');
        expect(recleaned('  Plain words, 2 < 3  ')).toBe('  Plain words, 2 < 3  ');
        expect(recleaned('<p>Already clean</p>')).toBe('<p>Already clean</p>');
    });

    it('in JSON lists, changes only the formatted-text entries, and nothing if none change', () => {
        const sections = JSON.stringify([
            { title: 'About <b>us</b>', body: '<p style="font-size: 40px">We grow coffee.</p>', placement: 'top' },
            { title: 'Team', content: '<div style="text-align: right">Ana</div>' },
        ]);
        expect(JSON.parse(recleanedJson(sections))).toEqual([
            { title: 'About <b>us</b>', body: '<p >We grow coffee.</p>', placement: 'top' },
            { title: 'Team', content: '<div style="text-align: right">Ana</div>' },
        ]);
        const clean = '[ {"title":"Team", "body":"<p>Ana</p>"} ]';
        expect(recleanedJson(clean)).toBe(clean);
        expect(recleanedJson('not json <p style="color: red">')).toBe('not json <p style="color: red">');
    });
});
