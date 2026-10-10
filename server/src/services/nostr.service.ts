// nostr-tools is ESM-only (@noble/curves has no CJS build);
// use dynamic import() so the compiled CJS output doesn't call require().
import type { Event as NostrEvent, EventTemplate } from 'nostr-tools/pure';
import { randomUUID } from 'crypto';
import { config } from '../config';
import prisma from '../lib/prisma';
import { signAsHostedUser } from './hostedSigner.service';

let _pool: InstanceType<Awaited<typeof import('nostr-tools/pool')>['SimplePool']> | null = null;
async function getPool() {
    if (!_pool) {
        const { SimplePool } = await import('nostr-tools/pool');
        _pool = new SimplePool();
    }
    return _pool;
}

/**
 * Publish a Nostr event signed by a user's custodial key.
 * For Nostr-native users (no custodial key), events are signed client-side.
 */
export async function publishEvent(
    userId: string,
    eventTemplate: EventTemplate
): Promise<string | null> {
    try {
        const signedEvent = await signAsHostedUser(userId, eventTemplate, 'server');
        if (!signedEvent) {
            // Nostr-native user — they sign on the client side
            console.log(`[Nostr] User ${userId} has no custodial key, skipping server-side publish`);
            return null;
        }

        // Publish to private relay only
        const pool = await getPool();
        const relays = config.nostrPrivateRelay
            ? [config.nostrPrivateRelay]
            : config.nostrRelays;
        const results = await Promise.allSettled(
            pool.publish(relays, signedEvent)
        );

        const published = results.filter((r) => r.status === 'fulfilled').length;
        console.log(`[Nostr] Published to ${published}/${relays.length} relays`);

        return published > 0 ? signedEvent.id : null;
    } catch (error) {
        console.error('[Nostr] Publish error:', error);
        return null;
    }
}

/**
 * Fetch a single event by id from the configured relays (private relay
 * first, then public). Signature is verified by the pool. Returns null on
 * miss or timeout — callers treat that as "event does not exist".
 */
export async function fetchEventById(eventId: string, timeoutMs = 5000): Promise<NostrEvent | null> {
    try {
        const pool = await getPool();
        const relays: string[] = [];
        if (config.nostrPrivateRelay) relays.push(config.nostrPrivateRelay);
        relays.push(...config.nostrRelays);
        if (relays.length === 0) return null;

        const event = await Promise.race([
            pool.get(relays, { ids: [eventId] }),
            new Promise<null>((resolve) => setTimeout(resolve, timeoutMs, null)),
        ]);
        if (!event || event.id !== eventId) return null;
        return event;
    } catch (error) {
        console.error('[Nostr] Event fetch error:', error);
        return null;
    }
}

/**
 * Publish a user profile update (Kind 0).
 */
export async function publishProfileUpdate(
    userId: string,
    profile: {
        name: string;
        about?: string;
        picture?: string;
        banner?: string;
        website?: string;
        nip05?: string;
        lud16?: string;
        lud06?: string;
        bolt12?: string;
    }
): Promise<string | null> {
    const content: Record<string, string> = {
        name: profile.name,
        display_name: profile.name,
        about: profile.about || '',
        picture: profile.picture || '',
        website: profile.website || '',
    };
    if (profile.banner) content.banner = profile.banner;
    if (profile.nip05) content.nip05 = profile.nip05;
    if (profile.lud16) content.lud16 = profile.lud16;
    if (profile.lud06) content.lud06 = profile.lud06;
    if (profile.bolt12) content.bolt12 = profile.bolt12;

    const event: EventTemplate = {
        kind: 0,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: JSON.stringify(content),
    };

    return publishEvent(userId, event);
}

/**
 * Publish a project as a long-form content event (Kind 30023).
 */
export async function publishProject(
    userId: string,
    project: {
        id: string;
        title: string;
        description: string;
        category: string;
        stage: string;
        thumbnail?: string;
    }
): Promise<string | null> {
    const event: EventTemplate = {
        kind: 30023,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
            ['d', project.id], // unique identifier for replaceable event
            ['title', project.title],
            ['t', project.category.toLowerCase()],
            ['t', project.stage.toLowerCase()],
            ['t', 'bies'], // tag all BIES projects
            ['summary', project.description.substring(0, 200)],
            ...(project.thumbnail ? [['image', project.thumbnail]] : []),
        ],
        content: project.description,
    };

    return publishEvent(userId, event);
}

/**
 * Publish a project as a NIP-99 classified listing (Kind 30402).
 * Discoverable in Nostr clients with marketplace/classified support.
 */
export async function publishProjectListing(
    userId: string,
    project: {
        id: string;
        title: string;
        description: string;
        category: string;
        stage: string;
        fundingGoal?: number | null;
        thumbnail?: string;
        location?: string;
    }
): Promise<string | null> {
    const tags: string[][] = [
        ['d', project.id],
        ['title', project.title],
        ['summary', project.description.substring(0, 200)],
        ['t', project.category.toLowerCase()],
        ['t', project.stage.toLowerCase()],
        ['t', 'bies'],
        ['t', 'investment'],
    ];

    if (project.fundingGoal) {
        tags.push(['price', String(project.fundingGoal), 'USD']);
    }
    if (project.thumbnail) {
        tags.push(['image', project.thumbnail]);
    }
    if (project.location) {
        tags.push(['location', project.location]);
    }

    const event: EventTemplate = {
        kind: 30402,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: project.description,
    };

    return publishEvent(userId, event);
}

/**
 * Publish a directory listing as a NIP-99 classified listing (Kind 30402).
 * Signed with the linked member's custodial key (call sites pass
 * memberUserId ?? ownerId). Returns the event id, or null for
 * Nostr-native users (who sign client-side via the nostrService twin).
 */
export async function publishDirectoryListing(
    userId: string,
    listing: {
        id: string;
        type: string; // FARM | PROVIDER
        name: string;
        about?: string | null;
        photo?: string | null;
        location?: string | null;
        products?: string | Array<{ label?: string } | string> | null; // FARM chips
        skills?: string | string[] | null; // PROVIDER
    }
): Promise<string | null> {
    const about = listing.about || '';
    const tags: string[][] = [
        ['d', listing.id],
        ['title', listing.name],
        ['summary', about.slice(0, 200)],
        ['t', 'bies'],
        ['t', 'directory'],
        ['t', listing.type === 'FARM' ? 'farm' : 'services'],
    ];

    // One topic tag per product label (FARM) or skill (PROVIDER),
    // deduped and capped at 10 to avoid tag spam.
    const rawItems = listing.type === 'FARM' ? listing.products : listing.skills;
    let items: unknown[] = [];
    if (typeof rawItems === 'string') {
        try { items = JSON.parse(rawItems || '[]'); } catch { items = []; }
    } else if (Array.isArray(rawItems)) {
        items = rawItems;
    }
    const seen = new Set(['bies', 'directory', 'farm', 'services']);
    for (const item of items) {
        const label = typeof item === 'string' ? item : (item as { label?: unknown })?.label;
        if (typeof label !== 'string') continue;
        const value = label.trim().toLowerCase();
        if (!value || seen.has(value)) continue;
        seen.add(value);
        tags.push(['t', value]);
        if (seen.size >= 14) break; // 4 base topic tags + max 10 item tags
    }

    if (listing.photo) tags.push(['image', listing.photo]);
    if (listing.location) tags.push(['location', listing.location]);

    const event: EventTemplate = {
        kind: 30402,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: about,
    };

    return publishEvent(userId, event);
}

// ─── NIP-99 Marketplace (Shopstr-compatible, Kind 30402) ─────────────────────

// Shopstr's default relay set (shopstr-eng/shopstr getDefaultRelays).
// Publishing here makes BIES listings visible in Shopstr's browse feed.
const SHOPSTR_RELAYS = [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://purplepag.es',
    'wss://relay.primal.net',
    'wss://relay.nostr.band',
];

// Base t-tags every BIES marketplace listing carries: "shopstr" puts the
// listing in Shopstr's feed; "bies" + "marketplace" drive our own filtering.
const MARKETPLACE_TOPIC_TAGS = ['shopstr', 'bies', 'marketplace'];

const MAX_CATEGORY_TAGS = 8;

/**
 * Marketplace listings always go to BOTH the private relay and the public
 * relays (external Shopstr visibility is the point) — same selection as the
 * calendar 'both' target, extended with Shopstr's default relay set.
 */
function marketplaceRelays(): string[] {
    const relays: string[] = [];
    if (config.nostrPrivateRelay) {
        relays.push(config.nostrPrivateRelay);
    }
    for (const relay of [...config.nostrRelays, ...SHOPSTR_RELAYS]) {
        if (!relays.includes(relay)) relays.push(relay);
    }
    return relays;
}

export interface MarketplaceListingInput {
    title: string;
    summary?: string;
    description?: string;
    price?: { amount?: number | string; currency?: string } | null;
    amount?: number | string;
    currency?: string;
    images?: string[];
    location?: string;
    status?: string; // active | sold
    categories?: string[];
    dTag?: string; // existing d-tag (edits); omit for new listings
    publishedAt?: number | string; // original published_at (preserved on edits)
}

/**
 * Build the Kind 30402 tag array + content for a marketplace listing.
 * MUST stay byte-identical to buildListingTags in src/utils/nip99.js
 * (the client-side twin for Nostr-native users).
 */
function buildMarketplaceListingTags(
    form: MarketplaceListingInput,
    { dTag, publishedAt }: { dTag?: string; publishedAt?: number | string } = {}
): { tags: string[][]; content: string; dTag: string } {
    const d = dTag || randomUUID();
    const description = form.description || '';
    const summary = (form.summary || description).slice(0, 200);
    const amount = form.price?.amount ?? form.amount ?? 0;
    const currency = String(form.price?.currency ?? form.currency ?? 'SATS').toUpperCase();

    const tags: string[][] = [
        ['d', d],
        ['title', form.title],
        ['summary', summary],
        // Set on first publish, preserved on edits (Shopstr convention)
        ['published_at', publishedAt != null && publishedAt !== ''
            ? String(publishedAt)
            : String(Math.floor(Date.now() / 1000))],
        ['price', String(amount), currency],
    ];

    for (const image of form.images || []) {
        if (image) tags.push(['image', image]);
    }
    if (form.location) tags.push(['location', form.location]);
    tags.push(['status', form.status === 'sold' ? 'sold' : 'active']);

    const seen = new Set(MARKETPLACE_TOPIC_TAGS);
    for (const topic of MARKETPLACE_TOPIC_TAGS) tags.push(['t', topic]);
    let categoryCount = 0;
    for (const category of form.categories || []) {
        const value = String(category).trim().toLowerCase();
        if (!value || seen.has(value)) continue;
        seen.add(value);
        tags.push(['t', value]);
        if (++categoryCount >= MAX_CATEGORY_TAGS) break;
    }

    return { tags, content: description, dTag: d };
}

/**
 * Publish a marketplace listing (NIP-99 Kind 30402, Shopstr-compatible),
 * signed with the user's custodial key. Publishes to BOTH the private relay
 * and public relays. Returns null for Nostr-native users (who sign
 * client-side via the nostrService twin) and on publish failure.
 */
export async function publishMarketplaceListing(
    userId: string,
    listing: MarketplaceListingInput
): Promise<{ eventId: string; dTag: string; naddr: string } | null> {
    try {
        const { tags, content, dTag } = buildMarketplaceListingTags(listing, {
            dTag: listing.dTag,
            publishedAt: listing.publishedAt,
        });

        const event: EventTemplate = {
            kind: 30402,
            created_at: Math.floor(Date.now() / 1000),
            tags,
            content,
        };

        const signedEvent = await signAsHostedUser(userId, event, 'server');
        if (!signedEvent) {
            // Nostr-native user — signed client-side
            console.log(`[Nostr] User ${userId} has no custodial key, skipping server-side NIP-99 publish`);
            return null;
        }

        const pool = await getPool();
        const relays = marketplaceRelays();
        const results = await Promise.allSettled(pool.publish(relays, signedEvent));
        const published = results.filter((r) => r.status === 'fulfilled').length;
        console.log(`[Nostr] NIP-99 marketplace listing published to ${published}/${relays.length} relays`);

        if (published === 0) return null;

        // Relay hints for the shareable naddr — public relays only (the
        // private relay is NIP-42 gated, useless to external Shopstr clients).
        const { naddrEncode } = await import('nostr-tools/nip19');
        const naddr = naddrEncode({
            kind: 30402,
            pubkey: signedEvent.pubkey,
            identifier: dTag,
            relays: relays.filter((r) => r !== config.nostrPrivateRelay).slice(0, 3),
        });

        return { eventId: signedEvent.id, dTag, naddr };
    } catch (error) {
        console.error('[Nostr] NIP-99 marketplace publish error:', error);
        return null;
    }
}

/**
 * Publish a NIP-09 deletion event (Kind 5) to remove a marketplace listing
 * from all marketplace relays. Custodial twin of the client's
 * deleteMarketplaceListing; returns false for Nostr-native users.
 */
export async function deleteMarketplaceListing(
    userId: string,
    nostrEventId: string,
    dTag: string
): Promise<boolean> {
    try {
        const signed = await signAsHostedUser(userId, (pubkey) => ({
            kind: 5,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['e', nostrEventId],
                ['a', `30402:${pubkey}:${dTag}`],
            ],
            content: 'Listing deleted from BIES',
        }), 'server');
        if (!signed) {
            // Nostr-native user — deletion happens client-side
            return false;
        }

        const pool = await getPool();
        const relays = marketplaceRelays();
        const results = await Promise.allSettled(pool.publish(relays, signed));
        const published = results.filter((r) => r.status === 'fulfilled').length;
        console.log(`[Nostr] NIP-99 marketplace deletion published to ${published}/${relays.length} relays`);
        return published > 0;
    } catch (error) {
        console.error('[Nostr] NIP-99 marketplace deletion error:', error);
        return false;
    }
}

// ─── Retracting a deleted account's events ───────────────────────────────────

// The public relays BIES and its app publish members' events to: the
// server's (config.nostrRelays), Shopstr's for listings, and the app's
// PUBLIC_RELAYS (src/services/nostrService.js).
const APP_PUBLIC_RELAYS = [
    'wss://relay.damus.io',
    'wss://relay.primal.net',
    'wss://relay.nostr.band',
    'wss://nos.lol',
    'wss://purplepag.es',
];

function publicPublishRelays(): string[] {
    return [...new Set([...config.nostrRelays, ...SHOPSTR_RELAYS, ...APP_PUBLIC_RELAYS])];
}

const RELAY_PAGE = 500; // strfry's maxFilterLimit
const MAX_EVENTS_TO_RETRACT = 5000;
const EVENTS_PER_DELETION = 300;
const QUERY_WAIT_MS = 4000;

/** The events a pubkey published, from BIES's relay and the public ones. */
async function findEventsBy(pubkey: string): Promise<NostrEvent[]> {
    const pool = await getPool();
    const found = new Map<string, NostrEvent>();
    const keep = (events: NostrEvent[]) => {
        let fresh = 0;
        for (const e of events) {
            if (e.pubkey !== pubkey || found.has(e.id) || found.size >= MAX_EVENTS_TO_RETRACT) continue;
            found.set(e.id, e);
            fresh++;
        }
        return fresh;
    };

    if (config.nostrPrivateRelay) {
        let until: number | undefined;
        while (found.size < MAX_EVENTS_TO_RETRACT) {
            const page = await pool.querySync(
                [config.nostrPrivateRelay],
                { authors: [pubkey], limit: RELAY_PAGE, ...(until !== undefined ? { until } : {}) },
                { maxWait: QUERY_WAIT_MS },
            );
            if (keep(page) === 0 || page.length < RELAY_PAGE) break;
            until = Math.min(...page.map((e) => e.created_at));
        }
    }
    keep(await pool.querySync(publicPublishRelays(), { authors: [pubkey], limit: RELAY_PAGE }, { maxWait: QUERY_WAIT_MS }));
    return [...found.values()];
}

/** NIP-09 tags for a batch of events: each id, plus the address of replaceable ones. */
function deletionTags(events: NostrEvent[], pubkey: string): string[][] {
    const tags: string[][] = [];
    const kinds = new Set<number>();
    for (const e of events) {
        tags.push(['e', e.id]);
        kinds.add(e.kind);
        const replaceable = e.kind === 0 || e.kind === 3 || (e.kind >= 10000 && e.kind < 20000);
        const addressable = e.kind >= 30000 && e.kind < 40000;
        if (replaceable) tags.push(['a', `${e.kind}:${pubkey}:`]);
        if (addressable) tags.push(['a', `${e.kind}:${pubkey}:${e.tags.find((t) => t[0] === 'd')?.[1] ?? ''}`]);
    }
    for (const kind of kinds) tags.push(['k', String(kind)]);
    return tags;
}

/**
 * For an email account being deleted: ask every public relay BIES publishes
 * to to forget it, signed with the key BIES holds, before that key goes. A
 * NIP-62 request to vanish covers relays that support it; NIP-09 deletion
 * requests for each event found cover the rest. Relays run by others decide
 * for themselves. BIES's own relay deletes the events directly
 * (requestRelayPurge), so nothing is sent there.
 *
 * Returns null when BIES holds no key for the account (nothing to sign with).
 */
export async function retractAllEvents(
    userId: string,
    pubkey: string,
): Promise<{ events: number; requests: number; accepted: number } | null> {
    const now = Math.floor(Date.now() / 1000);
    const vanish = await signAsHostedUser(userId, {
        kind: 62,
        created_at: now,
        tags: [['relay', 'ALL_RELAYS']],
        content: 'This account was deleted at its owner\'s request.',
    }, 'server');
    if (!vanish) return null;

    const events = await findEventsBy(pubkey);
    const requests: NostrEvent[] = [vanish];
    for (let i = 0; i < events.length; i += EVENTS_PER_DELETION) {
        const signed = await signAsHostedUser(userId, {
            kind: 5,
            created_at: now,
            tags: deletionTags(events.slice(i, i + EVENTS_PER_DELETION), pubkey),
            content: 'Account deleted',
        }, 'server');
        if (signed) requests.push(signed);
    }

    const pool = await getPool();
    const relays = publicPublishRelays();
    const results = await Promise.allSettled(requests.flatMap((request) => pool.publish(relays, request)));
    const accepted = results.filter((r) => r.status === 'fulfilled').length;
    console.log(`[Nostr] Retraction: ${events.length} events, ${requests.length} requests, ${accepted}/${results.length} accepted by relays`);
    return { events: events.length, requests: requests.length, accepted };
}

/**
 * Publish a NIP-65 relay list metadata event (Kind 10002).
 * Tags BIES relay as write, public relays as read.
 */
export async function publishRelayList(userId: string): Promise<string | null> {
    const tags: string[][] = [
        ['r', config.nostrPublicRelay, 'write'],
    ];

    // Add public relays as read
    for (const relay of config.nostrRelays) {
        tags.push(['r', relay, 'read']);
    }

    const event: EventTemplate = {
        kind: 10002,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: '',
    };

    return publishEvent(userId, event);
}

/**
 * Publish a Kind 1 announcement note to the BIES relay on behalf of a user.
 * Used for system events: new user joined, project created, lightning address added.
 * Only works for custodial-key users; Nostr-native users handle this client-side.
 */
export async function publishAnnouncement(
    userId: string,
    content: string,
    tags: string[][] = []
): Promise<string | null> {
    const event: EventTemplate = {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['t', 'bies'], ...tags],
        content,
    };

    return publishEvent(userId, event);
}

/**
 * Publish a NIP-52 time-based calendar event (Kind 31923).
 * Allows publishing to BIES relay only, public relays only, or both.
 */
export async function publishCalendarEvent(
    userId: string,
    event: {
        id: string;
        title: string;
        description: string;
        startDate: Date;
        endDate?: Date | null;
        location?: string;
        locationName?: string;
        locationAddress?: string;
        isOnline?: boolean;
        onlineUrl?: string;
        category?: string;
        tags?: string[];
        thumbnail?: string;
        ticketUrl?: string;
    },
    target: 'bies' | 'public' | 'both' = 'bies'
): Promise<string | null> {
    try {
        const startUnix = Math.floor(event.startDate.getTime() / 1000);
        const nip52Tags: string[][] = [
            ['d', event.id],
            ['title', event.title],
            ['start', String(startUnix)],
        ];

        if (event.endDate) {
            nip52Tags.push(['end', String(Math.floor(event.endDate.getTime() / 1000))]);
        }

        // Location tags
        if (event.location) {
            nip52Tags.push(['location', event.location]);
        }
        if (event.locationAddress) {
            nip52Tags.push(['g', event.locationAddress]); // geohash placeholder / address
        }

        // Online events
        if (event.isOnline && event.onlineUrl) {
            nip52Tags.push(['r', event.onlineUrl]);
        }

        // Metadata tags
        if (event.thumbnail) {
            nip52Tags.push(['image', event.thumbnail]);
        }
        if (event.ticketUrl) {
            nip52Tags.push(['r', event.ticketUrl]);
        }

        // Hashtags
        nip52Tags.push(['t', 'bies']);
        if (event.category) {
            nip52Tags.push(['t', event.category.toLowerCase().replace(/_/g, '-')]);
        }
        if (event.tags) {
            for (const tag of event.tags) {
                nip52Tags.push(['t', tag.toLowerCase()]);
            }
        }

        const nostrEvent: EventTemplate = {
            kind: 31923,
            created_at: Math.floor(Date.now() / 1000),
            tags: nip52Tags,
            content: event.description,
        };

        const signedEvent = await signAsHostedUser(userId, nostrEvent, 'server');
        if (!signedEvent) {
            // Nostr-native user — signed client-side
            console.log(`[Nostr] User ${userId} has no custodial key, skipping server-side NIP-52 publish`);
            return null;
        }

        const pool = await getPool();

        // Determine which relays to publish to
        const relays: string[] = [];
        if ((target === 'bies' || target === 'both') && config.nostrPrivateRelay) {
            relays.push(config.nostrPrivateRelay);
        }
        if (target === 'public' || target === 'both') {
            relays.push(...config.nostrRelays);
        }
        // Fallback
        if (relays.length === 0 && config.nostrPrivateRelay) {
            relays.push(config.nostrPrivateRelay);
        }

        const results = await Promise.allSettled(pool.publish(relays, signedEvent));
        const published = results.filter((r) => r.status === 'fulfilled').length;
        console.log(`[Nostr] NIP-52 calendar event published to ${published}/${relays.length} relays (target: ${target})`);

        return published > 0 ? signedEvent.id : null;
    } catch (error) {
        console.error('[Nostr] NIP-52 publish error:', error);
        return null;
    }
}

/**
 * Publish a NIP-09 deletion event (Kind 5) to remove a calendar event from relays.
 * References the original event by its Nostr event ID.
 */
export async function deleteCalendarEvent(
    userId: string,
    nostrEventId: string,
    dTag: string,
    target: 'bies' | 'public' | 'both' = 'bies'
): Promise<boolean> {
    try {
        const signed = await signAsHostedUser(userId, (pubkey) => ({
            kind: 5,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['e', nostrEventId],
                ['a', `31923:${pubkey}:${dTag}`],
            ],
            content: 'Event deleted from BIES',
        }), 'server');
        if (!signed) {
            // Nostr-native user — deletion happens client-side
            return false;
        }

        const pool = await getPool();
        const relays: string[] = [];
        if ((target === 'bies' || target === 'both') && config.nostrPrivateRelay) {
            relays.push(config.nostrPrivateRelay);
        }
        if (target === 'public' || target === 'both') {
            relays.push(...config.nostrRelays);
        }
        if (relays.length === 0 && config.nostrPrivateRelay) {
            relays.push(config.nostrPrivateRelay);
        }

        const results = await Promise.allSettled(pool.publish(relays, signed));
        const published = results.filter((r) => r.status === 'fulfilled').length;
        console.log(`[Nostr] NIP-09 deletion published to ${published}/${relays.length} relays`);
        return published > 0;
    } catch (error) {
        console.error('[Nostr] NIP-09 deletion error:', error);
        return false;
    }
}

/**
 * Publish a NIP-52 calendar event RSVP (Kind 31925).
 */
export async function publishRSVPEvent(
    userId: string,
    eventData: {
        eventId: string;
        eventDTag: string;
        hostPubkey: string;
        status: 'accepted' | 'declined' | 'tentative';
    },
    target: 'bies' | 'public' | 'both' = 'bies'
): Promise<string | null> {
    try {
        const rsvpTags: string[][] = [
            ['d', `${eventData.eventDTag}-rsvp`],
            ['a', `31923:${eventData.hostPubkey}:${eventData.eventDTag}`],
            ['L', 'status'],
            ['l', eventData.status, 'status'],
            ['p', eventData.hostPubkey],
        ];

        const rsvpEvent: EventTemplate = {
            kind: 31925,
            created_at: Math.floor(Date.now() / 1000),
            tags: rsvpTags,
            content: '',
        };

        const signed = await signAsHostedUser(userId, rsvpEvent, 'server');
        if (!signed) {
            return null;
        }

        const pool = await getPool();
        const relays: string[] = [];
        if ((target === 'bies' || target === 'both') && config.nostrPrivateRelay) {
            relays.push(config.nostrPrivateRelay);
        }
        if (target === 'public' || target === 'both') {
            relays.push(...config.nostrRelays);
        }
        if (relays.length === 0 && config.nostrPrivateRelay) {
            relays.push(config.nostrPrivateRelay);
        }

        const results = await Promise.allSettled(pool.publish(relays, signed));
        const published = results.filter((r) => r.status === 'fulfilled').length;
        console.log(`[Nostr] NIP-52 RSVP published to ${published}/${relays.length} relays (status: ${eventData.status})`);
        return published > 0 ? signed.id : null;
    } catch (error) {
        console.error('[Nostr] NIP-52 RSVP publish error:', error);
        return null;
    }
}

/**
 * Validate NIP-52 calendar event data before publishing.
 * Returns null if valid, or an error message string.
 */
export function validateCalendarEventData(event: {
    id?: string;
    title?: string;
    startDate?: Date | null;
}): string | null {
    if (!event.id) return 'Event ID (d-tag) is required';
    if (!event.title || event.title.trim().length === 0) return 'Event title is required';
    if (!event.startDate) return 'Start date is required';
    const startUnix = event.startDate.getTime();
    if (isNaN(startUnix)) return 'Start date is not a valid date';
    return null;
}

/**
 * Convert hex string to Uint8Array
 */
// ─── Courses (NIP-51 kind 30004 + NIP-23 kind 30023 + NIP-99 kind 30402) ────

/**
 * Sign a template with a user's custodial key and publish to the relays the
 * target selects. Returns the event id, or null for Nostr-native users
 * (they publish the twin event client-side).
 */
async function publishEventAs(
    userId: string,
    template: EventTemplate,
    target: 'bies' | 'public' | 'both'
): Promise<string | null> {
    try {
        const signed = await signAsHostedUser(userId, template, 'server');
        if (!signed) {
            return null; // Nostr-native — client-side twin publishes instead
        }

        const relays: string[] = [];
        if ((target === 'bies' || target === 'both') && config.nostrPrivateRelay) {
            relays.push(config.nostrPrivateRelay);
        }
        if (target === 'public' || target === 'both') {
            relays.push(...config.nostrRelays);
        }
        if (relays.length === 0 && config.nostrPrivateRelay) {
            relays.push(config.nostrPrivateRelay);
        }

        const pool = await getPool();
        const results = await Promise.allSettled(pool.publish(relays, signed));
        const published = results.filter((r) => r.status === 'fulfilled').length;
        console.log(`[Nostr] kind ${template.kind} published to ${published}/${relays.length} relays (target: ${target})`);
        return published > 0 ? signed.id : null;
    } catch (error) {
        console.error(`[Nostr] kind ${template.kind} publish error:`, error);
        return null;
    }
}

interface CourseRow {
    id: string;
    title: string;
    summary: string;
    description: string;
    category: string;
    coverImage: string;
    tags: string; // JSON array string
    priceSats: number;
}

interface LessonRow {
    id: string;
    title: string;
    type: string;
    content: string; // JSON string
}

function courseTopicTags(course: CourseRow): string[][] {
    const tags: string[][] = [
        ['t', 'bies'],
        ['t', 'education'],
    ];
    const seen = new Set(['bies', 'education']);
    const extra = [course.category, ...(JSON.parse(course.tags || '[]') as string[])];
    for (const raw of extra) {
        const t = String(raw || '').toLowerCase().replace(/_/g, '-').trim();
        if (t && !seen.has(t) && seen.size < 12) {
            seen.add(t);
            tags.push(['t', t]);
        }
    }
    return tags;
}

/**
 * Publish a FREE lesson as NIP-23 long-form content (kind 30023).
 * d-tag = lesson DB id; content = full markdown (video lessons embed the URL).
 */
export async function publishLessonArticle(
    userId: string,
    course: CourseRow,
    lesson: LessonRow,
    target: 'bies' | 'public' | 'both' = 'bies'
): Promise<string | null> {
    let markdown = '';
    try {
        const content = JSON.parse(lesson.content || '{}');
        if (lesson.type === 'TEXT') {
            markdown = content.markdown || '';
        } else if (lesson.type === 'VIDEO') {
            markdown = `${content.caption ? content.caption + '\n\n' : ''}${content.videoUrl || ''}`;
        }
    } catch {
        return null;
    }
    if (!markdown) return null;

    const tags: string[][] = [
        ['d', lesson.id],
        ['title', lesson.title],
        ['summary', (course.summary || '').slice(0, 200)],
        ['published_at', String(Math.floor(Date.now() / 1000))],
        ...courseTopicTags(course),
    ];
    if (course.coverImage) tags.push(['image', course.coverImage]);

    return publishEventAs(userId, {
        kind: 30023,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: markdown,
    }, target);
}

/**
 * Publish a PAID lesson as a NIP-99 classified teaser (kind 30402).
 * The content is a SERVER-DERIVED teaser (course summary) — full lesson
 * content must never enter the event; the API is the only gate.
 */
export async function publishPaidLessonTeaser(
    userId: string,
    course: CourseRow,
    lesson: LessonRow,
    target: 'bies' | 'public' | 'both' = 'bies'
): Promise<string | null> {
    const teaser = (course.summary || course.title).slice(0, 300);
    const tags: string[][] = [
        ['d', lesson.id],
        ['title', lesson.title],
        ['summary', teaser.slice(0, 200)],
        ['published_at', String(Math.floor(Date.now() / 1000))],
        ['price', String(course.priceSats), 'SATS'],
        ...courseTopicTags(course),
    ];
    if (course.coverImage) tags.push(['image', course.coverImage]);

    return publishEventAs(userId, {
        kind: 30402,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: teaser,
    }, target);
}

/**
 * Publish the course container as a NIP-51 curation set (kind 30004).
 * Ordered `a` tags reference the lesson events (30023 free / 30402 paid);
 * QUIZ lessons are never published and are skipped from the list.
 */
export async function publishCourse(
    userId: string,
    course: CourseRow,
    orderedLessons: LessonRow[],
    target: 'bies' | 'public' | 'both' = 'bies'
): Promise<string | null> {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { nostrPubkey: true },
    });
    if (!user?.nostrPubkey) return null;

    const isPaid = course.priceSats > 0;
    const tags: string[][] = [
        ['d', course.id],
        ['title', course.title],
        ['summary', (course.summary || '').slice(0, 200)],
        ['published_at', String(Math.floor(Date.now() / 1000))],
        ...courseTopicTags(course),
    ];
    if (course.coverImage) tags.push(['image', course.coverImage]);
    if (isPaid) tags.push(['price', String(course.priceSats), 'SATS']);

    for (const lesson of orderedLessons) {
        if (lesson.type === 'QUIZ') continue; // never mirrored
        const kind = isPaid ? 30402 : 30023;
        tags.push(['a', `${kind}:${user.nostrPubkey}:${lesson.id}`]);
    }

    return publishEventAs(userId, {
        kind: 30004,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: course.description || course.summary || '',
    }, target);
}

/**
 * NIP-09 delete (kind 5) for a course and its lesson events.
 */
export async function deleteCourseFromNostr(
    userId: string,
    refs: { courseEventId?: string | null; courseId: string; lessons: Array<{ eventId?: string | null; lessonId: string; kind: number }> },
    target: 'bies' | 'public' | 'both' = 'bies'
): Promise<boolean> {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { nostrPubkey: true, encryptedPrivkey: true },
    });
    if (!user?.encryptedPrivkey || !user.nostrPubkey) return false;

    const tags: string[][] = [];
    if (refs.courseEventId) tags.push(['e', refs.courseEventId]);
    tags.push(['a', `30004:${user.nostrPubkey}:${refs.courseId}`]);
    for (const lesson of refs.lessons) {
        if (lesson.eventId) tags.push(['e', lesson.eventId]);
        tags.push(['a', `${lesson.kind}:${user.nostrPubkey}:${lesson.lessonId}`]);
    }

    const eventId = await publishEventAs(userId, {
        kind: 5,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: 'Course deleted from BIES',
    }, target);
    return Boolean(eventId);
}
