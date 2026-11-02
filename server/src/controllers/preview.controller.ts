import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { config } from '../config';
import { cache, TTL } from '../services/redis.service';
import { isEnabled } from '../services/featureFlags.service';
import { removeTags } from '../middleware/sanitize';
import { isOpen } from './project.controller';
import { isRepeat, repeatLabel, shownOccurrence } from '../utils/eventRepeat';
import { dayView } from '../services/eventDates.service';
import { proposalStage } from '../services/eventProposals.service';
import { cardImage, cardKey, shareCardSpec, SQUARE, WIDE, type CardSpec } from '../services/shareCard.service';

/**
 * Public previews of a shared page, for people who aren't signed in to BIES:
 * the business, farm, opportunity, talent or event at the link, with enough to
 * want the rest, then "See all details" to sign in (src/pages/SharePreview.jsx).
 * GET /preview/:section/:id is that teaser; GET /preview/:section/:id/og is
 * the link card WhatsApp, iMessage and others draw (nginx sends their
 * crawlers there). No contact details, no member names, no amounts and no
 * reviews' words: what's behind sign-in is only named ("How to contact them").
 * An event is an invitation people share on purpose: its preview names its
 * hosts, co-hosts and sponsors and links to its tickets, as Luma does; its
 * address, online link and who's going stay for members.
 */

export const SECTIONS = ['trusted', 'farms', 'opportunities', 'talents', 'events'] as const;
export type Section = typeof SECTIONS[number];

const FLAG = { trusted: 'directories', farms: 'directories', opportunities: 'projects', talents: 'talent', events: 'events' } as const;

const SAFE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const ACTIVE = { isBanned: false, deletedAt: null };
const ACTIVE_FIELDS = { isBanned: true, deletedAt: true } as const;
const SUMMARY_LENGTH = 240;

/** The BIES icon a link card shows when it has no picture of its own (public/icons/icon-512.png). */
const ICON_SIZE = { width: 512, height: 512 };

const parseJson = <T>(value: string | null | undefined, fallback: T): T => {
    try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
};

// Where the words break onto a new line or paragraph.
const BREAK = /<\/(?:p|div|h[1-6]|li|blockquote)>|<br\s*\/?>/gi;

/**
 * Plain text, cut at a word near `length`, with … when cut. Its lines run on
 * with a space between, and a full stop after one without (a heading):
 * "BIES Networking night. Just a room…", not "nightJust a room".
 */
export function summary(text: string, length = SUMMARY_LENGTH): { text: string; cut: boolean } {
    const plain = (text || '').split(BREAK)
        .map((piece) => removeTags(piece).replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .reduce((all, piece) => (all ? `${all}${/[.!?…:;,]$/.test(all) ? '' : '.'} ${piece}` : piece), '');
    if (plain.length <= length) return { text: plain, cut: false };
    const space = plain.lastIndexOf(' ', length);
    return { text: `${plain.slice(0, space > length * 0.6 ? space : length).replace(/[\s,.;:–-]+$/, '')}…`, cut: true };
}

async function listingTeaser(id: string) {
    const listing = await prisma.directoryListing.findUnique({
        where: { id },
        include: {
            owner: { select: ACTIVE_FIELDS },
            memberUser: { select: ACTIVE_FIELDS },
            endorsements: { where: { user: ACTIVE }, select: { comment: true } },
        },
    });
    if (!listing || listing.status !== 'active' || !listing.isPublished) return null;
    const runner = listing.memberUser ?? listing.owner;
    if (!runner || runner.isBanned || runner.deletedAt) return null;

    const photos = parseJson<string[]>(listing.photos, []);
    const cover = listing.photo || photos[0] || listing.logo || '';
    const about = summary(listing.about);
    const isFarm = listing.type === 'FARM';
    return {
        section: (isFarm ? 'farms' : 'trusted') as Section,
        id: listing.id,
        type: listing.type,
        name: listing.name,
        category: listing.category,
        products: isFarm ? parseJson<{ label?: string }[]>(listing.products, []).map((p) => p?.label).filter(Boolean) : [],
        skills: isFarm ? [] : parseJson<string[]>(listing.skills, []),
        location: listing.location,
        photo: cover,
        coverFrame: cover === listing.photo ? listing.coverFrame : '',
        about: about.text,
        vouchCount: listing.vouchCount,
        isCertified: listing.isCertified,
        btcAccepted: listing.btcAccepted,
        pricing: isFarm ? '' : listing.pricing,
        // Named on the preview, shown after sign-in.
        members: {
            contact: !!(listing.phone || listing.whatsapp || listing.email),
            links: !!(listing.website || listing.instagram),
            hours: !!listing.hours,
            map: !!listing.mapUrl,
            morePhotos: photos.filter((p) => p !== cover).length,
            reviews: listing.endorsements.filter((e) => e.comment.trim()).length,
            fullText: about.cut,
        },
    };
}

async function opportunityTeaser(id: string) {
    const project = await prisma.project.findUnique({
        where: { id },
        include: { owner: { select: ACTIVE_FIELDS } },
    });
    if (!project || !project.isPublished || project.owner.isBanned || project.owner.deletedAt) return null;
    const photos = parseJson<string[]>(project.photos, []);
    const cover = project.thumbnail || photos[0] || '';
    const text = summary(project.description);
    return {
        section: 'opportunities' as Section,
        id: project.id,
        type: project.type,
        kind: project.kind,
        name: project.title,
        category: project.category,
        location: project.location,
        remote: project.remote,
        btcAccepted: project.type !== 'investment' && project.btcAccepted,
        photo: cover,
        coverFrame: project.coverFrame,
        about: text.text,
        closesOn: project.closesOn,
        isOpen: isOpen(project),
        members: {
            contact: !!(project.whatsapp || project.email),
            links: !!(project.websiteUrl || project.demoUrl),
            deck: !!project.deckKey,
            morePhotos: photos.filter((p) => p !== cover).length,
            fullText: text.cut,
        },
    };
}

async function talentTeaser(id: string) {
    const talent = await prisma.talentListing.findUnique({
        where: { id },
        include: { user: { select: ACTIVE_FIELDS } },
    });
    if (!talent || talent.user.isBanned || talent.user.deletedAt) return null;
    const works = parseJson<{ media?: { url: string; poster?: string }[] }[]>(talent.works, []);
    const firstMedia = works.flatMap((w) => w.media || [])[0];
    const text = summary(talent.about);
    return {
        section: 'talents' as Section,
        id: talent.id,
        name: talent.title,
        category: talent.category,
        skills: parseJson<string[]>(talent.skills, []),
        location: talent.location,
        remote: talent.remote,
        available: talent.available,
        btcAccepted: talent.btcAccepted,
        coverFrame: talent.photo ? talent.coverFrame : '',
        photo: talent.photo || firstMedia?.poster || (firstMedia && /\.(jpe?g|png|gif|webp)$/i.test(firstMedia.url) ? firstMedia.url : '') || '',
        about: text.text,
        members: {
            contact: !!(talent.whatsapp || talent.email || talent.website),
            rate: !!talent.rate,
            works: works.length,
            fullText: text.cut,
        },
    };
}

/** A member's name as the app shows it, or '' for a placeholder. */
const shownName = (name: string | null | undefined) => (name && !name.startsWith('nostr:') ? name.trim() : '');
const LIVE_LISTING = { name: true, status: true, isPublished: true, isOfficial: true } as const;
const liveListing = (l: { status: string; isPublished: boolean } | null) => !!l && l.status === 'active' && l.isPublished;

async function eventTeaser(id: string) {
    const event = await prisma.event.findUnique({
        where: { id },
        include: {
            host: { select: { ...ACTIVE_FIELDS, profile: { select: { name: true } } } },
            hostListing: { select: LIVE_LISTING },
            partners: {
                orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
                include: {
                    user: { select: { ...ACTIVE_FIELDS, profile: { select: { name: true } } } },
                    listing: { select: LIVE_LISTING },
                },
            },
            _count: { select: { attendees: { where: { status: 'GOING' } } } },
            dateChanges: true,
        },
    });
    if (!event || !event.isPublished || event.visibility === 'PRIVATE' || event.visibility === 'DRAFT') return null;
    if (event.calledOffAt) return null; // a proposed meetup that didn't happen
    if (event.host.isBanned || event.host.deletedAt) return null;

    const partnerName = (p: typeof event.partners[number]) => {
        if (p.user) return p.user.isBanned || p.user.deletedAt ? '' : shownName(p.user.profile?.name);
        if (p.listing) return liveListing(p.listing) ? p.listing.name : '';
        return p.name;
    };
    const named = (role: string) => event.partners.filter((p) => p.role === role).map(partnerName).filter(Boolean);
    // A repeating event: its next date as it really is (its last, once it's
    // all over: its own time, title and place), and who's going to that one.
    const when = shownOccurrence(event, new Date());
    const day = dayView(event, when);
    const about = summary(day.description);
    const going = isRepeat(event.repeat)
        ? await prisma.eventAttendee.count({ where: { eventId: event.id, status: 'GOING', occurrenceStart: when.key } })
        : event._count.attendees;
    return {
        section: 'events' as Section,
        id: event.id,
        name: day.title,
        kind: event.category,
        location: day.isOnline ? 'Online' : day.locationName,
        isOnline: day.isOnline,
        startDate: when.startDate,
        endDate: when.endDate,
        repeat: isRepeat(event.repeat) ? event.repeat : '',
        // The date as its rule makes it (startDate may be moved): what "Every
        // Saturday" is said from.
        occurrence: isRepeat(event.repeat) ? when.key : null,
        photo: event.thumbnail || '',
        coverFrame: event.coverFrame,
        // The cover as the link's picture shows it (shareCard.service.ts).
        shareFrame: event.shareFrame,
        // A proposed meetup: proposed until enough people are in.
        stage: proposalStage(event),
        minAttendees: event.minAttendees,
        about: about.text,
        isOfficial: liveListing(event.hostListing) && event.hostListing!.isOfficial,
        priceLabel: event.priceLabel,
        ticketUrl: /^https:\/\//i.test(event.ticketUrl) ? event.ticketUrl : '',
        bitcoinUrl: /^https:\/\//i.test(event.bitcoinUrl) ? event.bitcoinUrl : '',
        // Hosted as a business that's since been taken down: no name at all.
        host: (event.hostListingId
            ? (liveListing(event.hostListing) ? event.hostListing!.name : '')
            : shownName(event.host.profile?.name)) || 'A BIES member',
        cohosts: named('COHOST'),
        sponsors: named('SPONSOR'),
        members: {
            address: !!(day.locationAddress || day.locationMapUrl),
            onlineLink: !!day.onlineUrl,
            going,
            fullText: about.cut,
        },
    };
}

export type Teaser = NonNullable<Awaited<ReturnType<typeof listingTeaser | typeof opportunityTeaser | typeof talentTeaser | typeof eventTeaser>>>;

/** The teaser for a shared page, or null when it isn't there (or its part of BIES is switched off). */
export async function teaser(section: Section, id: string): Promise<Teaser | null> {
    if (!SAFE_ID_RE.test(id) || !await isEnabled(FLAG[section])) return null;
    const key = `preview:${section}:${id}`;
    const cached = await cache.getJson<Teaser | { missing: true }>(key);
    if (cached) return 'missing' in cached ? null : cached;
    const found = section === 'opportunities' ? await opportunityTeaser(id)
        : section === 'talents' ? await talentTeaser(id)
            : section === 'events' ? await eventTeaser(id)
                : await listingTeaser(id);
    await cache.setJson(key, found ?? { missing: true }, TTL.PROJECT_DETAIL);
    return found;
}

const sectionOf = (value: string): Section | null => (SECTIONS as readonly string[]).includes(value) ? value as Section : null;

/** GET /preview/:section/:id — no sign-in needed. */
export async function getPreview(req: Request, res: Response): Promise<void> {
    try {
        const section = sectionOf(req.params.section);
        const found = section && await teaser(section, req.params.id);
        if (!found) {
            res.status(404).json({ error: 'Not found' });
            return;
        }
        res.json(found);
    } catch (error) {
        console.error('Preview error:', error);
        res.status(500).json({ error: 'Failed to load the preview' });
    }
}

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

const OPPORTUNITY_TYPES: Record<string, string> = {
    investment: 'Project', 'business-for-sale': 'Business for sale', job: 'Job', partnership: 'Partnership', program: 'Grant or program',
};

const whenParts = (date: Date | string) => Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/El_Salvador', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
}).formatToParts(new Date(date)).map((p) => [p.type, p.value]));

/** The day an event is on, in El Salvador: "Sat 14 Nov". */
export function eventDay(date: Date | string): string {
    const parts = whenParts(date);
    return `${parts.weekday} ${parts.day} ${parts.month}`;
}

/** The time it starts, in El Salvador: "7:00 PM". */
export function eventTime(date: Date | string): string {
    const parts = whenParts(date);
    return `${parts.hour}:${parts.minute} ${parts.dayPeriod}`;
}

/** When an event starts, in El Salvador: "Sat 14 Nov · 7:00 PM". */
export function eventWhen(date: Date | string): string {
    return `${eventDay(date)} · ${eventTime(date)}`;
}

type EventTeaser = NonNullable<Awaited<ReturnType<typeof eventTeaser>>>;
const isEventTeaser = (found: Teaser): found is EventTeaser => found.section === 'events' && 'startDate' in found;

/**
 * How it repeats ("Every other Saturday"), said from the date as its rule
 * makes it: a date moved to a Sunday is still one of the Saturdays.
 */
const repeatText = (found: EventTeaser) => (found.repeat ? repeatLabel(found.repeat, new Date(found.occurrence ?? found.startDate)) : '');

/** What the picture of an event's link card shows. */
export function eventCardSpec(found: EventTeaser): CardSpec {
    return shareCardSpec({ ...found, repeatText: repeatText(found) });
}

/** The link card's words: what it is and where, then its own words. */
export function cardText(found: Teaser): { title: string; description: string } {
    if (isEventTeaser(found)) {
        // The day is in its name, as iMessage shows only the name (and the
        // picture says BIES): "BIES Soccer · Sat 7 Nov", then
        // "4:00 PM · Every other Saturday · Sports field — …".
        const lead = [
            eventTime(found.startDate),
            repeatText(found),
            found.stage === 'proposed' ? 'Proposed meetup' : '',
            found.location,
        ].filter(Boolean).join(' · ');
        const about = summary(found.about, 160).text;
        return { title: `${found.name} · ${eventDay(found.startDate)}`, description: [lead, about].filter(Boolean).join(' — ') };
    }
    const parts: string[] = [];
    if (found.section === 'opportunities' && 'type' in found) parts.push(OPPORTUNITY_TYPES[found.type] || 'Opportunity');
    if (found.section === 'talents') parts.push('Talent');
    if (found.location) parts.push(found.location);
    if ('vouchCount' in found && found.vouchCount > 0) {
        parts.push(`Recommended by ${found.vouchCount} ${found.vouchCount === 1 ? 'member' : 'members'}`);
    }
    const lead = parts.join(' · ');
    const about = summary(found.about, 160).text;
    return { title: `${found.name} | BIES`, description: [lead, about].filter(Boolean).join(' — ') || 'On BIES, Build in El Salvador' };
}

/**
 * GET /preview/:section/:id/og — the page link-preview crawlers read.
 * Not for search engines (noindex): a shared link previews; it doesn't
 * publish the listing.
 */
export async function getPreviewOG(req: Request, res: Response): Promise<void> {
    const section = sectionOf(req.params.section);
    const id = req.params.id;
    if (!section || !SAFE_ID_RE.test(id)) {
        res.status(400).json({ error: 'Invalid link' });
        return;
    }
    const base = config.appPublicUrl;
    const page = `${base}/${section}/${id}`;
    let title = 'BIES | Build in El Salvador';
    let description = 'Trusted businesses and farms, opportunities and talent, recommended by members of Build in El Salvador.';
    // The BIES icon, unless it has a picture of its own.
    let image = `${base}/icons/icon-512.png`;
    let imageSize: { width: number; height: number; type: string } | null = { ...ICON_SIZE, type: 'image/png' };
    try {
        const found = await teaser(section, id);
        if (found) {
            ({ title, description } = cardText(found));
            if (isEventTeaser(found)) {
                // An event's picture is drawn for it (getEventCard), named after what's on it.
                const spec = eventCardSpec(found);
                image = `${base}/api/preview/events/${id}/card.jpg?v=${cardKey(spec)}`;
                imageSize = { ...(spec.format === 'square' ? SQUARE : WIDE), type: 'image/jpeg' };
                // Drawn now, not waited for: it's ready by the time the crawler asks for it.
                void cardImage(id, spec);
            } else if (found.photo) {
                image = /^https?:\/\//i.test(found.photo) ? found.photo : `${base}${found.photo.startsWith('/') ? '' : '/'}${found.photo}`;
                imageSize = null; // a member's photo: its size isn't known here
            }
        }
    } catch (error) {
        console.error('Preview card error:', error);
    }
    const [t, d, i, u] = [title, description, image, page].map(escapeHtml);
    // Its size up front, so WhatsApp shows the picture before it has it.
    const sized = imageSize
        ? `\n  <meta property="og:image:width" content="${imageSize.width}" />\n  <meta property="og:image:height" content="${imageSize.height}" />\n  <meta property="og:image:type" content="${imageSize.type}" />`
        : '';
    res.set('Cache-Control', 'public, max-age=600');
    res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="robots" content="noindex" />
  <meta property="og:title" content="${t}" />
  <meta property="og:description" content="${d}" />
  <meta property="og:image" content="${i}" />${sized}
  <meta property="og:url" content="${u}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="BIES" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${t}" />
  <meta name="twitter:description" content="${d}" />
  <meta name="twitter:image" content="${i}" />
  <meta http-equiv="refresh" content="0;url=${u}" />
  <title>${t}</title>
</head>
<body>
  <p><a href="${u}">${t}</a></p>
</body>
</html>`);
}

/**
 * GET /preview/events/:id/card.jpg — the picture a shared event's link card
 * shows (shareCard.service.ts). No sign-in, like the card page that links it.
 */
export async function getEventCard(req: Request, res: Response): Promise<void> {
    const id = req.params.id;
    try {
        const found = SAFE_ID_RE.test(id) ? await teaser('events', id) : null;
        if (!found || !isEventTeaser(found)) {
            res.status(404).end();
            return;
        }
        const spec = eventCardSpec(found);
        const card = await cardImage(id, spec);
        if (!card) {
            res.redirect(302, `${config.appPublicUrl}/icons/icon-512.png`);
            return;
        }
        res.set('X-Content-Type-Options', 'nosniff');
        if ('bytes' in card) {
            // Drawn without its cover (it couldn't be had just now): not kept anywhere, so it's drawn again next time.
            res.set('Cache-Control', 'no-store');
            res.type('image/jpeg').send(card.bytes);
            return;
        }
        // The card page links it by what's on it (?v=), so that link can be kept a day.
        res.set('Cache-Control', `public, max-age=${req.query.v === cardKey(spec) ? 86400 : 300}`);
        res.type('image/jpeg').sendFile(card.file);
    } catch (error) {
        console.error('Share card error:', error);
        res.status(500).end();
    }
}
