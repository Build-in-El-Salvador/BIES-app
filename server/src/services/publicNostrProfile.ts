/**
 * A member's profile on public Nostr (Settings → Nostr → Public profile).
 *
 * BIES always keeps a member's Nostr profile (kind 0) on its members' relay.
 * Public Nostr is off until the member switches it on. Then BIES also sends
 * a profile to public relays, with only the parts the member ticked, and it
 * sends it again whenever they change their BIES profile.
 *
 * Many members used Nostr before BIES, so the public profile isn't
 * rebuilt from BIES: it starts from the newest one on public relays, and
 * only the ticked parts change. An @name, website or Lightning address set
 * in another app stays unless the member ticked that part.
 */
import { config } from '../config';
import { isClaimedNip05, nip05Address, NIP05_DOMAIN } from './nip05';

export const PUBLIC_PARTS = ['name', 'picture', 'banner', 'about', 'website', 'lightning', 'nip05'] as const;
export type PublicPart = (typeof PUBLIC_PARTS)[number];

// Ticked when a member first switches it on: who they are, not how to reach
// or pay them (website and Lightning are members-only on BIES by default).
export const DEFAULT_PARTS: PublicPart[] = ['name', 'picture', 'banner', 'about', 'nip05'];

export type PublicNostr = { on: boolean; parts: PublicPart[]; publishedAt: string | null };

/** The stored JSON (Profile.publicNostr) as settings: anything unknown is dropped. */
export function publicNostrOf(raw: unknown): PublicNostr {
    let stored: Record<string, unknown> = {};
    if (typeof raw === 'string') {
        try { stored = JSON.parse(raw || '{}'); } catch { stored = {}; }
    } else if (raw && typeof raw === 'object') {
        stored = raw as Record<string, unknown>;
    }
    const parts = Array.isArray(stored.parts)
        ? PUBLIC_PARTS.filter((p) => (stored.parts as unknown[]).includes(p))
        : [...DEFAULT_PARTS];
    return {
        on: stored.on === true,
        parts,
        publishedAt: typeof stored.publishedAt === 'string' ? stored.publishedAt : null,
    };
}

type BiesProfile = {
    name?: string | null; bio?: string | null; avatar?: string | null; banner?: string | null;
    website?: string | null; nip05Name?: string | null; lightningAddress?: string | null; bolt12Offer?: string | null;
};

// Photos uploaded to BIES may be stored as "/uploads/…": other apps need the full address.
function absolute(url: string | null | undefined): string {
    if (!url) return '';
    return url.startsWith('/') ? `${config.appPublicUrl}${url}` : url;
}

/**
 * The public profile to publish: the one on public relays now (`current`,
 * the content of its kind 0, or null when there's none), with the ticked
 * parts taken from BIES. A ticked part BIES has no value for is removed.
 * Pure.
 */
export function publicProfileContent(
    current: Record<string, unknown> | null,
    profile: BiesProfile,
    parts: readonly PublicPart[],
): Record<string, unknown> {
    const out: Record<string, unknown> = { ...(current || {}) };
    const set = (key: string, value: string | null | undefined) => {
        if (value) out[key] = value;
        else delete out[key];
    };
    const ticked = new Set(parts);

    if (ticked.has('name')) {
        set('display_name', profile.name);
        // The @name is the member's handle in other apps: BIES fills it only
        // when there's none.
        if (!out.name) set('name', profile.name);
    }
    if (ticked.has('picture')) set('picture', absolute(profile.avatar));
    if (ticked.has('banner')) set('banner', absolute(profile.banner));
    if (ticked.has('about')) set('about', profile.bio);
    if (ticked.has('website')) set('website', profile.website);
    if (ticked.has('lightning')) {
        const address = profile.lightningAddress || '';
        const lnurl = address.toLowerCase().startsWith('lnurl1');
        set('lud16', lnurl ? '' : address);
        set('lud06', lnurl ? address : '');
        set('bolt12', profile.bolt12Offer);
    }
    if (ticked.has('nip05')) {
        if (isClaimedNip05(profile.nip05Name)) {
            set('nip05', nip05Address(profile.nip05Name!));
        } else if (typeof out.nip05 === 'string' && out.nip05.toLowerCase().endsWith(`@${NIP05_DOMAIN}`)
            && out.nip05.toLowerCase() !== nip05Address(profile.nip05Name || '')) {
            // A BIES address the member no longer has. One from another
            // domain is theirs to keep.
            delete out.nip05;
        }
    }
    return out;
}
