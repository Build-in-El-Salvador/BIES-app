/**
 * Events controller — community events (meetups, hackathons, demo days).
 * Members only: signed-out visitors get a shared event's preview
 * (preview.controller). Who hosts, co-hosts, sponsors and edits an event:
 * services/eventPeople.service.ts.
 */

import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { z } from 'zod';
import { cache } from '../services/redis.service';
import { publishAnnouncement, publishCalendarEvent, deleteCalendarEvent, publishRSVPEvent, validateCalendarEventData } from '../services/nostr.service';
import { notifyEventRsvp, createNotification } from '../services/notification.service';
import { hiddenFromIds, isStaffUser } from '../services/moderation.service';
import {
    EVENT_PEOPLE, MAX_PARTNERS, PartnerError, actedForIds, canDeleteEvent, canEditEvent, checkPartners,
    hostNameOf, isLiveListing, notifyNewPartners, partnerSchema, partnersFor, samePartners,
} from '../services/eventPeople.service';
import { listingsActedFor, runsListing } from './listingTeam.controller';
import { coverFrameSchema, frameNewCover } from '../utils/coverFrame';
import {
    MAX_OPEN_PROPOSALS, MAX_PROPOSAL, MIN_PROPOSAL, VENUE_SELECT, confirmIfReached, openProposals, proposalStage, tellPeopleIn, venueFor, whenAndWhere,
} from '../services/eventProposals.service';

// ─── Validation ───────────────────────────────────────────────────────────────

// http(s) links only.
const webLink = z.string().trim().max(2000)
    .refine((v) => v === '' || /^https?:\/\//i.test(v), { message: 'Links must start with https://' });

export const createEventSchema = z.object({
    title: z.string().min(1).max(200),
    // Required, except on a proposed meetup (createEvent checks).
    description: z.string().max(20_000),
    category: z.enum(['NETWORKING', 'CONFERENCE', 'WORKSHOP', 'HACKATHON', 'MEETUP', 'DEMO_DAY', 'OTHER']).default('NETWORKING'),
    visibility: z.enum(['PUBLIC', 'LIMITED_SPACES', 'INVITE_ONLY', 'PRIVATE', 'DRAFT']).default('PUBLIC'),
    location: z.string().max(200).optional(),
    isOnline: z.boolean().default(false),
    onlineUrl: webLink.optional(),
    startDate: z.string().max(40), // More lenient, parse in controller
    endDate: z.string().max(40).nullable().optional(), // null on an edit: no end time
    thumbnail: z.string().max(2000).optional().or(z.literal('')),
    coverFrame: coverFrameSchema.optional(),
    // A BIES event's highlight card: another photo (optional) and its position.
    cardImage: z.string().max(2000).optional().or(z.literal('')),
    cardFrame: coverFrameSchema.optional(),
    ticketUrl: webLink.optional(),
    bitcoinUrl: webLink.optional(),
    maxAttendees: z.number().int().optional().nullable(),
    priceSats: z.number().int().min(0).optional().nullable(), // null/0 = free (RSVP-only)
    ticketCapacity: z.number().int().positive().optional().nullable(),
    payoutLightningAddress: z.string().max(320).optional(),
    tags: z.array(z.string().max(60)).max(30).optional(),
    isOfficial: z.boolean().optional(),
    endorsementRequested: z.boolean().optional(),
    guestList: z.array(z.object({ name: z.string().max(200), userId: z.string().max(64).optional() })).max(500).optional(),
    locationName: z.string().max(200).optional(),
    locationAddress: z.string().max(500).optional(),
    locationMapUrl: webLink.optional(),
    customSections: z.array(z.object({
        title: z.string().max(200).default(''),
        type: z.enum(['TEXT', 'PHOTO', 'CAROUSEL', 'GRAPH']).default('TEXT'),
        placement: z.enum(['LEFT', 'RIGHT']).default('LEFT'),
        body: z.string().max(20_000).optional(),
        content: z.string().max(20_000).optional(),
        imageUrl: z.string().max(2000).optional(),
        images: z.array(z.string().max(2000)).max(50).optional(),
        graphType: z.string().max(40).optional(),
        xAxisLabel: z.string().max(200).optional(),
        yAxisLabel: z.string().max(200).optional(),
        dataPoints: z.array(z.object({ label: z.string().max(200), value: z.union([z.string().max(200), z.number()]) })).max(100).optional(),
    })).max(20).optional(),
    nostrPublish: z.enum(['none', 'bies', 'public', 'both']).default('bies'),
    // Host as a business or farm the member runs or is on the team of.
    hostListingId: z.string().max(64).nullable().optional(),
    // What tickets cost, as the host writes it ("Free", "From $25").
    priceLabel: z.string().trim().max(40).optional(),
    partners: z.array(partnerSchema).max(MAX_PARTNERS).optional(),
    // A proposed meetup: it goes ahead once this many members are going
    // (counting the proposer) by decideBy (services/eventProposals.service.ts).
    minAttendees: z.number().int().min(MIN_PROPOSAL).max(MAX_PROPOSAL).nullable().optional(),
    decideBy: z.string().max(40).nullable().optional(),
    // Where it is, when that's a business or farm on BIES (its name, address and map link).
    venueListingId: z.string().max(64).nullable().optional(),
});

// Every field optional, and a field left out stays out: in zod 4, .partial()
// still fills in .default() values, which would reset what an edit didn't send.
export const updateEventSchema = createEventSchema.partial().extend({
    category: createEventSchema.shape.category.removeDefault().optional(),
    visibility: createEventSchema.shape.visibility.removeDefault().optional(),
    isOnline: createEventSchema.shape.isOnline.removeDefault().optional(),
    nostrPublish: createEventSchema.shape.nostrPublish.removeDefault().optional(),
});

// Derive isPublished from visibility
function visibilityToPublished(visibility: string): boolean {
    return visibility !== 'DRAFT' && visibility !== 'PRIVATE';
}

// ─── Controllers ─────────────────────────────────────────────────────────────

const ACTIVE = { isBanned: false, deletedAt: null };
/** In the list: published, and not private or a draft. */
const LISTED = { isPublished: true, visibility: { notIn: ['PRIVATE', 'DRAFT'] } };
/** An event with no end counts as on for 6 hours after it starts. */
const SIX_HOURS = 6 * 3600_000;
const stillOn = (now: Date) => ({ OR: [{ endDate: { gte: now } }, { endDate: null, startDate: { gte: new Date(now.getTime() - SIX_HOURS) } }] });
const over = (now: Date) => ({ OR: [{ endDate: { lt: now } }, { endDate: null, startDate: { lt: new Date(now.getTime() - SIX_HOURS) } }] });
const GOING_COUNT = { _count: { select: { attendees: { where: { status: 'GOING' } } } } };
/** Hosted as BIES's own page, while it's up: a BIES event. */
const OFFICIAL_HOST = { hostListing: { is: { isOfficial: true, status: 'active', isPublished: true } } };
/** Who's behind an event, and the business or farm where it is. */
const EVENT_INCLUDE = { ...EVENT_PEOPLE, venueListing: { select: VENUE_SELECT } };

/**
 * What only the host side changes: tickets and money, who hosts it, who sees
 * it, where people join online, and a BIES event's highlight card (BIES's team).
 */
const HOST_ONLY = [
    'ticketUrl', 'bitcoinUrl', 'priceLabel', 'payoutLightningAddress', 'priceSats', 'ticketCapacity',
    'visibility', 'guestList', 'hostListingId', 'isOnline', 'onlineUrl', 'cardImage', 'cardFrame',
    'minAttendees', 'decideBy',
] as const;
/** A BIES event's highlight card: only events hosted as BIES's own page have one. */
const CARD_FIELDS = ['cardImage', 'cardFrame'] as const;
const asText = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v));
/** Whether a value an edit sends differs from the stored one (JSON lists are stored as text, times as dates). */
const differs = (sent: unknown, stored: unknown): boolean => (stored instanceof Date
    ? new Date(String(sent)).getTime() !== stored.getTime()
    : asText(sent) !== asText(stored));
/** Tickets and money: a member's proposed meetup has none (everyone pays their own). */
const MONEY_FIELDS = ['ticketUrl', 'bitcoinUrl', 'priceSats', 'ticketCapacity', 'payoutLightningAddress'] as const;
/** At least this long between the decide-by time and the start. */
const DECIDE_BEFORE_START = 3600_000;

const EVENT_FIELDS = [
    'title', 'description', 'category', 'visibility',
    'location', 'locationName', 'locationAddress', 'locationMapUrl',
    'isOnline', 'onlineUrl', 'startDate', 'endDate',
    'thumbnail', 'coverFrame', 'cardImage', 'cardFrame', 'ticketUrl', 'bitcoinUrl', 'priceLabel', 'maxAttendees', 'tags',
    'priceSats', 'ticketCapacity', 'payoutLightningAddress',
    'endorsementRequested', 'guestList', 'customSections', 'nostrPublish',
    'minAttendees', 'decideBy',
] as const;

/** The event columns a create or edit sets, in the database's form. */
function eventData(body: Record<string, any>): Record<string, any> {
    const data: Record<string, any> = {};
    for (const field of EVENT_FIELDS) if (body[field] !== undefined) data[field] = body[field];
    if (data.tags !== undefined) data.tags = JSON.stringify(data.tags);
    if (data.guestList !== undefined) data.guestList = JSON.stringify(data.guestList);
    if (data.customSections !== undefined) data.customSections = JSON.stringify(data.customSections);
    if (data.startDate) data.startDate = new Date(data.startDate);
    if (data.endDate !== undefined) data.endDate = data.endDate ? new Date(data.endDate) : null;
    if (data.decideBy) data.decideBy = new Date(data.decideBy);
    return data;
}

const badDate = (d: unknown) => d instanceof Date && Number.isNaN(d.getTime());
const sameTime = (a?: Date | null, b?: Date | null) => (a ? a.getTime() : null) === (b ? b.getTime() : null);

/** Who called a meetup off, for the people in it. */
const calledOffBy = (actorId: string, hostId: string) => (actorId === hostId ? 'The member who proposed it called it off.' : 'It was called off.');

/** Why a proposal's numbers or deadline don't work, if they don't. */
function proposalProblem(min: number, decideBy: Date | null, start: Date, max: number | null | undefined): string | null {
    if (!decideBy || Number.isNaN(decideBy.getTime())) return 'decide_by_missing';
    if (decideBy.getTime() <= Date.now()) return 'decide_by_past';
    if (decideBy.getTime() > start.getTime() - DECIDE_BEFORE_START) return 'decide_by_after_start';
    if (max != null && max < min) return 'max_below_min';
    return null;
}

/** The event columns a tagged business or farm fills: where it is, and its photo when the event has none. */
type Venue = { id: string; name: string; location: string; mapUrl: string; photo: string; coverFrame: string };
/**
 * The event columns a tagged business or farm fills: where it is, its map
 * link and its photo when the event has none of its own. Moving from one
 * tagged place to another, what came from the old one is replaced.
 */
function venueData(venue: Venue, data: Record<string, any>, current?: { thumbnail?: string; locationMapUrl?: string }, old?: Venue | null) {
    data.venueListingId = venue.id;
    data.locationName = venue.name;
    data.locationAddress = venue.location || '';
    data.location = [venue.name, venue.location].filter(Boolean).join(', ');
    const fromOld = (field: 'locationMapUrl' | 'thumbnail', oldValue?: string) => !!oldValue && (data[field] ?? current?.[field]) === oldValue;
    const mapUrl = /^https?:\/\//i.test(venue.mapUrl || '') ? venue.mapUrl : '';
    if (!(data.locationMapUrl ?? current?.locationMapUrl) || fromOld('locationMapUrl', old?.mapUrl)) data.locationMapUrl = mapUrl;
    if (!(data.thumbnail ?? current?.thumbnail) || fromOld('thumbnail', old?.photo)) { data.thumbnail = venue.photo || ''; data.coverFrame = venue.photo ? (venue.coverFrame || '') : ''; }
}

const parseJson = (text: string | null | undefined) => { try { return JSON.parse(text || '[]'); } catch { return []; } };

/** An event as the list shows it (no guest list, payout address or online link). */
function eventCard(e: any, hidden: Set<string>) {
    // Hosted as a business that's since been taken down: neither it nor the BIES tag show.
    const { status: _status, isPublished: _published, ...listing } = isLiveListing(e.hostListing) ? e.hostListing : { status: '', isPublished: false };
    const hostListing = isLiveListing(e.hostListing) ? listing : null;
    return {
        id: e.id, title: e.title, category: e.category, visibility: e.visibility,
        startDate: e.startDate, endDate: e.endDate,
        location: e.location, locationName: e.locationName, isOnline: e.isOnline,
        thumbnail: e.thumbnail, coverFrame: e.coverFrame,
        // The highlight card, for BIES events (the list shows them as cards).
        ...(hostListing?.isOfficial ? { cardImage: e.cardImage, cardFrame: e.cardFrame } : {}),
        ticketUrl: e.ticketUrl, bitcoinUrl: e.bitcoinUrl, priceLabel: e.priceLabel, priceSats: e.priceSats,
        isOfficial: !!hostListing?.isOfficial, isEndorsed: e.isEndorsed, hostId: e.hostId,
        host: e.host, hostListing,
        partners: partnersFor(e.partners || [], hidden),
        goingCount: e._count?.attendees ?? 0,
        maxAttendees: e.maxAttendees,
        // A proposed meetup: where it stands, and what it needs.
        stage: proposalStage(e), minAttendees: e.minAttendees, decideBy: e.decideBy, confirmedAt: e.confirmedAt, calledOffAt: e.calledOffAt,
        venueListing: isLiveListing(e.venueListing)
            ? (({ status: _s, isPublished: _p, ...v }) => v)(e.venueListing)
            : null,
    };
}

/** Whether a listed host is gone for this viewer: suspended, deleted, or blocked either way. */
async function hostGone(hostId: string, hidden: Set<string>): Promise<boolean> {
    if (hidden.has(hostId)) return true;
    const host = await prisma.user.findUnique({ where: { id: hostId }, select: { isBanned: true, deletedAt: true } });
    return !host || host.isBanned || !!host.deletedAt;
}

/**
 * GET /events
 * Listed events, for members. upcoming=true: not ended yet, soonest first;
 * past=true: ended, latest first. Filters: category, search, isOfficial,
 * hostId, hostListingId. No hosts suspended or blocked either way.
 */
export async function listEvents(req: Request, res: Response): Promise<void> {
    try {
        const me = req.user!;
        // A repeated parameter comes as a list: only single values count.
        const q = Object.fromEntries(Object.entries(req.query).filter(([, v]) => typeof v === 'string')) as Record<string, string | undefined>;
        const take = Math.min(Math.max(parseInt(q.limit || '20', 10) || 20, 1), 50);
        const page = Math.max(parseInt(q.page || '1', 10) || 1, 1);
        const now = new Date();
        const hidden = await hiddenFromIds(me.id, { staff: isStaffUser(me) });

        const and: any[] = [];
        if (q.upcoming === 'true') and.push(stillOn(now));
        if (q.past === 'true') and.push(over(now));
        if (q.search) {
            and.push({ OR: [
                { title: { contains: q.search } },
                { description: { contains: q.search } },
                { location: { contains: q.search } },
                { hostListing: { name: { contains: q.search } } },
            ] });
        }
        if (hidden.length) and.push({ hostId: { notIn: hidden } });
        // A business or farm's page: what it hosts, and what's on there.
        if (q.atListingId) and.push({ OR: [{ hostListingId: q.atListingId }, { venueListingId: q.atListingId }] });
        const where: any = {
            ...LISTED,
            calledOffAt: null, // a proposed meetup that didn't happen
            host: ACTIVE,
            ...(q.category ? { category: q.category.toUpperCase() } : {}),
            ...(q.isOfficial === 'true' ? OFFICIAL_HOST : q.isOfficial === 'false' ? { NOT: OFFICIAL_HOST } : {}),
            ...(q.hostId ? { hostId: q.hostId } : {}),
            ...(q.hostListingId ? { hostListingId: q.hostListingId } : {}),
            ...(and.length ? { AND: and } : {}),
        };

        const order = q.past === 'true' ? 'desc' : 'asc';
        const [rows, total] = await Promise.all([
            prisma.event.findMany({
                where,
                orderBy: [{ startDate: order }, { id: 'asc' }],
                skip: (page - 1) * take,
                take,
                include: { ...EVENT_INCLUDE, ...GOING_COUNT },
            }),
            prisma.event.count({ where }),
        ]);
        const hiddenSet = new Set(hidden);
        const mine = rows.length
            ? await prisma.eventAttendee.findMany({ where: { userId: me.id, eventId: { in: rows.map((e) => e.id) } }, select: { eventId: true, status: true } })
            : [];
        const rsvp = new Map(mine.map((a) => [a.eventId, a.status]));

        res.json({
            data: rows.map((e) => ({ ...eventCard(e, hiddenSet), rsvpStatus: rsvp.get(e.id) || null })),
            pagination: { page, limit: take, total, totalPages: Math.ceil(total / take) },
        });
    } catch (error) {
        console.error('List events error:', error);
        res.status(500).json({ error: 'Failed to list events' });
    }
}

/**
 * GET /events/my
 * List all events created by the current user (all visibilities).
 */
export async function listMyEvents(req: Request, res: Response): Promise<void> {
    try {
        const { page = '1', limit = '50' } = req.query;
        const skip = (parseInt(page as string, 10) - 1) * parseInt(limit as string, 10);
        const take = Math.min(parseInt(limit as string, 10), 100);

        // Mine: I host it myself, I act for its host business (up or down) or
        // a co-host one, or I'm a co-host.
        const me = req.user!.id;
        const acted = await actedForIds(me);
        const mineWhere = {
            OR: [
                { hostId: me, hostListingId: null },
                ...(acted.length ? [{ hostListingId: { in: acted } }] : []),
                // A business I run or am on the team of, while it's down.
                { hostListing: { is: { OR: [{ memberUserId: me }, { memberUserId: null, isOwnBusiness: true, ownerId: me }, { team: { some: { userId: me } } }] } } },
                { partners: { some: { role: 'COHOST', OR: [{ userId: me }, ...(acted.length ? [{ listingId: { in: acted } }] : [])] } } },
            ],
        };
        const [events, total] = await Promise.all([
            prisma.event.findMany({
                where: mineWhere,
                orderBy: { createdAt: 'desc' },
                skip,
                take,
                include: { ...EVENT_INCLUDE, _count: { select: { attendees: true } } },
            }),
            prisma.event.count({ where: mineWhere }),
        ]);

        // Ticket sales per hosted event (PAID only)
        const eventIds = events.map((e) => e.id);
        const ticketStats = eventIds.length > 0
            ? await prisma.ticket.groupBy({
                by: ['eventId'],
                where: { eventId: { in: eventIds }, status: 'PAID' },
                _count: { _all: true },
                _sum: { amountSats: true },
            })
            : [];
        const statsByEvent = new Map(ticketStats.map((s) => [s.eventId, s]));

        // As the list shows them; sales only for the host side.
        const parsed = await Promise.all(events.map(async (e) => {
            const hostSide = await canDeleteEvent(e, req.user, acted);
            return {
                ...eventCard(e, new Set()),
                maxAttendees: e.maxAttendees,
                ticketCapacity: e.ticketCapacity,
                endorsementRequested: e.endorsementRequested,
                attendeeCount: e._count.attendees,
                canDelete: hostSide,
                ...(hostSide ? {
                    ticketsSold: statsByEvent.get(e.id)?._count._all || 0,
                    revenueSats: statsByEvent.get(e.id)?._sum.amountSats || 0,
                } : {}),
            };
        }));

        res.json({
            data: parsed,
            pagination: { page: parseInt(page as string, 10), limit: take, total, totalPages: Math.ceil(total / take) },
        });
    } catch (error) {
        console.error('List my events error:', error);
        res.status(500).json({ error: 'Failed to list your events' });
    }
}

/**
 * GET /events/attending — events the current user has RSVP'd to
 */
export async function listAttendingEvents(req: Request, res: Response): Promise<void> {
    try {
        const me = req.user!;
        const take = Math.min(Math.max(parseInt(String(req.query.limit || '50'), 10) || 50, 1), 100);
        const page = Math.max(parseInt(String(req.query.page || '1'), 10) || 1, 1);
        const where = { userId: me.id, status: { in: ['GOING', 'INTERESTED', 'INVITED'] } };
        const [records, total, hidden] = await Promise.all([
            prisma.eventAttendee.findMany({
                where,
                include: { event: { include: { ...EVENT_INCLUDE, ...GOING_COUNT } } },
                orderBy: { joinedAt: 'desc' },
                skip: (page - 1) * take,
                take,
            }),
            prisma.eventAttendee.count({ where }),
            hiddenFromIds(me.id, { staff: isStaffUser(me) }),
        ]);
        const hiddenSet = new Set(hidden);
        // As the list shows them: no guest list, payout address or online link.
        const data = records.map((a) => ({ ...eventCard(a.event, hiddenSet), attendeeCount: a.event._count.attendees, rsvpStatus: a.status }));
        res.json({ data, pagination: { page, limit: take, total, totalPages: Math.ceil(total / take) } });
    } catch (error) {
        console.error('List attending events error:', error);
        res.status(500).json({ error: 'Failed to list attending events' });
    }
}

/**
 * GET /events/:id
 * An event for a member: who hosts it, its co-hosts and sponsors, who's
 * going. Drafts are for whoever can edit; private events for them and the
 * guests. The guest list and payout address only for whoever can edit.
 */
export async function getEvent(req: Request, res: Response): Promise<void> {
    try {
        const me = req.user!;
        const event = await prisma.event.findUnique({
            where: { id: req.params.id },
            include: {
                ...EVENT_INCLUDE,
                ...GOING_COUNT,
                attendees: {
                    where: { status: 'GOING', user: ACTIVE },
                    take: 30,
                    orderBy: { joinedAt: 'asc' },
                    select: { userId: true, user: { select: { id: true, nostrPubkey: true, profile: { select: { name: true, avatar: true } } } } },
                },
            },
        });
        if (!event) { res.status(404).json({ error: 'Event not found' }); return; }

        const acted = await actedForIds(me.id);
        const canEdit = await canEditEvent(event, me, acted);
        const hostSide = canEdit && await canDeleteEvent(event, me, acted);
        if (!canEdit) {
            const hidden = new Set(await hiddenFromIds(me.id, { staff: isStaffUser(me) }));
            const unseen = event.visibility === 'DRAFT'
                || (event.visibility === 'PRIVATE' && !(await invitedTo(event, me.id)))
                || (!isStaffUser(me) && await hostGone(event.hostId, hidden));
            if (unseen) { res.status(404).json({ error: 'Event not found' }); return; }
        }
        const hidden = new Set(await hiddenFromIds(me.id, { staff: isStaffUser(me) }));

        const [myRsvp, ticketsSold] = await Promise.all([
            prisma.eventAttendee.findUnique({ where: { eventId_userId: { eventId: event.id, userId: me.id } }, select: { status: true } }),
            prisma.ticket.count({ where: { eventId: event.id, status: 'PAID' } }),
        ]);
        // My own place on it, which I can take off: me, or a business I act for.
        const myPartnerIds = event.partners
            .filter((p) => p.userId === me.id || (p.listingId && acted.includes(p.listingId)))
            .map((p) => p.id);

        res.json({
            ...eventCard(event, hidden),
            description: event.description,
            locationAddress: event.locationAddress,
            locationMapUrl: event.locationMapUrl,
            onlineUrl: event.onlineUrl,
            tags: parseJson(event.tags),
            customSections: parseJson(event.customSections),
            maxAttendees: event.maxAttendees,
            ticketCapacity: event.ticketCapacity,
            endorsementRequested: event.endorsementRequested,
            nostrPublish: event.nostrPublish,
            going: event.attendees.filter((a) => !hidden.has(a.userId)).map((a) => a.user),
            rsvpStatus: myRsvp?.status || null,
            ticketsSold,
            canEdit,
            canDelete: hostSide,
            myPartnerIds,
            // The tagged place, also while it isn't live (waiting for review, taken down): an edit keeps it.
            ...(canEdit ? { venueListingId: event.venueListingId } : {}),
            ...(hostSide ? { guestList: parseJson(event.guestList), payoutLightningAddress: event.payoutLightningAddress } : {}),
        });
    } catch (error) {
        console.error('Get event error:', error);
        res.status(500).json({ error: 'Failed to get event' });
    }
}


/**
 * POST /events
 * Create an event, hosted by me or as a business or farm I act for (a BIES
 * event when that's BIES's own page), with its co-hosts and sponsors.
 */
export async function createEvent(req: Request, res: Response): Promise<void> {
    try {
        const me = req.user!.id;
        const body = req.body as z.infer<typeof createEventSchema>;
        const data = eventData(body);
        // A proposed meetup: a member's, open to every member, on BIES only
        // until it's on (no feed post or Nostr calendar event for an idea).
        const proposal = body.minAttendees != null;
        if (!data.startDate || Number.isNaN(data.startDate.getTime())) {
            res.status(400).json({ error: 'Pick when it starts', reason: 'start_invalid' }); return;
        }
        if (badDate(data.endDate)) { res.status(400).json({ error: 'Pick when it ends', reason: 'end_invalid' }); return; }
        if (!proposal && !(data.description || '').trim()) {
            res.status(400).json({ error: 'Add what the event is about', reason: 'description_missing' }); return;
        }
        if (proposal) {
            const problem = proposalProblem(body.minAttendees!, data.decideBy || null, data.startDate, data.maxAttendees);
            if (problem) { res.status(400).json({ error: 'Check the numbers and the decide-by time', reason: problem }); return; }
            if (await openProposals(me) >= MAX_OPEN_PROPOSALS) {
                res.status(400).json({ error: `You can have ${MAX_OPEN_PROPOSALS} proposed meetups open at once`, reason: 'too_many_proposals', max: MAX_OPEN_PROPOSALS }); return;
            }
            for (const field of MONEY_FIELDS) delete data[field];
            data.visibility = 'PUBLIC';
            data.nostrPublish = 'none';
            delete body.hostListingId;
            delete body.partners;
        } else {
            delete data.minAttendees;
            delete data.decideBy;
        }
        if (body.venueListingId) {
            const venue = await venueFor(body.venueListingId, me);
            if (!venue) { res.status(400).json({ error: 'That business or farm isn\'t on BIES', reason: 'venue_not_found' }); return; }
            venueData(venue, data);
        }
        const nostrPublish: string = data.nostrPublish || 'none';
        const visibility = data.visibility || 'PUBLIC';
        const isPublished = visibilityToPublished(visibility);

        const hostListing = body.hostListingId ? (await listingsActedFor(me)).find((l) => l.id === body.hostListingId) : null;
        if (body.hostListingId && !hostListing) {
            res.status(403).json({ error: 'You can only host as a business you run or are on the team of', reason: 'not_your_listing' });
            return;
        }
        const partners = await checkPartners(me, body.partners || [], { hostListingId: hostListing?.id ?? null, isAdmin: !!req.user!.isAdmin });
        if (!hostListing?.isOfficial) for (const field of CARD_FIELDS) delete data[field];

        const event = await prisma.event.create({
            data: {
                ...data,
                hostId: me,
                hostListingId: hostListing?.id ?? null,
                isOfficial: !!hostListing?.isOfficial,
                isPublished,
                partners: { create: partners },
                // Whoever proposes a meetup is the first one in.
                ...(proposal ? { attendees: { create: { userId: me, status: 'GOING' } } } : {}),
            } as any,
            include: EVENT_INCLUDE,
        });
        await cache.delPattern('events:');
        const hostName = hostNameOf(event);
        await notifyNewPartners(me, event, hostName, partners);

        // Announce new event on the BIES feed
        if (isPublished && !proposal) {
            const dateStr = event.startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/El_Salvador' });
            publishAnnouncement(me, `${hostName} is hosting "${event.title}" on ${dateStr}${event.location ? ` in ${event.location}` : ''}. Check it out on BIES!`, [['t', 'new-event']]).catch((err) =>
                console.error('[Nostr] Event announcement failed:', err)
            );
        }

        const nostrPublished = isPublished && nostrPublish !== 'none'
            ? await publishToNostr(me, event, nostrPublish as 'bies' | 'public' | 'both')
            : false;

        res.status(201).json({ ...eventCard({ ...event, _count: { attendees: proposal ? 1 : 0 } }, new Set()), nostrPublished });
    } catch (error) {
        if (error instanceof PartnerError) { res.status(400).json({ error: error.message, reason: error.reason }); return; }
        console.error('Create event error:', error);
        res.status(500).json({ error: 'Failed to create event' });
    }
}

/**
 * NIP-52 calendar event (kind 31923, replaceable by its d-tag), signed with
 * the host's key on BIES (custodial members only); its id is kept.
 */
async function publishToNostr(signerId: string, event: any, target: 'bies' | 'public' | 'both'): Promise<boolean> {
    const validationError = validateCalendarEventData({ id: event.id, title: event.title, startDate: event.startDate });
    if (validationError) {
        console.warn('[Nostr] NIP-52 validation failed:', validationError);
        return false;
    }
    try {
        const nostrEventId = await publishCalendarEvent(signerId, {
            id: event.id,
            title: event.title,
            description: event.description,
            startDate: event.startDate,
            endDate: event.endDate || undefined,
            location: event.location || undefined,
            locationName: event.locationName || undefined,
            locationAddress: event.locationAddress || undefined,
            isOnline: event.isOnline,
            onlineUrl: event.onlineUrl || undefined,
            category: event.category,
            tags: parseJson(event.tags),
            thumbnail: event.thumbnail || undefined,
            ticketUrl: event.ticketUrl || undefined,
        }, target);
        if (!nostrEventId) return false;
        await prisma.event.update({ where: { id: event.id }, data: { nostrEventId } });
        return true;
    } catch (err) {
        console.error('[Nostr] NIP-52 calendar event publish failed:', err);
        return false;
    }
}

/**
 * PUT /events/:id
 * Edit an event: its host, a co-host, the host business's people, or an
 * admin. Changing who hosts it is for its host, the host business's people
 * or an admin, and only to a business they act for.
 */
export async function updateEvent(req: Request, res: Response): Promise<void> {
    try {
        const me = req.user!.id;
        const body = req.body as z.infer<typeof updateEventSchema>;
        const existing = await prisma.event.findUnique({
            where: { id: req.params.id },
            include: { partners: EVENT_PEOPLE.partners },
        });
        if (!existing) { res.status(404).json({ error: 'Event not found' }); return; }
        const acted = await actedForIds(me);
        if (!(await canEditEvent(existing, req.user, acted))) {
            res.status(403).json({ error: 'Not authorized' }); return;
        }
        const hostSide = await canDeleteEvent(existing, req.user, acted);
        // The co-hosts and sponsors this editor sees. The others (suspended,
        // blocked either way, a listing that's down) stay as they are.
        const hidden = new Set(await hiddenFromIds(me, { staff: isStaffUser(req.user!) }));
        const shown = partnersFor(existing.partners, hidden);

        const data = eventData(body);
        if (body.description !== undefined && !body.description.trim() && !existing.minAttendees) {
            res.status(400).json({ error: 'Add what the event is about', reason: 'description_missing' }); return;
        }
        if (data.startDate !== undefined && (!data.startDate || Number.isNaN(data.startDate.getTime()))) {
            res.status(400).json({ error: 'Pick when it starts', reason: 'start_invalid' }); return;
        }
        if (badDate(data.endDate)) { res.status(400).json({ error: 'Pick when it ends', reason: 'end_invalid' }); return; }
        // A proposal's number and deadline change only while it's still a
        // proposal (and never to nothing); a usual event doesn't become one.
        // A member's meetup has no tickets.
        const stageBefore = proposalStage(existing);
        if (stageBefore) {
            for (const field of MONEY_FIELDS) delete data[field];
            // Open to every member, on BIES only, hosted by the member.
            delete data.visibility;
            delete data.nostrPublish;
            delete body.hostListingId;
            delete body.partners;
        }
        if (stageBefore === 'proposed') {
            if (body.minAttendees === null || body.decideBy === null) {
                res.status(400).json({ error: 'Check the numbers and the decide-by time', reason: 'decide_by_missing' }); return;
            }
            const min = data.minAttendees ?? existing.minAttendees!;
            const decideBy = data.decideBy ?? existing.decideBy;
            const start = data.startDate ?? existing.startDate;
            const max = data.maxAttendees !== undefined ? data.maxAttendees : existing.maxAttendees;
            // Checked when one of them changes (the form sends them all on every edit).
            const touched = (data.minAttendees !== undefined && data.minAttendees !== existing.minAttendees)
                || (data.decideBy !== undefined && !sameTime(data.decideBy, existing.decideBy))
                || (data.startDate !== undefined && !sameTime(data.startDate, existing.startDate))
                || (data.maxAttendees !== undefined && (data.maxAttendees ?? null) !== existing.maxAttendees);
            const problem = touched ? proposalProblem(min, decideBy, start, max) : null;
            if (problem) { res.status(400).json({ error: 'Check the numbers and the decide-by time', reason: problem }); return; }
        } else {
            delete data.minAttendees;
            delete data.decideBy;
        }
        if (body.venueListingId !== undefined && (body.venueListingId || null) !== existing.venueListingId) {
            if (body.venueListingId) {
                const venue = await venueFor(body.venueListingId, me);
                if (!venue) { res.status(400).json({ error: 'That business or farm isn\'t on BIES', reason: 'venue_not_found' }); return; }
                const old = existing.venueListingId
                    ? await prisma.directoryListing.findUnique({ where: { id: existing.venueListingId }, select: VENUE_SELECT })
                    : null;
                venueData(venue, data, existing, old);
            } else {
                data.venueListingId = null;
            }
        }
        frameNewCover(data, 'thumbnail', existing.thumbnail);
        if (!hostSide) {
            // Co-hosts edit what the event is; its tickets and money, who hosts
            // it and who sees it stay with the host side. Unchanged copies pass.
            const changed = HOST_ONLY.find((f) => body[f] !== undefined && differs(body[f], existing[f]))
                ?? (body.partners !== undefined && !samePartners(body.partners, shown) ? 'partners' : undefined);
            if (changed) {
                res.status(403).json({ error: 'Only the host can change tickets, co-hosts, sponsors or who sees the event', reason: 'host_only', field: changed });
                return;
            }
            for (const field of HOST_ONLY) delete data[field];
            delete data.nostrPublish;
        }
        const nostrPublish: string = data.nostrPublish || 'none';
        if (data.visibility !== undefined) data.isPublished = visibilityToPublished(data.visibility);

        let hostListingId = existing.hostListingId;
        if (hostSide && body.hostListingId !== undefined && (body.hostListingId || null) !== existing.hostListingId) {
            // Off its business: the member who made it, the one who runs the business, or an admin.
            const from = existing.hostListingId
                ? await prisma.directoryListing.findUnique({ where: { id: existing.hostListingId }, select: { ownerId: true, memberUserId: true, isOwnBusiness: true } })
                : null;
            if (from && !req.user!.isAdmin && me !== existing.hostId && !runsListing(from, me)) {
                res.status(403).json({ error: 'Only who made this event, or who runs the business, can move it', reason: 'host_only' });
                return;
            }
            hostListingId = body.hostListingId || null;
            const listing = hostListingId ? (await listingsActedFor(me)).find((l) => l.id === hostListingId) : null;
            if (hostListingId && !listing) {
                res.status(403).json({ error: 'You can only host as a business you run or are on the team of', reason: 'not_your_listing' });
                return;
            }
            data.hostListingId = hostListingId;
            data.isOfficial = !!listing?.isOfficial;
            data.hostId = me; // whoever moves it is its host from now on
        }
        // The highlight card is BIES's: only while it's hosted as BIES's own page.
        const host = hostListingId ? await prisma.directoryListing.findUnique({ where: { id: hostListingId }, select: { isOfficial: true } }) : null;
        if (!host?.isOfficial) for (const field of CARD_FIELDS) delete data[field];
        // The card shows its own photo, or the cover: another photo there starts centred.
        const cardPhoto = (e: { cardImage?: string; thumbnail?: string }) => e.cardImage || e.thumbnail || '';
        if (data.cardFrame === undefined && cardPhoto({ ...existing, ...data }) !== cardPhoto(existing)) data.cardFrame = '';
        const partners = hostSide && body.partners !== undefined
            ? await checkPartners(me, body.partners, { hostListingId, eventId: existing.id, isAdmin: !!req.user!.isAdmin, acted })
            : null;
        const unseen = existing.partners.filter((p) => !shown.some((v) => v.id === p.id)).map((p) => p.id);

        const event = await prisma.$transaction(async (tx) => {
            if (partners) {
                await tx.eventPartner.deleteMany({ where: { eventId: existing.id, id: { notIn: unseen } } });
                if (partners.length) await tx.eventPartner.createMany({ data: partners.map((p) => ({ ...p, eventId: existing.id })) });
            }
            return tx.event.update({ where: { id: existing.id }, data, include: EVENT_INCLUDE });
        });
        await Promise.all([cache.delPattern('events:'), cache.del(`preview:events:${existing.id}`)]);
        if (partners) await notifyNewPartners(me, event, hostNameOf(event), partners, existing.partners);
        // A lower number may be met already.
        if (data.minAttendees !== undefined) await confirmIfReached(event.id).catch(() => false);
        // A meetup's people hear when it moves, or changes place.
        const moved = data.startDate !== undefined && data.startDate.getTime() !== existing.startDate.getTime();
        // Somewhere else: another business, or another name. Tagging the
        // business it was at already (typed in before) isn't a move.
        const placeName = (name?: string | null) => (name || '').normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase();
        const retagged = !!existing.venueListingId && !!event.venueListingId && existing.venueListingId !== event.venueListingId;
        const elsewhere = retagged || placeName(event.locationName) !== placeName(existing.locationName);
        if (stageBefore && stageBefore !== 'calledOff' && (moved || elsewhere)) {
            await tellPeopleIn(event.id, event.hostId, {
                title: `Changed: "${event.title}"`,
                body: `Now ${whenAndWhere(event)}.`,
                status: 'CHANGED',
            }, me);
        }

        // On Nostr, under the host's key: gone when it stops being public,
        // otherwise replaced (kind 31923 by its d-tag), on the host's own edit.
        let nostrPublished = false;
        const wasPublic = visibilityToPublished(existing.visibility);
        if (wasPublic && !event.isPublished && existing.nostrEventId) {
            const prevTarget = (existing.nostrPublish || 'bies') as 'bies' | 'public' | 'both';
            deleteCalendarEvent(existing.hostId, existing.nostrEventId, event.id, prevTarget).catch((err) =>
                console.error('[Nostr] NIP-09 deletion on visibility change failed:', err)
            );
            await prisma.event.update({ where: { id: event.id }, data: { nostrEventId: '', nostrPublish: 'none' } });
        } else if (nostrPublish !== 'none' && event.isPublished && me === existing.hostId) {
            nostrPublished = await publishToNostr(existing.hostId, event, nostrPublish as 'bies' | 'public' | 'both');
        }

        res.json({ ...eventCard(event, new Set()), nostrPublished });
    } catch (error) {
        if (error instanceof PartnerError) { res.status(400).json({ error: error.message, reason: error.reason }); return; }
        console.error('Update event error:', error);
        res.status(500).json({ error: 'Failed to update event' });
    }
}

/**
 * DELETE /events/:id
 * Delete an event (host or admin).
 */
export async function deleteEvent(req: Request, res: Response): Promise<void> {
    try {
        const existing = await prisma.event.findUnique({
            where: { id: req.params.id },
            select: {
                id: true, title: true, hostId: true, hostListingId: true, nostrEventId: true, nostrPublish: true,
                minAttendees: true, confirmedAt: true, calledOffAt: true, startDate: true,
            },
        });

        if (!existing) { res.status(404).json({ error: 'Event not found' }); return; }
        if (!(await canDeleteEvent(existing, req.user))) {
            res.status(403).json({ error: 'Not authorized' }); return;
        }
        // A meetup people are in, still ahead: they're told (with no page to open after).
        const stage = proposalStage(existing);
        if ((stage === 'proposed' || stage === 'on') && existing.startDate.getTime() > Date.now()) {
            await tellPeopleIn(existing.id, existing.hostId, {
                title: `Called off: "${existing.title}"`,
                body: calledOffBy(req.user!.id, existing.hostId),
                status: 'CALLED_OFF',
                link: false,
            }, req.user!.id);
        }

        // Delete NIP-52 calendar event from Nostr relays before removing from DB
        if (existing.nostrEventId && existing.nostrPublish !== 'none') {
            deleteCalendarEvent(
                existing.hostId,
                existing.nostrEventId,
                req.params.id,
                (existing.nostrPublish || 'bies') as 'bies' | 'public' | 'both'
            ).catch((err) =>
                console.error('[Nostr] NIP-09 deletion on event delete failed:', err)
            );
        }

        await prisma.event.delete({ where: { id: req.params.id } });
        await Promise.all([cache.delPattern('events:'), cache.del(`preview:events:${existing.id}`)]);

        res.json({ message: 'Event deleted' });
    } catch (error) {
        console.error('Delete event error:', error);
        res.status(500).json({ error: 'Failed to delete event' });
    }
}

/**
 * DELETE /events/:id/partners/:partnerId
 * Take a co-host or sponsor off: whoever can edit the event, the member
 * named, or anyone acting for the business named.
 */
export async function removePartner(req: Request, res: Response): Promise<void> {
    try {
        const me = req.user!.id;
        const partner = await prisma.eventPartner.findFirst({
            where: { id: req.params.partnerId, eventId: req.params.id },
            include: { event: { select: { id: true, hostId: true, hostListingId: true } } },
        });
        if (!partner) { res.status(404).json({ error: 'Not found' }); return; }
        const acted = await actedForIds(me);
        const allowed = partner.userId === me
            || (!!partner.listingId && acted.includes(partner.listingId))
            || await canDeleteEvent(partner.event, req.user, acted);
        if (!allowed) { res.status(403).json({ error: 'Not authorized' }); return; }
        await prisma.eventPartner.delete({ where: { id: partner.id } });
        await Promise.all([cache.delPattern('events:'), cache.del(`preview:events:${partner.event.id}`)]);
        res.json({ removed: true });
    } catch (error) {
        console.error('Remove event partner error:', error);
        res.status(500).json({ error: 'Failed to take the name off' });
    }
}

/**
 * PUT /events/:id/endorse
 * Endorse a community event (admin only).
 */
export async function endorseEvent(req: Request, res: Response): Promise<void> {
    try {
        if (!req.user!.isAdmin) {
            res.status(403).json({ error: 'Admin only' }); return;
        }

        const { endorse = true } = req.body;

        const event = await prisma.event.update({
            where: { id: req.params.id },
            data: { isEndorsed: Boolean(endorse) },
        });

        await cache.delPattern('events:');
        res.json({ ...event, tags: JSON.parse(event.tags || '[]') });
    } catch (error) {
        console.error('Endorse event error:', error);
        res.status(500).json({ error: 'Failed to endorse event' });
    }
}

/**
 * POST /events/:id/rsvp
 * RSVP to an event.
 */
/**
 * Whether a member is invited to an event: the host invited them (an
 * attendee row, whatever its status now), or picked them in the event's guest
 * list. Invite-only events let only them, the host and admins RSVP or buy.
 */
export async function invitedTo(event: { id: string; guestList?: string | null }, userId: string): Promise<boolean> {
    let guests: { userId?: string }[] = [];
    try { guests = JSON.parse(event.guestList || '[]'); } catch { guests = []; }
    if (Array.isArray(guests) && guests.some((g) => g?.userId === userId)) return true;
    return !!(await prisma.eventAttendee.findFirst({ where: { eventId: event.id, userId }, select: { id: true } }));
}

export async function rsvpEvent(req: Request, res: Response): Promise<void> {
    try {
        const userId = req.user!.id;
        const { status = 'GOING' } = req.body;

        const validStatuses = ['GOING', 'INTERESTED', 'NOT_GOING'];
        if (!validStatuses.includes(status)) {
            res.status(400).json({ error: `Status must be one of: ${validStatuses.join(', ')}` }); return;
        }

        const event = await prisma.event.findUnique({
            where: { id: req.params.id },
            select: {
                id: true, title: true, hostId: true, maxAttendees: true, isPublished: true,
                visibility: true, nostrPublish: true, guestList: true,
                minAttendees: true, decideBy: true, confirmedAt: true, calledOffAt: true,
                host: { select: { nostrPubkey: true } },
            },
        });

        if (!event || event.visibility === 'DRAFT') {
            res.status(404).json({ error: 'Event not found' }); return;
        }
        // Private: its guests (and the host and admins) can say they're going.
        if (event.visibility === 'PRIVATE' && event.hostId !== userId && !req.user!.isAdmin && !(await invitedTo(event, userId))) {
            res.status(404).json({ error: 'Event not found' }); return;
        }

        // A proposed meetup that's been called off, or is past its deadline.
        const stage = proposalStage(event);
        if (stage === 'calledOff' || (stage === 'proposed' && event.decideBy && event.decideBy.getTime() < Date.now())) {
            res.status(409).json({ error: 'This meetup was called off', reason: 'called_off' }); return;
        }
        // Whoever proposed it counts towards it: they call it off instead.
        if (stage === 'proposed' && event.hostId === userId && status !== 'GOING') {
            res.status(400).json({ error: 'You proposed it: call it off instead', reason: 'proposer_stays' }); return;
        }

        // Invite only: the host, admins, and members the host invited.
        if (event.visibility === 'INVITE_ONLY' && event.hostId !== userId && !req.user!.isAdmin && !(await invitedTo(event, userId))) {
            res.status(403).json({ error: 'This event is invite only' }); return;
        }

        if (status === 'GOING' && event.maxAttendees) {
            // Only GOING attendees consume capacity (not INTERESTED/INVITED/NOT_GOING)
            const goingCount = await prisma.eventAttendee.count({
                where: { eventId: req.params.id, status: 'GOING' },
            });
            if (goingCount >= event.maxAttendees) {
                const existing = await prisma.eventAttendee.findUnique({
                    where: { eventId_userId: { eventId: req.params.id, userId } },
                });
                if (!existing) {
                    res.status(409).json({ error: 'Event is at full capacity', reason: 'full' }); return;
                }
            }
        }

        // Check if this is a new RSVP (not an update)
        const existingRsvp = await prisma.eventAttendee.findUnique({
            where: { eventId_userId: { eventId: req.params.id, userId } },
        });

        const attendee = await prisma.eventAttendee.upsert({
            where: { eventId_userId: { eventId: req.params.id, userId } },
            update: { status },
            create: { eventId: req.params.id, userId, status },
        });

        // Announce RSVP on the BIES feed (only for new RSVPs with GOING status)
        if (!existingRsvp && (status === 'GOING' || status === 'INTERESTED')) {
            const rsvpUser = await prisma.user.findUnique({
                where: { id: userId },
                select: { profile: { select: { name: true } } },
            });
            const userName = rsvpUser?.profile?.name || 'A BIES member';

            if (status === 'GOING' && stage !== 'proposed') {
                publishAnnouncement(userId, `${userName} is going to "${event.title}"!`, [['t', 'rsvp']]).catch((err) =>
                    console.error('[Nostr] RSVP announcement failed:', err)
                );
            }

            // Notify event host (don't notify yourself). On a proposal: how it stands.
            if (event.hostId !== userId && stage === 'proposed' && status === 'GOING') {
                const going = await prisma.eventAttendee.count({ where: { eventId: event.id, status: 'GOING' } });
                const needs = Math.max(0, (event.minAttendees || 0) - going);
                if (needs > 0) {
                    createNotification({
                        userId: event.hostId,
                        type: 'EVENT_RSVP',
                        title: `${userName} is in for "${event.title}"`,
                        body: `${going} of ${event.minAttendees} in · needs ${needs} more`,
                        data: { eventId: event.id, attendeeId: userId, status: 'GOING' },
                    }).catch(() => {});
                }
            } else if (event.hostId !== userId) {
                notifyEventRsvp({
                    hostId: event.hostId,
                    attendeeName: userName,
                    attendeeId: userId,
                    eventTitle: event.title,
                    eventId: req.params.id,
                    status,
                }).catch(() => {});
            }
        }

        // Publish NIP-52 RSVP (kind 31925) to Nostr
        const nostrTarget = (event.nostrPublish || 'none') as string;
        if (nostrTarget !== 'none' && event.host?.nostrPubkey) {
            const rsvpStatusMap: Record<string, 'accepted' | 'declined' | 'tentative'> = {
                GOING: 'accepted',
                INTERESTED: 'tentative',
                NOT_GOING: 'declined',
            };
            publishRSVPEvent(userId, {
                eventId: req.params.id,
                eventDTag: req.params.id,
                hostPubkey: event.host.nostrPubkey,
                status: rsvpStatusMap[status] || 'tentative',
            }, nostrTarget as 'bies' | 'public' | 'both').then(async (nostrRsvpId) => {
                if (nostrRsvpId) {
                    await prisma.eventAttendee.update({
                        where: { id: attendee.id },
                        data: { nostrEventId: nostrRsvpId },
                    });
                }
            }).catch((err) =>
                console.error('[Nostr] NIP-52 RSVP publish failed:', err)
            );
        }

        // That may have made a proposal's number: then it's on.
        // (If that check fails, the sweep makes it before the deadline passes.)
        const confirmed = status === 'GOING' && stage === 'proposed' ? await confirmIfReached(event.id).catch(() => false) : false;

        res.json({ ...attendee, confirmed });
    } catch (error) {
        console.error('RSVP error:', error);
        res.status(500).json({ error: 'Failed to RSVP' });
    }
}

/**
 * DELETE /events/:id/rsvp
 * Cancel RSVP.
 */
export async function cancelRsvp(req: Request, res: Response): Promise<void> {
    try {
        // On an invite-only event the invitation stays: back to INVITED, so
        // the member can still say they're going later.
        const event = await prisma.event.findUnique({
            where: { id: req.params.id },
            select: { visibility: true, hostId: true, minAttendees: true, confirmedAt: true, calledOffAt: true },
        });
        // Whoever proposes a meetup counts towards it: they call it off instead.
        if (event && event.hostId === req.user!.id && proposalStage(event) === 'proposed') {
            res.status(400).json({ error: 'You proposed it: call it off instead', reason: 'proposer_stays' }); return;
        }
        if (event?.visibility === 'INVITE_ONLY') {
            await prisma.eventAttendee.updateMany({
                where: { eventId: req.params.id, userId: req.user!.id },
                data: { status: 'INVITED' },
            });
        } else {
            await prisma.eventAttendee.deleteMany({
                where: { eventId: req.params.id, userId: req.user!.id },
            });
        }
        res.json({ message: 'RSVP cancelled' });
    } catch (error) {
        console.error('Cancel RSVP error:', error);
        res.status(500).json({ error: 'Failed to cancel RSVP' });
    }
}

/**
 * POST /events/:id/call-off
 * Its proposer (the host side) calls off a proposed meetup, or one that's on:
 * it stays, marked called off, and everyone in is told.
 */
export async function callOffEvent(req: Request, res: Response): Promise<void> {
    try {
        const event = await prisma.event.findUnique({
            where: { id: req.params.id },
            select: { id: true, title: true, hostId: true, hostListingId: true, minAttendees: true, confirmedAt: true, calledOffAt: true, startDate: true },
        });
        if (!event) { res.status(404).json({ error: 'Event not found' }); return; }
        if (!(await canDeleteEvent(event, req.user))) { res.status(403).json({ error: 'Not authorized' }); return; }
        const stage = proposalStage(event);
        if (stage !== 'proposed' && stage !== 'on') {
            res.status(400).json({ error: 'Only a proposed meetup is called off this way', reason: 'not_a_proposal' }); return;
        }
        if (event.startDate.getTime() <= Date.now()) {
            res.status(400).json({ error: 'It has started already', reason: 'started' }); return;
        }
        const won = await prisma.event.updateMany({ where: { id: event.id, calledOffAt: null }, data: { calledOffAt: new Date() } });
        if (won.count === 1) {
            await Promise.all([cache.delPattern('events:'), cache.del(`preview:events:${event.id}`)]);
            await tellPeopleIn(event.id, event.hostId, {
                title: `Called off: "${event.title}"`,
                body: calledOffBy(req.user!.id, event.hostId),
                status: 'CALLED_OFF',
            }, req.user!.id);
        }
        res.json({ stage: 'calledOff' });
    } catch (error) {
        console.error('Call off event error:', error);
        res.status(500).json({ error: 'Failed to call it off' });
    }
}

/**
 * POST /events/:id/invite
 * Invite a member to an event. Creates an INVITED attendee record
 * and sends them a notification.
 */
export async function inviteToEvent(req: Request, res: Response): Promise<void> {
    try {
        const inviterId = req.user!.id;
        const eventId = req.params.id;
        const { userId: targetUserId } = req.body;

        if (!targetUserId) {
            res.status(400).json({ error: 'userId is required' }); return;
        }

        const event = await prisma.event.findUnique({
            where: { id: eventId },
            select: { id: true, title: true, isPublished: true, hostId: true, hostListingId: true },
        });

        if (!event || !event.isPublished) {
            res.status(404).json({ error: 'Event not found' }); return;
        }

        // Only the host side can send invitations
        if (!(await canDeleteEvent(event, req.user))) {
            res.status(403).json({ error: 'Only the event host can send invitations' }); return;
        }

        // Don't allow inviting yourself
        if (targetUserId === inviterId) {
            res.status(400).json({ error: 'You cannot invite yourself' }); return;
        }

        // Check target user exists
        const targetUser = await prisma.user.findUnique({
            where: { id: targetUserId },
            select: { id: true },
        });
        if (!targetUser) {
            res.status(404).json({ error: 'User not found' }); return;
        }

        // Check if already attending or invited
        const existing = await prisma.eventAttendee.findUnique({
            where: { eventId_userId: { eventId, userId: targetUserId } },
        });

        if (existing) {
            res.status(409).json({ error: 'User already has an RSVP for this event' }); return;
        }

        // Create INVITED attendee record
        await prisma.eventAttendee.create({
            data: { eventId, userId: targetUserId, status: 'INVITED' },
        });

        // Send notification
        const inviter = await prisma.user.findUnique({
            where: { id: inviterId },
            select: { profile: { select: { name: true } } },
        });
        const inviterName = inviter?.profile?.name || 'A BIES member';

        createNotification({
            userId: targetUserId,
            type: 'EVENT_RSVP',
            title: `${inviterName} invited you to "${event.title}"`,
            body: 'You have been invited to an event. Check it out!',
            data: { eventId, inviterId, status: 'INVITED' },
        }).catch(() => {});

        res.status(201).json({ message: 'Invitation sent' });
    } catch (error) {
        console.error('Invite to event error:', error);
        res.status(500).json({ error: 'Failed to send invitation' });
    }
}
