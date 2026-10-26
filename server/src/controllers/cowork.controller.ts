/**
 * Cowork controller — server-backed, joinable cowork sessions with venues,
 * attendance, and history. Replaces the old ephemeral Nostr presence model.
 *
 * Mirrors the events controller conventions: JSON-string arrays (amenities),
 * flattened host/attendee profiles, read-through cache for the venue dropdown,
 * and broadcast({ type: 'cowork_update' }) on mutations for WS-aware clients.
 */

import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { z } from 'zod';
import { cache } from '../services/redis.service';
import { broadcast } from '../services/websocket.service';

// Venue dropdown cache. Uses the 'cowork_venues:' prefix so it can be
// invalidated with cache.delPattern('cowork_venues:') on add.
const COWORK_VENUES_CACHE_KEY = 'cowork_venues:all';
const COWORK_VENUES_TTL = 300; // 5 min — venues change infrequently

// ─── Include shapes (mirror events.controller profile-include) ────────────────

const HOST_SELECT = {
    id: true,
    nostrPubkey: true,
    profile: { select: { name: true, avatar: true, company: true } },
} as const;

const ATTENDEE_USER_SELECT = {
    id: true,
    nostrPubkey: true,
    profile: { select: { id: true, name: true, avatar: true, company: true } },
} as const;

// ─── Validation ────────────────────────────────────────────────────────────────

export const addVenueSchema = z.object({
    name: z.string().trim().min(1).max(120),
    address: z.string().max(200).optional(),
    area: z.string().max(80).optional(),
    lat: z.number().nullable().optional(),
    lng: z.number().nullable().optional(),
});

export const createSessionSchema = z.object({
    title: z.string().trim().min(1).max(140),
    venueId: z.string().optional(),
    locationName: z.string().max(200).optional(),
    lat: z.number().nullable().optional(),
    lng: z.number().nullable().optional(),
    note: z.string().max(280).optional(),
    amenities: z.array(z.string().max(40)).max(20).default([]),
    durationMinutes: z.number().int().min(30).max(480),
    startTime: z.string().optional(),
});

// ─── Serialization helpers ───────────────────────────────────────────────────

function flattenHost(h: any) {
    return {
        id: h.id,
        name: h.profile?.name || '',
        avatar: h.profile?.avatar || '',
        nostrPubkey: h.nostrPubkey,
    };
}

function toVenue(v: any) {
    return {
        id: v.id,
        name: v.name,
        address: v.address,
        area: v.area,
        lat: v.lat,
        lng: v.lng,
        createdById: v.createdById,
    };
}

function safeParseArray(raw: string | null | undefined): string[] {
    try {
        const parsed = JSON.parse(raw || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/** Build the shared Session JSON shape (list item + detail base). */
function baseSession(s: any, currentUserId: string, attendeeCount: number, isAttending: boolean) {
    return {
        id: s.id,
        title: s.title,
        host: flattenHost(s.host),
        venue: s.venue
            ? { id: s.venue.id, name: s.venue.name, address: s.venue.address, area: s.venue.area, lat: s.venue.lat, lng: s.venue.lng }
            : null,
        locationName: s.locationName,
        lat: s.lat,
        lng: s.lng,
        note: s.note,
        amenities: safeParseArray(s.amenities),
        startTime: s.startTime,
        endTime: s.endTime,
        status: s.status,
        attendeeCount,
        isAttending,
        isHost: s.hostId === currentUserId,
    };
}

// ─── Venues ──────────────────────────────────────────────────────────────────

/**
 * GET /cowork/venues
 * List all venues for the dropdown, grouped by area. Read-through cache.
 */
export async function listVenues(req: Request, res: Response): Promise<void> {
    try {
        const cached = await cache.getJson<any>(COWORK_VENUES_CACHE_KEY);
        if (cached) { res.json(cached); return; }

        const venues = await prisma.coworkVenue.findMany({
            orderBy: [{ area: 'asc' }, { name: 'asc' }],
        });
        const data = venues.map(toVenue);

        // Group by area (empty area collapses into '' -> frontend shows 'Other').
        // orderBy area asc means groups are emitted in area order already.
        const groupsMap = new Map<string, ReturnType<typeof toVenue>[]>();
        for (const v of data) {
            const key = v.area || '';
            if (!groupsMap.has(key)) groupsMap.set(key, []);
            groupsMap.get(key)!.push(v);
        }
        const groups = Array.from(groupsMap.entries()).map(([area, vs]) => ({ area, venues: vs }));

        const result = { data, groups };
        await cache.setJson(COWORK_VENUES_CACHE_KEY, result, COWORK_VENUES_TTL);
        res.json(result);
    } catch (error) {
        console.error('List cowork venues error:', error);
        res.status(500).json({ error: 'Failed to list venues' });
    }
}

/**
 * POST /cowork/venues
 * Add a spot with case-insensitive (name + area) dedupe.
 */
export async function addVenue(req: Request, res: Response): Promise<void> {
    try {
        const name = req.body.name.trim();
        const area = (req.body.area || '').trim();
        const address = (req.body.address || '').trim();
        const lat = req.body.lat ?? null;
        const lng = req.body.lng ?? null;

        const nameLower = name.toLowerCase();
        const areaLower = area.toLowerCase();

        // Case-insensitive dedupe on (name, area). SQLite's `equals` is byte-wise
        // and has no ILIKE, and the @@unique([name, area]) index is byte-wise too,
        // so casefold BOTH sides in JS — otherwise case variants (e.g. "Sukhumvit"
        // vs "sukhumvit") leak a near-duplicate row into the dropdown.
        const isSameVenue = (v: { name: string; area: string }) =>
            v.name.trim().toLowerCase() === nameLower
            && (v.area || '').trim().toLowerCase() === areaLower;

        const existing = (await prisma.coworkVenue.findMany()).find(isSameVenue);
        if (existing) {
            // Surface reuse so the caller can tell an existing spot was returned
            // rather than their submitted pin being stored. With an empty area,
            // distinct real places collide on the (name, "") key; the client uses
            // `reused` to warn the user to add an area to list a separate spot
            // instead of silently attaching their session to the wrong coordinates.
            res.status(200).json({ ...toVenue(existing), reused: true });
            return;
        }

        try {
            const venue = await prisma.coworkVenue.create({
                data: { name, address, area, lat, lng, createdById: req.user!.id },
            });
            await cache.delPattern('cowork_venues:');
            res.status(201).json({ ...toVenue(venue), reused: false });
        } catch (err: any) {
            // Unique-index race (@@unique([name, area])) — return the existing row.
            if (err?.code === 'P2002') {
                const raced = (await prisma.coworkVenue.findMany()).find(isSameVenue);
                if (raced) { res.status(200).json({ ...toVenue(raced), reused: true }); return; }
            }
            throw err;
        }
    } catch (error) {
        console.error('Add cowork venue error:', error);
        res.status(500).json({ error: 'Failed to add venue' });
    }
}

// ─── Sessions ────────────────────────────────────────────────────────────────

/**
 * GET /cowork/sessions?filter=active|past
 * Lazy-expires ACTIVE sessions past their endTime, then lists by filter.
 */
export async function listSessions(req: Request, res: Response): Promise<void> {
    try {
        const filter = req.query.filter === 'past' ? 'past' : 'active';

        // Lazy expiry: flip ACTIVE sessions whose endTime has passed to ENDED.
        await prisma.coworkSession.updateMany({
            where: { status: 'ACTIVE', endTime: { not: null, lt: new Date() } },
            data: { status: 'ENDED' },
        });

        const where = filter === 'past' ? { status: 'ENDED' } : { status: 'ACTIVE' };
        const orderBy = filter === 'past'
            ? ({ endTime: 'desc' } as const)
            : ({ startTime: 'asc' } as const);

        const sessions = await prisma.coworkSession.findMany({
            where,
            orderBy,
            include: {
                host: { select: HOST_SELECT },
                venue: true,
                _count: { select: { attendees: true } },
                attendees: { where: { userId: req.user!.id }, select: { id: true } },
            },
        });

        const data = sessions.map((s) =>
            baseSession(s, req.user!.id, s._count.attendees, s.attendees.length > 0)
        );
        res.json({ data });
    } catch (error) {
        console.error('List cowork sessions error:', error);
        res.status(500).json({ error: 'Failed to list sessions' });
    }
}

/**
 * POST /cowork/sessions
 * Create a session. Host auto-attends. durationMinutes -> endTime.
 */
export async function createSession(req: Request, res: Response): Promise<void> {
    try {
        const hostId = req.user!.id;
        const { title, venueId, locationName, lat, lng, note, amenities, durationMinutes, startTime } = req.body;

        // Require EITHER a resolvable venueId OR (locationName + finite coords).
        let resolvedVenue: any = null;
        if (venueId) {
            resolvedVenue = await prisma.coworkVenue.findUnique({ where: { id: venueId } });
            if (!resolvedVenue) { res.status(400).json({ error: 'Venue not found' }); return; }
        } else {
            const hasName = typeof locationName === 'string' && locationName.trim().length > 0;
            const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);
            if (!hasName || !hasCoords) { res.status(400).json({ error: 'Location required' }); return; }
        }

        const start = startTime ? new Date(startTime) : new Date();
        if (Number.isNaN(start.getTime())) { res.status(400).json({ error: 'Invalid startTime' }); return; }
        const end = new Date(start.getTime() + durationMinutes * 60000);

        // Prefer explicit coords, else fall back to the venue's for the map thumbnail.
        const finalLat = Number.isFinite(lat) ? lat : (resolvedVenue?.lat ?? null);
        const finalLng = Number.isFinite(lng) ? lng : (resolvedVenue?.lng ?? null);
        const finalLocationName = typeof locationName === 'string' ? locationName.trim() : '';

        // Create session + host attendee atomically.
        const session = await prisma.$transaction(async (tx) => {
            const created = await tx.coworkSession.create({
                data: {
                    title: title.trim(),
                    hostId,
                    venueId: resolvedVenue ? resolvedVenue.id : null,
                    locationName: finalLocationName,
                    lat: finalLat,
                    lng: finalLng,
                    note: (note || '').trim(),
                    amenities: JSON.stringify(amenities || []),
                    startTime: start,
                    endTime: end,
                },
                include: { host: { select: HOST_SELECT }, venue: true },
            });
            await tx.coworkAttendee.create({ data: { sessionId: created.id, userId: hostId } });
            return created;
        });

        broadcast({ type: 'cowork_update' });
        res.status(201).json(baseSession(session, hostId, 1, true));
    } catch (error) {
        console.error('Create cowork session error:', error);
        if (error instanceof z.ZodError) {
            res.status(400).json({ error: 'Validation failed', details: error.issues });
            return;
        }
        res.status(500).json({ error: 'Failed to create session' });
    }
}

/**
 * GET /cowork/sessions/:id
 * Detail with attendee profiles.
 */
export async function getSession(req: Request, res: Response): Promise<void> {
    try {
        const session = await prisma.coworkSession.findUnique({
            where: { id: req.params.id },
            include: {
                host: { select: HOST_SELECT },
                venue: true,
                _count: { select: { attendees: true } },
                attendees: {
                    take: 50,
                    orderBy: { joinedAt: 'asc' },
                    include: { user: { select: ATTENDEE_USER_SELECT } },
                },
            },
        });

        if (!session) { res.status(404).json({ error: 'Session not found' }); return; }

        const currentUserId = req.user!.id;
        const attendees = session.attendees.map((a) => ({
            id: a.userId,
            name: a.user.profile?.name || '',
            avatar: a.user.profile?.avatar || '',
            nostrPubkey: a.user.nostrPubkey,
            isHost: a.userId === session.hostId,
        }));
        // `attendees` above is capped at 50 for display, so scanning it would
        // report the 51st+ attendee as not attending. Check membership directly.
        const membership = await prisma.coworkAttendee.findUnique({
            where: { sessionId_userId: { sessionId: session.id, userId: currentUserId } },
            select: { id: true },
        });
        const isAttending = membership !== null;

        res.json({
            ...baseSession(session, currentUserId, session._count.attendees, isAttending),
            attendees,
        });
    } catch (error) {
        console.error('Get cowork session error:', error);
        res.status(500).json({ error: 'Failed to get session' });
    }
}

/**
 * POST /cowork/sessions/:id/join
 */
export async function joinSession(req: Request, res: Response): Promise<void> {
    try {
        const userId = req.user!.id;
        const sessionId = req.params.id;

        const session = await prisma.coworkSession.findUnique({
            where: { id: sessionId },
            select: { id: true, status: true },
        });
        if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
        if (session.status === 'ENDED') { res.status(409).json({ error: 'Session has ended' }); return; }

        await prisma.coworkAttendee.upsert({
            where: { sessionId_userId: { sessionId, userId } },
            update: {},
            create: { sessionId, userId },
        });

        const attendeeCount = await prisma.coworkAttendee.count({ where: { sessionId } });
        broadcast({ type: 'cowork_update' });
        res.json({ attendeeCount, isAttending: true });
    } catch (error) {
        console.error('Join cowork session error:', error);
        res.status(500).json({ error: 'Failed to join session' });
    }
}

/**
 * DELETE /cowork/sessions/:id/join
 * Leave. The host cannot leave — they must end the session instead.
 */
export async function leaveSession(req: Request, res: Response): Promise<void> {
    try {
        const userId = req.user!.id;
        const sessionId = req.params.id;

        const session = await prisma.coworkSession.findUnique({
            where: { id: sessionId },
            select: { id: true, hostId: true },
        });
        if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
        if (session.hostId === userId) {
            res.status(400).json({ error: 'Host cannot leave; end the session instead' });
            return;
        }

        await prisma.coworkAttendee.deleteMany({ where: { sessionId, userId } });

        const attendeeCount = await prisma.coworkAttendee.count({ where: { sessionId } });
        broadcast({ type: 'cowork_update' });
        res.json({ attendeeCount, isAttending: false });
    } catch (error) {
        console.error('Leave cowork session error:', error);
        res.status(500).json({ error: 'Failed to leave session' });
    }
}

/**
 * POST /cowork/sessions/:id/end
 * Host-only (or admin). Marks the session ENDED. Idempotent.
 */
export async function endSession(req: Request, res: Response): Promise<void> {
    try {
        const userId = req.user!.id;
        const sessionId = req.params.id;

        const session = await prisma.coworkSession.findUnique({
            where: { id: sessionId },
            include: {
                host: { select: HOST_SELECT },
                venue: true,
                _count: { select: { attendees: true } },
                attendees: { where: { userId }, select: { id: true } },
            },
        });
        if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
        if (session.hostId !== userId && !req.user!.isAdmin) {
            res.status(403).json({ error: 'Not authorized' });
            return;
        }

        const isAttending = session.attendees.length > 0;

        // Already ended — return idempotently.
        if (session.status === 'ENDED') {
            res.json(baseSession(session, userId, session._count.attendees, isAttending));
            return;
        }

        const endTime = new Date();
        await prisma.coworkSession.update({
            where: { id: sessionId },
            data: { status: 'ENDED', endTime },
        });

        broadcast({ type: 'cowork_update' });
        res.json(baseSession(
            { ...session, status: 'ENDED', endTime },
            userId,
            session._count.attendees,
            isAttending
        ));
    } catch (error) {
        console.error('End cowork session error:', error);
        res.status(500).json({ error: 'Failed to end session' });
    }
}
