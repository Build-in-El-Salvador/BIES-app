import { isPlaceholderName } from './profileComplete.js';

/**
 * The letter shown for a member without a photo (components/InitialAvatar.jsx):
 * the first letter or digit of their name, upper-cased. '' (so a person figure
 * is shown instead) when there's no name, it isn't text, it's the
 * "nostr:1a2b3c4d" a Nostr sign-in gets until they choose one, it's a key
 * (npub1…, hex), or it starts with a symbol or emoji.
 */
export function initialOf(name) {
    // Nostr profiles can hold anything: only text is a name.
    if (typeof name !== 'string' || isPlaceholderName(name)) return '';
    // A key shown in place of a name (npub1…, hex) isn't one either.
    if (/^(npub1|nprofile1)/i.test(name.trim()) || /^[0-9a-f]{16,}/i.test(name.trim())) return '';
    const first = Array.from(name.trim())[0] || '';
    return /^[\p{L}\p{N}]$/u.test(first) ? first.toLocaleUpperCase() : '';
}
