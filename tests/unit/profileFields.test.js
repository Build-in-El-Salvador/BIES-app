/**
 * Edit profile's fields as the edit page and the profile page read them
 * (src/utils/profileFields.js).
 *
 * Run: npm run test:unit   (node --test; no network)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    asOthersSeeIt, customLinksOf, hiddenSectionsOf, instagramLink, joinName, namePartsOf, profileStrength, rolesOf,
} from '../../src/utils/profileFields.js';

test('names: as the server sends them, or split from an older profile', () => {
    assert.deepEqual(namePartsOf({ name: 'Mary Ann Smith', firstName: 'Mary Ann', lastName: 'Smith' }), { firstName: 'Mary Ann', lastName: 'Smith' });
    assert.deepEqual(namePartsOf({ name: 'Ana Beltrán López' }), { firstName: 'Ana', lastName: 'Beltrán López' });
    assert.deepEqual(namePartsOf({ name: 'nostr:1a2b3c4d' }), { firstName: '', lastName: '' });
    assert.equal(joinName(' Ana ', ''), 'Ana');
    assert.equal(joinName('Ana', 'Beltrán'), 'Ana Beltrán');
});

test('roles: the list, or the one title and company from before', () => {
    assert.deepEqual(rolesOf({ roles: [{ title: 'Founder', company: 'X' }, { title: '', company: '' }] }), [{ title: 'Founder', company: 'X' }]);
    assert.deepEqual(rolesOf({ title: 'Architect', company: '' }), [{ title: 'Architect', company: '' }]);
    assert.deepEqual(rolesOf({}), []);
});

test('switched-off sections: what others see, and Experience from showExperience', () => {
    const profile = {
        hiddenSections: ['links', 'tags', 'nonsense'], showExperience: false,
        website: 'https://a.example', instagram: '@a', customLinks: [{ label: 'A', url: 'https://a.example' }],
        tags: ['x'], experience: [{ title: 'Lead' }], customSections: [{ type: 'TEXT', body: 'hi' }], location: 'El Zonte',
    };
    assert.deepEqual([...hiddenSectionsOf(profile)].sort(), ['experience', 'links', 'tags']);
    const seen = asOthersSeeIt(profile);
    assert.equal(seen.website, '');
    assert.equal(seen.instagram, '');
    assert.deepEqual(seen.customLinks, []);
    assert.deepEqual(seen.tags, []);
    assert.deepEqual(seen.experience, []);
    assert.equal(seen.customSections.length, 1); // still on
    assert.equal(seen.location, 'El Zonte');
});

test('Instagram: a handle, a link, or nothing safe', () => {
    assert.deepEqual(instagramLink('@cafe.cumbre'), { href: 'https://instagram.com/cafe.cumbre', label: '@cafe.cumbre' });
    assert.deepEqual(instagramLink('instagram.com/cafecumbre'), { href: 'https://instagram.com/cafecumbre', label: '@cafecumbre' });
    assert.deepEqual(instagramLink('https://www.instagram.com/cafecumbre/'), { href: 'https://www.instagram.com/cafecumbre/', label: '@cafecumbre' });
    assert.equal(instagramLink(''), null);
    assert.equal(instagramLink('not a handle!'), null);
    assert.equal(instagramLink('javascript:alert(1)'), null);
});

test('your own links: web links only, with the site as the label when there is none', () => {
    assert.deepEqual(customLinksOf({ customLinks: [
        { label: 'YouTube', url: 'https://youtube.com/@a' },
        { label: '', url: 'https://www.blog.example.org/' },
        { label: 'Bad', url: 'javascript:alert(1)' },
    ] }), [
        { label: 'YouTube', url: 'https://youtube.com/@a' },
        { label: 'blog.example.org', url: 'https://www.blog.example.org/' },
    ]);
});

test('profile strength: the share done, and what to add next', () => {
    assert.deepEqual(profileStrength({ roles: [], experience: [], customLinks: [] }), { percent: 0, next: 'photo' });
    const some = profileStrength({ avatar: '/u/a.jpg', roles: [{ title: 'Founder' }], location: 'X', bio: '', customLinks: [], experience: [] });
    assert.deepEqual(some, { percent: 50, next: 'about' });
    const all = profileStrength({
        avatar: 'a', roles: [{ title: 'F' }], location: 'X', bio: 'Hi', instagram: '@a', customLinks: [], experience: [{ title: 'Lead' }],
    });
    assert.deepEqual(all, { percent: 100, next: null });
});
