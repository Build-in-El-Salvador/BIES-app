/**
 * A profile's website as people type it: "mywebsite.com" saves as
 * https://mywebsite.com (a tester's "Invalid url", 2026-10-25), from app
 * builds that send it as typed too.
 */

import { describe, it, expect } from 'vitest';
import { updateProfileSchema } from '../controllers/profile.controller';

const website = (value: unknown) => updateProfileSchema.safeParse({ website: value });

describe('a profile website', () => {
    it('without a scheme is saved with https://', () => {
        expect(website('mywebsite.com').data?.website).toBe('https://mywebsite.com');
        expect(website('www.mywebsite.com/about').data?.website).toBe('https://www.mywebsite.com/about');
        expect(website('  mywebsite.com ').data?.website).toBe('https://mywebsite.com');
    });

    it('with a scheme is kept as it is', () => {
        expect(website('https://www.mywebsite.com').data?.website).toBe('https://www.mywebsite.com');
        expect(website('http://mywebsite.com').data?.website).toBe('http://mywebsite.com');
    });

    it('can still be cleared, or left out', () => {
        expect(website('').data?.website).toBe('');
        expect(website(undefined).success).toBe(true);
    });

    it('still has to be a web address', () => {
        expect(website('not a website').success).toBe(false);
    });
});
