/**
 * Runtime feature toggles.
 *
 * Admin-controlled flags stored as a JSON column on the SiteSettings
 * singleton (`site_settings.feature_flags`). Semantics:
 *
 *   - Every known slug defaults to **enabled** — new features ship on and
 *     old DB rows never break.
 *   - Unknown slugs found in storage are ignored on read.
 *   - Reads are cached (TTL.FEATURE_FLAGS); writes invalidate the cache, so
 *     the toggling admin sees the change immediately and other instances
 *     converge within the TTL.
 *   - Fail-open: a storage error yields all-enabled (and is not cached), so
 *     a flaky DB can never hide the app.
 *
 * The canonical slug list lives here (server) and is mirrored in
 * `src/config/featureSlugs.js` (client) — keep both in sync. See
 * `docs/feature-toggles.md`.
 */

import prisma from '../lib/prisma';
import { cache, TTL, cacheKey } from './redis.service';

// ─── Canonical slugs ─────────────────────────────────────────────────────────

export const FEATURE_SLUGS = [
    'directories', // farm + certified provider directories
    'talent',      // BIES Talents: members' skills and services, with proof of work
    'points',      // leaderboard, profile points UI, scorer, NIP-58 badges
    'events',      // ecosystem events
    'media',       // media page (YouTube/Substack feeds)
    'news',        // news page content + Twitter/news refresh loop
    'messages',    // direct messages
    'zaps',        // zap buttons + Coinos wallet
    'feedback',    // bug/feedback tracker
    'investors',   // investor features + vetting (investors/investments APIs)
    'projects',    // project listings
    'cowork',      // Cowork check-in page (client-side Nostr — UI gate only)
    'marketplace', // Shopstr-compatible NIP-99 marketplace (also build-time MARKETPLACE_ENABLED)
    'bounties',    // bounty board + escrow/maintenance loop (also build-time BOUNTIES_ENABLED)
    'dashboard',   // personal dashboard (client-side only — UI gate)
    'courses',     // courses catalog and player (UI gate only; /api/courses stays open)
] as const;

export type FeatureSlug = (typeof FEATURE_SLUGS)[number];
export type FeatureFlags = Record<FeatureSlug, boolean>;

const SLUG_SET: ReadonlySet<string> = new Set(FEATURE_SLUGS);

// ─── Pure core (unit-tested) ─────────────────────────────────────────────────

/** All known slugs, every one enabled. */
export function defaultFlags(): FeatureFlags {
    const flags = {} as FeatureFlags;
    for (const slug of FEATURE_SLUGS) flags[slug] = true;
    return flags;
}

export function isValidSlug(slug: string): slug is FeatureSlug {
    return SLUG_SET.has(slug);
}

/**
 * Parse a stored JSON flag map. Unknown slugs are ignored, missing slugs
 * default to true, malformed/absent JSON yields all-enabled.
 */
export function parseStoredFlags(raw: string | null | undefined): FeatureFlags {
    const flags = defaultFlags();
    if (!raw) return flags;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (const slug of FEATURE_SLUGS) {
                const value = (parsed as Record<string, unknown>)[slug];
                if (typeof value === 'boolean') flags[slug] = value;
            }
        }
    } catch {
        // malformed JSON → all defaults (fail-open)
    }
    return flags;
}

/**
 * Merge a partial update into a full flag map. Throws on unknown slugs or
 * non-boolean values — route-level Zod validation should make this
 * unreachable from the API, but the service defends itself for other callers.
 */
export function mergeFlags(current: FeatureFlags, partial: Partial<FeatureFlags>): FeatureFlags {
    const merged = { ...current };
    for (const [key, value] of Object.entries(partial)) {
        if (!isValidSlug(key)) throw new Error(`Unknown feature slug: ${key}`);
        if (typeof value !== 'boolean') throw new Error(`Flag "${key}" must be a boolean`);
        merged[key] = value;
    }
    return merged;
}

// ─── Service ─────────────────────────────────────────────────────────────────

/** Current flags — cached read, lazy-default (no row ⇒ all enabled). */
export async function getFlags(): Promise<FeatureFlags> {
    const cached = await cache.getJson<Partial<FeatureFlags>>(cacheKey.featureFlags());
    if (cached) return { ...defaultFlags(), ...cached };

    try {
        const row = await prisma.siteSettings.findUnique({
            where: { id: 'default' },
            select: { featureFlags: true },
        });
        const flags = parseStoredFlags(row?.featureFlags);
        await cache.setJson(cacheKey.featureFlags(), flags, TTL.FEATURE_FLAGS);
        return flags;
    } catch (error) {
        // Fail-open and do NOT cache the fallback — a transient DB error must
        // never flip a disabled feature on for the whole TTL.
        console.error('[Flags] Read failed — failing open (all enabled):', error);
        return defaultFlags();
    }
}

/** Cheap cached check used by the gate middleware and background services. */
export async function isEnabled(slug: FeatureSlug): Promise<boolean> {
    const flags = await getFlags();
    return flags[slug] !== false;
}

/**
 * Apply a partial flag update (admin-only at the route layer). Validates
 * slugs, merges over the stored map, persists, and invalidates the cache.
 */
export async function setFlags(partial: Partial<FeatureFlags>): Promise<FeatureFlags> {
    const row = await prisma.siteSettings.findUnique({
        where: { id: 'default' },
        select: { featureFlags: true },
    });
    const merged = mergeFlags(parseStoredFlags(row?.featureFlags), partial);
    const json = JSON.stringify(merged);

    await prisma.siteSettings.upsert({
        where: { id: 'default' },
        update: { featureFlags: json },
        create: { id: 'default', featureFlags: json },
    });

    await cache.del(cacheKey.featureFlags());
    return merged;
}
