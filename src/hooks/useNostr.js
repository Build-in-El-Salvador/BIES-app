import { useState, useEffect, useRef, useCallback } from 'react';
import { nostrService, profileCache } from '../services/nostrService';
import { nostrSigner } from '../services/nostrSigner';
import { nip19 } from 'nostr-tools';

/**
 * Subscribe to a Nostr feed for specific authors.
 * @param {string[]} npubs - npub or hex pubkeys to follow
 * @param {'public'|'private'|'combined'} relayMode - which relays to query
 */
export const useNostrFeed = (npubs, relayMode = 'combined') => {
    const [posts, setPosts] = useState([]);
    const [loading, setLoading] = useState(true);
    const [profiles, setProfiles] = useState({});
    const fetchedProfiles = useRef(new Set());

    useEffect(() => {
        if (!npubs || npubs.length === 0) {
            setLoading(false);
            return;
        }

        // Clear stale posts when relay mode or authors change
        setPosts([]);
        setLoading(true);
        fetchedProfiles.current.clear();

        const relays =
            relayMode === 'private'  ? [nostrService.biesRelay] :
            relayMode === 'public'   ? nostrService.publicRelays :
            nostrService.relays; // combined

        // Stop loading after 15s even if no events arrive
        const timeout = setTimeout(() => setLoading(false), 15000);

        // Collect pubkeys during streaming, batch-fetch after EOSE.
        // Post-EOSE live arrivals are debounced (300ms) and batched too.
        const preEosePubkeys = [];
        const liveQueue = new Set();
        let debounceTimer = null;
        let eoseFired = false;
        let cancelled = false;

        // Use the same relays for profile fetching as for the feed subscription
        const profileRelays = relays;

        const flushLiveProfiles = async () => {
            if (liveQueue.size === 0) return;
            const toFetch = [...liveQueue].filter(pk => !fetchedProfiles.current.has(pk));
            toFetch.forEach(pk => fetchedProfiles.current.add(pk));
            liveQueue.clear();
            if (toFetch.length === 0) return;
            const profileMap = await nostrService.getProfiles(toFetch, profileRelays);
            if (profileMap.size > 0) {
                setProfiles(prev => {
                    const next = { ...prev };
                    for (const [pk, p] of profileMap) next[pk] = p;
                    return next;
                });
            }
        };

        const authorsHex = npubs
            .map(a => {
                try { return a.startsWith('npub') ? nip19.decode(a).data : a; }
                catch { return null; }
            })
            .filter(Boolean);

        let sub;

        const startSubscription = async () => {
            if (authorsHex.length === 0) {
                setLoading(false);
                return;
            }

            // Ensure signer is ready when hitting the BIES relay (NIP-42)
            if (relayMode !== 'public') {
                try { await nostrSigner.tryRestore(); } catch { /* ok — public relays still work */ }
            }

            sub = nostrService.pool.subscribeMany(
                relays,
                { kinds: [1], authors: authorsHex, limit: 20 },
                {
                    onevent: (event) => {
                        if (cancelled) return;

                        // Skip machine-generated content
                        const c = (event.content || '').trimStart();
                        if (c.startsWith('{') || c.startsWith('xitchat-') || c.startsWith('[')) return;

                        // Skip replies (events with 'e' tags are replies, not root posts)
                        if (event.tags.some(t => t[0] === 'e')) return;

                        setPosts(prev => {
                            if (prev.find(p => p.id === event.id)) return prev;
                            return [...prev, event].sort((a, b) => b.created_at - a.created_at);
                        });
                        clearTimeout(timeout);
                        setLoading(false);

                        if (!fetchedProfiles.current.has(event.pubkey)) {
                            if (!eoseFired) {
                                preEosePubkeys.push(event.pubkey);
                            } else {
                                liveQueue.add(event.pubkey);
                                clearTimeout(debounceTimer);
                                debounceTimer = setTimeout(flushLiveProfiles, 300);
                            }
                        }
                    },
                    oneose: async () => {
                        eoseFired = true;
                        setLoading(false);
                        clearTimeout(debounceTimer);
                        const toFetch = [...new Set(preEosePubkeys)].filter(pk => !fetchedProfiles.current.has(pk));
                        toFetch.forEach(pk => fetchedProfiles.current.add(pk));
                        if (toFetch.length === 0) return;

                        // Instantly hydrate from localStorage cache
                        const cached = profileCache.getMany(toFetch);
                        if (cached.size > 0) {
                            setProfiles(prev => {
                                const next = { ...prev };
                                for (const [pk, p] of cached) next[pk] = p;
                                return next;
                            });
                        }

                        // Fetch from the same relays as the feed subscription
                        const profileMap = await nostrService.getProfiles(toFetch, profileRelays);
                        if (profileMap.size > 0) {
                            setProfiles(prev => {
                                const next = { ...prev };
                                for (const [pk, p] of profileMap) next[pk] = p;
                                return next;
                            });
                        }
                    },
                    onclose: () => { if (!cancelled) setLoading(false); },
                    onauth: async (evt) => {
                        try { return await nostrSigner.signEvent(evt); } catch { return undefined; }
                    },
                }
            );
        };

        startSubscription().catch(err => {
            console.error('[Nostr] Feed subscription error:', err);
            setLoading(false);
            clearTimeout(timeout);
        });

        return () => {
            cancelled = true;
            clearTimeout(timeout);
            clearTimeout(debounceTimer);
            if (sub) sub.close();
        };
    }, [JSON.stringify(npubs), relayMode]);

    return { posts, loading, profiles };
};

/**
 * NIP-17 Direct Messages hook
 *
 * Subscribes to kind:1059 gift-wraps, unwraps them to extract kind:14 rumors,
 * and groups messages by conversation partner.
 */
export const useNostrDMs = ({ onIncomingMessage } = {}) => {
    const [messages, setMessages] = useState([]);
    const [loading, setLoading] = useState(false);
    const [publicKey, setPublicKey] = useState(null);
    const [error, setError] = useState(null);
    const [profiles, setProfiles] = useState({});
    const subRef = useRef(null);
    const processedIds = useRef(new Set());
    const fetchedProfiles = useRef(new Set());
    const onIncomingRef = useRef(onIncomingMessage);
    onIncomingRef.current = onIncomingMessage;

    const connect = useCallback(async () => {
        setLoading(true);
        setError(null);

        try {
            // Try to restore signing ability (handles page refresh for all login methods)
            if (!nostrSigner.hasNip44) {
                const restored = await nostrSigner.tryRestore();
                if (!restored) {
                    const method = nostrSigner.storedMethod;
                    if (method === 'nsec') {
                        throw new Error('Your signing session has expired. Please log in again with your nsec key or passkey.');
                    } else if (method === 'bunker') {
                        throw new Error('Could not reconnect to your remote signer. Please log in again.');
                    } else {
                        throw new Error('Nostr signing not available. Please log in with a Nostr account to use messaging.');
                    }
                }
            }

            const pubkey = await nostrSigner.getPublicKey();
            setPublicKey(pubkey);

            // Subscribe to NIP-17 gift-wraps (kind:1059)
            subRef.current = nostrService.subscribeToNip17DMs(pubkey, async (giftWrapEvent) => {
                // Skip already processed
                if (processedIds.current.has(giftWrapEvent.id)) return;
                processedIds.current.add(giftWrapEvent.id);

                try {
                    const { rumor, sealPubkey } = await nostrService.unwrapGiftWrap(giftWrapEvent);

                    // Determine the conversation partner
                    const isSender = sealPubkey === pubkey;
                    const partnerPubkey = isSender
                        ? rumor.tags.find(t => t[0] === 'p')?.[1]
                        : sealPubkey;

                    if (!partnerPubkey) return;

                    // Fetch partner profile if not already fetched (use ref to avoid stale closure)
                    if (!fetchedProfiles.current.has(partnerPubkey)) {
                        fetchedProfiles.current.add(partnerPubkey);
                        nostrService.getProfile(partnerPubkey).then(profile => {
                            if (profile) {
                                setProfiles(prev => ({ ...prev, [partnerPubkey]: profile }));
                            }
                        });
                    }

                    const dm = {
                        id: giftWrapEvent.id,
                        content: rumor.content,
                        created_at: rumor.created_at,
                        senderPubkey: sealPubkey,
                        partnerPubkey,
                        isSender,
                    };

                    setMessages(prev => {
                        if (prev.find(m => m.id === dm.id)) return prev;
                        // Replace optimistic pending message with the real relay-delivered one
                        if (dm.isSender) {
                            const pendingIdx = prev.findIndex(m =>
                                m.id.startsWith('pending-') &&
                                m.content === dm.content &&
                                m.partnerPubkey === dm.partnerPubkey
                            );
                            if (pendingIdx !== -1) {
                                const updated = [...prev];
                                updated[pendingIdx] = dm;
                                return updated;
                            }
                            // Safety net: if a relay-delivered copy with the same
                            // content + partner + close timestamp already exists,
                            // drop this duplicate (handles edge-case race conditions).
                            const alreadyDelivered = prev.some(m =>
                                !m.id.startsWith('pending-') &&
                                m.isSender &&
                                m.content === dm.content &&
                                m.partnerPubkey === dm.partnerPubkey &&
                                Math.abs(m.created_at - dm.created_at) < 2
                            );
                            if (alreadyDelivered) return prev;
                        }
                        return [...prev, dm].sort((a, b) => a.created_at - b.created_at);
                    });

                    // Fire notification callback for received (not sent) messages
                    if (!dm.isSender) {
                        onIncomingRef.current?.(dm);
                    }
                } catch (err) {
                    // Skip messages we can't decrypt (not for us, corrupted, etc.)
                    console.debug('Could not unwrap gift-wrap:', err.message);
                }
            });

        } catch (err) {
            console.error('Failed to connect Nostr DMs:', err);
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, []);

    // Cleanup subscription on unmount
    useEffect(() => {
        return () => {
            if (subRef.current) {
                subRef.current.close();
            }
        };
    }, []);

    const sendMessage = useCallback(async (recipientPubkey, content) => {
        // Add optimistic message BEFORE publishing so it is already in state
        // when the relay echoes the gift-wrap back through the subscription.
        // This prevents the race condition where the echo arrives before the
        // optimistic insert, causing a duplicate.
        const pendingId = 'pending-' + Date.now();
        const dm = {
            id: pendingId,
            content,
            created_at: Math.floor(Date.now() / 1000),
            senderPubkey: publicKey,
            partnerPubkey: recipientPubkey,
            isSender: true,
        };

        setMessages(prev => [...prev, dm]);

        try {
            await nostrService.sendNip17DM(recipientPubkey, content);
        } catch (err) {
            // Remove the optimistic message on send failure
            setMessages(prev => prev.filter(m => m.id !== pendingId));
            throw err;
        }

        return dm;
    }, [publicKey]);

    // Group messages by conversation partner
    const conversations = messages.reduce((acc, msg) => {
        const key = msg.partnerPubkey;
        if (!acc[key]) acc[key] = [];
        acc[key].push(msg);
        return acc;
    }, {});

    return {
        messages,
        conversations,
        profiles,
        loading,
        error,
        connect,
        publicKey,
        sendMessage,
    };
};
