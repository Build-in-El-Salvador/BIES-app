/**
 * Accounts muted on this device: people on Nostr who aren't BIES members,
 * whom Block can't reach on the server (BlockDialog). Their posts and
 * messages are hidden here. Kept per signed-in member, and listed in
 * Settings → Blocked members, where they can be unmuted.
 */

// Before 2026-10 the Feed kept one list for every account on the device.
const LEGACY_KEY = 'bies_muted_users';
const keyFor = (userId) => `bies_muted:${userId}`;

const EMPTY = { userId: null, pubkeys: new Set() };
let state = EMPTY;
const listeners = new Set();

function read(userId) {
    try {
        let raw = localStorage.getItem(keyFor(userId));
        if (raw === null) {
            // The old device-wide list goes to the first account that signs in.
            raw = localStorage.getItem(LEGACY_KEY);
            if (raw !== null) {
                localStorage.setItem(keyFor(userId), raw);
                localStorage.removeItem(LEGACY_KEY);
            }
        }
        const list = JSON.parse(raw || '[]');
        return new Set(Array.isArray(list) ? list : []);
    } catch {
        return new Set();
    }
}

/** `{ userId, pubkeys }` for this member: the same object until it changes. */
export function getMuted(userId) {
    if (!userId) return EMPTY;
    if (state.userId !== userId) state = { userId, pubkeys: read(userId) };
    return state;
}

function write(userId, pubkeys) {
    state = { userId, pubkeys };
    try { localStorage.setItem(keyFor(userId), JSON.stringify([...pubkeys])); } catch { /* kept in memory */ }
    listeners.forEach((fn) => fn());
}

export function mute(userId, pubkey) {
    if (!userId || !pubkey) return;
    write(userId, new Set(getMuted(userId).pubkeys).add(pubkey));
}

export function unmute(userId, pubkey) {
    if (!userId) return;
    const next = new Set(getMuted(userId).pubkeys);
    next.delete(pubkey);
    write(userId, next);
}

export function subscribeMuted(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}
