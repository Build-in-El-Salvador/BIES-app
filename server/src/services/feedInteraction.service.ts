/**
 * What a Feed notification ("liked your post", "replied to your comment")
 * may say, checked against BIES's relay before anyone is told. The post or
 * comment it's about has to be the told member's, and the actor's own like
 * or reply to it has to be there. A reply's words come from that reply,
 * never from the request, so the notification can't carry other text.
 */
import type { Event as NostrEvent } from 'nostr-tools/pure';
import { queryPrivateRelay } from './nostr.service';

export type FeedInteractionType = 'POST_COMMENT' | 'POST_LIKE' | 'COMMENT_LIKE' | 'COMMENT_REPLY';

export interface FeedInteractionClaim {
    type: FeedInteractionType;
    actorPubkey: string;
    targetPubkey: string;
    /** The post or comment acted on: liked, or replied to. */
    eventId: string;
    /** What the app says the reply said; used only where nothing can be checked. */
    claimedText?: string;
}

const isLike = (type: FeedInteractionType) => type === 'POST_LIKE' || type === 'COMMENT_LIKE';
const refersTo = (event: NostrEvent, id: string) => event.tags.some((t) => t[0] === 'e' && t[1] === id);

/**
 * `{ text }` to notify with (text only for a reply, from the reply itself),
 * or null when there's nothing true to tell. Without a private relay (a
 * development server) nothing can be checked, and the claim is taken as it
 * is. A relay that doesn't answer tells no one.
 */
export async function checkFeedInteraction(claim: FeedInteractionClaim): Promise<{ text?: string } | null> {
    try {
        const target = await queryPrivateRelay({ ids: [claim.eventId], limit: 1 });
        if (target === null) return { text: isLike(claim.type) ? undefined : claim.claimedText };
        if (!target.some((e) => e.id === claim.eventId && e.pubkey === claim.targetPubkey)) return null;

        const own = await queryPrivateRelay({
            kinds: [isLike(claim.type) ? 7 : 1],
            authors: [claim.actorPubkey],
            '#e': [claim.eventId],
            limit: 10,
        });
        const latest = (own ?? [])
            .filter((e) => e.pubkey === claim.actorPubkey && refersTo(e, claim.eventId))
            .sort((a, b) => b.created_at - a.created_at)[0];
        if (!latest) return null;
        return isLike(claim.type) ? {} : { text: latest.content };
    } catch (err) {
        console.error('[Feed] Checking a feed notification failed:', err);
        return null;
    }
}
