/**
 * Who a business or farm listing is to a member: the member who runs it,
 * and how the member who added it is connected to it (the three choices on
 * the Add a business form). As runnerId / runsListing on the server
 * (listingTeam.controller.ts).
 */

/** addedAs for a listing added by someone who works there ("I work there"). */
export const ADDED_AS_STAFF = 'STAFF';

/**
 * The id of the member who runs the listing: its linked member when staff
 * linked one; otherwise the member who added it, when they added it as their
 * own business (not as someone who works there). Null when nobody does.
 */
export function runnerIdOf(listing) {
    if (!listing) return null;
    if (listing.memberUserId) return listing.memberUserId;
    return listing.isOwnBusiness && listing.addedAs !== ADDED_AS_STAFF ? listing.ownerId || null : null;
}

/** Whether `userId` runs the listing (and so manages its team). */
export const runsListing = (listing, userId) => !!userId && runnerIdOf(listing) === userId;

/** The member who runs it, as GET /directory/:id sends them (memberUser or owner), or null. */
export function runnerOf(listing) {
    if (!listing) return null;
    if (listing.memberUserId) return listing.memberUser || null;
    return runnerIdOf(listing) ? listing.owner || null : null;
}

/** Whether `userId` is on the listing's team, as GET /directory/:id sends it (to members). */
export const onTeam = (listing, userId) =>
    !!userId && Array.isArray(listing?.team) && listing.team.some((m) => m?.userId === userId);

/**
 * The adder's connection, as the form asks it: 'customer' (they recommend
 * it), 'owner' (it's their business) or 'staff' (they work there).
 */
export function connectionOf(listing) {
    if (!listing?.isOwnBusiness) return 'customer';
    return listing.addedAs === ADDED_AS_STAFF ? 'staff' : 'owner';
}

/** The listing fields for a connection the form picked. */
export const connectionFields = (connection) => ({
    isOwnBusiness: connection === 'owner' || connection === 'staff',
    addedAs: connection === 'staff' ? ADDED_AS_STAFF : '',
});

/**
 * The listings a member works at, for "Works at" on their profile: those
 * the server says they work at (`teamListings`: GET /directory?worksAt=, a
 * team they're on by their own doing), less the ones they run and any in
 * `shown` (already on the profile another way), each once.
 */
export function worksAt(teamListings, userId, shown = []) {
    const skip = new Set(shown.filter(Boolean).map((l) => l.id));
    const out = [];
    for (const l of Array.isArray(teamListings) ? teamListings : []) {
        if (!l?.id || skip.has(l.id) || runsListing(l, userId)) continue;
        skip.add(l.id);
        out.push(l);
    }
    return out;
}
