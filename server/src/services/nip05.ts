/**
 * BIES addresses: name@buildinelsalvador.com, a member's NIP-05 identifier,
 * served by nip05.controller.ts.
 *
 * Having one is what "verified" means in BIES: a member claims a name in
 * Settings → Nostr and other Nostr apps show it with a tick. Until November
 * 2026 every new member was given one at sign-up, made from their key
 * ("nostr-1a2b3c4d"). Those still work, so nothing breaks in other apps,
 * but they don't count as verified: only a name the member claimed does,
 * and the claim is recorded when they make it (Profile.nip05ClaimedAt).
 *
 * Names that would pass for BIES, its team or its staff are kept
 * (isReservedNip05), and a name someone gives up is held for a while before
 * anyone else can claim it (isHeldNip05, the released_nip05 table).
 */

export const NIP05_DOMAIN = 'buildinelsalvador.com';

// The addresses sign-up used to hand out: "nostr-" and 8 hex characters of
// the key, with a number added if that was taken.
const GIVEN_AT_SIGNUP = /^nostr-[0-9a-f]{8}\d*$/;

/** A name that looks like one sign-up handed out: members can't claim it. */
export function looksGivenAtSignup(name: string): boolean {
    return GIVEN_AT_SIGNUP.test(name);
}

/** Whether the member claimed their BIES address: what makes them verified. */
export function isClaimedNip05(profile: { nip05Name?: string | null; nip05ClaimedAt?: Date | string | null } | null | undefined): boolean {
    return !!profile?.nip05Name && profile.nip05ClaimedAt != null;
}

export function nip05Address(name: string): string {
    return `${name}@${NIP05_DOMAIN}`;
}

// ─── Names kept for BIES ─────────────────────────────────────────────────────
//
// A claimed name shows as verified, on BIES and in other Nostr apps, so a
// name that would read as BIES itself, its team or its staff speaking is
// kept: only admins can take one. Names are compared as they read
// (normaliseNip05): "m1ke", "mi.ke" and "mike_" are all "mike".

// Whole names.
const PROTECTED_NAMES = [
    // BIES and its staff, in English…
    'admin', 'administrator', 'root', 'support', 'help', 'info', 'contact', 'hello', 'team', 'staff',
    'mod', 'mods', 'moderator', 'moderators', 'official', 'bies', 'buildinelsalvador', 'security', 'abuse',
    'noreply', 'postmaster', 'hostmaster', 'webmaster', 'billing', 'payments', 'press',
    'media', 'news', 'events', 'legal', 'privacy', 'verify', 'verified', 'system', 'app',
    // …and in Spanish.
    'soporte', 'oficial', 'biesoficial', 'verificado', 'administrador', 'equipo', 'equipobies', 'ayuda',
    'prensa', 'pagos', 'contacto', 'seguridad', 'moderador',
    // The team, by first name and the usual short forms.
    'luis', 'mike', 'michael', 'mattias', 'matt', 'emilio', 'eric', 'nelson', 'edwin', 'cam',
    // The President.
    'bukele', 'nayib',
    // BIES's own: the Buildy bot, headquarters.
    'buildy', 'hq', 'bieshq',
];
// A name with one of these as a part ("bies.support", "admin_mike", "buildy.bot").
const PROTECTED_PARTS = [
    'admin', 'support', 'staff', 'mod', 'moderator', 'official', 'bies', 'security', 'verified', 'buildy',
    'administrador', 'soporte', 'moderador', 'oficial', 'seguridad', 'verificado',
];
// These anywhere in a name ("officialbies", "nayibbukele").
const PROTECTED_WITHIN = [
    'buildinelsalvador', 'official', 'verified', 'moderator',
    'oficial', 'verificado', 'moderador', 'bukele', 'nayib', 'buildybot',
];
// "bies" with one of these ("biessupport", "teambies", "biesmike").
// "biesta" or "adminton" are fine.
const STAFF_WORDS = [
    'admin', 'support', 'staff', 'team', 'mod', 'help', 'info', 'news', 'event', 'app', 'security', 'official', 'hq',
    'soporte', 'oficial', 'equipo', 'ayuda', 'prensa', 'pagos', 'contacto', 'seguridad', 'verificado',
    'luis', 'mike', 'michael', 'mattias', 'matt', 'emilio', 'eric', 'nelson', 'edwin', 'cam',
];

// Digits that pass for letters: "0ff1c1al" reads "official".
const LOOKALIKE_DIGITS: Record<string, string> = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't' };

/** A name as it reads: lowercase, no dots, hyphens or underscores, digits that pass for letters as those letters. */
export function normaliseNip05(name: string): string {
    return name.toLowerCase().replace(/[._-]/g, '').replace(/[013457]/g, (d) => LOOKALIKE_DIGITS[d]);
}

const protectedNames = new Set(PROTECTED_NAMES.map(normaliseNip05));
const protectedParts = new Set(PROTECTED_PARTS);

/** Whether a name is kept for BIES: only admins can claim it. */
export function isReservedNip05(name: string): boolean {
    const plain = normaliseNip05(name);
    if (!plain) return false;
    return protectedNames.has(plain)
        || name.toLowerCase().split(/[._-]/).some((part) => protectedParts.has(normaliseNip05(part)))
        || PROTECTED_WITHIN.some((word) => plain.includes(word))
        || (plain.includes('bies') && STAFF_WORDS.some((word) => plain.replace('bies', ' ').includes(word)));
}

// ─── Names given up ──────────────────────────────────────────────────────────

/** How long a name someone gave up is held: meanwhile only the key that had it can take it back. */
export const RELEASED_HOLD_MS = 90 * 24 * 60 * 60 * 1000;

export type ReleasedName = { pubkey: string | null; releasedAt: Date; blocked: boolean };

/**
 * Whether a name someone gave up is still held from this key: one an admin
 * took away (`blocked`), from everyone; any other, for 90 days, from all
 * but the key that had it.
 */
export function isHeldNip05(released: ReleasedName | null | undefined, pubkey: string | null | undefined, now = Date.now()): boolean {
    if (!released) return false;
    if (released.blocked) return true;
    if (now - released.releasedAt.getTime() >= RELEASED_HOLD_MS) return false;
    return !pubkey || released.pubkey !== pubkey;
}
