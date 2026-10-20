/**
 * Redis service — provides a unified caching layer.
 * Falls back gracefully to in-memory Map when Redis is unavailable (dev mode).
 *
 * For production with 500+ concurrent users, set REDIS_URL in your environment.
 * Redis handles:
 *   - Distributed rate limiting (shared across multiple Node processes)
 *   - Session/challenge store (auth challenges)
 *   - Response caching (project lists, profile lists)
 *   - WebSocket presence tracking
 *   - Pub/sub for real-time notifications across instances
 */

import { config } from '../config';

// ─── Types ───────────────────────────────────────────────────────────────────

interface CacheEntry {
    value: string;
    expiresAt: number;
}

// ─── In-memory fallback (dev / no Redis) ─────────────────────────────────────

class InMemoryCache {
    private store = new Map<string, CacheEntry>();
    private readonly MAX_SIZE = 10_000;
    // A budget in characters as well as entries, so a few big answers can't
    // fill the server's memory; an answer bigger than MAX_VALUE isn't kept.
    private readonly MAX_CHARS = 50_000_000;
    private readonly MAX_VALUE = 1_000_000;
    private chars = 0;

    private drop(key: string): void {
        const entry = this.store.get(key);
        if (!entry) return;
        this.chars -= entry.value.length;
        this.store.delete(key);
    }

    get(key: string): string | null {
        const entry = this.store.get(key);
        if (!entry) return null;
        if (Date.now() > entry.expiresAt) {
            this.drop(key);
            return null;
        }
        return entry.value;
    }

    set(key: string, value: string, ttlSeconds: number): void {
        this.drop(key);
        if (value.length > this.MAX_VALUE) return;
        // Evict the oldest entries while over either limit
        while (this.store.size > 0 && (this.store.size >= this.MAX_SIZE || this.chars + value.length > this.MAX_CHARS)) {
            const firstKey = this.store.keys().next().value;
            if (firstKey === undefined) break;
            this.drop(firstKey);
        }
        this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
        this.chars += value.length;
    }

    del(key: string): void {
        this.drop(key);
    }

    /** Delete all keys matching a prefix */
    delPattern(prefix: string): void {
        for (const key of [...this.store.keys()]) {
            if (key.startsWith(prefix)) this.drop(key);
        }
    }

    /** Returns time-to-live in seconds, or -1 if not found/expired */
    ttl(key: string): number {
        const entry = this.store.get(key);
        if (!entry) return -1;
        const remaining = Math.ceil((entry.expiresAt - Date.now()) / 1000);
        return remaining > 0 ? remaining : -1;
    }
}

// ─── Redis client (optional) ─────────────────────────────────────────────────

let redisClient: any = null;
let useRedis = false;

async function initRedis(): Promise<void> {
    if (!config.redisUrl) {
        console.log('[Cache] No REDIS_URL configured — using in-memory cache (single-instance mode)');
        return;
    }

    try {
        // Dynamic import so the server starts even without ioredis installed
        const ioredis = await import('ioredis');
        const Redis = ioredis.default || (ioredis as any);
        redisClient = new (Redis as any)(config.redisUrl, {
            lazyConnect: true,
            maxRetriesPerRequest: 3,
            retryStrategy: (times: number) => Math.min(times * 100, 3000),
            enableOfflineQueue: false,
        });

        redisClient.on('connect', () => console.log('[Cache] Redis connected'));
        redisClient.on('error', (err: Error) => console.error('[Cache] Redis error:', err.message));

        await redisClient.connect();
        useRedis = true;
        console.log('[Cache] Redis mode active — ready for multi-instance deployment');
    } catch (err: any) {
        console.warn('[Cache] Failed to connect to Redis, falling back to in-memory:', err.message);
    }
}

// Initialize immediately (non-blocking)
initRedis();

// ─── Fallback instance ────────────────────────────────────────────────────────

const memCache = new InMemoryCache();

// ─── Public API ──────────────────────────────────────────────────────────────

export const cache = {
    /** Get a cached value. Returns null if missing/expired. */
    async get(key: string): Promise<string | null> {
        try {
            if (useRedis && redisClient) return await redisClient.get(key);
            return memCache.get(key);
        } catch {
            return memCache.get(key);
        }
    },

    /** Set a cached value with TTL in seconds. */
    async set(key: string, value: string, ttlSeconds: number): Promise<void> {
        try {
            if (useRedis && redisClient) {
                await redisClient.set(key, value, 'EX', ttlSeconds);
                return;
            }
        } catch { /* fall through */ }
        memCache.set(key, value, ttlSeconds);
    },

    /** Delete a specific key. */
    async del(key: string): Promise<void> {
        try {
            if (useRedis && redisClient) {
                await redisClient.del(key);
                return;
            }
        } catch { /* fall through */ }
        memCache.del(key);
    },

    /** Delete all keys with a given prefix. */
    async delPattern(prefix: string): Promise<void> {
        try {
            if (useRedis && redisClient) {
                const keys: string[] = await redisClient.keys(`${prefix}*`);
                if (keys.length > 0) await redisClient.del(...keys);
                return;
            }
        } catch { /* fall through */ }
        memCache.delPattern(prefix);
    },

    /** Convenience: get + JSON.parse */
    async getJson<T>(key: string): Promise<T | null> {
        const raw = await cache.get(key);
        if (!raw) return null;
        try { return JSON.parse(raw) as T; } catch { return null; }
    },

    /** Convenience: JSON.stringify + set */
    async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
        await cache.set(key, JSON.stringify(value), ttlSeconds);
    },

    // ─── Auth challenge store ──────────────────────────────────────────────
    async setChallenge(pubkey: string, challenge: string): Promise<void> {
        await cache.set(`challenge:${pubkey}`, challenge, 5 * 60); // 5 min TTL
    },

    async getChallenge(pubkey: string): Promise<string | null> {
        return cache.get(`challenge:${pubkey}`);
    },

    async deleteChallenge(pubkey: string): Promise<void> {
        await cache.del(`challenge:${pubkey}`);
    },
};

// ─── TTLs (seconds) ──────────────────────────────────────────────────────────

export const TTL = {
    PROJECT_LIST: 60,        // 1 min – frequently updated
    PROJECT_DETAIL: 120,     // 2 min
    PROFILE_LIST: 120,       // 2 min
    PROFILE_DETAIL: 300,     // 5 min
    SEARCH_RESULTS: 30,      // 30 sec
    EVENT_LIST: 300,         // 5 min
    ANALYTICS_DASHBOARD: 60, // 1 min
    NOTIFICATION_COUNT: 30,  // 30 sec
    PLATFORM_STATS: 300,     // 5 min – public homepage
    CONTENT_LIST: 300,       // 5 min
    CONTENT_DETAIL: 600,     // 10 min
    TWITTER_FEED: 900,       // 15 min
    SITE_SETTINGS: 300,      // 5 min
    FEATURE_FLAGS: 300,      // 5 min – runtime feature toggles
    MATCH_RESULTS: 120,      // 2 min
    FOLLOW_LIST: 120,        // 2 min
    LEADERBOARD: 60,         // 1 min – points leaderboard
};

// ─── Cache key builders ───────────────────────────────────────────────────────

export const cacheKey = {
    projects: (params: Record<string, string>) =>
        `projects:${new URLSearchParams(params).toString()}`,
    projectDetail: (id: string) => `project:${id}`,
    profiles: (params: Record<string, string>) =>
        `profiles:${new URLSearchParams(params).toString()}`,
    profileDetail: (id: string) => `profile:${id}`,
    search: (q: string) => `search:${q.toLowerCase().trim()}`,
    events: (params: Record<string, string>) =>
        `events:${new URLSearchParams(params).toString()}`,
    notificationCount: (userId: string) => `notif_count:${userId}`,
    analytics: (userId: string) => `analytics:${userId}`,
    platformStats: () => 'platform_stats:public',
    articles: (params: Record<string, string>) =>
        `articles:${new URLSearchParams(params).toString()}`,
    articleDetail: (id: string) => `article:${id}`,
    videos: (params: Record<string, string>) =>
        `videos:${new URLSearchParams(params).toString()}`,
    resources: () => 'legal_resources:all',
    followers: (userId: string) => `followers:${userId}`,
    following: (userId: string) => `following:${userId}`,
    matches: (projectId: string) => `matches:${projectId}`,
    investorRecs: (userId: string) => `investor_recs:${userId}`,
    twitterFeed: () => 'twitter:feed',
    liveNewsFeed: () => 'newsfeed:live',
    siteSettings: () => 'site_settings:default',
    featureFlags: () => 'feature_flags:default',
    leaderboard: (scope: string) => `leaderboard:${scope}`,
    courses: (params: Record<string, string>) =>
        `courses:${new URLSearchParams(params).toString()}`,
};

// ─── Cross-module invalidation helpers ───────────────────────────────────────

/**
 * Leaderboard cache generation. Entries live under generation-stamped keys
 * (`leaderboard:<scope>:g<N>`) and invalidation bumps the generation instead
 * of deleting: a plain delete races with cache-aside readers (read-miss →
 * DB query → [eviction lands here] → set re-caches the pre-mutation ranks
 * for a full TTL), whereas a bump retires the key a concurrent reader
 * resolved before its DB query, so its write-back is never readable again.
 * Retired Redis entries age out via their TTL; retired in-memory entries are
 * swept eagerly on invalidation (the Map only deletes lazily on read, and
 * retired keys are never read again).
 *
 * Redis mode keeps the counter in Redis (atomic INCR, shared across
 * instances). The in-memory fallback uses a process-local counter — exact in
 * single-instance mode, and during a Redis flap the local bump still keeps
 * this instance fresh while cross-instance staleness stays bounded by the
 * entry TTL (same bound as any cache op during an outage).
 */
const LEADERBOARD_GEN_KEY = 'leaderboard:gen';
let memLeaderboardGen = 0;

async function leaderboardGen(): Promise<number> {
    try {
        if (useRedis && redisClient) {
            const raw = await redisClient.get(LEADERBOARD_GEN_KEY);
            const parsed = raw === null ? 0 : parseInt(raw, 10);
            if (Number.isFinite(parsed)) return parsed;
            return 0;
        }
    } catch {
        /* Redis flap — fall back to the local counter */
    }
    return memLeaderboardGen;
}

/**
 * Generation-stamped cache key for a leaderboard scope. Callers must resolve
 * it ONCE before their cache read and reuse the same key for the write-back —
 * that ordering is what lets an invalidation during the DB query retire the
 * key out from under the writer.
 */
export async function leaderboardCacheKey(
    scope: 'monthly' | 'lifetime'
): Promise<string> {
    return `${cacheKey.leaderboard(scope)}:g${await leaderboardGen()}`;
}

/**
 * Invalidate both leaderboard scopes by bumping the generation. Called
 * wherever ranked totals mutate: live scoring (points.service applyPoints),
 * the monthly rollover's bucket reset (points.indexer lazyMonthSync) and
 * admin adjust/recompute — so new ranks surface immediately instead of after
 * the 60s TTL.
 */
export async function invalidateLeaderboardCache(): Promise<void> {
    // Local bump first: keeps this instance fresh even mid Redis flap. The
    // sweep right after (no await in between, so no reader can interleave)
    // reclaims the now-retired in-memory entries — without it, mem mode
    // would accumulate one dead ~top-100 JSON blob per generation until the
    // Map's capacity eviction kicked in. Redis-side retired keys are left to
    // their TTL instead (an eager KEYS scan there would block the server).
    memLeaderboardGen += 1;
    memCache.delPattern(cacheKey.leaderboard('monthly'));
    memCache.delPattern(cacheKey.leaderboard('lifetime'));
    try {
        if (useRedis && redisClient) {
            await redisClient.incr(LEADERBOARD_GEN_KEY);
        }
    } catch {
        /* Redis flap — the local bump above covers this instance */
    }
}
