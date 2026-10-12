/**
 * The BIES Trust Score of a directory listing: members' vouches minus their
 * downvotes. At TRUSTED_THRESHOLD or more, a live listing is BIES Trusted
 * (isCertified); certifiedAt is set when it gets there and cleared if it
 * drops back.
 *
 * Votes that don't count: those of whoever runs the business (the linked
 * member, or the member who added it as their own business), and those of
 * banned or deleted accounts. The controller refuses the first kind; they
 * are left out here too in case a listing changed hands after the vote.
 */

import prisma from '../lib/prisma';

export const TRUSTED_THRESHOLD = 5;

/** Recompute one listing's counts, score and BIES Trusted status. Missing listings are ignored. */
export async function recomputeListingScore(listingId: string): Promise<void> {
    const listing = await prisma.directoryListing.findUnique({
        where: { id: listingId },
        select: {
            status: true, isCertified: true, ownerId: true, memberUserId: true, isOwnBusiness: true,
            endorsements: {
                where: { user: { isBanned: false, deletedAt: null } },
                select: { userId: true, vote: true },
            },
        },
    });
    if (!listing) return;

    const runsIt = new Set([listing.memberUserId, listing.isOwnBusiness ? listing.ownerId : null].filter(Boolean));
    const counted = listing.endorsements.filter((e) => !runsIt.has(e.userId));
    const vouchCount = counted.filter((e) => e.vote > 0).length;
    const downvoteCount = counted.filter((e) => e.vote < 0).length;
    const score = vouchCount - downvoteCount;

    const isCertified = listing.status === 'active' && score >= TRUSTED_THRESHOLD;
    const data: {
        reputationScore: number; vouchCount: number; downvoteCount: number;
        isCertified: boolean; certifiedAt?: Date | null;
    } = { reputationScore: score, vouchCount, downvoteCount, isCertified };
    if (isCertified && !listing.isCertified) data.certifiedAt = new Date();
    if (!isCertified && listing.isCertified) data.certifiedAt = null;

    await prisma.directoryListing.update({ where: { id: listingId }, data });
}

/**
 * Recompute every listing (sequential). Per-listing failures are logged and
 * do not abort the run.
 */
export async function recomputeAllScores(): Promise<void> {
    const listings = await prisma.directoryListing.findMany({ select: { id: true } });
    for (const { id } of listings) {
        try {
            await recomputeListingScore(id);
        } catch (error) {
            console.error(`[DirectoryReputation] Failed to recompute listing ${id}:`, error);
        }
    }
}
