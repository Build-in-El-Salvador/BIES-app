import { SimplePool, nip19, finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import * as nip44 from 'nostr-tools/nip44';
import { nostrSigner } from './nostrSigner.js';
import { buildListingTags, parseListingEvent, dedupeListings, listingNaddr } from '../utils/nip99.js';

// ─── Persistent profile cache (localStorage) ────────────────────────────────

const PROFILE_CACHE_KEY = 'bies_nostr_profiles';
const PROFILE_CACHE_TTL = 3600 * 1000; // 1 hour
const PROFILE_CACHE_VERSION = 1;

export const profileCache = {
    _getStore() {
        try {
            const raw = localStorage.getItem(PROFILE_CACHE_KEY);
            if (!raw) return { v: PROFILE_CACHE_VERSION, profiles: {} };
            const store = JSON.parse(raw);
            if (store.v !== PROFILE_CACHE_VERSION) return { v: PROFILE_CACHE_VERSION, profiles: {} };
            return store;
        } catch { return { v: PROFILE_CACHE_VERSION, profiles: {} }; }
    },
    getMany(pubkeys) {
        const store = this._getStore();
        const now = Date.now();
        const result = new Map();
        for (const pk of pubkeys) {
            const entry = store.profiles[pk];
            if (entry && (now - entry.ts) < PROFILE_CACHE_TTL) {
                result.set(pk, entry.data);
            }
        }
        return result;
    },
    setMany(profileMap) {
        const store = this._getStore();
        const now = Date.now();
        for (const [pk, data] of profileMap) {
            store.profiles[pk] = { data, ts: now };
        }
        // Evict entries older than 24h to prevent unbounded growth
        const cutoff = now - 86400000;
        for (const pk of Object.keys(store.profiles)) {
            if (store.profiles[pk].ts < cutoff) delete store.profiles[pk];
        }
        try { localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(store)); } catch { /* quota */ }
    },
};

// Private BIES relay (set via env or falls back to relative WebSocket URL)
// Use import.meta.env.BASE_URL (from vite.config base) so the path works
// both in dev (/relay) and production.
export const BIES_RELAY = import.meta.env.VITE_NOSTR_RELAY || (
    typeof window !== 'undefined'
        ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}${import.meta.env.BASE_URL || '/'}relay`
        : 'ws://localhost:7777'
);

// Public relays for fetching external profiles/content
export const PUBLIC_RELAYS = [
    'wss://relay.damus.io',
    'wss://relay.primal.net',
    'wss://relay.nostr.band',
    'wss://nos.lol',
    'wss://purplepag.es',
];

// Relays used for NIP-17 DMs — includes BIES relay so whitelisted users
// can send and receive DMs across all Nostr relays.
export const DM_RELAYS = [BIES_RELAY, ...PUBLIC_RELAYS];

// All relays (BIES relay first for priority)
export const NOSTR_RELAYS = [BIES_RELAY, ...PUBLIC_RELAYS];

// Marketplace relays — BIES relay + Shopstr's default relay set
// (shopstr-eng/shopstr getDefaultRelays). Publishing here makes BIES
// listings visible in Shopstr's browse feed.
export const MARKETPLACE_RELAYS = [...new Set([
    BIES_RELAY,
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://purplepag.es',
    'wss://relay.primal.net',
    'wss://relay.nostr.band',
])];

/**
 * NIP-42 auth handler — signs the AUTH challenge event so the BIES
 * private relay allows read/write access.  Uses the unified signer
 * (in-memory key or browser extension, depending on login method).
 */
async function handleRelayAuth(evt) {
    // Relay AUTH fires from websocket callbacks — no user gesture. Signers
    // that need one (Amber/NIP-55 navigates to another app) must never be
    // invoked here; private-relay access degrades gracefully instead.
    if (!nostrSigner.canSignSilently) {
        console.warn('[Nostr] Skipping relay AUTH — signer requires user interaction');
        return undefined;
    }
    try {
        return await nostrSigner.signEvent(evt);
    } catch (err) {
        console.error('[Nostr] AUTH signing failed:', err);
        return undefined;
    }
}

class NostrService {
    constructor() {
        this.pool = new SimplePool();
        this.relays = NOSTR_RELAYS;
        this.biesRelay = BIES_RELAY;
        this.publicRelays = PUBLIC_RELAYS;
        this.dmRelays = DM_RELAYS;

        // Enable NIP-42 automatic auth for the BIES private relay.
        // When the relay (or auth proxy) sends an AUTH challenge on connect,
        // the pool will sign and respond automatically using the user's key.
        this.pool.automaticallyAuth = (relayUrl) => {
            // Only auto-auth for the BIES relay, not public relays
            const normalized = relayUrl.replace(/\/+$/, '');
            const biesNorm = this.biesRelay.replace(/\/+$/, '');
            if (normalized === biesNorm) {
                return async (evt) => {
                    // No user gesture in relay callbacks — see handleRelayAuth.
                    if (!nostrSigner.canSignSilently) {
                        console.warn('[Nostr] Skipping relay AUTH — signer requires user interaction');
                        return undefined;
                    }
                    console.log('[Nostr] AUTH challenge received for BIES relay, signing...');
                    try {
                        const signed = await nostrSigner.signEvent(evt);
                        console.log('[Nostr] AUTH event signed successfully');
                        return signed;
                    } catch (err) {
                        console.error('[Nostr] AUTH signing failed:', err);
                        return undefined;
                    }
                };
            }
            return undefined;
        };
    }

    async connect() {
        return true;
    }

    // Subscribe to posts (Kind 1) from specific authors
    subscribeToFeed(authors, callback) {
        const authorsHex = authors
            .map(a => {
                try {
                    return a.startsWith('npub') ? nip19.decode(a).data : a;
                } catch (err) {
                    console.warn(`[Nostr] Invalid npub skipped: ${a.slice(0, 20)}...`, err.message);
                    return null;
                }
            })
            .filter(Boolean);

        if (authorsHex.length === 0) {
            console.warn('[Nostr] No valid authors to subscribe to');
            return { close: () => {} };
        }

        const sub = this.pool.subscribeMany(
            this.relays,
            {
                kinds: [1],
                authors: authorsHex,
                limit: 20
            },
            {
                onevent: (event) => {
                    callback(event);
                },
                onclose: () => {
                    console.log('Subscription closed');
                },
                onauth: handleRelayAuth,
            }
        );

        return sub;
    }

    /**
     * Batch-fetch profiles for multiple pubkeys.
     * Returns a Map of pubkey → merged profile object.
     *
     * Defaults to the BIES private relay. If any pubkeys are still missing
     * after querying the primary relays, falls back to public relays.
     *
     * @param {string[]} pubkeys - hex pubkeys
     * @param {string[]} [relays] - specific relays to query (default: BIES relay only)
     */
    async getProfiles(pubkeys, relays) {
        const unique = [...new Set(pubkeys)].filter(Boolean);
        if (unique.length === 0) return new Map();

        // Phase 1: return cached profiles instantly
        const cached = profileCache.getMany(unique);
        const missing = unique.filter(pk => !cached.has(pk));
        if (missing.length === 0) return cached;

        // Phase 2: fetch missing from relays (BIES relay by default)
        try {
            const result = new Map(cached);
            const primaryRelays = relays || [this.biesRelay];
            const events = await this.pool.querySync(primaryRelays, { kinds: [0], authors: missing });
            const fetched = this._mergeProfileEvents(events);
            for (const [pk, p] of fetched) result.set(pk, p);

            // Phase 3: fallback to public relays for any still-missing profiles
            // (skip if caller explicitly provided relays)
            if (!relays) {
                const stillMissing = missing.filter(pk => !fetched.has(pk));
                if (stillMissing.length > 0) {
                    const fallbackEvents = await this.pool.querySync(this.publicRelays, { kinds: [0], authors: stillMissing });
                    const fallbackFetched = this._mergeProfileEvents(fallbackEvents);
                    for (const [pk, p] of fallbackFetched) {
                        fetched.set(pk, p);
                        result.set(pk, p);
                    }
                }
            }

            // Persist newly fetched profiles to cache
            if (fetched.size > 0) profileCache.setMany(fetched);

            return result;
        } catch (error) {
            console.error('[Nostr] Batch profile fetch failed:', error);
            return cached;
        }
    }

    /** Merge multiple kind:0 events per pubkey into one profile object. */
    _mergeProfileEvents(events) {
        const byPubkey = new Map();
        for (const evt of events) {
            if (!byPubkey.has(evt.pubkey)) byPubkey.set(evt.pubkey, []);
            byPubkey.get(evt.pubkey).push(evt);
        }
        const result = new Map();
        for (const [pubkey, evts] of byPubkey) {
            evts.sort((a, b) => b.created_at - a.created_at);
            let merged = {};
            for (const evt of evts) {
                try {
                    const data = JSON.parse(evt.content);
                    for (const [key, value] of Object.entries(data)) {
                        if (value && !merged[key]) merged[key] = value;
                    }
                } catch { /* skip malformed */ }
            }
            result.set(pubkey, merged);
        }
        return result;
    }

    // Fetch user profile (Kind 0 — NIP-01 + NIP-24 extra metadata fields)
    // Queries the BIES private relay first, then falls back to public relays
    // if no profile is found. Merges any missing fields from older events.
    async getProfile(pubkey, relays) {
        // Check cache first
        const cached = profileCache.getMany([pubkey]);
        if (cached.has(pubkey)) return cached.get(pubkey);

        try {
            const filter = { kinds: [0], authors: [pubkey] };
            const primaryRelays = relays || [this.biesRelay];
            let events = await this.pool.querySync(primaryRelays, filter);

            // Fallback to public relays if nothing found on primary
            // (skip if caller explicitly provided relays)
            if ((!events || events.length === 0) && !relays) {
                events = await this.pool.querySync(this.publicRelays, filter);
            }

            if (!events || events.length === 0) return null;

            const fetched = this._mergeProfileEvents(events);
            const profile = fetched.get(pubkey) || null;

            if (profile) profileCache.setMany(new Map([[pubkey, profile]]));

            return profile;
        } catch (error) {
            console.error('Error fetching profile:', error);
            return null;
        }
    }

    // ─── NIP-17 Private Direct Messages ──────────────────────────────────────

    /**
     * Send a NIP-17 DM (kind:14 rumor → kind:13 seal → kind:1059 gift-wrap)
     *
     * Flow:
     * 1. Create unsigned kind:14 rumor with message content
     * 2. Sign a kind:13 seal containing NIP-44 encrypted rumor
     * 3. Create kind:1059 gift-wrap with random throwaway key
     * 4. Publish gift-wraps to both sender's and recipient's relays
     */
    async sendNip17DM(recipientPubkey, content) {
        const senderPubkey = await nostrSigner.getPublicKey();
        const now = Math.floor(Date.now() / 1000);
        // Randomize timestamp within +/- 2 days for metadata privacy
        const randomOffset = Math.floor(Math.random() * 172800) - 86400;

        // Step 1: Create kind:14 rumor (unsigned direct message)
        const rumor = {
            kind: 14,
            created_at: now,
            tags: [['p', recipientPubkey]],
            content: content,
            pubkey: senderPubkey,
        };

        // Step 2: Create kind:13 seal — encrypt rumor for recipient
        const rumorJson = JSON.stringify(rumor);

        if (!nostrSigner.hasNip44) {
            throw new Error('NIP-44 encryption not available. Please log in again.');
        }

        const encryptedForRecipient = await nostrSigner.nip44.encrypt(recipientPubkey, rumorJson);

        const sealForRecipient = await nostrSigner.signEvent({
            kind: 13,
            created_at: now + randomOffset,
            tags: [],
            content: encryptedForRecipient,
        });

        // Step 3: Gift-wrap for recipient (kind:1059) with random throwaway key
        const recipientGiftWrap = this._createGiftWrap(sealForRecipient, recipientPubkey, now);

        // Step 4: Create seal + gift-wrap for sender (so they can see sent messages)
        const encryptedForSender = await nostrSigner.nip44.encrypt(senderPubkey, rumorJson);

        const sealForSender = await nostrSigner.signEvent({
            kind: 13,
            created_at: now + randomOffset,
            tags: [],
            content: encryptedForSender,
        });

        const senderGiftWrap = this._createGiftWrap(sealForSender, senderPubkey, now);

        // Publish gift-wraps to all DM relays (BIES + public)
        const results = await Promise.allSettled([
            ...this.pool.publish(this.dmRelays, recipientGiftWrap, { onauth: handleRelayAuth }),
            ...this.pool.publish(this.dmRelays, senderGiftWrap, { onauth: handleRelayAuth }),
        ]);

        const succeeded = results.filter(r => r.status === 'fulfilled').length;
        const failed = results.filter(r => r.status === 'rejected').length;
        if (failed > 0) {
            console.warn(`[NIP-17] Published to ${succeeded} relays, ${failed} failed`);
        }
        if (succeeded === 0) {
            throw new Error('Failed to publish DM to any relay');
        }

        return rumor;
    }

    /**
     * Create a kind:1059 gift-wrap using a random throwaway key
     */
    _createGiftWrap(seal, recipientPubkey, baseTimestamp) {
        const randomSk = generateSecretKey();
        const randomPk = getPublicKey(randomSk);
        const randomOffset = Math.floor(Math.random() * 172800) - 86400;

        // NIP-44 encrypt the seal for the recipient using the throwaway key
        const conversationKey = nip44.v2.utils.getConversationKey(randomSk, recipientPubkey);
        const encryptedSeal = nip44.v2.encrypt(JSON.stringify(seal), conversationKey);

        const giftWrap = {
            kind: 1059,
            created_at: baseTimestamp + randomOffset,
            tags: [['p', recipientPubkey]],
            content: encryptedSeal,
            pubkey: randomPk,
        };

        // Sign with throwaway key
        return finalizeEvent(giftWrap, randomSk);
    }

    /**
     * Subscribe to NIP-17 DMs (kind:1059 gift-wraps addressed to myPubkey)
     */
    subscribeToNip17DMs(myPubkey, callback) {
        // Subscribe on all DM relays (BIES + public).
        //
        // Pass a single filter object (not wrapped in an array) — SimplePool
        // in nostr-tools v2 double-nests arrays, producing invalid REQ
        // messages that relays reject with "filter is not an object".
        const sub = this.pool.subscribeMany(
            this.dmRelays,
            {
                kinds: [1059],
                '#p': [myPubkey],
                limit: 100,
            },
            {
                onevent: (event) => {
                    callback(event);
                },
            }
        );
        return sub;
    }

    /**
     * Unwrap a NIP-17 gift-wrap to extract the rumor (kind:14)
     *
     * 1. NIP-44 decrypt gift-wrap content with my key + gift-wrap author pubkey → kind:13 seal
     * 2. NIP-44 decrypt seal content with my key + seal author pubkey → kind:14 rumor
     */
    async unwrapGiftWrap(giftWrapEvent) {
        if (!nostrSigner.hasNip44) {
            throw new Error('NIP-44 decryption not available. Please log in again.');
        }

        // Step 1: Decrypt the gift-wrap to get the seal
        const sealJson = await nostrSigner.nip44.decrypt(giftWrapEvent.pubkey, giftWrapEvent.content);
        const seal = JSON.parse(sealJson);

        if (seal.kind !== 13) {
            throw new Error('Invalid seal kind: ' + seal.kind);
        }

        // Step 2: Decrypt the seal to get the rumor
        const rumorJson = await nostrSigner.nip44.decrypt(seal.pubkey, seal.content);
        const rumor = JSON.parse(rumorJson);

        if (rumor.kind !== 14) {
            throw new Error('Invalid rumor kind: ' + rumor.kind);
        }

        return {
            rumor,
            sealPubkey: seal.pubkey, // The actual sender
            giftWrapId: giftWrapEvent.id,
        };
    }

    // Legacy NIP-04 methods (kept for backward compatibility)
    // Use two separate subscriptions since SimplePool double-nests filter arrays.
    subscribeToDMs(myPubkey, callback) {
        const params = { onevent: (event) => callback(event), onauth: handleRelayAuth };
        const sub1 = this.pool.subscribeMany(
            this.relays,
            { kinds: [4], '#p': [myPubkey], limit: 50 },
            params,
        );
        const sub2 = this.pool.subscribeMany(
            this.relays,
            { kinds: [4], authors: [myPubkey], limit: 50 },
            params,
        );
        return { close: (reason) => { sub1.close(reason); sub2.close(reason); } };
    }

    async publishEvent(event) {
        const signedEvent = await nostrSigner.signEvent(event);
        return Promise.any(this.pool.publish(this.relays, signedEvent, { onauth: handleRelayAuth }));
    }

    /**
     * Publish an event that's already signed (so the caller keeps its id):
     * to the BIES relay only, or to every relay.
     */
    async publishSigned(signedEvent, { biesOnly = false } = {}) {
        const relays = biesOnly ? [this.biesRelay] : this.relays;
        return Promise.any(this.pool.publish(relays, signedEvent, { onauth: handleRelayAuth }));
    }

    /**
     * Undo my like: a NIP-09 deletion of my kind:7 reactions to an event.
     * Uses the reaction ids when known, else looks them up on the relays.
     * @returns {Promise<boolean>} false when there was nothing to undo
     */
    async unreact(targetId, { biesOnly = false, knownIds = [] } = {}) {
        let ids = knownIds.filter(Boolean);
        if (!ids.length) {
            const me = await nostrSigner.getPublicKey();
            const relays = biesOnly ? [this.biesRelay] : this.relays;
            const events = await this.pool.querySync(relays, { kinds: [7], authors: [me], '#e': [targetId] }, { onauth: handleRelayAuth });
            ids = events.map((e) => e.id);
        }
        if (!ids.length) return false;
        const deletion = await nostrSigner.signEvent({
            kind: 5,
            created_at: Math.floor(Date.now() / 1000),
            tags: [...ids.map((id) => ['e', id]), ['k', '7']],
            content: '',
        });
        await this.publishSigned(deletion, { biesOnly });
        return true;
    }

    /**
     * Publish a signed event to the private BIES relay only.
     */
    async publishToBiesRelay(event) {
        const signedEvent = await nostrSigner.signEvent(event);
        console.log('[Nostr] Publishing to BIES relay:', this.biesRelay);
        try {
            return await Promise.any(this.pool.publish([this.biesRelay], signedEvent, { onauth: handleRelayAuth }));
        } catch (err) {
            // Promise.any wraps rejections in AggregateError — unwrap for clarity
            if (err?.errors?.length) {
                const inner = err.errors[0];
                console.error('[Nostr] BIES relay publish rejected:', inner?.message || inner);
                throw typeof inner === 'string' ? new Error(inner) : inner;
            }
            throw err;
        }
    }

    /**
     * Subscribe to the private BIES relay only (handles the NIP-42 AUTH challenge).
     * Optional callbacks (both may be omitted — existing callers are unaffected):
     * - oneose: fires once the relay finished replaying stored events
     * - onclose: fires when the subscription closes (e.g. relay unreachable)
     */
    subscribeToBiesRelay(filter, onevent, { oneose, onclose } = {}) {
        return this.pool.subscribeMany([this.biesRelay], filter, { onevent, oneose, onclose, onauth: handleRelayAuth });
    }

    /**
     * Update the user's Nostr profile (kind:0 metadata).
     * Signs via browser extension and publishes to all relays.
     * @param {Object} profileData - { name, about, picture, website, nip05, banner, lud16, ... }
     * @returns {Promise} resolves when published to at least one relay
     */
    async updateProfile(profileData) {
        const pubkey = await nostrSigner.getPublicKey();

        // Fetch existing kind:0 to preserve fields we're not editing
        const existing = await this.getProfile(pubkey);
        const merged = { ...existing, ...profileData };

        // Remove null/undefined values
        Object.keys(merged).forEach(k => {
            if (merged[k] == null || merged[k] === '') delete merged[k];
        });

        const event = {
            kind: 0,
            pubkey,
            created_at: Math.floor(Date.now() / 1000),
            tags: [],
            content: JSON.stringify(merged),
        };

        return this.publishEvent(event);
    }

    /**
     * Update the user's Nostr profile (kind:0 metadata).
     * Same as updateProfile but publishes only to the private BIES relay.
     */
    async updateProfileToBiesRelay(profileData) {
        const pubkey = await nostrSigner.getPublicKey();

        const existing = await this.getProfile(pubkey);
        const merged = { ...existing, ...profileData };

        Object.keys(merged).forEach(k => {
            if (merged[k] == null || merged[k] === '') delete merged[k];
        });

        const event = {
            kind: 0,
            pubkey,
            created_at: Math.floor(Date.now() / 1000),
            tags: [],
            content: JSON.stringify(merged),
        };

        return this.publishToBiesRelay(event);
    }

    /**
     * Get Nostr follower count (kind:3 contact lists that include this pubkey).
     * Uses relay.nostr.band which supports NIP-45 COUNT or falls back to querying.
     */
    async getFollowerCount(pubkey) {
        try {
            const events = await this.pool.querySync(
                ['wss://relay.nostr.band'],
                { kinds: [3], '#p': [pubkey], limit: 1000 }
            );
            // Deduplicate by author (each author's latest kind:3 is their contact list)
            const uniqueAuthors = new Set(events.map(e => e.pubkey));
            return uniqueAuthors.size;
        } catch (error) {
            console.error('Error fetching Nostr follower count:', error);
            return 0;
        }
    }

    /**
     * Get Nostr following count (kind:3 contact list p-tags for this pubkey).
     */
    async getFollowingCount(pubkey) {
        try {
            const events = await this.pool.querySync(
                this.publicRelays,
                { kinds: [3], authors: [pubkey], limit: 1 }
            );
            if (!events || events.length === 0) return 0;
            // Sort newest-first and use the latest contact list
            events.sort((a, b) => b.created_at - a.created_at);
            const pTags = events[0].tags.filter(t => t[0] === 'p');
            return pTags.length;
        } catch (error) {
            console.error('Error fetching Nostr following count:', error);
            return 0;
        }
    }

    /**
     * Search Nostr profiles by name using NIP-50 search on relay.nostr.band.
     * Returns an array of { pubkey, name, display_name, picture, nip05 }.
     */
    async searchProfiles(query, limit = 10) {
        try {
            const events = await this.pool.querySync(
                ['wss://relay.nostr.band'],
                {
                    kinds: [0],
                    search: query,
                    limit,
                }
            );

            return events.map(event => {
                try {
                    const profile = JSON.parse(event.content);
                    return {
                        pubkey: event.pubkey,
                        name: profile.name || '',
                        display_name: profile.display_name || '',
                        picture: profile.picture || '',
                        nip05: profile.nip05 || '',
                    };
                } catch {
                    return null;
                }
            }).filter(Boolean);
        } catch (error) {
            console.error('Nostr profile search failed:', error);
            return [];
        }
    }

    /**
     * Publish a NIP-52 time-based calendar event (kind:31923).
     * For Nostr-native users — signs via browser extension.
     * @param {Object} eventData - Event details from the BIES event form
     * @param {'bies'|'public'|'both'} target - Which relays to publish to
     */
    async publishCalendarEvent(eventData, target = 'bies') {
        // Validate required NIP-52 fields
        if (!eventData.id) throw new Error('Event ID (d-tag) is required for NIP-52');
        if (!eventData.title?.trim()) throw new Error('Event title is required for NIP-52');
        if (!eventData.startDate) throw new Error('Start date is required for NIP-52');
        const startUnix = Math.floor(new Date(eventData.startDate).getTime() / 1000);
        if (isNaN(startUnix)) throw new Error('Invalid start date for NIP-52');

        const pubkey = await nostrSigner.getPublicKey();

        const tags = [
            ['d', eventData.id],
            ['title', eventData.title],
            ['start', String(startUnix)],
        ];

        if (eventData.endDate) {
            tags.push(['end', String(Math.floor(new Date(eventData.endDate).getTime() / 1000))]);
        }

        if (eventData.location) {
            tags.push(['location', eventData.location]);
        }
        if (eventData.locationAddress) {
            tags.push(['g', eventData.locationAddress]);
        }
        if (eventData.isOnline && eventData.onlineUrl) {
            tags.push(['r', eventData.onlineUrl]);
        }
        if (eventData.thumbnail) {
            tags.push(['image', eventData.thumbnail]);
        }
        if (eventData.ticketUrl) {
            tags.push(['r', eventData.ticketUrl]);
        }

        tags.push(['t', 'bies']);
        if (eventData.category) {
            tags.push(['t', eventData.category.toLowerCase().replace(/_/g, '-')]);
        }
        if (eventData.tags && Array.isArray(eventData.tags)) {
            for (const t of eventData.tags) {
                tags.push(['t', t.toLowerCase()]);
            }
        }

        const event = {
            kind: 31923,
            pubkey,
            created_at: Math.floor(Date.now() / 1000),
            tags,
            content: eventData.description || '',
        };

        // Determine relays based on target
        let relays;
        if (target === 'bies') {
            relays = [this.biesRelay];
        } else if (target === 'public') {
            relays = [...this.publicRelays];
        } else {
            relays = [this.biesRelay, ...this.publicRelays];
        }

        const signedEvent = await nostrSigner.signEvent(event);
        const results = await Promise.allSettled(
            this.pool.publish(relays, signedEvent, { onauth: handleRelayAuth })
        );
        const succeeded = results.filter(r => r.status === 'fulfilled').length;
        if (succeeded === 0) {
            throw new Error('Failed to publish NIP-52 calendar event to any relay');
        }
        console.log(`[NIP-52] Calendar event published to ${succeeded}/${relays.length} relays (target: ${target})`);
        return signedEvent.id;
    }

    /**
     * Subscribe to NIP-52 calendar events (kind:31923) from relays.
     * Returns a subscription handle with a .close() method.
     * @param {Function} callback - Called with each calendar event
     * @param {Object} [options] - Optional filter overrides
     * @param {string[]} [options.authors] - Filter by author pubkeys
     * @param {number} [options.since] - Only events after this unix timestamp
     * @param {number} [options.limit] - Max events to fetch
     */
    subscribeToCalendarEvents(callback, options = {}) {
        const filter = {
            kinds: [31923],
            ...(options.authors ? { authors: options.authors } : {}),
            ...(options.since ? { since: options.since } : {}),
            limit: options.limit || 50,
        };

        const relays = [this.biesRelay, ...this.publicRelays];

        const sub = this.pool.subscribeMany(
            relays,
            filter,
            {
                onevent: (event) => callback(event),
                onauth: handleRelayAuth,
            }
        );

        return sub;
    }

    /**
     * Publish a NIP-09 deletion event (kind:5) to remove a calendar event.
     * @param {string} nostrEventId - The Nostr event ID to delete
     * @param {string} dTag - The d-tag of the calendar event
     * @param {'bies'|'public'|'both'} target - Which relays to delete from
     */
    async deleteCalendarEvent(nostrEventId, dTag, target = 'bies') {
        const pubkey = await nostrSigner.getPublicKey();

        const event = {
            kind: 5,
            pubkey,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['e', nostrEventId],
                ['a', `31923:${pubkey}:${dTag}`],
            ],
            content: 'Event deleted from BIES',
        };

        let relays;
        if (target === 'bies') relays = [this.biesRelay];
        else if (target === 'public') relays = [...this.publicRelays];
        else relays = [this.biesRelay, ...this.publicRelays];

        const signedEvent = await nostrSigner.signEvent(event);
        const results = await Promise.allSettled(
            this.pool.publish(relays, signedEvent, { onauth: handleRelayAuth })
        );
        const succeeded = results.filter(r => r.status === 'fulfilled').length;
        console.log(`[NIP-09] Deletion published to ${succeeded}/${relays.length} relays`);
        return succeeded > 0;
    }

    /**
     * Publish a NIP-52 calendar event RSVP (kind:31925).
     * @param {Object} rsvpData - { eventDTag, hostPubkey, status }
     * @param {'bies'|'public'|'both'} target
     */
    async publishRSVPEvent(rsvpData, target = 'bies') {
        const pubkey = await nostrSigner.getPublicKey();

        const tags = [
            ['d', `${rsvpData.eventDTag}-rsvp`],
            ['a', `31923:${rsvpData.hostPubkey}:${rsvpData.eventDTag}`],
            ['L', 'status'],
            ['l', rsvpData.status, 'status'],
            ['p', rsvpData.hostPubkey],
        ];

        const event = {
            kind: 31925,
            pubkey,
            created_at: Math.floor(Date.now() / 1000),
            tags,
            content: '',
        };

        let relays;
        if (target === 'bies') relays = [this.biesRelay];
        else if (target === 'public') relays = [...this.publicRelays];
        else relays = [this.biesRelay, ...this.publicRelays];

        const signedEvent = await nostrSigner.signEvent(event);
        const results = await Promise.allSettled(
            this.pool.publish(relays, signedEvent, { onauth: handleRelayAuth })
        );
        const succeeded = results.filter(r => r.status === 'fulfilled').length;
        if (succeeded === 0) {
            throw new Error('Failed to publish NIP-52 RSVP to any relay');
        }
        console.log(`[NIP-52] RSVP published to ${succeeded}/${relays.length} relays`);
        return signedEvent.id;
    }

    /**
     * Check relay connectivity. Returns { url, connected } for each relay.
     * Caches result for 30 seconds to avoid spamming WebSocket connections.
     */
    async checkRelayHealth() {
        if (this._relayHealthCache && Date.now() - this._relayHealthCacheTime < 30000) {
            return this._relayHealthCache;
        }
        const relays = [this.biesRelay, ...this.publicRelays];
        const results = await Promise.allSettled(
            relays.map(async (url) => {
                const ws = new WebSocket(url);
                return new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 5000);
                    ws.onopen = () => { clearTimeout(timeout); ws.close(); resolve(url); };
                    ws.onerror = () => { clearTimeout(timeout); reject(new Error('error')); };
                });
            })
        );
        const health = relays.map((url, i) => ({
            url,
            connected: results[i].status === 'fulfilled',
        }));
        this._relayHealthCache = health;
        this._relayHealthCacheTime = Date.now();
        return health;
    }

    /**
     * Publish a NIP-99 classified listing (kind:30402) for a project.
     * For Nostr-native users — signs via browser extension.
     */
    async publishProjectListing(project) {
        const pubkey = await nostrSigner.getPublicKey();
        const tags = [
            ['d', project.id],
            ['title', project.title],
            ['summary', (project.description || '').substring(0, 200)],
            ['t', (project.category || 'other').toLowerCase()],
            ['t', (project.stage || 'idea').toLowerCase()],
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

        const event = {
            kind: 30402,
            pubkey,
            created_at: Math.floor(Date.now() / 1000),
            tags,
            content: project.description || '',
        };

        return this.publishEvent(event);
    }

    /**
     * Publish a directory listing as a NIP-99 classified listing (kind:30402).
     * For Nostr-native users — signs via browser extension. Twin of the
     * server's publishDirectoryListing (nostr.service.ts): same kind, tags,
     * and content. Returns the signed event id so callers can persist it
     * as nostrListingEventId.
     * @param {Object} listing - { id, type, name, about, photo, location, products, skills }
     */
    async publishDirectoryListing(listing) {
        const pubkey = await nostrSigner.getPublicKey();
        const about = listing.about || '';
        const tags = [
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
        let items = [];
        if (typeof rawItems === 'string') {
            try { items = JSON.parse(rawItems || '[]'); } catch { items = []; }
        } else if (Array.isArray(rawItems)) {
            items = rawItems;
        }
        const seen = new Set(['bies', 'directory', 'farm', 'services']);
        for (const item of items) {
            const label = typeof item === 'string' ? item : item?.label;
            if (typeof label !== 'string') continue;
            const value = label.trim().toLowerCase();
            if (!value || seen.has(value)) continue;
            seen.add(value);
            tags.push(['t', value]);
            if (seen.size >= 14) break; // 4 base topic tags + max 10 item tags
        }

        if (listing.photo) tags.push(['image', listing.photo]);
        if (listing.location) tags.push(['location', listing.location]);

        const event = {
            kind: 30402,
            pubkey,
            created_at: Math.floor(Date.now() / 1000),
            tags,
            content: about,
        };

        const signedEvent = await nostrSigner.signEvent(event);
        await Promise.any(this.pool.publish(this.relays, signedEvent, { onauth: handleRelayAuth }));
        return signedEvent.id;
    }

    // ─── NIP-99 Marketplace (Shopstr-compatible, kind:30402) ─────────────────

    /**
     * Publish a marketplace listing (NIP-99 kind:30402, Shopstr-compatible).
     * For Nostr-native users — signs via browser extension. Twin of the
     * server's publishMarketplaceListing (nostr.service.ts): same tags and
     * content (built by buildListingTags in utils/nip99.js).
     * @param {Object} listing - form fields (see buildListingTags) plus
     *        optional dTag/publishedAt when editing an existing listing
     * @returns {Promise<{id: string, dTag: string, pubkey: string, naddr: string}>}
     */
    async publishMarketplaceListing(listing) {
        const pubkey = await nostrSigner.getPublicKey();
        const { tags, content, dTag } = buildListingTags(listing, {
            dTag: listing.dTag,
            publishedAt: listing.publishedAt,
        });

        const event = {
            kind: 30402,
            pubkey,
            created_at: Math.floor(Date.now() / 1000),
            tags,
            content,
        };

        const signedEvent = await nostrSigner.signEvent(event);
        const results = await Promise.allSettled(
            this.pool.publish(MARKETPLACE_RELAYS, signedEvent, { onauth: handleRelayAuth })
        );
        const succeeded = results.filter(r => r.status === 'fulfilled').length;
        if (succeeded === 0) {
            throw new Error('Failed to publish marketplace listing to any relay');
        }
        console.log(`[NIP-99] Marketplace listing published to ${succeeded}/${MARKETPLACE_RELAYS.length} relays`);

        // Relay hints for the shareable naddr — public relays only (the BIES
        // relay is private/NIP-42 gated, useless to external Shopstr clients).
        const hintRelays = MARKETPLACE_RELAYS.filter(r => r !== this.biesRelay);
        return {
            id: signedEvent.id,
            dTag,
            pubkey,
            naddr: listingNaddr({ pubkey, dTag }, hintRelays),
        };
    }

    /**
     * Fetch marketplace listings (kind:30402), filtered to real products
     * (title + price, no directory/investment tags) and deduped by
     * (pubkey, d-tag). Attaches sellerName/sellerAvatar from kind:0 profiles.
     * @param {Object} [options]
     * @param {'bies'|'global'} [options.scope] - 'bies' queries the private
     *        relay only; anything else queries all marketplace relays
     * @param {string[]} [options.authors] - filter by seller pubkeys
     * @param {number} [options.limit]
     */
    async fetchMarketplaceListings({ scope = 'bies', authors, limit = 100 } = {}) {
        const relays = scope === 'bies' ? [this.biesRelay] : MARKETPLACE_RELAYS;
        try {
            const events = await this.pool.querySync(relays, {
                kinds: [30402],
                limit,
                ...(authors ? { authors } : {}),
            });

            const hintRelays = MARKETPLACE_RELAYS.filter(r => r !== this.biesRelay);
            const listings = dedupeListings(
                events.map(e => parseListingEvent(e, hintRelays)).filter(Boolean)
            );

            // Batch-load seller profiles (cached) and attach display info
            const profiles = await this.getProfiles(listings.map(l => l.pubkey));
            for (const listing of listings) {
                const profile = profiles.get(listing.pubkey);
                listing.sellerName = profile?.display_name || profile?.name || '';
                listing.sellerAvatar = profile?.picture || '';
            }

            return listings;
        } catch (error) {
            console.error('[NIP-99] Marketplace listings fetch failed:', error);
            return [];
        }
    }

    /**
     * Fetch a single marketplace listing by naddr. Queries the naddr's
     * embedded relay hints plus all marketplace relays; returns the latest
     * revision, or null if not found / not a marketplace listing.
     */
    async fetchMarketplaceListing(naddr) {
        try {
            const decoded = nip19.decode(naddr);
            if (decoded.type !== 'naddr' || decoded.data.kind !== 30402) {
                throw new Error('Not a kind:30402 naddr');
            }
            const { pubkey, identifier, relays: decodedRelays } = decoded.data;
            const relays = [...new Set([...(decodedRelays || []), ...MARKETPLACE_RELAYS])];

            const events = await this.pool.querySync(relays, {
                kinds: [30402],
                authors: [pubkey],
                '#d': [identifier],
                limit: 5,
            });

            const hintRelays = MARKETPLACE_RELAYS.filter(r => r !== this.biesRelay);
            const listings = dedupeListings(
                events.map(e => parseListingEvent(e, hintRelays)).filter(Boolean)
            );
            return listings[0] || null;
        } catch (error) {
            console.error('[NIP-99] Marketplace listing fetch failed:', error);
            return null;
        }
    }

    /**
     * Publish a NIP-09 deletion event (kind:5) to remove a marketplace
     * listing from all marketplace relays.
     * @param {string} eventId - the Nostr event ID of the listing
     * @param {string} dTag - the listing's d-tag
     */
    async deleteMarketplaceListing(eventId, dTag) {
        const pubkey = await nostrSigner.getPublicKey();

        const event = {
            kind: 5,
            pubkey,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['e', eventId],
                ['a', `30402:${pubkey}:${dTag}`],
            ],
            content: 'Listing deleted from BIES',
        };

        const signedEvent = await nostrSigner.signEvent(event);
        const results = await Promise.allSettled(
            this.pool.publish(MARKETPLACE_RELAYS, signedEvent, { onauth: handleRelayAuth })
        );
        const succeeded = results.filter(r => r.status === 'fulfilled').length;
        console.log(`[NIP-09] Marketplace deletion published to ${succeeded}/${MARKETPLACE_RELAYS.length} relays`);
        return succeeded > 0;
    }

    /**
     * Relay set for a course-mirror target ('bies' | 'public' | 'both').
     */
    _courseRelays(target) {
        if (target === 'bies') return [this.biesRelay];
        if (target === 'public') return [...this.publicRelays];
        return [this.biesRelay, ...this.publicRelays];
    }

    /**
     * Deduped topic tags for a course event (mirrors the server's
     * courseTopicTags in nostr.service.ts).
     */
    _courseTopicTags(course) {
        const tags = [['t', 'bies'], ['t', 'education']];
        const seen = new Set(['bies', 'education']);
        let extraTags = course.tags;
        if (typeof extraTags === 'string') {
            try { extraTags = JSON.parse(extraTags || '[]'); } catch { extraTags = []; }
        }
        for (const raw of [course.category, ...(extraTags || [])]) {
            const t = String(raw || '').toLowerCase().replace(/_/g, '-').trim();
            if (t && !seen.has(t) && seen.size < 12) {
                seen.add(t);
                tags.push(['t', t]);
            }
        }
        return tags;
    }

    /**
     * Publish one course lesson for a Nostr-native author. Twin of the
     * server's publishLessonArticle / publishPaidLessonTeaser:
     * free lesson → kind 30023 full markdown; paid lesson → kind 30402
     * with a summary-derived teaser ONLY (full content never enters the
     * event — the API is the real gate). Quiz lessons must not be passed.
     * Returns the signed event id.
     * @param {Object} course - { id, title, summary, coverImage, tags, category, priceSats }
     * @param {Object} lesson - { id, title, type, content: {markdown|videoUrl,caption} }
     */
    async publishCourseLesson(course, lesson, target = 'bies') {
        if (lesson.type === 'QUIZ') return null; // never mirrored
        const isPaid = (course.priceSats || 0) > 0;
        const now = Math.floor(Date.now() / 1000);

        const tags = [
            ['d', lesson.id],
            ['title', lesson.title],
            ['summary', (course.summary || '').slice(0, 200)],
            ['published_at', String(now)],
            ...this._courseTopicTags(course),
        ];
        if (course.coverImage) tags.push(['image', course.coverImage]);

        let kind;
        let content;
        if (isPaid) {
            kind = 30402;
            tags.push(['price', String(course.priceSats), 'SATS']);
            content = (course.summary || course.title).slice(0, 300);
        } else {
            kind = 30023;
            const body = lesson.content || {};
            content = lesson.type === 'VIDEO'
                ? `${body.caption ? body.caption + '\n\n' : ''}${body.videoUrl || ''}`
                : (body.markdown || '');
            if (!content) return null;
        }

        const pubkey = await nostrSigner.getPublicKey();
        const signedEvent = await nostrSigner.signEvent({
            kind,
            pubkey,
            created_at: now,
            tags,
            content,
        });
        await Promise.any(this.pool.publish(this._courseRelays(target), signedEvent, { onauth: handleRelayAuth }));
        return signedEvent.id;
    }

    /**
     * Publish the course container as a NIP-51 curation set (kind 30004)
     * for a Nostr-native author. Ordered `a` tags reference the lesson
     * events (30023 free / 30402 paid); quiz lessons are skipped. Twin of
     * the server's publishCourse. Returns the signed event id.
     * @param {Object} course - { id, title, summary, description, coverImage, tags, category, priceSats }
     * @param {Array<{id, type}>} orderedLessons - lessons in position order
     */
    async publishCourse(course, orderedLessons, target = 'bies') {
        const pubkey = await nostrSigner.getPublicKey();
        const isPaid = (course.priceSats || 0) > 0;
        const now = Math.floor(Date.now() / 1000);

        const tags = [
            ['d', course.id],
            ['title', course.title],
            ['summary', (course.summary || '').slice(0, 200)],
            ['published_at', String(now)],
            ...this._courseTopicTags(course),
        ];
        if (course.coverImage) tags.push(['image', course.coverImage]);
        if (isPaid) tags.push(['price', String(course.priceSats), 'SATS']);

        for (const lesson of orderedLessons || []) {
            if (lesson.type === 'QUIZ') continue;
            tags.push(['a', `${isPaid ? 30402 : 30023}:${pubkey}:${lesson.id}`]);
        }

        const signedEvent = await nostrSigner.signEvent({
            kind: 30004,
            pubkey,
            created_at: now,
            tags,
            content: course.description || course.summary || '',
        });
        await Promise.any(this.pool.publish(this._courseRelays(target), signedEvent, { onauth: handleRelayAuth }));
        return signedEvent.id;
    }

    /**
     * Publish a NIP-65 relay list metadata event (kind:10002).
     * For Nostr-native users — signs via browser extension.
     * Tags BIES relay as write, public relays as read.
     */
    async publishRelayList() {
        const pubkey = await nostrSigner.getPublicKey();
        const tags = [
            ['r', this.biesRelay, 'write'],
            ...this.publicRelays.map(relay => ['r', relay, 'read']),
        ];

        const event = {
            kind: 10002,
            pubkey,
            created_at: Math.floor(Date.now() / 1000),
            tags,
            content: '',
        };

        return this.publishEvent(event);
    }

    async sendDM(recipientPubkey, content) {
        // Use NIP-17 by default
        return this.sendNip17DM(recipientPubkey, content);
    }
}

export const nostrService = new NostrService();
