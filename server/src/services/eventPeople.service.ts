import prisma from '../lib/prisma';
import { z } from 'zod';
import { listingsActedFor, runsListing } from '../controllers/listingTeam.controller';
import { blockedEitherWay } from './moderation.service';
import { createNotification } from './notification.service';
import { ownsUploads } from './uploads.service';

/**
 * Who's behind an event: its host (a member, or a business or farm they act
 * for), its co-hosts and its sponsors, and who may edit it.
 *
 * - The host member created it. Hosting as a business needs them to run
 *   it or be on its team (listingTeam.controller). An event hosted as the
 *   listing marked as BIES's own page is a BIES event.
 * - Co-hosts and sponsors are members, businesses or farms on BIES, or
 *   someone not on BIES (a name, a logo and a link). Each is told when
 *   added, and can take their name off.
 * - The host, co-hosts (a member, or anyone acting for a co-host business),
 *   anyone acting for the host business, and admins edit it. Sponsors don't.
 */

export const PARTNER_ROLES = ['COHOST', 'SPONSOR'] as const;
export const MAX_PARTNERS = 12;

const webLink = z.string().trim().max(2000)
    .refine((v) => v === '' || /^https:\/\//i.test(v), { message: 'Links must start with https://' });

export const partnerSchema = z.object({
    role: z.enum(PARTNER_ROLES),
    userId: z.string().max(64).optional(),
    listingId: z.string().max(64).optional(),
    name: z.string().trim().max(80).optional(),
    logo: z.string().max(500).optional(),
    url: webLink.optional(),
}).refine((p) => [p.userId, p.listingId, p.name].filter(Boolean).length === 1, {
    message: 'A co-host or sponsor is a member, a business, or a name',
});

export type PartnerInput = z.infer<typeof partnerSchema>;

const ACTIVE = { isBanned: false, deletedAt: null };
const LIVE = { status: 'active', isPublished: true };

const personSelect = { id: true, nostrPubkey: true, profile: { select: { name: true, avatar: true } } };
const listingSelect = { id: true, name: true, type: true, category: true, logo: true, photo: true, isOfficial: true };

/** Prisma include for an event's people, as the app shows them. */
export const EVENT_PEOPLE = {
    host: { select: personSelect },
    hostListing: { select: listingSelect },
    partners: {
        orderBy: [{ position: 'asc' as const }, { createdAt: 'asc' as const }],
        include: {
            user: { select: { ...personSelect, isBanned: true, deletedAt: true } },
            listing: { select: { ...listingSelect, status: true, isPublished: true } },
        },
    },
};

type PartnerRow = {
    id: string; role: string; userId: string | null; listingId: string | null;
    name: string; logo: string; url: string;
    user: { id: string; nostrPubkey: string | null; profile: { name: string; avatar: string } | null; isBanned: boolean; deletedAt: Date | null } | null;
    listing: { id: string; name: string; type: string; category: string; logo: string; photo: string; isOfficial: boolean; status: string; isPublished: boolean } | null;
};

/**
 * Co-hosts and sponsors as the viewer sees them: none suspended, deleted
 * or blocked either way, no listing that isn't live.
 */
export type PartnerView =
    | { id: string; role: string; kind: 'member'; userId: string; nostrPubkey: string | null; name: string; image: string }
    | { id: string; role: string; kind: 'listing'; listingId: string; listingType: string; name: string; image: string }
    | { id: string; role: string; kind: 'other'; name: string; image: string; url: string };

export function partnersFor(rows: PartnerRow[], hidden: Set<string>): PartnerView[] {
    return rows.flatMap((p): PartnerView[] => {
        if (p.userId) {
            if (!p.user || p.user.isBanned || p.user.deletedAt || hidden.has(p.userId)) return [];
            return [{ id: p.id, role: p.role, kind: 'member', userId: p.userId, nostrPubkey: p.user.nostrPubkey, name: p.user.profile?.name || '', image: p.user.profile?.avatar || '' }];
        }
        if (p.listingId) {
            if (!p.listing || p.listing.status !== 'active' || !p.listing.isPublished) return [];
            return [{ id: p.id, role: p.role, kind: 'listing', listingId: p.listingId, listingType: p.listing.type, name: p.listing.name, image: p.listing.logo || p.listing.photo || '' }];
        }
        return [{ id: p.id, role: p.role, kind: 'other', name: p.name, image: p.logo, url: p.url }];
    });
}

/** The listings `userId` acts for, as ids. */
export async function actedForIds(userId: string): Promise<string[]> {
    return (await listingsActedFor(userId)).map((l) => l.id);
}

type EventRef = { id: string; hostId: string; hostListingId: string | null };
type Viewer = { id: string; isAdmin?: boolean } | undefined;

/** May edit the event: its host, a co-host, the host business's people, or an admin. */
export async function canEditEvent(event: EventRef, user: Viewer, acted?: string[]): Promise<boolean> {
    if (!user) return false;
    if (user.isAdmin || event.hostId === user.id) return true;
    const mine = acted ?? await actedForIds(user.id);
    if (event.hostListingId && mine.includes(event.hostListingId)) return true;
    const cohost = await prisma.eventPartner.findFirst({
        where: { eventId: event.id, role: 'COHOST', OR: [{ userId: user.id }, ...(mine.length ? [{ listingId: { in: mine } }] : [])] },
        select: { id: true },
    });
    return !!cohost;
}

/** May delete the event: its host, the host business's people, or an admin (not co-hosts). */
export async function canDeleteEvent(event: EventRef, user: Viewer, acted?: string[]): Promise<boolean> {
    if (!user) return false;
    if (user.isAdmin || event.hostId === user.id) return true;
    const mine = acted ?? await actedForIds(user.id);
    return !!event.hostListingId && mine.includes(event.hostListingId);
}

export class PartnerError extends Error {
    constructor(message: string, public reason: string) { super(message); }
}

/**
 * Check the co-hosts and sponsors an edit sends, as `me` saves them. Logos
 * of people not on BIES are BIES uploads of this member, or ones the event
 * already shows. Returns rows to store (in order), without duplicates.
 */
export async function checkPartners(me: string, inputs: PartnerInput[], opts: { hostListingId: string | null; eventId?: string }) {
    if (inputs.length > MAX_PARTNERS) throw new PartnerError(`At most ${MAX_PARTNERS} co-hosts and sponsors`, 'too_many_partners');
    const keptLogos = new Set(opts.eventId
        ? (await prisma.eventPartner.findMany({ where: { eventId: opts.eventId }, select: { logo: true } })).map((p) => p.logo).filter(Boolean)
        : []);
    const seen = new Set<string>();
    const rows: Array<{ role: string; userId: string | null; listingId: string | null; name: string; logo: string; url: string; position: number }> = [];
    for (const p of inputs) {
        const key = p.userId ? `u:${p.userId}` : p.listingId ? `l:${p.listingId}` : `n:${(p.name || '').toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (p.userId) {
            const user = await prisma.user.findFirst({ where: { id: p.userId, ...ACTIVE }, select: { id: true } });
            if (!user) throw new PartnerError('Member not found', 'no_member');
            if (p.userId !== me && await blockedEitherWay(me, p.userId)) throw new PartnerError('You can\'t add this member', 'blocked');
        } else if (p.listingId) {
            if (p.listingId === opts.hostListingId) continue; // it's the host already
            const listing = await prisma.directoryListing.findFirst({ where: { id: p.listingId, ...LIVE }, select: { id: true } });
            if (!listing) throw new PartnerError('Business not found', 'no_listing');
        } else {
            const logo = p.logo || '';
            if (logo && !keptLogos.has(logo) && !await ownsUploads(me, [logo])) throw new PartnerError('Use a logo you uploaded', 'logo_not_yours');
        }
        rows.push({
            role: p.role,
            userId: p.userId || null,
            listingId: p.listingId || null,
            name: p.userId || p.listingId ? '' : (p.name || '').trim(),
            logo: p.userId || p.listingId ? '' : (p.logo || ''),
            url: p.userId || p.listingId ? '' : (p.url || ''),
            position: rows.length,
        });
    }
    return rows;
}

/** The member who runs a listing, to hear about it (none for a listing only recommended). */
async function runnerOf(listingId: string): Promise<string | null> {
    const l = await prisma.directoryListing.findUnique({ where: { id: listingId }, select: { ownerId: true, memberUserId: true, isOwnBusiness: true } });
    if (!l) return null;
    return l.memberUserId ?? (runsListing(l, l.ownerId) ? l.ownerId : null);
}

/**
 * Tell newly added co-hosts and sponsors (a member, or the member who runs
 * a business) that they're on the event. `before` are the rows it had.
 */
export async function notifyNewPartners(
    me: string,
    event: { id: string; title: string },
    hostName: string,
    rows: Array<{ role: string; userId: string | null; listingId: string | null }>,
    before: Array<{ userId: string | null; listingId: string | null }> = [],
): Promise<void> {
    const had = new Set(before.map((p) => p.userId ? `u:${p.userId}` : `l:${p.listingId}`));
    const told = new Set<string>();
    for (const p of rows) {
        if (!p.userId && !p.listingId) continue;
        if (had.has(p.userId ? `u:${p.userId}` : `l:${p.listingId}`)) continue;
        const to = p.userId || (p.listingId ? await runnerOf(p.listingId) : null);
        if (!to || to === me || told.has(to)) continue;
        told.add(to);
        const listingName = p.listingId
            ? (await prisma.directoryListing.findUnique({ where: { id: p.listingId }, select: { name: true } }))?.name
            : null;
        const who = listingName || 'you';
        const what = p.role === 'COHOST' ? 'a co-host' : 'a sponsor';
        await createNotification({
            userId: to,
            type: 'SYSTEM',
            title: `${hostName} added ${who} as ${what} of ${event.title}`,
            body: p.role === 'COHOST' && p.userId
                ? 'You can edit the event too. To take your name off, open the event.'
                : 'To take the name off, open the event.',
            data: { link: `/events/${event.id}`, eventId: event.id, actorId: me },
        }).catch((err) => console.error('[Events] Partner notification failed:', err));
    }
}

/** The name an event goes by: its host business, or the host member. */
export function hostNameOf(event: { hostListing?: { name: string } | null; host?: { profile: { name: string } | null } | null }): string {
    const name = event.hostListing?.name || event.host?.profile?.name || '';
    return name && !name.startsWith('nostr:') ? name : 'A BIES member';
}
