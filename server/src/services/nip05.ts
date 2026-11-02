/**
 * BIES addresses: name@buildinelsalvador.com, a member's NIP-05 identifier,
 * served by nip05.controller.ts.
 *
 * Having one is what "verified" means in BIES: a member claims a name in
 * Settings → Nostr and other Nostr apps show it with a tick. Until November
 * 2026 every new member was given one at sign-up, made from their key
 * ("nostr-1a2b3c4d"). Those still work, so nothing breaks in other apps,
 * but they don't count as verified: only a name the member chose does.
 */

export const NIP05_DOMAIN = 'buildinelsalvador.com';

// The addresses sign-up used to hand out: "nostr-" and 8 hex characters of
// the key, with a number added if that was taken.
const GIVEN_AT_SIGNUP = /^nostr-[0-9a-f]{8}\d*$/;

/** A name that looks like one sign-up handed out: members can't claim it. */
export function looksGivenAtSignup(name: string): boolean {
    return GIVEN_AT_SIGNUP.test(name);
}

/** Whether the member chose this name: a verified BIES address. */
export function isClaimedNip05(name: string | null | undefined): boolean {
    return !!name && !GIVEN_AT_SIGNUP.test(name);
}

export function nip05Address(name: string): string {
    return `${name}@${NIP05_DOMAIN}`;
}
