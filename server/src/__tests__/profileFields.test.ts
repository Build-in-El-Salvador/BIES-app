/** services/profileFields.ts and the Nostr profile BIES publishes (profilePrivacy.ts). */
import { describe, it, expect } from 'vitest';
import { applyEditFields, cleanCustomLinks, joinName, namePartsOf, rolesOf, splitName } from '../services/profileFields';
import { nostrProfileFor, PRIVACY_DEFAULTS } from '../services/profilePrivacy';

describe('names', () => {
    it('split at the first space, and join without stray spaces', () => {
        expect(splitName('  Ana   Beltrán López ')).toEqual({ firstName: 'Ana', lastName: 'Beltrán López' });
        expect(splitName('Murphslife')).toEqual({ firstName: 'Murphslife', lastName: '' });
        expect(splitName('nostr:1a2b3c4d')).toEqual({ firstName: '', lastName: '' });
        expect(joinName(' Mary Ann ', '')).toBe('Mary Ann');
        expect(joinName('', 'Smith')).toBe('Smith');
    });

    it('open as saved while they still make the name', () => {
        expect(namePartsOf({ name: 'Mary Ann Smith', firstName: 'Mary Ann', lastName: 'Smith' })).toEqual({ firstName: 'Mary Ann', lastName: 'Smith' });
        expect(namePartsOf({ name: 'Someone Else', firstName: 'Mary Ann', lastName: 'Smith' })).toEqual({ firstName: 'Someone', lastName: 'Else' });
    });
});

describe('a save', () => {
    it('makes the name from its parts, and the headline from the first role', () => {
        const data: Record<string, any> = { firstName: 'Ana', lastName: 'Beltrán', roles: [{ title: 'Founder', company: 'X' }, { title: 'Mentor' }] };
        applyEditFields(data, null);
        expect(data.name).toBe('Ana Beltrán');
        expect([data.title, data.company]).toEqual(['Founder', 'X']);
        expect(JSON.parse(data.roles)).toEqual([{ title: 'Founder', company: 'X' }, { title: 'Mentor', company: '' }]);
    });

    it('with no roles left, empties the headline', () => {
        const data: Record<string, any> = { roles: [] };
        applyEditFields(data, { title: 'Old', company: 'Co' });
        expect([data.title, data.company, data.roles]).toEqual(['', '', '[]']);
    });

    it("keeps only web links", () => {
        expect(cleanCustomLinks([{ label: 'A', url: 'https://a.example' }, { label: 'B', url: 'javascript:alert(1)' }, { url: '' }]))
            .toEqual([{ label: 'A', url: 'https://a.example' }]);
        expect(rolesOf({ roles: 'not json', title: 'T', company: '' })).toEqual([{ title: 'T', company: '' }]);
    });
});

describe('the Nostr profile', () => {
    it('leaves the links out when Links & Social is off, but not the BIES address', () => {
        const profile = { name: 'Ana', website: 'https://a.example', lightningAddress: 'ana@getalby.com', nip05Name: 'ana', hiddenSections: '["links"]' };
        const out = nostrProfileFor(profile, PRIVACY_DEFAULTS);
        expect([out.website, out.lud16]).toEqual(['', '']);
        expect(out.nip05).toContain('ana@');
        const on = nostrProfileFor({ ...profile, hiddenSections: '[]' }, PRIVACY_DEFAULTS);
        expect([on.website, on.lud16]).toEqual(['https://a.example', 'ana@getalby.com']);
    });
});
