/**
 * Edit profile's fields, as the edit page and the profile page read them
 * (the server's side: server/src/services/profileFields.ts).
 *
 * - "What you do": roles, each a title and a company; the first is the
 *   headline on member cards. Profiles from before have one title + company.
 * - Sections a member switched off are hidden from everyone else (the server
 *   leaves them out) and from their own profile page, but kept.
 */
import { isPlaceholderName } from './profileComplete.js';

/** The sections with a switch, in the order Edit profile shows them. */
export const SECTIONS = ['links', 'experience', 'projects', 'custom', 'tags'];
// Those the server keeps in hiddenSections (Experience uses showExperience).
const HIDEABLE = ['links', 'projects', 'custom', 'tags'];

export const MAX_ROLES = 10;
export const MAX_CUSTOM_LINKS = 10;

const str = (v) => (typeof v === 'string' ? v.trim() : '');

export function joinName(first, last) {
    // A name is 100 characters at most (the server's limit), however long each half.
    return [first, last].map(str).filter(Boolean).join(' ').slice(0, 100);
}

/** First and last name to start the form with (the server sends them; older servers don't). */
export function namePartsOf(profile = {}) {
    if (typeof profile.firstName === 'string' || typeof profile.lastName === 'string') {
        return { firstName: str(profile.firstName), lastName: str(profile.lastName) };
    }
    const name = str(profile.name).replace(/\s+/g, ' ');
    if (isPlaceholderName(name)) return { firstName: '', lastName: '' };
    const space = name.indexOf(' ');
    return space < 0 ? { firstName: name, lastName: '' } : { firstName: name.slice(0, space), lastName: name.slice(space + 1) };
}

/** A profile's roles: its list, or the one title and company it had before. */
export function rolesOf(profile = {}) {
    const list = Array.isArray(profile.roles) && profile.roles.length
        ? profile.roles
        : [{ title: profile.title, company: profile.company }];
    return list.map((r) => ({ title: str(r?.title), company: str(r?.company) })).filter((r) => r.title || r.company);
}

/** The sections switched off on this profile. */
export function hiddenSectionsOf(profile = {}) {
    const hidden = new Set(Array.isArray(profile.hiddenSections) ? profile.hiddenSections.filter((s) => HIDEABLE.includes(s)) : []);
    if (profile.showExperience === false) hidden.add('experience');
    return hidden;
}

/** A profile as others see it, for its member's own page: switched-off sections left out, as the server does. */
export function asOthersSeeIt(profile) {
    if (!profile) return profile;
    const hidden = hiddenSectionsOf(profile);
    const out = { ...profile };
    if (hidden.has('links')) Object.assign(out, { website: '', twitter: '', linkedin: '', instagram: '', customLinks: [], lightningAddress: '', bolt12Offer: '' });
    if (hidden.has('experience')) out.experience = [];
    if (hidden.has('projects')) out.biesProjects = [];
    if (hidden.has('custom')) out.customSections = [];
    if (hidden.has('tags')) out.tags = [];
    return out;
}

export function isWebLink(url) {
    try {
        const { protocol } = new URL(url);
        return protocol === 'http:' || protocol === 'https:';
    } catch {
        return false;
    }
}

/**
 * "@handle", "handle" or the member's instagram.com link, as the Instagram
 * link and how it reads. Anything else (another site's link, "@cafe cumbre")
 * isn't shown: the Instagram icon only ever opens instagram.com.
 */
export function instagramLink(value) {
    const raw = str(value);
    if (!raw) return null;
    const link = raw.match(/^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([^/?#]+)\/?(?:[?#].*)?$/i);
    const handle = (link ? link[1] : raw).replace(/^@+/, '');
    if (!/^[A-Za-z0-9._]{1,30}$/.test(handle)) return null;
    return { href: `https://instagram.com/${handle}`, label: `@${handle}` };
}

/** A member's own links that are safe to show: label (or the site) and a web link. */
export function customLinksOf(profile = {}) {
    return (Array.isArray(profile.customLinks) ? profile.customLinks : [])
        .filter((l) => l && isWebLink(l.url))
        .map((l) => ({ url: l.url, label: str(l.label) || l.url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '') }));
}

/**
 * How complete a profile is, for Edit profile's meter: the share of these
 * filled in, and the first one missing (the "Next:" it suggests).
 */
export const STRENGTH_STEPS = ['photo', 'role', 'location', 'about', 'links', 'experience'];
export function profileStrength(form) {
    const done = {
        photo: !!str(form.avatar),
        role: rolesOf(form).length > 0,
        location: !!str(form.location),
        about: !!str(form.bio),
        links: [form.website, form.twitter, form.linkedin, form.instagram].some((v) => !!str(v))
            || (Array.isArray(form.customLinks) && form.customLinks.some((l) => str(l?.url))),
        experience: Array.isArray(form.experience) && form.experience.some((e) => str(e?.title) || str(e?.company)),
    };
    const count = STRENGTH_STEPS.filter((s) => done[s]).length;
    return {
        percent: Math.round((count / STRENGTH_STEPS.length) * 100),
        next: STRENGTH_STEPS.find((s) => !done[s]) || null,
    };
}
