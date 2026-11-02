/**
 * The public Nostr profile BIES builds (services/publicNostrProfile.ts) and
 * BIES addresses (services/nip05.ts): what was set in other Nostr apps
 * stays, only the ticked parts change, and only a chosen name is verified.
 */

import { describe, it, expect, vi } from 'vitest';

vi.hoisted(() => { process.env.APP_PUBLIC_URL = 'https://app.example.test'; });

import { DEFAULT_PARTS, PUBLIC_PARTS, publicNostrOf, publicProfileContent } from '../services/publicNostrProfile';
import { isClaimedNip05, looksGivenAtSignup } from '../services/nip05';

const bies = {
    name: 'Ana López', bio: 'Builder in San Salvador', avatar: '/uploads/public/1-a.webp',
    banner: 'https://cdn.example/cover.jpg', website: 'https://ana.dev', nip05Name: 'ana',
    lightningAddress: 'ana@getalby.com', bolt12Offer: '',
};

describe('publicNostrOf', () => {
    it('is off with the default parts when nothing is stored', () => {
        expect(publicNostrOf('{}')).toEqual({ on: false, parts: DEFAULT_PARTS, publishedAt: null });
        expect(publicNostrOf('not json')).toEqual({ on: false, parts: DEFAULT_PARTS, publishedAt: null });
    });

    it('keeps known parts in order and drops anything else', () => {
        const s = publicNostrOf(JSON.stringify({ on: true, parts: ['nip05', 'evil', 'name'], publishedAt: '2026-11-02T00:00:00.000Z' }));
        expect(s).toEqual({ on: true, parts: ['name', 'nip05'], publishedAt: '2026-11-02T00:00:00.000Z' });
    });

    it('is on only for true', () => {
        expect(publicNostrOf({ on: 'yes' }).on).toBe(false);
    });
});

describe('publicProfileContent', () => {
    const current = {
        name: 'ana_btc', display_name: 'Ana', about: 'Old bio', picture: 'https://old.example/p.jpg',
        website: 'https://elsewhere.example', lud16: 'ana@walletofsatoshi.com', nip05: 'ana@primal.net', custom: 'kept',
    };

    it('changes only the ticked parts and keeps everything else', () => {
        const out = publicProfileContent(current, bies, ['about']);
        expect(out).toEqual({ ...current, about: 'Builder in San Salvador' });
    });

    it('sets display_name but keeps the @name set elsewhere', () => {
        const out = publicProfileContent(current, bies, ['name']);
        expect(out.display_name).toBe('Ana López');
        expect(out.name).toBe('ana_btc');
    });

    it('fills the @name from BIES when there is none', () => {
        expect(publicProfileContent(null, bies, ['name'])).toEqual({ display_name: 'Ana López', name: 'Ana López' });
    });

    it('gives photos stored on BIES their full address', () => {
        const out = publicProfileContent(null, bies, ['picture', 'banner']);
        expect(out.picture).toBe('https://app.example.test/uploads/public/1-a.webp');
        expect(out.banner).toBe('https://cdn.example/cover.jpg');
    });

    it('removes a ticked part BIES has no value for', () => {
        const out = publicProfileContent(current, { ...bies, website: '' }, ['website']);
        expect(out).not.toHaveProperty('website');
    });

    it('handles a Lightning address or an LNURL', () => {
        expect(publicProfileContent(current, bies, ['lightning'])).toMatchObject({ lud16: 'ana@getalby.com' });
        const lnurl = publicProfileContent(current, { ...bies, lightningAddress: 'LNURL1abc' }, ['lightning']);
        expect(lnurl.lud06).toBe('LNURL1abc');
        expect(lnurl).not.toHaveProperty('lud16');
    });

    it('publishes a claimed BIES address', () => {
        expect(publicProfileContent(current, bies, ['nip05']).nip05).toBe('ana@buildinelsalvador.com');
    });

    it('leaves an address from another domain when the member has no claimed one', () => {
        const out = publicProfileContent(current, { ...bies, nip05Name: null }, ['nip05']);
        expect(out.nip05).toBe('ana@primal.net');
    });

    it('removes a BIES address the member no longer has, but not their sign-up one', () => {
        const old = { nip05: 'ana@buildinelsalvador.com' };
        expect(publicProfileContent(old, { ...bies, nip05Name: null }, ['nip05'])).not.toHaveProperty('nip05');
        const signup = { nip05: 'nostr-1a2b3c4d@buildinelsalvador.com' };
        expect(publicProfileContent(signup, { ...bies, nip05Name: 'nostr-1a2b3c4d' }, ['nip05']).nip05).toBe(signup.nip05);
    });

    it('removes a BIES address the member no longer has even when that part is off', () => {
        const old = { name: 'ana_btc', nip05: 'old@buildinelsalvador.com' };
        expect(publicProfileContent(old, bies, ['about'])).not.toHaveProperty('nip05');
        expect(publicProfileContent({ nip05: 'ana@primal.net' }, bies, ['about']).nip05).toBe('ana@primal.net');
    });

    it('builds a full profile with every part ticked', () => {
        const out = publicProfileContent(null, bies, PUBLIC_PARTS);
        expect(out).toEqual({
            display_name: 'Ana López', name: 'Ana López', picture: 'https://app.example.test/uploads/public/1-a.webp',
            banner: 'https://cdn.example/cover.jpg', about: 'Builder in San Salvador', website: 'https://ana.dev',
            lud16: 'ana@getalby.com', nip05: 'ana@buildinelsalvador.com',
        });
    });
});

describe('BIES addresses', () => {
    it('counts a chosen name as verified, not one given at sign-up', () => {
        expect(isClaimedNip05('ana')).toBe(true);
        expect(isClaimedNip05('nostr-1a2b3c4d')).toBe(false);
        expect(isClaimedNip05('nostr-1a2b3c4d2')).toBe(false);
        expect(isClaimedNip05(null)).toBe(false);
        expect(isClaimedNip05('nostr-fan')).toBe(true);
    });

    it('spots names that look given at sign-up', () => {
        expect(looksGivenAtSignup('nostr-deadbeef')).toBe(true);
        expect(looksGivenAtSignup('nostr.deadbeef')).toBe(false);
    });
});
