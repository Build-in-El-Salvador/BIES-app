import { profilesApi } from '../services/api';

/**
 * Everyone the signed-in member follows, as a Set of user ids, for the
 * Follow buttons on lists of members. (/:id/following gives 50 at a time.)
 * A server from before /me/following-ids gives its first 50 instead.
 */
export async function myFollowingIds(userId) {
    const res = await profilesApi.getMyFollowingIds().catch(() => null);
    if (Array.isArray(res?.ids)) return new Set(res.ids);
    const page = await profilesApi.getFollowing(userId, { limit: 50 });
    const list = Array.isArray(page?.data) ? page.data : Array.isArray(page) ? page : [];
    return new Set(list.map((u) => u.id));
}
