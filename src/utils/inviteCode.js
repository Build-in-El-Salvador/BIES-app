/**
 * Invite codes on the device (invite-only sign-up; the rules are the
 * server's, in server/src/services/invite.service.ts).
 *
 * A code looks like BIES-K7M4-Q9TX: 8 characters from 31 letters and digits
 * with the look-alikes (0/O, 1/I/L) left out. Capitals, spaces, dashes and
 * the BIES- in front don't matter when typed.
 *
 * Links carry the code after # (https://app.buildinelsalvador.com/invite#BIES-K7M4-Q9TX),
 * which browsers never send to a server: it stays out of server logs, link
 * previews and Referer headers.
 *
 * Pure module (storage is passed in) so it runs under `node --test`.
 */

export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LENGTH = 8;
const PREFIX = 'BIES';

/** The 8 characters of a code as typed or pasted, or null if it can't be one. */
export function normalizeInviteCode(input) {
    if (typeof input !== 'string' || input.length > 64) return null;
    let body = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (body.length === PREFIX.length + CODE_LENGTH && body.startsWith(PREFIX)) body = body.slice(PREFIX.length);
    if (body.length !== CODE_LENGTH) return null;
    for (const ch of body) if (!CODE_ALPHABET.includes(ch)) return null;
    return body;
}

/** BIES-K7M4-Q9TX from any way of writing it, or null. */
export function formatInviteCode(input) {
    const body = normalizeInviteCode(input);
    return body ? `${PREFIX}-${body.slice(0, 4)}-${body.slice(4)}` : null;
}

/**
 * What the field shows while someone types: capitals, the dashes put in for
 * them, and nothing past the code's length. Characters a code never has are
 * dropped as typed.
 */
export function formatAsTyped(input) {
    let chars = String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (chars.startsWith(PREFIX)) chars = chars.slice(PREFIX.length);
    chars = [...chars].filter((ch) => CODE_ALPHABET.includes(ch)).join('').slice(0, CODE_LENGTH);
    if (!chars) return '';
    return `${PREFIX}-${chars.slice(0, 4)}${chars.length > 4 ? `-${chars.slice(4)}` : ''}`;
}

/** The code in an invite link's #, or null. */
export function inviteCodeFromHash(hash) {
    if (typeof hash !== 'string' || !hash) return null;
    let text = hash.replace(/^#/, '');
    try { text = decodeURIComponent(text); } catch { /* as it is */ }
    return formatInviteCode(text);
}

/** The link to share: the code after #, never in the path. */
export function inviteLink(origin, code) {
    return `${String(origin).replace(/\/+$/, '')}/invite#${formatInviteCode(code)}`;
}

// ─── The code this device is signing up with ────────────────────────────────

const STORAGE_KEY = 'bies_invite';

/**
 * Where the code is kept: this session only (it's gone when the tab or app
 * closes), never in long-lived storage, and forgotten at sign-in and sign-out.
 */
export function inviteStorage() {
    try {
        return typeof sessionStorage === 'undefined' ? null : sessionStorage;
    } catch {
        return null;
    }
}

/** Keep a code that worked until it's used (or expires): sign-up sends it. */
export function rememberInvite(storage, code, expiresAt) {
    const formatted = formatInviteCode(code);
    if (!storage || !formatted) return;
    const expires = Date.parse(expiresAt);
    storage.setItem(STORAGE_KEY, JSON.stringify({ code: formatted, expiresAt: Number.isFinite(expires) ? expires : Date.now() + 7 * 86400000 }));
}

/** { code, expiresAt } kept on this device, or null (an expired one is dropped). */
export function rememberedInvite(storage, now = Date.now()) {
    if (!storage) return null;
    let kept = null;
    try { kept = JSON.parse(storage.getItem(STORAGE_KEY) || 'null'); } catch { kept = null; }
    const code = kept && formatInviteCode(kept.code);
    if (!code || !(kept.expiresAt > now)) {
        storage.removeItem(STORAGE_KEY);
        return null;
    }
    return { code, expiresAt: kept.expiresAt };
}

/** After signing in or making the account: the code isn't needed here any more. */
export function forgetInvite(storage) {
    storage?.removeItem(STORAGE_KEY);
}
