import prisma from '../lib/prisma';

/**
 * The network line on a member card (Members → Cards), for one viewer:
 * how many people the member is connected to either way, as their profile's
 * Network counts them, and up to three faces. People the viewer follows come
 * first ("Followed by Ana and 6 others you follow"), as on Instagram and
 * Facebook; with none of those, anyone in their network.
 *
 * The same people the follower lists show: members blocked either way,
 * suspended and deleted members are left out. A member who keeps their
 * network to themselves (Settings → Privacy: Network) shows only their
 * follower count, with no one named, as the follower lists answer.
 */

export type NetworkFace = { id: string; name: string; avatar: string | null };
export type NetworkPreview =
    | { hidden: true; followers: number }
    | { hidden: false; total: number; youFollow: number; people: NetworkFace[] };

export type NetworkCard = { userId: string; networkHidden?: boolean; followers?: number };

const FACES = 3;
// Looked up per member to find FACES with a real name, photos first.
const CANDIDATES = 8;

// A name the app shows: not blank, and not the nostr: placeholder of an unfinished profile.
const realName = (name: string | null | undefined): name is string => !!name?.trim() && !name.startsWith('nostr:');

export async function networkPreviews(viewerId: string, cards: NetworkCard[], hidden: string[]): Promise<Map<string, NetworkPreview>> {
    const out = new Map<string, NetworkPreview>();
    for (const c of cards) if (c.networkHidden) out.set(c.userId, { hidden: true, followers: c.followers ?? 0 });
    const open = cards.filter((c) => !c.networkHidden).map((c) => c.userId);
    if (!open.length) return out;

    // Both ends of each follow: a member on this page may have been suspended
    // or blocked since the shared list was cached.
    const active = { isBanned: false, deletedAt: null };
    const shown = hidden.length ? { followerId: { notIn: hidden }, followingId: { notIn: hidden } } : {};
    const [mine, links] = await Promise.all([
        prisma.follow.findMany({ where: { followerId: viewerId }, select: { followingId: true } }),
        prisma.follow.findMany({
            where: {
                follower: active,
                following: active,
                ...shown,
                OR: [{ followingId: { in: open } }, { followerId: { in: open } }],
            },
            select: { followerId: true, followingId: true },
            orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        }),
    ]);
    const iFollow = new Set(mine.map((f) => f.followingId));

    // Each member's network (newest connections first), and their followers the viewer follows.
    const network = new Map<string, Set<string>>(open.map((id) => [id, new Set<string>()]));
    const known = new Map<string, string[]>(open.map((id) => [id, []]));
    for (const { followerId, followingId } of links) {
        const theirs = network.get(followingId);
        if (theirs) {
            theirs.add(followerId);
            if (iFollow.has(followerId)) known.get(followingId)!.push(followerId);
        }
        network.get(followerId)?.add(followingId);
    }

    // Faces: people the viewer follows, else anyone in the network but the viewer.
    const candidates = new Map(open.map((id) => {
        const people = known.get(id)!.length ? known.get(id)! : [...network.get(id)!].filter((p) => p !== viewerId);
        return [id, people.slice(0, CANDIDATES)];
    }));
    const ids = [...new Set([...candidates.values()].flat())];
    const profiles = ids.length
        ? await prisma.profile.findMany({ where: { userId: { in: ids } }, select: { userId: true, name: true, avatar: true } })
        : [];
    const byId = new Map(profiles.map((p) => [p.userId, p]));

    for (const id of open) {
        const named = candidates.get(id)!
            .map((p) => byId.get(p))
            .filter((p): p is NonNullable<typeof p> => !!p && realName(p.name));
        const people = [...named.filter((p) => p.avatar), ...named.filter((p) => !p.avatar)]
            .slice(0, FACES)
            .map((p) => ({ id: p.userId, name: p.name, avatar: p.avatar || null }));
        out.set(id, { hidden: false, total: network.get(id)!.size, youFollow: known.get(id)!.length, people });
    }
    return out;
}
