import { isPlaceholderName } from './profileComplete.js';

/**
 * The letter shown for a member without a photo (components/InitialAvatar.jsx):
 * the first letter or digit of their name, upper-cased. '' (so a person figure
 * is shown instead) when there's no name, it's the "nostr:1a2b3c4d" a Nostr
 * sign-in gets until they choose one, or it starts with a symbol or emoji.
 */
export function initialOf(name) {
    if (isPlaceholderName(name)) return '';
    const first = Array.from(String(name).trim())[0] || '';
    return /^[\p{L}\p{N}]$/u.test(first) ? first.toLocaleUpperCase() : '';
}
