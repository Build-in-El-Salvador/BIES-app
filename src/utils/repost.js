import { verifyEvent } from 'nostr-tools/pure';

/**
 * A repost carries the post it shares, as JSON its reposter wrote. Show it
 * only if that post is signed by its author and is the one the repost names.
 */
export function isGenuineRepost(repost, original) {
    if (!original || typeof original !== 'object' || original.kind !== 1 || !original.content) return false;
    const named = repost.tags.find((t) => t[0] === 'e')?.[1];
    if (named && named !== original.id) return false;
    // A fresh copy: verifyEvent trusts a "verified" mark cached on the object.
    const { id, pubkey, created_at, kind, tags, content, sig } = original;
    try {
        return verifyEvent({ id, pubkey, created_at, kind, tags, content, sig });
    } catch {
        return false;
    }
}
