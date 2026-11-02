/**
 * The public Nostr profile BIES builds (services/publicNostrProfile.ts) and
 * BIES addresses (services/nip05.ts): what was set in other Nostr apps
 * stays, only the ticked parts change (as Privacy allows), an unticked part
 * loses only what BIES put there, only a claimed name is verified, names
 * that pass for BIES or its team are kept, and names given up are held.
 */

import { describe, it, expect, vi } from 'vitest';

vi.hoisted(() => { process.env.APP_PUBLIC_URL = 'https://app.example.test'; });

import {
    PUBLIC_PARTS, allowedParts, buildPublicProfile, defaultParts, hiddenByPrivacy, publicNostrOf, publicProfileContent, sameProfile, sourceFields,
} from '../services/publicNostrProfile';
import { RELEASED_HOLD_MS, isClaimedNip05, isHeldNip05, isReservedNip05, looksGivenAtSignup, normaliseNip05 } from '../services/nip05';

const bies = {
    name: 'Ana López', bio: 'Builder in San Salvador', avatar: '/uploads/public/1-a.webp',
    banner: 'https://cdn.example/cover.jpg', website: 'https://ana.dev', nip05Name: 'ana', nip05ClaimedAt: new Date('2026-11-02T00:00:00Z'),
    lightningAddress: 'ana@getalby.com', bolt12Offer: '',
};
const open = { links: 'MEMBERS', bio: 'PUBLIC' } as const;

describe('publicNostrOf', () => {
    const nothing = { on: false, parts: null, publishedAt: null, publishedParts: null, publishedCreatedAt: null, publishedValues: {} };

    it('is off, with no parts chosen and nothing published, when nothing is stored', () => {
        expect(publicNostrOf('{}')).toEqual(nothing);
        expect(publicNostrOf('not json')).toEqual(nothing);
        expect(publicNostrOf('[1]')).toEqual(nothing);
    });

    it('keeps known parts in order and drops anything else', () => {
        const s = publicNostrOf(JSON.stringify({
            on: true, parts: ['nip05', 'evil', 'name'], publishedAt: '2026-11-02T00:00:00.000Z',
            publishedParts: ['about', 'x'], publishedCreatedAt: 1_700_000_000, publishedValues: { about: 'Hi', bad: 3 }, other: 'dropped',
        }));
        expect(s).toEqual({
            on: true, parts: ['name', 'nip05'], publishedAt: '2026-11-02T00:00:00.000Z',
            publishedParts: ['about'], publishedCreatedAt: 1_700_000_000, publishedValues: { about: 'Hi' },
        });
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

    it("doesn't publish a BIES address that was never claimed", () => {
        expect(publicProfileContent(null, { ...bies, nip05ClaimedAt: null }, ['nip05'])).not.toHaveProperty('nip05');
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

describe('what BIES published, and parts taken off', () => {
    it('says what BIES put in the profile, and not an @name set elsewhere', () => {
        const { content, values } = buildPublicProfile({ name: 'ana_btc', lud16: 'ana@wos.com' }, bies, ['name', 'about']);
        expect(content).toEqual({ name: 'ana_btc', display_name: 'Ana López', about: 'Builder in San Salvador', lud16: 'ana@wos.com' });
        expect(values).toEqual({ display_name: 'Ana López', about: 'Builder in San Salvador' });
    });

    it('a part taken off loses what BIES put there', () => {
        const first = buildPublicProfile({ custom: 'kept' }, bies, ['name', 'about', 'website']);
        const second = buildPublicProfile(first.content, bies, ['name'], first.values);
        expect(second.content).toEqual({ custom: 'kept', display_name: 'Ana López', name: 'Ana López' });
        expect(second.values).toEqual({ display_name: 'Ana López', name: 'Ana López' });
    });

    it('…but not a value set since in another app', () => {
        const first = buildPublicProfile(null, bies, ['about', 'lightning']);
        const elsewhere = { ...first.content, about: 'Changed in Primal', lud16: 'ana@primal.net' };
        expect(buildPublicProfile(elsewhere, bies, [], first.values).content).toEqual({ about: 'Changed in Primal', lud16: 'ana@primal.net' });
    });

    it('keeps the @name BIES filled up to date, and takes it off with the name', () => {
        const first = buildPublicProfile(null, bies, ['name']);
        const renamed = buildPublicProfile(first.content, { ...bies, name: 'Ana L.' }, ['name'], first.values);
        expect(renamed.content).toEqual({ display_name: 'Ana L.', name: 'Ana L.' });
        expect(buildPublicProfile(renamed.content, bies, [], renamed.values).content).toEqual({});
    });

    it('takes off a BIES address BIES published when the part goes', () => {
        const first = buildPublicProfile(null, bies, ['nip05']);
        expect(buildPublicProfile(first.content, bies, ['about'], first.values).content).not.toHaveProperty('nip05');
        // One the member set themselves in another app stays.
        expect(buildPublicProfile({ nip05: 'ana@buildinelsalvador.com' }, bies, ['about'], {}).content.nip05).toBe('ana@buildinelsalvador.com');
    });
});

describe('Privacy and the parts', () => {
    it('"Links: Only me" hides the website, Lightning and BIES address; "Bio: Members" the bio', () => {
        expect(hiddenByPrivacy(open)).toEqual([]);
        expect(hiddenByPrivacy({ links: 'ONLY_ME', bio: 'PUBLIC' })).toEqual(['website', 'lightning', 'nip05']);
        expect(hiddenByPrivacy({ links: 'MEMBERS', bio: 'MEMBERS' })).toEqual(['about']);
        expect(allowedParts(PUBLIC_PARTS, { links: 'ONLY_ME', bio: 'MEMBERS' })).toEqual(['name', 'picture', 'banner']);
    });

    it('ticks by default only what BIES has and Privacy allows', () => {
        expect(defaultParts(bies, open)).toEqual(['name', 'picture', 'banner', 'about', 'nip05']);
        expect(defaultParts({ name: 'Bo', bio: 'Hi', avatar: '', banner: null, nip05Name: 'nostr-1a2b3c4d', nip05ClaimedAt: null }, open)).toEqual(['name', 'about']);
        expect(defaultParts(bies, { links: 'ONLY_ME', bio: 'MEMBERS' })).toEqual(['name', 'picture', 'banner']);
    });

    it('knows which BIES fields each part is made from (the BIES address always counts)', () => {
        expect(sourceFields(['about'])).toEqual(['nip05Name', 'bio']);
        expect(sourceFields(['lightning', 'picture'])).toEqual(['nip05Name', 'lightningAddress', 'bolt12Offer', 'avatar']);
    });

    it('compares profiles field by field', () => {
        expect(sameProfile({ a: '1', b: '2' }, { b: '2', a: '1' })).toBe(true);
        expect(sameProfile({ a: '1' }, { a: '1', b: '2' })).toBe(false);
        expect(sameProfile(null, {})).toBe(true);
    });
});

describe('BIES addresses', () => {
    it('counts a claimed name as verified, not one only given', () => {
        const claimedAt = new Date();
        expect(isClaimedNip05({ nip05Name: 'ana', nip05ClaimedAt: claimedAt })).toBe(true);
        expect(isClaimedNip05({ nip05Name: 'ana', nip05ClaimedAt: '2026-11-02T00:00:00.000Z' })).toBe(true);
        expect(isClaimedNip05({ nip05Name: 'ana', nip05ClaimedAt: null })).toBe(false);
        expect(isClaimedNip05({ nip05Name: null, nip05ClaimedAt: claimedAt })).toBe(false);
        expect(isClaimedNip05(null)).toBe(false);
    });

    it('spots names that look given at sign-up', () => {
        expect(looksGivenAtSignup('nostr-deadbeef')).toBe(true);
        expect(looksGivenAtSignup('nostr.deadbeef')).toBe(false);
    });
});

describe('names kept for BIES', () => {
    it('reads names as they look', () => {
        expect(normaliseNip05('M1.ke_')).toBe('mike');
        expect(normaliseNip05('0ff1c14l')).toBe('official');
        expect(normaliseNip05('b-1-3-5')).toBe('bies');
        expect(normaliseNip05('cam7')).toBe('camt');
    });

    it("keeps the team's names, the President's, and BIES's own", () => {
        for (const name of ['luis', 'mike', 'm1ke', 'mi.ke', 'michael', 'mattias', 'matt', 'emilio', 'eric', 'nelson', 'edwin', 'cam',
            'bukele', 'nayib', 'nayibbukele', 'nayib.bukele', 'buildy', 'buildy.bot', 'buildybot', 'hq', 'bieshq', 'hq.bies']) {
            expect(isReservedNip05(name), name).toBe(true);
        }
    });

    it('keeps staff words in Spanish, alone or with "bies"', () => {
        for (const name of ['soporte', 'oficial', 'biesoficial', 'verificado', 'administrador', 'admin', 'equipo', 'equipobies', 'ayuda',
            'prensa', 'pagos', 'contacto', 'seguridad', 'moderador', 'soporte.ana', 'biessoporte', 'ayudabies', 'bies.pagos']) {
            expect(isReservedNip05(name), name).toBe(true);
        }
    });

    it('sees through digits and separators', () => {
        for (const name of ['0fficial', 'b1essupport', 'bies-supp0rt', 's.u.p.p.o.r.t', 'adm1n', '5oporte', 'b.i.e.s.m.i.k.e', 'mike-bies']) {
            expect(isReservedNip05(name), name).toBe(true);
        }
    });

    it("leaves members' own names alone", () => {
        for (const name of ['ana.lopez', 'adminton', 'biesta', 'mikel', 'camila', 'ericka', 'luisa', 'matteo', 'buildyourfuture', 'nelsonia', 'polo', 'tanmor', 'glu']) {
            expect(isReservedNip05(name), name).toBe(false);
        }
    });
});

describe('names given up', () => {
    const now = Date.parse('2026-11-02T12:00:00Z');
    const day = 24 * 60 * 60 * 1000;
    const released = (ago: number, extra = {}) => ({ pubkey: 'a'.repeat(64), releasedAt: new Date(now - ago), blocked: false, ...extra });

    it('are held from others for 90 days, but not from the key that had them', () => {
        expect(isHeldNip05(released(day), 'b'.repeat(64), now)).toBe(true);
        expect(isHeldNip05(released(day), null, now)).toBe(true);
        expect(isHeldNip05(released(day), 'a'.repeat(64), now)).toBe(false);
        expect(isHeldNip05(released(RELEASED_HOLD_MS), 'b'.repeat(64), now)).toBe(false);
        expect(isHeldNip05(null, 'b'.repeat(64), now)).toBe(false);
    });

    it('a deleted account\'s name is held from everyone for 90 days', () => {
        expect(isHeldNip05(released(day, { pubkey: null }), 'a'.repeat(64), now)).toBe(true);
    });

    it('one an admin took away is held from everyone, its owner too, for good', () => {
        expect(isHeldNip05(released(day, { blocked: true }), 'a'.repeat(64), now)).toBe(true);
        expect(isHeldNip05(released(400 * day, { blocked: true }), 'b'.repeat(64), now)).toBe(true);
    });
});
