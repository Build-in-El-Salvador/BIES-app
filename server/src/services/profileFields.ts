/**
 * The Edit profile fields kept beside the ones the rest of BIES reads:
 *
 * - First and last name. `name` is them joined, and stays what's shown and
 *   searched. They're kept as typed, so "Mary Ann" + "Smith" opens as it was
 *   saved. When `name` changed some other way (an app from before them, the
 *   first-run name screen, an admin), they're split from it again: the first
 *   word, then the rest.
 * - "What you do": one role or more, each a title and a company. The first is
 *   the headline, copied into `title` and `company` (member cards, search,
 *   older app builds), and an older build saving those changes the first only.
 * - Instagram and the member's own links (label + link).
 * - Sections switched off in Edit profile: hidden from everyone else (as if
 *   empty), kept for when they're switched back on. Experience uses
 *   showExperience, which older builds already switch.
 */

export const HIDEABLE_SECTIONS = ['links', 'projects', 'custom', 'tags'] as const;
export type HideableSection = (typeof HIDEABLE_SECTIONS)[number];

export const MAX_ROLES = 10;
export const MAX_CUSTOM_LINKS = 10;

export type Role = { title: string; company: string };
export type CustomLink = { label: string; url: string };

const parse = (raw: unknown): unknown => {
    if (typeof raw !== 'string') return raw;
    try { return JSON.parse(raw || 'null'); } catch { return null; }
};
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** The name a Nostr sign-in gets until the member chooses one ("nostr:1a2b3c4d"). */
const isPlaceholder = (name: string) => !name.trim() || name.trim().startsWith('nostr:');

export function joinName(first: string | null | undefined, last: string | null | undefined): string {
    return [first, last].map((part) => (part || '').trim()).filter(Boolean).join(' ').slice(0, 100);
}

/** A whole name as first and last: the first word, then the rest. */
export function splitName(name: string | null | undefined): { firstName: string; lastName: string } {
    const clean = (name || '').trim().replace(/\s+/g, ' ');
    if (isPlaceholder(clean)) return { firstName: '', lastName: '' };
    const space = clean.indexOf(' ');
    return space < 0
        ? { firstName: clean, lastName: '' }
        : { firstName: clean.slice(0, space), lastName: clean.slice(space + 1) };
}

/** The first and last name to show in Edit profile: as saved, unless `name` has moved on since. */
export function namePartsOf(profile: { name?: string | null; firstName?: string | null; lastName?: string | null }) {
    const name = (profile.name || '').trim();
    if (isPlaceholder(name)) return { firstName: '', lastName: '' };
    if (joinName(profile.firstName, profile.lastName) === name.replace(/\s+/g, ' ')) {
        return { firstName: (profile.firstName || '').trim(), lastName: (profile.lastName || '').trim() };
    }
    return splitName(name);
}

/** Roles as sent: trimmed, the empty ones gone, ten at most. */
export function cleanRoles(raw: unknown): Role[] {
    const list = Array.isArray(raw) ? raw : [];
    return list
        .map((r) => ({ title: text(r?.title, 200), company: text(r?.company, 200) }))
        .filter((r) => r.title || r.company)
        .slice(0, MAX_ROLES);
}

/** A profile's roles: the saved list, or the one title and company it had before there were more. */
export function rolesOf(profile: { roles?: unknown; title?: string | null; company?: string | null }): Role[] {
    const saved = cleanRoles(parse(profile.roles));
    if (saved.length) return saved;
    return cleanRoles([{ title: profile.title, company: profile.company }]);
}

const isWebLink = (url: string) => {
    try {
        const { protocol } = new URL(url);
        return protocol === 'https:' || protocol === 'http:';
    } catch {
        return false;
    }
};

/** A member's own links: a label and a web link each (http or https only), ten at most. */
export function cleanCustomLinks(raw: unknown): CustomLink[] {
    const list = Array.isArray(parse(raw)) ? (parse(raw) as unknown[]) : [];
    return list
        .map((l: any) => ({ label: text(l?.label, 40), url: text(l?.url, 2000) }))
        .filter((l) => l.url && isWebLink(l.url))
        .slice(0, MAX_CUSTOM_LINKS);
}

export function hiddenSectionsOf(raw: unknown): Set<HideableSection> {
    const list = parse(raw);
    return new Set(
        (Array.isArray(list) ? list : []).filter((s): s is HideableSection => (HIDEABLE_SECTIONS as readonly unknown[]).includes(s)),
    );
}

/** The Edit profile fields, as the profile routes send them. */
export function editFieldsOf(profile: Record<string, any>) {
    return {
        ...namePartsOf(profile),
        roles: rolesOf(profile),
        customLinks: cleanCustomLinks(profile.customLinks),
        hiddenSections: [...hiddenSectionsOf(profile.hiddenSections)],
    };
}

/**
 * What a save changes, worked out from what was sent and the profile before
 * it (`data` is the picked request fields; this edits it in place).
 */
export function applyEditFields(
    data: Record<string, any>,
    old: { name?: string | null; firstName?: string | null; lastName?: string | null; roles?: string | null; title?: string | null; company?: string | null } | null,
): void {
    // Names: from first and last when sent; a new whole name splits.
    if (data.firstName !== undefined || data.lastName !== undefined) {
        const before = old ? namePartsOf(old) : { firstName: '', lastName: '' };
        const firstName = text(data.firstName ?? before.firstName, 50);
        const lastName = text(data.lastName ?? before.lastName, 50);
        const name = joinName(firstName, lastName);
        if (name) Object.assign(data, { firstName, lastName, name });
        else { delete data.firstName; delete data.lastName; } // a name is never emptied here
    } else if (typeof data.name === 'string') {
        const before = old ? namePartsOf(old) : { firstName: '', lastName: '' };
        if (data.name.trim().replace(/\s+/g, ' ') !== joinName(before.firstName, before.lastName)) {
            Object.assign(data, splitName(data.name));
        }
    }

    // Roles: the list when sent (the first is the headline); a title or
    // company alone (an app from before) changes the first role only.
    if (data.roles !== undefined) {
        const roles = cleanRoles(data.roles);
        data.roles = JSON.stringify(roles);
        data.title = roles[0]?.title ?? '';
        data.company = roles[0]?.company ?? '';
    } else if (data.title !== undefined || data.company !== undefined) {
        const roles = old ? rolesOf(old) : [];
        const first = { title: data.title ?? roles[0]?.title ?? '', company: data.company ?? roles[0]?.company ?? '' };
        data.roles = JSON.stringify(cleanRoles([first, ...roles.slice(1)]));
    }

    if (data.instagram !== undefined) data.instagram = text(data.instagram, 200);
    if (data.customLinks !== undefined) data.customLinks = JSON.stringify(cleanCustomLinks(data.customLinks));
    if (data.hiddenSections !== undefined) data.hiddenSections = JSON.stringify([...hiddenSectionsOf(data.hiddenSections)]);
}
