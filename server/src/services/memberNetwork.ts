import { Prisma } from '@prisma/client';
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

type NetworkRow = { member: string; other: string; known: number | bigint; total: number | bigint; youFollow: number | bigint };

export async function networkPreviews(viewerId: string, cards: NetworkCard[], hidden: string[]): Promise<Map<string, NetworkPreview>> {
    const out = new Map<string, NetworkPreview>();
    for (const c of cards) if (c.networkHidden) out.set(c.userId, { hidden: true, followers: c.followers ?? 0 });
    const open = cards.filter((c) => !c.networkHidden).map((c) => c.userId);
    if (!open.length) return out;

    // Counted in the database, so a member with thousands of followers costs
    // the server CANDIDATES + 1 rows, not thousands. One row per person in a
    // member's network (followers and following, each person once); `known`
    // when they follow the member and the viewer follows them. Both ends of
    // each follow must be active and not blocked: a member on this page may
    // have been suspended or blocked since the shared list was cached.
    // Faces in order: people the viewer follows, newest follow of the member
    // first; then anyone, newest follow either way first; ties by follow id.
    const shown = (column: string) => (hidden.length ? Prisma.sql`AND ${Prisma.raw(column)} NOT IN (${Prisma.join(hidden)})` : Prisma.empty);
    const rows = await prisma.$queryRaw<NetworkRow[]>`
        WITH links AS (
            SELECT f.following_id AS member, f.follower_id AS other, f.created_at AS at, f.id AS link, 1 AS follows_them
            FROM follows f WHERE f.following_id IN (${Prisma.join(open)})
            UNION ALL
            SELECT f.follower_id, f.following_id, f.created_at, f.id, 0
            FROM follows f WHERE f.follower_id IN (${Prisma.join(open)})
        ),
        latest AS (
            SELECT links.*, MAX(at) OVER (PARTITION BY member, other) AS last_at FROM links
        ),
        network AS (
            SELECT l.member, l.other,
                   MAX(l.at) AS at, MIN(CASE WHEN l.at = l.last_at THEN l.link END) AS link,
                   MAX(CASE WHEN l.follows_them = 1 THEN l.at END) AS followed_at,
                   MIN(CASE WHEN l.follows_them = 1 THEN l.link END) AS followed_link,
                   MAX(CASE WHEN l.follows_them = 1 AND mine.id IS NOT NULL THEN 1 ELSE 0 END) AS known
            FROM latest l
            JOIN users m ON m.id = l.member AND m.is_banned = false AND m.deleted_at IS NULL
            JOIN users o ON o.id = l.other AND o.is_banned = false AND o.deleted_at IS NULL
            LEFT JOIN follows mine ON mine.follower_id = ${viewerId} AND mine.following_id = l.other
            WHERE 1 = 1 ${shown('l.member')} ${shown('l.other')}
            GROUP BY l.member, l.other
        )
        SELECT member, other, known, total, "youFollow" FROM (
            SELECT member, other, known,
                   COUNT(*) OVER (PARTITION BY member) AS total,
                   SUM(known) OVER (PARTITION BY member) AS "youFollow",
                   ROW_NUMBER() OVER (
                       PARTITION BY member
                       ORDER BY known DESC, other = ${viewerId},
                                CASE WHEN known = 1 THEN followed_at ELSE at END DESC,
                                CASE WHEN known = 1 THEN followed_link ELSE link END
                   ) AS n
            FROM network
        ) ranked
        WHERE n <= ${CANDIDATES + 1}`;

    // Faces: people the viewer follows, else anyone in the network but the viewer.
    const byMember = new Map<string, NetworkRow[]>(open.map((id) => [id, []]));
    for (const row of rows) byMember.get(row.member)?.push(row);
    const candidates = new Map(open.map((id) => {
        const theirs = byMember.get(id)!;
        const youFollow = Number(theirs[0]?.youFollow ?? 0);
        const people = theirs.filter((r) => r.other !== viewerId && (!youFollow || Number(r.known) === 1)).map((r) => r.other);
        return [id, people.slice(0, CANDIDATES)];
    }));
    const ids = [...new Set([...candidates.values()].flat())];
    const profiles = ids.length
        ? await prisma.profile.findMany({ where: { userId: { in: ids } }, select: { userId: true, name: true, avatar: true } })
        : [];
    const byId = new Map(profiles.map((p) => [p.userId, p]));

    for (const id of open) {
        const first = byMember.get(id)![0];
        const named = candidates.get(id)!
            .map((p) => byId.get(p))
            .filter((p): p is NonNullable<typeof p> => !!p && realName(p.name));
        const people = [...named.filter((p) => p.avatar), ...named.filter((p) => !p.avatar)]
            .slice(0, FACES)
            .map((p) => ({ id: p.userId, name: p.name, avatar: p.avatar || null }));
        out.set(id, { hidden: false, total: Number(first?.total ?? 0), youFollow: Number(first?.youFollow ?? 0), people });
    }
    return out;
}
