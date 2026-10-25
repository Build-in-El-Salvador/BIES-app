/**
 * Events controller — community events (meetups, hackathons, demo days).
 */

import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { z } from 'zod';
import { cache, cacheKey, TTL } from '../services/redis.service';
import { publishAnnouncement, publishCalendarEvent, deleteCalendarEvent, publishRSVPEvent, validateCalendarEventData } from '../services/nostr.service';
import { notifyEventRsvp, createNotification } from '../services/notification.service';
import { config } from '../config';
import { removeTags } from '../middleware/sanitize';

// ─── OG helpers ──────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

function stripHtml(str: string): string {
    return removeTags(str).replace(/\s+/g, ' ').trim();
}

/** First origin from CORS_ORIGIN (may be comma-separated in dev). */
function getCanonicalBaseUrl(): string {
    const origin = config.corsOrigin.split(',')[0].trim().replace(/\/$/, '');
    return origin || 'https://bies.app';
}

/** Only allow alphanumeric + underscore + hyphen in IDs (CUID-safe). */
const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

// ─── Validation ───────────────────────────────────────────────────────────────

// http(s) links only.
const webLink = z.string().trim().max(2000)
    .refine((v) => v === '' || /^https?:\/\//i.test(v), { message: 'Links must start with https://' });

export const createEventSchema = z.object({
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(20_000),
    category: z.enum(['NETWORKING', 'CONFERENCE', 'WORKSHOP', 'HACKATHON', 'MEETUP', 'DEMO_DAY', 'OTHER']).default('NETWORKING'),
    visibility: z.enum(['PUBLIC', 'LIMITED_SPACES', 'INVITE_ONLY', 'PRIVATE', 'DRAFT']).default('PUBLIC'),
    location: z.string().max(200).optional(),
    isOnline: z.boolean().default(false),
    onlineUrl: webLink.optional(),
    startDate: z.string().max(40), // More lenient, parse in controller
    endDate: z.string().max(40).optional(),
    thumbnail: z.string().max(2000).optional().or(z.literal('')),
    ticketUrl: webLink.optional(),
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
});

export const updateEventSchema = createEventSchema.partial();

// Derive isPublished from visibility
function visibilityToPublished(visibility: string): boolean {
    return visibility !== 'DRAFT' && visibility !== 'PRIVATE';
}

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * GET /events
 * List publicly visible events with filters.
 */
export async function listEvents(req: Request, res: Response): Promise<void> {
    try {
        const { category, upcoming, search, isOfficial, isEndorsed, hostId, page = '1', limit = '20' } = req.query;
        const skip = (parseInt(page as string, 10) - 1) * parseInt(limit as string, 10);
        const take = Math.min(parseInt(limit as string, 10), 50);

        // Cache key must include every filter that shapes the result set,
        // otherwise a filtered request poisons the cache for unfiltered ones
        const cKey = cacheKey.events({
            category: category as string || '',
            upcoming: upcoming as string || '',
            isOfficial: isOfficial as string || '',
            isEndorsed: isEndorsed as string || '',
            search: search as string || '',
            hostId: hostId as string || '',
            page: page as string,
            limit: limit as string
        });
        const cached = await cache.getJson<any>(cKey);
        if (cached) { res.json(cached); return; }

        // Only show published events that are not PRIVATE or DRAFT
        const where: any = {
            isPublished: true,
            visibility: { notIn: ['PRIVATE', 'DRAFT'] },
        };

        if (category && typeof category === 'string') {
            where.category = category.toUpperCase();
        }
        if (upcoming === 'true') {
            where.startDate = { gte: new Date() };
        }
        if (isOfficial === 'true') {
            where.isOfficial = true;
        } else if (isOfficial === 'false') {
            where.isOfficial = false;
        }
        if (isEndorsed === 'true') {
            where.isEndorsed = true;
        }
        if (hostId && typeof hostId === 'string') {
            where.hostId = hostId;
        }
        if (search && typeof search === 'string') {
            where.OR = [
                { title: { contains: search } },
                { description: { contains: search } },
                { location: { contains: search } },
            ];
        }

        const [events, total] = await Promise.all([
            prisma.event.findMany({
                where,
                orderBy: { startDate: 'asc' },
                skip,
                take,
                include: {
                    host: {
                        select: {
                            id: true, nostrPubkey: true,
                            profile: { select: { name: true, avatar: true, company: true } },
                        },
                    },
                    _count: { select: { attendees: true } },
                },
            }),
            prisma.event.count({ where }),
        ]);

        const parsed = events.map((e) => ({
            ...e,
            tags: JSON.parse(e.tags || '[]'),
            guestList: JSON.parse(e.guestList || '[]'),
            customSections: JSON.parse((e as any).customSections || '[]'),
            attendeeCount: e._count.attendees,
        }));

        const result = {
            data: parsed,
            pagination: { page: parseInt(page as string, 10), limit: take, total, totalPages: Math.ceil(total / take) },
        };

        await cache.setJson(cKey, result, TTL.EVENT_LIST);
        res.json(result);
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

        const [events, total] = await Promise.all([
            prisma.event.findMany({
                where: { hostId: req.user!.id },
                orderBy: { createdAt: 'desc' },
                skip,
                take,
                include: {
                    _count: { select: { attendees: true } },
                },
            }),
            prisma.event.count({ where: { hostId: req.user!.id } }),
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

        const parsed = events.map((e) => ({
            ...e,
            tags: JSON.parse(e.tags || '[]'),
            guestList: JSON.parse(e.guestList || '[]'),
            customSections: JSON.parse((e as any).customSections || '[]'),
            attendeeCount: e._count.attendees,
            ticketsSold: statsByEvent.get(e.id)?._count._all || 0,
            revenueSats: statsByEvent.get(e.id)?._sum.amountSats || 0,
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
        const { page = '1', limit = '50' } = req.query;
        const skip = (parseInt(page as string, 10) - 1) * parseInt(limit as string, 10);
        const take = Math.min(parseInt(limit as string, 10), 100);

        const attendeeRecords = await prisma.eventAttendee.findMany({
            where: { userId: req.user!.id, status: { in: ['GOING', 'INTERESTED', 'INVITED'] } },
            include: {
                event: {
                    include: {
                        _count: { select: { attendees: true } },
                        host: { select: { id: true, nostrPubkey: true, profile: { select: { name: true, avatar: true } } } },
                    },
                },
            },
            orderBy: { joinedAt: 'desc' },
            skip,
            take,
        });

        const total = await prisma.eventAttendee.count({
            where: { userId: req.user!.id, status: { in: ['GOING', 'INTERESTED', 'INVITED'] } },
        });

        const data = attendeeRecords.map((a) => ({
            ...a.event,
            tags: JSON.parse(a.event.tags || '[]'),
            guestList: JSON.parse(a.event.guestList || '[]'),
            customSections: JSON.parse((a.event as any).customSections || '[]'),
            attendeeCount: a.event._count.attendees,
            rsvpStatus: a.status,
            host: a.event.host,
        }));

        res.json({
            data,
            pagination: { page: parseInt(page as string, 10), limit: take, total, totalPages: Math.ceil(total / take) },
        });
    } catch (error) {
        console.error('List attending events error:', error);
        res.status(500).json({ error: 'Failed to list attending events' });
    }
}

/**
 * GET /events/:id
 * Get a single event with attendee info.
 */
export async function getEvent(req: Request, res: Response): Promise<void> {
    try {
        const event = await prisma.event.findUnique({
            where: { id: req.params.id },
            include: {
                host: {
                    select: {
                        id: true, nostrPubkey: true,
                        profile: { select: { name: true, avatar: true, company: true } },
                    },
                },
                attendees: {
                    take: 20,
                    orderBy: { joinedAt: 'asc' },
                    include: {
                        user: {
                            select: {
                                id: true,
                                nostrPubkey: true,
                                profile: {
                                    select: {
                                        id: true,
                                        name: true,
                                        avatar: true,
                                        company: true,
                                    },
                                },
                            },
                        },
                    },
                },
                _count: { select: { attendees: true } },
            },
        });

        if (!event) {
            res.status(404).json({ error: 'Event not found' });
            return;
        }

        const currentUserId = req.user?.id;

        // DRAFT: only host can view
        if (event.visibility === 'DRAFT' && event.hostId !== currentUserId) {
            res.status(404).json({ error: 'Event not found' });
            return;
        }

        // PRIVATE: only host or guests can view
        if (event.visibility === 'PRIVATE' && event.hostId !== currentUserId) {
            const guestList: { name: string; userId?: string }[] = JSON.parse(event.guestList || '[]');
            const isGuest = currentUserId && guestList.some((g) => g.userId === currentUserId);
            if (!isGuest) {
                res.status(404).json({ error: 'Event not found' });
                return;
            }
        }

        // Current user's RSVP status + PAID ticket count
        const [myRsvp, ticketsSold] = await Promise.all([
            currentUserId
                ? prisma.eventAttendee.findUnique({
                    where: { eventId_userId: { eventId: event.id, userId: currentUserId } },
                    select: { status: true },
                })
                : Promise.resolve(null),
            prisma.ticket.count({ where: { eventId: event.id, status: 'PAID' } }),
        ]);

        res.json({
            ...event,
            tags: JSON.parse(event.tags || '[]'),
            guestList: JSON.parse(event.guestList || '[]'),
            customSections: JSON.parse((event as any).customSections || '[]'),
            attendeeCount: event._count.attendees,
            ticketsSold,
            rsvpStatus: myRsvp?.status || null,
        });
    } catch (error) {
        console.error('Get event error:', error);
        res.status(500).json({ error: 'Failed to get event' });
    }
}

/**
 * GET /events/:id/og
 * Return an HTML page with Open Graph meta tags for social media link previews.
 * No auth required — crawlers (WhatsApp, Facebook, etc.) cannot send tokens.
 */
export async function getEventOG(req: Request, res: Response): Promise<void> {
    const rawId = req.params.id;

    // Reject IDs that contain characters unsafe for HTML interpolation
    if (!rawId || !SAFE_ID_RE.test(rawId)) {
        res.status(400).json({ error: 'Invalid event ID' });
        return;
    }

    const id = rawId;
    const baseUrl = getCanonicalBaseUrl();
    const eventUrl = `${baseUrl}/events/${id}`;

    // Default/fallback OG values
    let ogTitle = 'BIES | Build in El Salvador';
    let ogDescription = 'Bitcoin-native investment ecosystem connecting builders and investors in El Salvador';
    let ogImage = `${baseUrl}/icons/icon-512.png`;

    try {
        const event = await prisma.event.findUnique({
            where: { id },
            select: {
                title: true,
                description: true,
                startDate: true,
                endDate: true,
                thumbnail: true,
                location: true,
                locationName: true,
                visibility: true,
                isPublished: true,
                host: {
                    select: { profile: { select: { name: true } } },
                },
            },
        });

        // Only populate OG tags for public/visible events
        if (event && event.visibility !== 'DRAFT' && event.visibility !== 'PRIVATE') {
            ogTitle = escapeHtml(event.title.slice(0, 70));

            // Build description: date · location · host
            const parts: string[] = [];
            if (event.startDate) {
                parts.push(event.startDate.toLocaleDateString('en-US', {
                    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
                }));
            }
            if (event.locationName || event.location) {
                parts.push(escapeHtml((event.locationName || event.location || '').slice(0, 60)));
            }
            if (event.host?.profile?.name) {
                parts.push(`Hosted by ${escapeHtml(event.host.profile.name)}`);
            }
            if (parts.length > 0) {
                ogDescription = parts.join(' \u00b7 ');
            } else if (event.description) {
                ogDescription = escapeHtml(stripHtml(event.description).slice(0, 200));
            }

            if (event.thumbnail) {
                const thumbUrl = event.thumbnail.startsWith('http')
                    ? event.thumbnail
                    : `${baseUrl}${event.thumbnail}`;
                ogImage = escapeHtml(thumbUrl);
            }
        }
    } catch (error) {
        console.error('OG meta fetch error:', error);
        // Fall through with default values
    }

    // Cache for 10 minutes — OG data changes infrequently and crawlers re-fetch
    res.set('Cache-Control', 'public, max-age=600');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta property="og:title" content="${ogTitle}" />
  <meta property="og:description" content="${ogDescription}" />
  <meta property="og:image" content="${ogImage}" />
  <meta property="og:url" content="${eventUrl}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="BIES" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${ogTitle}" />
  <meta name="twitter:description" content="${ogDescription}" />
  <meta name="twitter:image" content="${ogImage}" />
  <meta http-equiv="refresh" content="0;url=/events/${id}" />
  <title>${ogTitle}</title>
</head>
<body>
  <p>Redirecting to <a href="/events/${id}">${ogTitle}</a>&hellip;</p>
  <script>window.location.replace("/events/${id}");</script>
</body>
</html>`;

    res.type('html').send(html);
}

/**
 * POST /events
 * Create a new event.
 */
export async function createEvent(req: Request, res: Response): Promise<void> {
    try {
        const allowedFields = [
            'title', 'description', 'category', 'visibility',
            'location', 'locationName', 'locationAddress', 'locationMapUrl',
            'isOnline', 'onlineUrl', 'startDate', 'endDate',
            'thumbnail', 'ticketUrl', 'maxAttendees', 'tags', 'isOfficial',
            'priceSats', 'ticketCapacity', 'payoutLightningAddress',
            'endorsementRequested', 'guestList', 'customSections', 'nostrPublish',
        ];
        const data: any = {};
        for (const field of allowedFields) {
            if (req.body[field] !== undefined) {
                if (field === 'isOfficial' && req.body[field] === true && !req.user!.isAdmin) {
                    continue;
                }
                data[field] = req.body[field];
            }
        }

        // Extract nostrPublish before DB write (stored separately)
        const nostrPublish: string = data.nostrPublish || 'none';

        // Derive isPublished from visibility
        const visibility = data.visibility || 'PUBLIC';
        const isPublished = visibilityToPublished(visibility);

        const parsedTags: string[] = data.tags || [];
        if (data.tags) data.tags = JSON.stringify(data.tags);
        if (data.guestList) data.guestList = JSON.stringify(data.guestList);
        if (data.customSections) data.customSections = JSON.stringify(data.customSections);
        if (data.startDate) data.startDate = new Date(data.startDate);
        if (data.endDate) data.endDate = new Date(data.endDate);

        const event = await prisma.event.create({
            data: { ...data, hostId: req.user!.id, isPublished },
            include: {
                host: {
                    select: {
                        id: true,
                        profile: { select: { name: true, avatar: true } },
                    },
                },
            },
        });

        await cache.delPattern('events:');

        // Announce new event on the BIES feed
        if (isPublished) {
            const hostName = event.host?.profile?.name || 'A BIES member';
            const dateStr = data.startDate ? new Date(data.startDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
            publishAnnouncement(req.user!.id, `${hostName} is hosting "${event.title}"${dateStr ? ` on ${dateStr}` : ''}${event.location ? ` in ${event.location}` : ''}. Check it out on BIES!`, [['t', 'new-event']]).catch((err) =>
                console.error('[Nostr] Event announcement failed:', err)
            );
        }

        // Publish NIP-52 calendar event to Nostr relays (custodial users)
        let nostrPublished = false;
        if (nostrPublish !== 'none' && isPublished) {
            const validationError = validateCalendarEventData({
                id: event.id,
                title: event.title,
                startDate: data.startDate,
            });
            if (validationError) {
                console.warn('[Nostr] NIP-52 validation failed:', validationError);
            } else {
                try {
                    const nostrEventId = await publishCalendarEvent(req.user!.id, {
                        id: event.id,
                        title: event.title,
                        description: event.description,
                        startDate: data.startDate,
                        endDate: data.endDate || undefined,
                        location: event.location || undefined,
                        locationName: event.locationName || undefined,
                        locationAddress: event.locationAddress || undefined,
                        isOnline: event.isOnline,
                        onlineUrl: event.onlineUrl || undefined,
                        category: event.category,
                        tags: parsedTags,
                        thumbnail: event.thumbnail || undefined,
                        ticketUrl: event.ticketUrl || undefined,
                    }, nostrPublish as 'bies' | 'public' | 'both');
                    if (nostrEventId) {
                        await prisma.event.update({
                            where: { id: event.id },
                            data: { nostrEventId },
                        });
                        nostrPublished = true;
                    }
                } catch (err) {
                    console.error('[Nostr] NIP-52 calendar event publish failed:', err);
                }
            }
        }

        res.status(201).json({
            ...event,
            tags: JSON.parse(event.tags || '[]'),
            guestList: JSON.parse(event.guestList || '[]'),
            customSections: JSON.parse((event as any).customSections || '[]'),
            nostrPublished,
        });
    } catch (error) {
        console.error('Create event error:', error);
        if (error instanceof z.ZodError) {
            res.status(400).json({ error: 'Validation failed', details: error.issues });
            return;
        }
        res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to create event' });
    }
}

/**
 * PUT /events/:id
 * Update an event (host only).
 */
export async function updateEvent(req: Request, res: Response): Promise<void> {
    try {
        const existing = await prisma.event.findUnique({
            where: { id: req.params.id },
            select: { hostId: true, visibility: true, nostrEventId: true, nostrPublish: true },
        });

        if (!existing) { res.status(404).json({ error: 'Event not found' }); return; }
        if (existing.hostId !== req.user!.id && !req.user!.isAdmin) {
            res.status(403).json({ error: 'Not authorized' }); return;
        }

        const allowedFields = [
            'title', 'description', 'category', 'visibility',
            'location', 'locationName', 'locationAddress', 'locationMapUrl',
            'isOnline', 'onlineUrl', 'startDate', 'endDate',
            'thumbnail', 'ticketUrl', 'maxAttendees', 'tags', 'isOfficial',
            'priceSats', 'ticketCapacity', 'payoutLightningAddress',
            'endorsementRequested', 'guestList', 'customSections', 'nostrPublish',
        ];
        const data: any = {};
        for (const field of allowedFields) {
            if (req.body[field] !== undefined) {
                if (field === 'isOfficial' && req.body[field] === true && !req.user!.isAdmin) {
                    continue;
                }
                data[field] = req.body[field];
            }
        }

        const nostrPublish: string = data.nostrPublish || 'none';

        // Sync isPublished when visibility changes
        if (data.visibility !== undefined) {
            data.isPublished = visibilityToPublished(data.visibility);
        }

        // Format arrays into JSON strings for SQLite
        const parsedTags: string[] = data.tags || [];
        if (data.tags !== undefined) data.tags = JSON.stringify(data.tags);
        if (data.guestList !== undefined) data.guestList = JSON.stringify(data.guestList);
        if (data.customSections !== undefined) data.customSections = JSON.stringify(data.customSections);

        if (data.startDate) data.startDate = new Date(data.startDate);
        if (data.endDate) data.endDate = new Date(data.endDate);

        const event = await prisma.event.update({ where: { id: req.params.id }, data });
        await cache.delPattern('events:');

        // If visibility changed to non-public and event was previously on Nostr, delete it
        let nostrPublished = false;
        const wasPublic = visibilityToPublished(existing.visibility);
        const isNowPublic = event.isPublished;

        if (wasPublic && !isNowPublic && existing.nostrEventId) {
            const prevTarget = (existing.nostrPublish || 'bies') as 'bies' | 'public' | 'both';
            deleteCalendarEvent(req.user!.id, existing.nostrEventId, event.id, prevTarget).catch((err) =>
                console.error('[Nostr] NIP-09 deletion on visibility change failed:', err)
            );
            await prisma.event.update({
                where: { id: event.id },
                data: { nostrEventId: '', nostrPublish: 'none' },
            });
        } else if (nostrPublish !== 'none' && isNowPublic) {
            // Re-publish NIP-52 calendar event (kind 31923 is replaceable via d-tag)
            const validationError = validateCalendarEventData({
                id: event.id,
                title: event.title,
                startDate: event.startDate,
            });
            if (validationError) {
                console.warn('[Nostr] NIP-52 validation failed on update:', validationError);
            } else {
                try {
                    const nostrEventId = await publishCalendarEvent(req.user!.id, {
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
                        tags: parsedTags.length > 0 ? parsedTags : JSON.parse(event.tags || '[]'),
                        thumbnail: event.thumbnail || undefined,
                        ticketUrl: event.ticketUrl || undefined,
                    }, nostrPublish as 'bies' | 'public' | 'both');
                    if (nostrEventId) {
                        await prisma.event.update({
                            where: { id: event.id },
                            data: { nostrEventId },
                        });
                        nostrPublished = true;
                    }
                } catch (err) {
                    console.error('[Nostr] NIP-52 calendar event update failed:', err);
                }
            }
        }

        res.json({
            ...event,
            tags: JSON.parse(event.tags || '[]'),
            guestList: JSON.parse(event.guestList || '[]'),
            customSections: JSON.parse((event as any).customSections || '[]'),
            nostrPublished,
        });
    } catch (error) {
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
            select: { hostId: true, nostrEventId: true, nostrPublish: true },
        });

        if (!existing) { res.status(404).json({ error: 'Event not found' }); return; }
        if (existing.hostId !== req.user!.id && !req.user!.isAdmin) {
            res.status(403).json({ error: 'Not authorized' }); return;
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
        await cache.delPattern('events:');

        res.json({ message: 'Event deleted' });
    } catch (error) {
        console.error('Delete event error:', error);
        res.status(500).json({ error: 'Failed to delete event' });
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
                host: { select: { nostrPubkey: true } },
            },
        });

        if (!event || !event.isPublished) {
            res.status(404).json({ error: 'Event not found' }); return;
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
                    res.status(409).json({ error: 'Event is at full capacity' }); return;
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

            if (status === 'GOING') {
                publishAnnouncement(userId, `${userName} is going to "${event.title}"!`, [['t', 'rsvp']]).catch((err) =>
                    console.error('[Nostr] RSVP announcement failed:', err)
                );
            }

            // Notify event host (don't notify yourself)
            if (event.hostId !== userId) {
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

        res.json(attendee);
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
        const event = await prisma.event.findUnique({ where: { id: req.params.id }, select: { visibility: true } });
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
            select: { title: true, isPublished: true, hostId: true },
        });

        if (!event || !event.isPublished) {
            res.status(404).json({ error: 'Event not found' }); return;
        }

        // Only the event host can send invitations
        if (event.hostId !== inviterId) {
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
