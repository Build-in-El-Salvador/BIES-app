/**
 * Who sees what on a member's profile (Settings → Privacy).
 *
 * Name, profile photo, cover photo and headline (title and company) are
 * public, as on Facebook. The bio is public unless the member makes it
 * members-only. Location, links, details and the network are for members,
 * or for the member alone. Applied per viewer after the shared profile
 * cache (profile.controller.ts), so one cached profile serves everyone.
 */

export type Viewer = 'self' | 'member' | 'public';

export const PRIVACY_CHOICES = {
    bio: ['PUBLIC', 'MEMBERS'],
    location: ['MEMBERS', 'ONLY_ME'],
    links: ['MEMBERS', 'ONLY_ME'],
    details: ['MEMBERS', 'ONLY_ME'],
    network: ['MEMBERS', 'ONLY_ME'],
} as const;

export type PrivacyKey = keyof typeof PRIVACY_CHOICES;
export type Privacy = { [K in PrivacyKey]: (typeof PRIVACY_CHOICES)[K][number] };

export const PRIVACY_DEFAULTS: Privacy = {
    bio: 'PUBLIC',
    location: 'MEMBERS',
    links: 'MEMBERS',
    details: 'MEMBERS',
    network: 'MEMBERS',
};

/** The stored JSON as settings: unknown or invalid values take the default. */
export function privacyOf(raw: unknown): Privacy {
    let stored: Record<string, unknown> = {};
    if (typeof raw === 'string') {
        try { stored = JSON.parse(raw || '{}'); } catch { stored = {}; }
    } else if (raw && typeof raw === 'object') {
        stored = raw as Record<string, unknown>;
    }
    const out = { ...PRIVACY_DEFAULTS } as Record<PrivacyKey, string>;
    for (const key of Object.keys(PRIVACY_CHOICES) as PrivacyKey[]) {
        const value = stored[key];
        if (typeof value === 'string' && (PRIVACY_CHOICES[key] as readonly string[]).includes(value)) out[key] = value;
    }
    return out as Privacy;
}

// The fields each setting covers, with what they read as when hidden.
const HIDDEN_AS: Record<'location' | 'links' | 'details', Record<string, unknown>> = {
    location: { location: '' },
    links: { website: '', twitter: '', linkedin: '', github: '', lightningAddress: '', bolt12Offer: '', coinosUsername: null, nip05Name: null },
    details: {
        experience: [], customSections: [], biesProjects: [], skills: [], tags: [], lookingFor: [],
        investmentFocus: [], investmentStage: [], minTicket: null, maxTicket: null, portfolioCount: 0,
    },
};

// All a signed-out visitor gets, at most.
const PUBLIC_FIELDS = ['id', 'userId', 'name', 'avatar', 'banner', 'title', 'company', 'bio', 'isPublic', 'createdAt'];

/** Who is looking at a member's profile: themselves, another member, or anyone. */
export function viewerFor(viewerId: string | null | undefined, memberId: string | null | undefined): Viewer {
    if (!viewerId) return 'public';
    return viewerId === memberId ? 'self' : 'member';
}

/**
 * A member's profile as it appears inside something else (a listing's
 * member, a course's author, a project's owner): select its \`privacy\` too,
 * and this applies the member's settings as on their own profile page.
 */
export function nestedProfileForViewer<T extends { id?: string; profile?: Record<string, any> | null }>(user: T | null | undefined, viewerId: string | null | undefined): T | null | undefined {
    if (!user?.profile) return user;
    return { ...user, profile: profileForViewer(user.profile, viewerFor(viewerId, user.id)) };
}

/** Whether this viewer may see the member's followers and following. */
export function canSeeNetwork(privacy: Privacy, viewer: Viewer): boolean {
    return viewer === 'self' || (viewer === 'member' && privacy.network === 'MEMBERS');
}

/**
 * A profile (parsed, as the profile routes send it) as this viewer may see
 * it. `networkHidden` tells the app the follower lists are private.
 */
export function profileForViewer<T extends Record<string, any>>(profile: T, viewer: Viewer): Record<string, any> {
    const privacy = privacyOf(profile.privacy);
    if (viewer === 'self') return { ...profile, privacy };

    if (viewer === 'public') {
        const out: Record<string, any> = {};
        for (const field of PUBLIC_FIELDS) if (field in profile) out[field] = profile[field];
        if (privacy.bio !== 'PUBLIC') out.bio = '';
        if (profile.user) out.user = { id: profile.user.id, nostrPubkey: profile.user.nostrPubkey };
        out.networkHidden = true;
        return out;
    }

    const out: Record<string, any> = { ...profile };
    delete out.privacy;
    for (const key of ['location', 'links', 'details'] as const) {
        if (privacy[key] === 'ONLY_ME') Object.assign(out, HIDDEN_AS[key]);
    }
    out.networkHidden = !canSeeNetwork(privacy, viewer);
    return out;
}

/**
 * Whether a search term matches what this viewer can see of the profile, so
 * a search can't find a member by a hidden location or bio.
 */
export function matchesVisibly(profile: Record<string, any>, term: string, viewer: Viewer): boolean {
    const shown = profileForViewer(profile, viewer);
    const text = [shown.name, shown.title, shown.company, shown.bio, shown.location]
        .filter((v) => typeof v === 'string')
        .join(' ')
        .toLowerCase();
    return text.includes(term.toLowerCase());
}
