import { moderationApi } from './api';

/**
 * The members this member blocked. The server hides them everywhere it
 * serves content; the app hides them where content comes straight from Nostr
 * (the Feed, messages), by pubkey. Held per signed-in member, so another
 * account on the same device never sees this list.
 */

export const EMPTY = { userId: null, loaded: false, members: [], ids: new Set(), pubkeys: new Set() };
let state = EMPTY;
let pending = null;
const listeners = new Set();

function set(userId, members) {
    state = {
        userId,
        loaded: true,
        members,
        ids: new Set(members.map((m) => m.id)),
        pubkeys: new Set(members.map((m) => m.nostrPubkey).filter(Boolean)),
    };
    listeners.forEach((fn) => fn());
}

/** Load (or reload) the list for this member. */
export function loadBlocks(userId) {
    if (!userId) {
        if (state !== EMPTY) { state = EMPTY; listeners.forEach((fn) => fn()); }
        return Promise.resolve();
    }
    if (pending?.userId === userId) return pending.promise;
    const promise = moderationApi.blocks()
        .then((res) => { if (pending?.promise === promise) set(userId, res.data || []); })
        .catch(() => { /* The server still hides them; try again next time. */ })
        .finally(() => { if (pending?.promise === promise) pending = null; });
    pending = { userId, promise };
    return promise;
}

/**
 * Block a member, by `{ userId }` or `{ pubkey }`. Rejects with reason
 * `not_member` for a pubkey that isn't a BIES member.
 */
export async function block(userId, target) {
    const res = await moderationApi.block(target);
    pending = null;
    await loadBlocks(userId);
    return res;
}

export async function unblock(userId, blockedId) {
    await moderationApi.unblock(blockedId);
    pending = null;
    await loadBlocks(userId);
}

export function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export const getBlocks = () => state;
