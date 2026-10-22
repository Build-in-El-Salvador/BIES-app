/**
 * The members who vouch for a listing, the first to recommend it first (a
 * changed vote dates from the change, on the server). Reviews come only to
 * members (GET /directory/:id), so signed out there are none.
 */
export function recommenders(listing) {
    const reviews = Array.isArray(listing?.endorsements) ? listing.endorsements : [];
    return reviews
        .filter((r) => r.vote > 0 && r.user)
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

const hasWords = (r) => !!(r.comment || '').trim();

/**
 * Reviews: what members wrote. A vouch without words shows only under
 * "Recommended by", except the member's own (`mine`), so they can add words
 * or take it back. A downvote always has words (it needs a reason).
 */
export function writtenReviews(reviews, mine) {
    return (Array.isArray(reviews) ? reviews : []).filter((r) => r === mine || hasWords(r));
}

/** How many reviews have words (the Reviews count; the Trust Score counts every vote). */
export const reviewCount = (reviews) => (Array.isArray(reviews) ? reviews : []).filter(hasWords).length;
