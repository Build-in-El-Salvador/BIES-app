/**
 * A member's profile on public Nostr (Settings → Nostr → Public profile).
 *
 * BIES always keeps a member's Nostr profile (kind 0) on its members' relay.
 * Public Nostr is off until the member switches it on. Then, when they press
 * Publish, BIES also sends a profile to public relays with the parts they
 * ticked, as far as Settings → Privacy allows. From then on it follows
 * changes to those parts of their BIES profile ("follow-ups"): the parts as
 * published, not as ticked since, so nothing new reaches public Nostr until
 * they press Publish again. Switching it off stops the follow-ups until the
 * next Publish.
 *
 * Many members used Nostr before BIES, so the public profile isn't
 * rebuilt from BIES: it starts from the newest one on public relays, and
 * only the ticked parts change. An @name, website or Lightning address set
 * in another app stays unless the member ticked that part. A part they
 * untick (or Privacy hides) loses what BIES itself put there, and only that:
 * BIES keeps what it published (`publishedValues`) to tell them apart.
 */
import { config } from '../config';
import { isClaimedNip05, nip05Address, NIP05_DOMAIN } from './nip05';
import type { Privacy } from './profilePrivacy';

export const PUBLIC_PARTS = ['name', 'picture', 'banner', 'about', 'website', 'lightning', 'nip05'] as const;
export type PublicPart = (typeof PUBLIC_PARTS)[number];

// The fields of a Nostr profile each part fills.
const PART_FIELDS: Record<PublicPart, string[]> = {
    name: ['display_name', 'name'],
    picture: ['picture'],
    banner: ['banner'],
    about: ['about'],
    website: ['website'],
    lightning: ['lud16', 'lud06', 'bolt12'],
    nip05: ['nip05'],
};

// The BIES profile fields each part is made from.
const PART_SOURCES: Record<PublicPart, (keyof BiesProfile)[]> = {
    name: ['name'],
    picture: ['avatar'],
    banner: ['banner'],
    about: ['bio'],
    website: ['website'],
    lightning: ['lightningAddress', 'bolt12Offer'],
    nip05: ['nip05Name', 'nip05ClaimedAt'],
};

// Ticked when a member first switches it on, if BIES has something for it
// and Privacy allows it: who they are, not how to reach or pay them
// (website and Lightning are members-only on BIES by default).
const DEFAULT_CANDIDATES: PublicPart[] = ['name', 'picture', 'banner', 'about', 'nip05'];

/** What BIES put in each field of the public profile it last published. */
export type PublishedValues = Record<string, string>;

export type PublicNostr = {
    on: boolean;
    /** The parts the member ticked; null until they switch it on (defaultParts until then). */
    parts: PublicPart[] | null;
    /** When BIES last published it. */
    publishedAt: string | null;
    /** The parts that Publish showed: what follow-ups keep up to date. Null: no follow-ups until the next Publish. */
    publishedParts: PublicPart[] | null;
    /** The published profile's created_at: a follow-up never builds on an older one. */
    publishedCreatedAt: number | null;
    publishedValues: PublishedValues;
};

const partsOf = (value: unknown): PublicPart[] | null =>
    Array.isArray(value) ? PUBLIC_PARTS.filter((p) => value.includes(p)) : null;

/** The stored JSON (Profile.publicNostr) as settings: anything unknown is dropped. */
export function publicNostrOf(raw: unknown): PublicNostr {
    let stored: Record<string, unknown> = {};
    if (typeof raw === 'string') {
        try { stored = JSON.parse(raw || '{}'); } catch { stored = {}; }
    } else if (raw && typeof raw === 'object') {
        stored = raw as Record<string, unknown>;
    }
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) stored = {};
    const values: PublishedValues = {};
    if (stored.publishedValues && typeof stored.publishedValues === 'object' && !Array.isArray(stored.publishedValues)) {
        for (const [key, value] of Object.entries(stored.publishedValues as Record<string, unknown>)) {
            if (typeof value === 'string') values[key] = value;
        }
    }
    return {
        on: stored.on === true,
        parts: partsOf(stored.parts),
        publishedAt: typeof stored.publishedAt === 'string' ? stored.publishedAt : null,
        publishedParts: partsOf(stored.publishedParts),
        publishedCreatedAt: Number.isInteger(stored.publishedCreatedAt) ? stored.publishedCreatedAt as number : null,
        publishedValues: values,
    };
}

export type BiesProfile = {
    name?: string | null; bio?: string | null; avatar?: string | null; banner?: string | null;
    website?: string | null; nip05Name?: string | null; nip05ClaimedAt?: Date | string | null;
    lightningAddress?: string | null; bolt12Offer?: string | null;
};

/**
 * The parts Settings → Privacy keeps off public Nostr: "Links: Only me" the
 * website, Lightning and BIES address; "Bio: Members" the bio.
 */
export function hiddenByPrivacy(privacy: Pick<Privacy, 'links' | 'bio'>): PublicPart[] {
    return [
        ...(privacy.links === 'ONLY_ME' ? ['website', 'lightning', 'nip05'] as PublicPart[] : []),
        ...(privacy.bio !== 'PUBLIC' ? ['about'] as PublicPart[] : []),
    ];
}

/** The parts as Privacy allows them. */
export function allowedParts(parts: readonly PublicPart[], privacy: Pick<Privacy, 'links' | 'bio'>): PublicPart[] {
    const hidden = hiddenByPrivacy(privacy);
    return parts.filter((p) => !hidden.includes(p));
}

function hasValue(profile: BiesProfile, part: PublicPart): boolean {
    if (part === 'nip05') return isClaimedNip05(profile);
    return PART_SOURCES[part].some((field) => !!profile[field]);
}

/** The parts ticked when the member first switches it on: those BIES has something for that Privacy allows. */
export function defaultParts(profile: BiesProfile, privacy: Pick<Privacy, 'links' | 'bio'>): PublicPart[] {
    return allowedParts(DEFAULT_CANDIDATES, privacy).filter((p) => hasValue(profile, p));
}

/** The ticked parts: as the member chose them, or the defaults until they have. */
export function chosenParts(settings: PublicNostr, profile: BiesProfile, privacy: Pick<Privacy, 'links' | 'bio'>): PublicPart[] {
    return settings.parts ?? defaultParts(profile, privacy);
}

/** The BIES profile fields these parts are made from (a BIES address change always counts: an old one comes off). */
export function sourceFields(parts: readonly PublicPart[]): (keyof BiesProfile)[] {
    return [...new Set<keyof BiesProfile>(['nip05Name', ...parts.flatMap((p) => PART_SOURCES[p])])];
}

// Photos uploaded to BIES may be stored as "/uploads/…": other apps need the full address.
export function publicUrl(url: string | null | undefined): string {
    if (!url) return '';
    return url.startsWith('/') ? `${config.appPublicUrl}${url}` : url;
}

/**
 * The public profile to publish: the one on public relays now (`current`,
 * the content of its kind 0, or null when there's none), with the ticked
 * parts taken from BIES. A ticked part BIES has no value for is removed. A
 * part not ticked loses what BIES published for it (`previous`), where it's
 * still what BIES put there. Returns the profile and what BIES put in it
 * (`values`, to keep as the next `previous`). Pure.
 */
export function buildPublicProfile(
    current: Record<string, unknown> | null,
    profile: BiesProfile,
    parts: readonly PublicPart[],
    previous: PublishedValues = {},
): { content: Record<string, unknown>; values: PublishedValues } {
    const out: Record<string, unknown> = { ...(current || {}) };
    const values: PublishedValues = {};
    const ticked = new Set(parts);

    for (const part of PUBLIC_PARTS) {
        if (ticked.has(part)) continue;
        for (const field of PART_FIELDS[part]) {
            if (typeof previous[field] === 'string' && out[field] === previous[field]) delete out[field];
        }
    }

    const set = (key: string, value: string | null | undefined) => {
        if (value) {
            out[key] = value;
            values[key] = value;
        } else {
            delete out[key];
        }
    };

    if (ticked.has('name')) {
        set('display_name', profile.name);
        // The @name is the member's handle in other apps: BIES fills it only
        // when there's none, or when the one there is BIES's.
        if (!out.name || (typeof previous.name === 'string' && out.name === previous.name)) set('name', profile.name);
    }
    if (ticked.has('picture')) set('picture', publicUrl(profile.avatar));
    if (ticked.has('banner')) set('banner', publicUrl(profile.banner));
    if (ticked.has('about')) set('about', profile.bio);
    if (ticked.has('website')) set('website', profile.website);
    if (ticked.has('lightning')) {
        const address = profile.lightningAddress || '';
        const lnurl = address.toLowerCase().startsWith('lnurl1');
        set('lud16', lnurl ? '' : address);
        set('lud06', lnurl ? address : '');
        set('bolt12', profile.bolt12Offer);
    }
    // A BIES address the member no longer has goes, ticked or not: someone
    // else may claim the name. One from another domain is theirs to keep.
    if (typeof out.nip05 === 'string' && out.nip05.toLowerCase().endsWith(`@${NIP05_DOMAIN}`)
        && out.nip05.toLowerCase() !== nip05Address(profile.nip05Name || '')) {
        delete out.nip05;
    }
    if (ticked.has('nip05') && isClaimedNip05(profile)) set('nip05', nip05Address(profile.nip05Name!));
    return { content: out, values };
}

/** The public profile to publish (buildPublicProfile), without what BIES put in it. */
export function publicProfileContent(
    current: Record<string, unknown> | null,
    profile: BiesProfile,
    parts: readonly PublicPart[],
    previous: PublishedValues = {},
): Record<string, unknown> {
    return buildPublicProfile(current, profile, parts, previous).content;
}

/** Whether two Nostr profiles say the same (the order of their fields aside). */
export function sameProfile(a: Record<string, unknown> | null, b: Record<string, unknown> | null): boolean {
    const sorted = (o: Record<string, unknown> | null) => JSON.stringify(Object.keys(o || {}).sort().map((k) => [k, (o || {})[k]]));
    return sorted(a) === sorted(b);
}
