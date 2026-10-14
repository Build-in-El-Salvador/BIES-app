import { moderationApi } from './api';

/**
 * The members this member blocked. The server hides them everywhere it
 * serves content; the app hides them where content comes straight from Nostr
 * (the Feed, messages), by pubkey. Blocking works both ways: `pubkeys` also
 * holds the members who blocked this one (`hiddenPubkeys` from the server),
 * whose posts are hidden too; `members` (Settings → Blocked members) lists
 * only those this member blocked. Held per signed-in member, so another
 * account on the same device never sees this list.
 */

export const EMPTY = { userId: null, loaded: false, error: false, members: [], hidden: [], ids: new Set(), pubkeys: new Set() };
let state = EMPTY;
let pending = null;
const listeners = new Set();

function set(userId, members, { error = false, hidden = state.userId === userId ? state.hidden : [] } = {}) {
    state = {
        userId,
        loaded: true,
        error,
        members,
        hidden,
        ids: new Set(members.map((m) => m.id)),
        pubkeys: new Set([...members.map((m) => m.nostrPubkey), ...hidden].filter(Boolean)),
    };
    listeners.forEach((fn) => fn());
}

const membersOf = (userId) => (state.userId === userId ? state.members : []);

/** Load (or reload) the list for this member. */
export function loadBlocks(userId) {
    if (!userId) {
        if (state !== EMPTY) { state = EMPTY; listeners.forEach((fn) => fn()); }
        return Promise.resolve();
    }
    if (pending?.userId === userId) return pending.promise;
    const promise = moderationApi.blocks()
        .then((res) => { if (pending?.promise === promise) set(userId, res.data || [], { hidden: res.hiddenPubkeys || [] }); })
        // The server still hides them. Keep what we had, and say it failed.
        .catch(() => { if (pending?.promise === promise) set(userId, membersOf(userId), { error: true }); })
        .finally(() => { if (pending?.promise === promise) pending = null; });
    pending = { userId, promise };
    return promise;
}

/**
 * Block a member, by `{ userId }` or `{ pubkey }`. Rejects with reason
 * `not_member` for a pubkey that isn't a BIES member. Their posts are hidden
 * at once, before the list reloads.
 */
export async function block(userId, target) {
    const res = await moderationApi.block(target);
    if (res?.member && !membersOf(userId).some((m) => m.id === res.member.id)) {
        set(userId, [{ ...res.member, blockedAt: new Date().toISOString() }, ...membersOf(userId)]);
    }
    pending = null;
    await loadBlocks(userId);
    return res;
}

export async function unblock(userId, blockedId) {
    await moderationApi.unblock(blockedId);
    set(userId, membersOf(userId).filter((m) => m.id !== blockedId));
    pending = null;
    await loadBlocks(userId);
}

export function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export const getBlocks = () => state;
