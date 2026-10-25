import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { isNativePlatform } from '../utils/platform';
import { useFeature } from '../context/FeatureFlagsContext';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigationType } from 'react-router-dom';
import { publicUrl } from '../utils/publicUrl';
import { Loader2, Send, Globe, Lock, Zap, TrendingUp, Flame, Clock, Calendar, X, ImagePlus, Smile, RefreshCw, Heart, ChevronDown } from 'lucide-react';
import { nostrService, BIES_RELAY, profileCache } from '../services/nostrService';
import { primalService, EXPLORE_VIEWS } from '../services/primalService';
import { nostrSigner } from '../services/nostrSigner';
import { mediaService } from '../services/mediaService';
import { useAuth } from '../context/AuthContext';
import { notificationsApi, profilesApi, uploadApi } from '../services/api';
import { getAssetUrl } from '../utils/assets';
import NostrIcon from '../components/NostrIcon';
import ZapModal from '../components/ZapModal';
import EmojiPicker from '../components/EmojiPicker';
import NostrGifPicker from '../components/NostrGifPicker';
import { useLightbox } from '../context/LightboxContext';
import { nip19 } from 'nostr-tools';
import { cachedFeed, rememberFeed, feedCacheKey } from '../utils/feedCache';
import { feedPostOf, addFeedPosts, mergePosts as mergeFeedPosts, tallyCounts, markIds } from '../utils/feedPosts';
import { Note, FeedSkeleton, Paginator } from '../components/feed';
import { formatTime as formatTimeUtil, parseNoteContent as parseNoteContentUtil, getDisplayName as getDisplayNameUtil } from '../utils/noteUtils';
import '../components/feed/Feed.css';
import { useBlocks, useMuted } from '../hooks/useBlocks';
import { mute } from '../services/muteStore';
import { useModerationDialogs } from '../components/moderation/useModerationDialogs';

const EXPLORE_ICONS = {
    trending_24h: TrendingUp,
    trending_4h: Flame,
    trending_48h: Calendar,
    trending_7d: TrendingUp,
    mostzapped: Zap,
    popular: Heart,
    latest: Clock,
};

function formatCount(n) {
    if (!n) return '0';
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
}

function formatSats(n) {
    if (!n) return '0';
    if (n >= 100000000) return (n / 100000000).toFixed(2).replace(/\.?0+$/, '') + ' BTC';
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
}

/** The post a shared link names (?post=note1…, or a hex id), as a hex id. */
function sharedPostId(search) {
    const value = new URLSearchParams(search).get('post');
    if (!value) return null;
    if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
    try {
        const decoded = nip19.decode(value);
        if (decoded.type === 'note') return decoded.data;
        if (decoded.type === 'nevent') return decoded.data.id;
    } catch { /* not a post id */ }
    return null;
}

/**
 * The BIES feed. With `author` (a hex pubkey) it is one member's posts and
 * reposts, embedded in their profile: no header or tabs, the same cards,
 * likes, reposts, replies and menus. `showCompose` keeps the post box,
 * `emptyText` replaces the empty message, and `onPosts(posts, loading)`
 * hands the posts to the page (the profile's Photos tab).
 */
// Members' BIES names and photos, kept on this device for a day so the feed
// shows them at once next time; each visit looks them up again anyway.
const MEMBER_NAMES_KEY = 'bies_member_names';
const MEMBER_NAMES_TTL = 24 * 3600 * 1000;

function readMemberNames() {
    try {
        const stored = JSON.parse(localStorage.getItem(MEMBER_NAMES_KEY) || '{}');
        const since = Date.now() - MEMBER_NAMES_TTL;
        return Object.fromEntries(Object.entries(stored)
            .filter(([, m]) => m && m.ts > since && typeof m.name === 'string')
            .map(([pk, m]) => [pk, { name: m.name, avatar: m.avatar || '' }]));
    } catch {
        return {};
    }
}

function keepMemberNames(found) {
    try {
        const stored = JSON.parse(localStorage.getItem(MEMBER_NAMES_KEY) || '{}');
        const now = Date.now();
        for (const [pk, m] of Object.entries(found)) stored[pk] = { name: m.name, avatar: m.avatar, ts: now };
        for (const pk of Object.keys(stored)) if (!(stored[pk]?.ts > now - MEMBER_NAMES_TTL)) delete stored[pk];
        localStorage.setItem(MEMBER_NAMES_KEY, JSON.stringify(stored));
    } catch { /* storage full or off: they're looked up each time */ }
}

// The feed opens with the newest 50 events; counts are asked 50 posts at a time.
const FEED_PAGE = 50;
// Posts drawn in the first pass, about a screen and a half; the rest follow.
const FIRST_DRAW = 15;
// A kept feed asks again from 10 minutes before its newest event, so a post
// from a phone whose clock is a little behind isn't skipped; posts already
// shown are not added twice.
const SINCE_OVERLAP = 600;

const Feed = ({ author = null, showCompose = true, emptyText, onPosts } = {}) => {
    const embedded = !!author;
    const { user } = useAuth();
    const accountId = user?.id;
    // Members this member blocked: their posts and comments are hidden here.
    const blocks = useBlocks();
    const { t } = useTranslation();
    const location = useLocation();
    const [posts, setPosts] = useState([]);
    // Nostr profiles (kind 0) of who appears here, from the relays or the cache.
    const [nostrProfiles, setProfiles] = useState({});
    // Members' own BIES names and photos (POST /profiles/lookup). They win
    // over a Nostr profile, which can be missing from the BIES relay, an old
    // copy, or what the member's other Nostr apps say.
    const [members, setMembers] = useState(readMemberNames);
    const lookedUp = useRef(new Set());
    const profiles = useMemo(() => {
        const keys = Object.keys(members);
        if (keys.length === 0) return nostrProfiles;
        const merged = { ...nostrProfiles };
        for (const pk of keys) {
            const { name, avatar } = members[pk];
            merged[pk] = { ...nostrProfiles[pk], name, display_name: name, ...(avatar ? { picture: getAssetUrl(avatar) } : {}) };
        }
        return merged;
    }, [nostrProfiles, members]);
    const [noteStats, setNoteStats] = useState({});
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [feedMode, setFeedMode] = useState('private'); // 'private' | 'explore'
    // The store app shows only the BIES private feed: Explore is the open
    // Nostr network, which BIES doesn't moderate (App Review guideline 1.2).
    const exploreAllowed = !isNativePlatform();
    const zapsOn = useFeature('zaps');
    const [exploreView, setExploreView] = useState('trending_24h');
    const [exploreDropdownOpen, setExploreDropdownOpen] = useState(false);
    const exploreDropdownRef = useRef(null);
    const [refreshKey, setRefreshKey] = useState(0);
    const [refreshing, setRefreshing] = useState(false);
    const fetchedProfiles = useRef(new Set());
    // This view of the BIES feed (the members' feed, or one member's posts),
    // and the view whose load has finished: its counts are asked for, and it
    // is kept for next time (utils/feedCache.js), only once the two match.
    const feedKey = feedMode === 'private' ? feedCacheKey(accountId, author) : null;
    const [readyKey, setReadyKey] = useState(null);

    // Re-subscribe to the private relay when the page regains visibility.
    // Mobile browsers kill WebSocket connections when backgrounded; the pool
    // can't detect the dead WebSocket until a TCP timeout fires (seconds to
    // minutes).  Force-closing the relay drops the stale connection so the
    // next subscribeMany creates a fresh WebSocket and re-authenticates.
    useEffect(() => {
        const onVisible = () => {
            if (document.visibilityState === 'visible' && feedMode === 'private') {
                nostrService.pool.close([BIES_RELAY]);
                setRefreshKey(k => k + 1);
            }
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => document.removeEventListener('visibilitychange', onVisible);
    }, [feedMode]);

    // Close explore dropdown on click outside
    useEffect(() => {
        const handleClickOutside = (e) => {
            if (exploreDropdownRef.current && !exploreDropdownRef.current.contains(e.target)) {
                setExploreDropdownOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // Compose state
    const [composeText, setComposeText] = useState('');
    const [broadcastPublic, setBroadcastPublic] = useState(false);
    const manualRelayToggle = useRef(false);

    // Sync compose relay default to match feed tab (user can still override)
    useEffect(() => {
        if (!manualRelayToggle.current) {
            setBroadcastPublic(feedMode === 'explore');
        }
        manualRelayToggle.current = false;
    }, [feedMode]);
    const [posting, setPosting] = useState(false);
    const [postError, setPostError] = useState('');
    const [attachedFiles, setAttachedFiles] = useState([]); // { file, previewUrl, type, dimensions }
    const [uploading, setUploading] = useState(false);
    const fileInputRef = useRef(null);

    // Interaction state
    const [likedNotes, setLikedNotes] = useState(new Set());
    // My like's event id per note or comment, so a second tap can undo it.
    const myReactionIds = useRef(new Map());
    const [repostedNotes, setRepostedNotes] = useState(new Set());
    const [replyTarget, setReplyTarget] = useState(null);
    const [replyText, setReplyText] = useState('');
    const [replyPosting, setReplyPosting] = useState(false);
    const [zapTarget, setZapTarget] = useState(null);
    const [myPubkey, setMyPubkey] = useState(null);
    const [repostMenu, setRepostMenu] = useState(null); // post.id or null — shows repost relay choice
    const [postMenu, setPostMenu] = useState(null); // post.id or null — shows "..." menu
    const [deletingPost, setDeletingPost] = useState(null); // post.id being deleted
    const [copyToast, setCopyToast] = useState(null); // toast message string

    // Mention autocomplete
    const [mentionResults, setMentionResults] = useState([]);
    const [mentionLoading, setMentionLoading] = useState(false);
    const [mentionAnchor, setMentionAnchor] = useState(null); // { field: 'compose'|'reply', startIndex }
    const mentionSearchTimer = useRef(null);

    // Comment section state
    const [openComments, setOpenComments] = useState(new Set());
    const [comments, setComments] = useState({});
    const [loadingComments, setLoadingComments] = useState({});
    const [visibleCommentCount, setVisibleCommentCount] = useState({});
    const [likedComments, setLikedComments] = useState(new Set());
    const fetchedComments = useRef(new Set());

    // Emoji & GIF picker state
    const [showEmojiPicker, setShowEmojiPicker] = useState(false);
    const [showGifPicker, setShowGifPicker] = useState(false);
    const [commentEmojiPicker, setCommentEmojiPicker] = useState(null); // post.id or null
    const [commentGifPicker, setCommentGifPicker] = useState(null); // post.id or null
    const composeInputRef = useRef(null);
    const commentInputRefs = useRef({});

    const currentView = EXPLORE_VIEWS.find(v => v.key === exploreView) || EXPLORE_VIEWS[0];

    // Fetch own pubkey once on mount for reaction persistence and notifications
    const myPubkeyRef = useRef(null);
    useEffect(() => {
        nostrSigner.getPublicKey().then(pk => {
            setMyPubkey(pk);
            myPubkeyRef.current = pk;
            if (pk && !fetchedProfiles.current.has(pk)) {
                fetchedProfiles.current.add(pk);
                nostrService.getProfile(pk).then(p => {
                    if (p) setProfiles(prev => ({ ...prev, [pk]: p }));
                });
            }
        }).catch(() => {});
    }, []);

    // Sort notes based on the current explore view
    const sortNotes = useCallback((notes, stats, viewKey) => {
        const view = EXPLORE_VIEWS.find(v => v.key === viewKey);
        if (!view) return notes;

        return [...notes].sort((a, b) => {
            const sa = stats[a.id] || {};
            const sb = stats[b.id] || {};

            if (view.timeframe === 'trending') {
                return (sb.score24h || 0) - (sa.score24h || 0);
            } else if (view.timeframe === 'popular') {
                return (sb.score || 0) - (sa.score || 0);
            } else if (view.timeframe === 'mostzapped') {
                return (sb.satszapped || 0) - (sa.satszapped || 0);
            }
            return b.created_at - a.created_at;
        });
    }, []);

    // Where the walk back through older posts is (loadOlderPrivate): the
    // oldest event received, the page it reached, and whether it's done.
    const olderUntil = useRef(null);
    const oldestReceived = useRef(null);
    const [olderDone, setOlderDone] = useState(false);

    // Likes, reposts and replies of the BIES feed's posts, and which ones I
    // liked or reposted: one query per batch of posts, the first once the
    // feed has loaded (every post it shows at once), then the posts that come
    // later (live, older pages, a shared post). Each query runs to its end; a
    // reload of the feed starts again. The BIES relay only: asking public
    // relays would hand them the ids of members-only posts (and the member's
    // sign-in, if one asked).
    const countsAsked = useRef(new Set());
    const countQueries = useRef(new Set());
    const countsRound = useRef(0);
    // When my own like, repost or reply last changed a post's counts here:
    // a query sent before that doesn't overwrite them.
    const countsTouched = useRef(new Map());
    const touchCounts = (id) => countsTouched.current.set(id, Date.now());
    const stopCountQueries = () => {
        countsRound.current++;
        for (const query of countQueries.current) query.close();
        countQueries.current.clear();
    };
    const askCounts = (batch) => {
        const ids = batch.map(p => p.id);
        ids.forEach(id => countsAsked.current.add(id));
        const round = countsRound.current;
        const sentAt = Date.now();
        const events = [];
        let finished = false;
        const query = nostrService.pool.subscribeMany(
            [BIES_RELAY],
            { kinds: [7, 6, 1, 5], '#e': ids, limit: 2000 },
            {
                onevent: (event) => events.push(event),
                oneose: async () => {
                    finished = true;
                    query.close();
                    const me = myPubkeyRef.current || await nostrSigner.getPublicKey().catch(() => null);
                    if (round !== countsRound.current) return;
                    const fresh = ids.filter(id => !(countsTouched.current.get(id) >= sentAt));
                    const { stats, liked, reposted, deleted } = tallyCounts(events, batch, me);
                    setNoteStats(prev => {
                        const next = { ...prev };
                        for (const id of fresh) next[id] = { ...prev[id], ...stats[id] };
                        return next;
                    });
                    if (me) {
                        setLikedNotes(prev => markIds(prev, fresh, liked));
                        setRepostedNotes(prev => markIds(prev, fresh, reposted));
                    }
                    // Posts their authors deleted since this feed was kept.
                    if (deleted.size) {
                        if (deleted.has(sharedPost.current?.id)) sharedPost.current = null;
                        setPosts(prev => prev.filter(p => !deleted.has(p.id)));
                    }
                },
                onclose: () => {
                    countQueries.current.delete(query);
                    // Closed by the relay before its end: asked again with the next posts.
                    if (!finished && round === countsRound.current) ids.forEach(id => countsAsked.current.delete(id));
                },
                onauth: relayAuth,
            }
        );
        countQueries.current.add(query);
    };

    // Subscribe to private relay feed. A view of it shown before in this
    // session comes back at once from memory (utils/feedCache.js), and the
    // relay is asked only for what's newer than its newest event; otherwise
    // the newest 50.
    const reconnectAttempts = useRef(0);
    const newestReceived = useRef(null);

    useEffect(() => {
        if (feedMode !== 'private') return;

        const key = feedCacheKey(accountId, author);
        const kept = cachedFeed(key);
        const since = kept?.newest ? kept.newest - SINCE_OVERLAP : null;
        setPosts(kept?.posts || []);
        setProfiles(kept?.profiles || {});
        setNoteStats(kept?.stats || {});
        if (kept) {
            setLikedNotes(kept.liked);
            setRepostedNotes(kept.reposted);
        }
        setComments({});
        setOpenComments(new Set());
        setLoading(!kept);
        setReadyKey(null);
        fetchedProfiles.current.clear();
        fetchedComments.current.clear();
        countsAsked.current.clear();
        oldestReceived.current = kept?.oldest ?? null;
        newestReceived.current = kept?.newest ?? null;
        olderUntil.current = kept?.olderUntil ?? null;
        setOlderDone(kept?.olderDone || false);

        let cancelled = false;
        let reconnectTimer = null;
        let sub = null;
        let timeout = null;

        // Collect pubkeys during streaming, batch-fetch profiles after EOSE.
        // Post-EOSE live arrivals are debounced (300ms) and batched too. The
        // kept posts' people are looked up again, as a first load would.
        const preEosePubkeys = (kept?.posts || []).flatMap(p => [p.pubkey, ...(p._reposters || []).map(r => r.pubkey)]);
        const liveQueue = new Set();
        let debounceTimer = null;
        let eoseFired = false;
        // Events this load received before EOSE, and the oldest of them.
        let received = 0;
        let receivedOldest = null;

        // New posts join the list once per frame, not one render per event.
        let pending = [];
        let flushFrame = 0;
        const flush = () => {
            cancelAnimationFrame(flushFrame);
            flushFrame = 0;
            if (pending.length === 0) return;
            const batch = pending;
            pending = [];
            setPosts(prev => addFeedPosts(prev, batch));
            clearTimeout(timeout);
            setLoading(false);
        };

        const flushLiveProfiles = async () => {
            if (liveQueue.size === 0) return;
            const toFetch = [...liveQueue].filter(pk => !fetchedProfiles.current.has(pk));
            toFetch.forEach(pk => fetchedProfiles.current.add(pk));
            liveQueue.clear();
            if (toFetch.length === 0) return;
            const profileMap = await nostrService.getProfiles(toFetch, [BIES_RELAY]);
            if (profileMap.size > 0) {
                setProfiles(prev => {
                    const next = { ...prev };
                    for (const [pk, p] of profileMap) next[pk] = p;
                    return next;
                });
            }
        };

        // Ensure the signer is ready before subscribing so the NIP-42
        // AUTH handshake can complete immediately (prevents proxy timeout).
        const startSubscription = async () => {
            try {
                await nostrSigner.tryRestore();
            } catch {
                // Signer restore failed — subscribe anyway; the relay may
                // still work if the extension is available.
            }

            if (cancelled) return;

            timeout = setTimeout(() => setLoading(false), 15000);

            sub = nostrService.pool.subscribeMany(
                [BIES_RELAY],
                {
                    kinds: [1, 6], limit: FEED_PAGE,
                    ...(since ? { since } : {}),
                    ...(author ? { authors: [author] } : {}),
                },
                {
                    onevent: (event) => {
                        // Older pages start before the oldest event received,
                        // replies and reposts included (loadOlderPrivate).
                        if (oldestReceived.current === null || event.created_at < oldestReceived.current) oldestReceived.current = event.created_at;
                        // The newest no later than now: a post dated ahead
                        // (a phone's clock) mustn't move the next `since` past
                        // posts made in between.
                        const seenAt = Math.min(event.created_at, Math.floor(Date.now() / 1000));
                        if (newestReceived.current === null || seenAt > newestReceived.current) newestReceived.current = seenAt;
                        if (!eoseFired) {
                            received++;
                            if (receivedOldest === null || event.created_at < receivedOldest) receivedOldest = event.created_at;
                        }

                        // Root notes and reposts (deduplicated by the original
                        // note's id); replies and machine-generated events are skipped.
                        const post = feedPostOf(event);
                        if (!post) return;
                        pending.push(post);
                        if (!flushFrame) flushFrame = requestAnimationFrame(flush);

                        for (const pk of [post.pubkey, ...(post._reposters || []).map(r => r.pubkey)]) {
                            if (fetchedProfiles.current.has(pk)) continue;
                            if (!eoseFired) {
                                preEosePubkeys.push(pk);
                            } else {
                                liveQueue.add(pk);
                                clearTimeout(debounceTimer);
                                debounceTimer = setTimeout(flushLiveProfiles, 300);
                            }
                        }
                    },
                    oneose: async () => {
                        eoseFired = true;
                        flush();
                        // A full page of newer events: there may be more
                        // between them and the kept posts, so rather than
                        // leave a gap the feed goes on from these, as a
                        // first load would.
                        if (kept && received >= FEED_PAGE) {
                            setPosts(prev => prev.filter(p => (p._repostTime || p.created_at) >= receivedOldest));
                            oldestReceived.current = receivedOldest;
                            olderUntil.current = null;
                            setOlderDone(false);
                        }
                        reconnectAttempts.current = 0; // Reset backoff on success
                        setLoading(false);
                        setReadyKey(key);
                        if (author) setAuthorLoadedAt(Date.now());
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

                        // Fetch from BIES relay only (local, fast)
                        const profileMap = await nostrService.getProfiles(toFetch, [BIES_RELAY]);
                        if (profileMap.size > 0) {
                            setProfiles(prev => {
                                const next = { ...prev };
                                for (const [pk, p] of profileMap) next[pk] = p;
                                return next;
                            });
                        }
                    },
                    onclose: () => {
                        setLoading(false);
                        // Auto-reconnect with exponential backoff
                        // (nginx timeout, mobile network switch, cell handoff).
                        if (!cancelled) {
                            const attempt = reconnectAttempts.current;
                            const delay = Math.min(2000 * Math.pow(2, attempt), 30000);
                            reconnectAttempts.current = attempt + 1;
                            console.log(`[Feed] Relay closed, reconnecting in ${delay}ms (attempt ${attempt + 1})`);
                            reconnectTimer = setTimeout(() => {
                                setRefreshKey(k => k + 1);
                            }, delay);
                        }
                    },
                    onauth: async (evt) => {
                        try {
                            return await nostrSigner.signEvent(evt);
                        } catch {
                            return undefined;
                        }
                    },
                }
            );
        };

        startSubscription();

        return () => {
            cancelled = true;
            clearTimeout(timeout);
            clearTimeout(debounceTimer);
            clearTimeout(reconnectTimer);
            cancelAnimationFrame(flushFrame);
            if (sub) sub.close();
            stopCountQueries();
        };
    }, [feedMode, refreshKey, author, accountId]);

    // Counts for the posts not asked about yet, once the feed has loaded.
    // Posts that arrive together (the first load, a page of older posts)
    // share a query.
    useEffect(() => {
        if (!feedKey || readyKey !== feedKey) return undefined;
        const toAsk = posts.filter(p => !countsAsked.current.has(p.id));
        if (toAsk.length === 0) return undefined;
        const timer = setTimeout(() => {
            for (let i = 0; i < toAsk.length; i += FEED_PAGE) askCounts(toAsk.slice(i, i + FEED_PAGE));
        }, 0);
        return () => clearTimeout(timer);
    }, [feedKey, readyKey, posts]);

    // Keep this view of the feed for next time (utils/feedCache.js), once
    // it has loaded.
    useEffect(() => {
        if (!feedKey || readyKey !== feedKey) return;
        rememberFeed(feedKey, {
            posts,
            profiles: nostrProfiles,
            stats: noteStats,
            liked: likedNotes,
            reposted: repostedNotes,
            newest: newestReceived.current,
            oldest: oldestReceived.current,
            olderUntil: olderUntil.current,
            olderDone,
        });
    }, [feedKey, readyKey, posts, nostrProfiles, noteStats, likedNotes, repostedNotes, olderDone]);

    // The BIES members among who appears on the BIES feed (authors, reposters,
    // repliers): their BIES names and photos, a hundred at a time.
    useEffect(() => {
        if (feedMode !== 'private') return undefined;
        const shown = new Set();
        for (const post of posts) {
            shown.add(post.pubkey);
            for (const r of post._reposters || []) shown.add(r.pubkey);
        }
        for (const list of Object.values(comments)) for (const c of list || []) shown.add(c.pubkey);
        const toLookUp = [...shown].filter((pk) => /^[0-9a-f]{64}$/.test(pk || '') && !lookedUp.current.has(pk));
        if (toLookUp.length === 0) return undefined;
        const timer = setTimeout(() => {
            toLookUp.forEach((pk) => lookedUp.current.add(pk));
            for (let i = 0; i < toLookUp.length; i += 100) {
                const batch = toLookUp.slice(i, i + 100);
                profilesApi.lookup(batch)
                    .then((res) => {
                        if (res?.data && Object.keys(res.data).length > 0) {
                            setMembers((prev) => ({ ...prev, ...res.data }));
                            keepMemberNames(res.data);
                        }
                    })
                    .catch(() => batch.forEach((pk) => lookedUp.current.delete(pk))); // tried again next time
            }
        }, 150);
        return () => clearTimeout(timer);
    }, [feedMode, posts, comments]);

    // Ensure profiles are loaded for repost authors (catches missed/failed fetches)
    const repostProfileRetries = useRef(new Set());
    useEffect(() => {
        const missing = posts
            .flatMap(p => (p._reposters || []).map(r => r.pubkey))
            .filter(pk => !profiles[pk]);
        const unique = [...new Set(missing)].filter(pk => !repostProfileRetries.current.has(pk));
        if (unique.length === 0) return;
        unique.forEach(pk => repostProfileRetries.current.add(pk));
        nostrService.getProfiles(unique).then(profileMap => {
            if (profileMap.size > 0) {
                setProfiles(prev => {
                    const next = { ...prev };
                    for (const [pk, p] of profileMap) next[pk] = p;
                    return next;
                });
            }
        });
    }, [posts, profiles]);

    // Fetch explore feed from Primal
    useEffect(() => {
        if (feedMode !== 'explore') return;

        let cancelled = false;
        setPosts([]);
        setProfiles({});
        setNoteStats({});
        setComments({});
        setOpenComments(new Set());
        setLoading(true);
        setReadyKey(null);
        fetchedComments.current.clear();

        (async () => {
            try {
                const opts = { limit: 30 };
                if (myPubkey) opts.userPubkey = myPubkey;
                const result = await primalService.fetchExploreFeed(currentView, opts);
                if (cancelled) return;

                setProfiles(result.profiles);
                setNoteStats(result.stats);
                setPosts(sortNotes(result.notes, result.stats, exploreView));

                // Pre-populate liked/reposted state from Primal actions
                if (result.actions) {
                    const liked = new Set();
                    const reposted = new Set();
                    for (const [eventId, action] of Object.entries(result.actions)) {
                        if (action.liked) liked.add(eventId);
                        if (action.reposted) reposted.add(eventId);
                    }
                    if (liked.size) setLikedNotes(prev => new Set([...prev, ...liked]));
                    if (reposted.size) setRepostedNotes(prev => new Set([...prev, ...reposted]));
                }
            } catch (err) {
                console.error('[Feed] Primal fetch failed:', err);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();

        return () => { cancelled = true; };
    }, [feedMode, exploreView, currentView, sortNotes, refreshKey]);

    const mergePosts = (events) => setPosts(prev => mergeFeedPosts(prev, events));
    const relayAuth = async (evt) => { try { return await nostrSigner.signEvent(evt); } catch { return undefined; } };
    const ensureProfiles = useCallback(async (pubkeys) => {
        const toFetch = [...new Set(pubkeys)].filter(pk => pk && !fetchedProfiles.current.has(pk));
        if (!toFetch.length) return;
        toFetch.forEach(pk => fetchedProfiles.current.add(pk));
        const map = await nostrService.getProfiles(toFetch, [BIES_RELAY]).catch(() => new Map());
        if (map.size) setProfiles(prev => { const next = { ...prev }; for (const [pk, pr] of map) next[pk] = pr; return next; });
    }, []);

    // Older posts in the BIES feed, page by page (the feed opens with the
    // newest 50). Pages start before the oldest event received, replies and
    // reposts included, so a page of replies, or a repost of an old note,
    // doesn't stop or skip the walk back (olderUntil, oldestReceived, above).
    const loadOlderPrivate = async () => {
        if (olderDone || loadingMore) return;
        const start = olderUntil.current ?? oldestReceived.current;
        if (start === null) return;
        setLoadingMore(true);
        try {
            // Up to 5 pages, until about 10 more posts show or the relay
            // has no more (a member who mostly replies has few per page).
            let until = start - 1;
            let shown = 0;
            for (let page = 0; page < 5 && shown < 10; page++) {
                const events = await nostrService.pool.querySync([BIES_RELAY], { kinds: [1, 6], until, limit: 40, ...(author ? { authors: [author] } : {}) }, { onauth: relayAuth });
                if (!events.length) { setOlderDone(true); break; }
                const oldest = Math.min(...events.map(e => e.created_at));
                olderUntil.current = oldest;
                until = oldest - 1;
                const found = events.map(feedPostOf).filter(Boolean);
                mergePosts(found);
                ensureProfiles(found.flatMap(e => [e.pubkey, ...(e._reposters || []).map(r => r.pubkey)]));
                shown += found.length;
            }
        } catch (err) {
            console.error('[Feed] Loading older posts failed:', err);
        } finally {
            setLoadingMore(false);
        }
    };
    // A profile's posts: when the newest events held few posts (the member
    // mostly replies), fetch older ones at once rather than say "No posts yet".
    const [authorLoadedAt, setAuthorLoadedAt] = useState(0);
    useEffect(() => {
        if (author && authorLoadedAt && posts.length < 10) loadOlderPrivate();
    }, [authorLoadedAt]);

    // Load more: older BIES posts, or more of the explore feed
    const handleLoadMore = async () => {
        if (feedMode === 'private') { if (!loadingMore) await loadOlderPrivate(); return; }
        if (loadingMore || feedMode !== 'explore' || posts.length === 0) return;
        setLoadingMore(true);
        try {
            const opts = { limit: 20 };
            if (myPubkey) opts.userPubkey = myPubkey;
            const result = await primalService.loadMore(currentView, posts, noteStats, opts);
            if (result.notes.length > 0) {
                setProfiles(prev => ({ ...prev, ...result.profiles }));
                setNoteStats(prev => {
                    const merged = { ...prev, ...result.stats };
                    const allNotes = [...posts, ...result.notes];
                    const deduped = allNotes.filter((n, i, arr) => arr.findIndex(x => x.id === n.id) === i);
                    setPosts(sortNotes(deduped, merged, exploreView));
                    return merged;
                });
                // Pre-populate liked/reposted for new posts
                if (result.actions) {
                    const liked = new Set();
                    const reposted = new Set();
                    for (const [eventId, action] of Object.entries(result.actions)) {
                        if (action.liked) liked.add(eventId);
                        if (action.reposted) reposted.add(eventId);
                    }
                    if (liked.size) setLikedNotes(prev => new Set([...prev, ...liked]));
                    if (reposted.size) setRepostedNotes(prev => new Set([...prev, ...reposted]));
                }
            }
        } catch (err) {
            console.error('[Feed] Load more failed:', err);
        } finally {
            setLoadingMore(false);
        }
    };

    // Refresh feed — bumps refreshKey to re-trigger subscription/fetch effects.
    // Force-close the relay first so the pool drops any stale WebSocket and
    // establishes a fresh authenticated connection.
    const handleRefreshFeed = useCallback(() => {
        if (loading || refreshing) return;
        setRefreshing(true);
        if (feedMode === 'private') {
            nostrService.pool.close([BIES_RELAY]);
        }
        setRefreshKey(k => k + 1);
        setTimeout(() => setRefreshing(false), 1500);
    }, [loading, refreshing, feedMode]);

    const handleFileSelect = async (e) => {
        const files = Array.from(e.target.files || []);
        e.target.value = '';
        setPostError('');

        const newAttachments = [];
        for (const file of files) {
            const err = mediaService.validateFile(file, attachedFiles.length + newAttachments.length)
                || await mediaService.validateVideoLength(file);
            if (err) {
                setPostError(err);
                break;
            }
            const dimensions = await mediaService.getImageDimensions(file);
            newAttachments.push({
                file,
                previewUrl: URL.createObjectURL(file),
                type: file.type,
                dimensions,
            });
        }

        if (newAttachments.length > 0) {
            setAttachedFiles(prev => [...prev, ...newAttachments]);
        }
    };

    const removeAttachment = (index) => {
        setAttachedFiles(prev => {
            const updated = [...prev];
            URL.revokeObjectURL(updated[index].previewUrl);
            updated.splice(index, 1);
            return updated;
        });
    };

    const handlePost = async () => {
        if ((!composeText.trim() && attachedFiles.length === 0) || posting || uploading) return;

        if (!nostrSigner.hasKey && nostrSigner.mode !== 'extension' && !nostrSigner.storedMethod && !window.nostr) {
            setPostError('Nostr signing not available. Please log in with your Nostr account to post.');
            return;
        }

        setPosting(true);
        setPostError('');

        try {
            let content = composeText.trim();
            const tags = [['t', 'bies']];

            if (attachedFiles.length > 0) {
                setUploading(true);
                const uploadResults = await Promise.all(
                    attachedFiles.map(a => mediaService.uploadFile(a.file))
                );

                const urls = uploadResults.map(r => r.url);
                if (content) content += '\n';
                content += urls.join('\n');

                uploadResults.forEach((result, i) => {
                    tags.push(mediaService.buildImetaTag(result, attachedFiles[i].dimensions));
                });
            }

            const event = {
                kind: 1,
                created_at: Math.floor(Date.now() / 1000),
                tags,
                content,
            };

            // Sign the event first so we can add it to the feed optimistically
            const signedEvent = await nostrSigner.signEvent(event);

            if (broadcastPublic) {
                await Promise.any(nostrService.pool.publish(nostrService.relays, signedEvent));
            } else {
                await Promise.any(nostrService.pool.publish([BIES_RELAY], signedEvent));
            }

            // Optimistically add to feed so the user sees it immediately
            setPosts(prev => {
                if (prev.find(p => p.id === signedEvent.id)) return prev;
                return [signedEvent, ...prev];
            });

            setComposeText('');
            attachedFiles.forEach(a => URL.revokeObjectURL(a.previewUrl));
            setAttachedFiles([]);
        } catch (err) {
            console.error('[Feed] Post failed:', err);
            const msg = err?.errors?.[0]?.message || err?.message || String(err);
            setPostError(`Post failed: ${msg}`);
        } finally {
            setPosting(false);
            setUploading(false);
        }
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handlePost();
        }
    };

    // Insert emoji at cursor in compose textarea
    const handleComposeEmoji = (emoji) => {
        const el = composeInputRef.current;
        if (el) {
            const start = el.selectionStart;
            const end = el.selectionEnd;
            const newText = composeText.slice(0, start) + emoji + composeText.slice(end);
            setComposeText(newText);
            requestAnimationFrame(() => {
                el.selectionStart = el.selectionEnd = start + emoji.length;
                el.focus();
            });
        } else {
            setComposeText(prev => prev + emoji);
        }
    };

    // Insert emoji at cursor in comment textarea
    const handleCommentEmoji = (postId, emoji) => {
        const el = commentInputRefs.current[postId];
        if (el) {
            const start = el.selectionStart;
            const end = el.selectionEnd;
            const current = (replyTarget?.id === postId ? replyText : '');
            const newText = current.slice(0, start) + emoji + current.slice(end);
            setReplyTarget({ id: postId, pubkey: replyTarget?.pubkey });
            setReplyText(newText);
            requestAnimationFrame(() => {
                el.selectionStart = el.selectionEnd = start + emoji.length;
                el.focus();
            });
        } else {
            setReplyTarget({ id: postId, pubkey: replyTarget?.pubkey });
            setReplyText(prev => prev + emoji);
        }
        setCommentEmojiPicker(null);
    };

    // Insert GIF URL into compose
    const handleComposeGif = (url) => {
        setComposeText(prev => prev ? prev + '\n' + url : url);
        setShowGifPicker(false);
    };

    // Insert GIF URL into comment
    const handleCommentGif = (postId, postPubkey, url) => {
        setReplyTarget({ id: postId, pubkey: postPubkey });
        setReplyText(prev => prev ? prev + '\n' + url : url);
        setCommentGifPicker(null);
    };

    const bumpLikes = (id, by) => {
        touchCounts(id);
        setNoteStats(prev => ({
            ...prev,
            [id]: { ...prev[id], likes: Math.max(0, (prev[id]?.likes || 0) + by) },
        }));
    };

    // Like a note (kind:7 reaction); tapping again undoes it (a NIP-09
    // deletion of the reaction), as in every social app.
    const handleLike = async (post) => {
        if (!nostrSigner.hasKey && nostrSigner.mode !== 'extension' && !nostrSigner.storedMethod && !window.nostr) return;
        const biesOnly = feedMode === 'private';

        if (likedNotes.has(post.id)) {
            setLikedNotes(prev => { const next = new Set(prev); next.delete(post.id); return next; });
            bumpLikes(post.id, -1);
            try {
                await nostrService.unreact(post.id, { biesOnly, knownIds: [myReactionIds.current.get(post.id)] });
                myReactionIds.current.delete(post.id);
            } catch (err) {
                console.error('[Feed] Unlike failed:', err);
                setLikedNotes(prev => new Set(prev).add(post.id));
                bumpLikes(post.id, 1);
            }
            return;
        }

        try {
            const signed = await nostrSigner.signEvent({
                kind: 7,
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                    ['e', post.id],
                    ['p', post.pubkey],
                ],
                content: '+',
            });
            await nostrService.publishSigned(signed, { biesOnly });
            myReactionIds.current.set(post.id, signed.id);
            setLikedNotes(prev => new Set(prev).add(post.id));
            bumpLikes(post.id, 1);
            // Notify the post author (fire-and-forget)
            if (user) {
                notificationsApi.feedInteraction({
                    type: 'POST_LIKE',
                    targetPubkey: post.pubkey,
                    actorName: myPubkey ? getDisplayName(myPubkey) : '',
                    eventId: post.id,
                });
            }
        } catch (err) {
            console.error('[Feed] Like failed:', err);
        }
    };

    // Repost a note (kind:6) — relay: 'private' | 'public'
    const handleRepost = async (post, relay) => {
        if (repostedNotes.has(post.id)) return;
        if (!nostrSigner.hasKey && nostrSigner.mode !== 'extension' && !nostrSigner.storedMethod && !window.nostr) return;

        setRepostMenu(null);
        try {
            const event = {
                kind: 6,
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                    ['e', post.id, ''],
                    ['p', post.pubkey],
                ],
                content: JSON.stringify(post),
            };
            if (relay === 'private') {
                await nostrService.publishToBiesRelay(event);
            } else {
                await nostrService.publishEvent(event);
            }
            touchCounts(post.id);
            setRepostedNotes(prev => new Set(prev).add(post.id));
            setNoteStats(prev => ({
                ...prev,
                [post.id]: { ...prev[post.id], reposts: (prev[post.id]?.reposts || 0) + 1 },
            }));
        } catch (err) {
            console.error('[Feed] Repost failed:', err);
        }
    };

    // Reply to a note (kind:1 with e/p tags)
    const handleReply = async (post) => {
        if (!replyText.trim() || replyPosting) return;
        if (!nostrSigner.hasKey && nostrSigner.mode !== 'extension' && !nostrSigner.storedMethod && !window.nostr) return;

        setReplyPosting(true);
        try {
            const content = replyText.trim();
            const unsigned = {
                kind: 1,
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                    ['e', post.id, '', 'root'],
                    ['p', post.pubkey],
                ],
                content,
            };
            const signed = await nostrSigner.signEvent(unsigned);
            if (feedMode === 'private') {
                await nostrService.publishToBiesRelay(signed);
            } else {
                await Promise.any(nostrService.pool.publish(nostrService.relays, signed));
            }
            setReplyText('');
            setReplyTarget(null);
            touchCounts(post.id);
            setNoteStats(prev => ({
                ...prev,
                [post.id]: { ...prev[post.id], replies: (prev[post.id]?.replies || 0) + 1 },
            }));

            // Add reply optimistically to local comment cache and open comments
            setComments(prev => {
                const existing = prev[post.id] || [];
                if (existing.find(e => e.id === signed.id)) return prev;
                return { ...prev, [post.id]: [...existing, signed].sort((a, b) => a.created_at - b.created_at) };
            });
            fetchedComments.current.add(post.id);
            setOpenComments(prev => new Set(prev).add(post.id));

            // Notify the post author (fire-and-forget)
            if (user) {
                const actorName = myPubkey ? getDisplayName(myPubkey) : '';
                notificationsApi.feedInteraction({
                    type: 'POST_COMMENT',
                    targetPubkey: post.pubkey,
                    actorName,
                    eventId: post.id,
                    contentPreview: content,
                });
                // If replying to a specific comment, also notify the comment author
                if (replyTarget?.pubkey && replyTarget.pubkey !== post.pubkey) {
                    notificationsApi.feedInteraction({
                        type: 'COMMENT_REPLY',
                        targetPubkey: replyTarget.pubkey,
                        actorName,
                        eventId: post.id,
                        contentPreview: content,
                    });
                }
            }
        } catch (err) {
            console.error('[Feed] Reply failed:', err);
        } finally {
            setReplyPosting(false);
        }
    };

    // Like a comment (kind:7 reaction targeting the comment event); again to undo
    const handleCommentLike = async (comment) => {
        if (!nostrSigner.hasKey && nostrSigner.mode !== 'extension' && !nostrSigner.storedMethod && !window.nostr) return;
        const biesOnly = feedMode === 'private';

        if (likedComments.has(comment.id)) {
            setLikedComments(prev => { const next = new Set(prev); next.delete(comment.id); return next; });
            try {
                await nostrService.unreact(comment.id, { biesOnly, knownIds: [myReactionIds.current.get(comment.id)] });
                myReactionIds.current.delete(comment.id);
            } catch (err) {
                console.error('[Feed] Comment unlike failed:', err);
                setLikedComments(prev => new Set(prev).add(comment.id));
            }
            return;
        }

        try {
            const signed = await nostrSigner.signEvent({
                kind: 7,
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                    ['e', comment.id],
                    ['p', comment.pubkey],
                ],
                content: '+',
            });
            await nostrService.publishSigned(signed, { biesOnly });
            myReactionIds.current.set(comment.id, signed.id);
            setLikedComments(prev => new Set(prev).add(comment.id));
            // Notify the comment author (fire-and-forget)
            if (user) {
                notificationsApi.feedInteraction({
                    type: 'COMMENT_LIKE',
                    targetPubkey: comment.pubkey,
                    actorName: myPubkey ? getDisplayName(myPubkey) : '',
                    eventId: comment.id,
                });
            }
        } catch (err) {
            console.error('[Feed] Comment like failed:', err);
        }
    };

    // Reply to a comment — prefill the textarea with @npub and focus it
    const handleCommentReply = (postId, comment) => {
        const npub = nip19.npubEncode(comment.pubkey);
        const mention = `nostr:${npub} `;
        setReplyTarget({ id: postId, pubkey: comment.pubkey });
        setReplyText(mention);
        // Focus the textarea for this post
        setTimeout(() => {
            const el = commentInputRefs.current[postId];
            if (el) {
                el.focus();
                el.setSelectionRange(mention.length, mention.length);
            }
        }, 50);
    };

    // Brief copy-confirmation toast
    const showToast = (msg) => {
        setCopyToast(msg);
        setTimeout(() => setCopyToast(null), 2000);
    };

    // A post's link: a BIES post opens in the BIES Feed (for members; others
    // sign in first), a public one on njump.me. Only the link is shared, not
    // the text of a members-only post.
    const postUrl = (post) => {
        const noteId = nip19.noteEncode(post.id);
        return feedMode === 'explore' ? `https://njump.me/${noteId}` : publicUrl(`/feed?post=${noteId}`);
    };

    // Share a note
    const handleShare = async (post) => {
        const url = postUrl(post);
        if (navigator.share) {
            try {
                await navigator.share({ url });
            } catch { /* cancelled */ }
        } else {
            await navigator.clipboard.writeText(url);
            showToast(t('feed.linkCopied', 'Link copied'));
        }
    };

    // NIP-09: Request delete — publishes a kind:5 event referencing the target event
    const handleDeletePost = async (post) => {
        if (!nostrSigner.hasKey && nostrSigner.mode !== 'extension' && !nostrSigner.storedMethod && !window.nostr) return;
        setPostMenu(null);
        setDeletingPost(post.id);
        try {
            const event = {
                kind: 5,
                created_at: Math.floor(Date.now() / 1000),
                tags: [['e', post.id]],
                content: 'Request delete',
            };
            // A private post's deletion stays on the BIES relay; a public one
            // goes to every relay.
            if (feedMode === 'private') {
                await nostrService.publishToBiesRelay(event);
            } else {
                await nostrService.publishEvent(event);
                try { await nostrService.publishToBiesRelay(event); } catch { /* best-effort */ }
            }
            // Remove from local feed (and don't put it back as a shared post)
            if (sharedPost.current?.id === post.id) sharedPost.current = null;
            setPosts(prev => prev.filter(p => p.id !== post.id));
            // Its photos and videos go from BIES too (only mine; the server checks).
            const media = [...new Set([
                ...(post.content.match(/https?:\/\/[^\s<>"']+/g) || []),
                ...post.tags.filter(t => t[0] === 'imeta').flatMap(t => t.slice(1)).filter(v => v.startsWith('url ')).map(v => v.slice(4)),
            ])].slice(0, 20);
            if (media.length) uploadApi.discard(media).catch(() => { /* leftovers only */ });
        } catch (err) {
            console.error('[Feed] Delete request failed:', err);
        } finally {
            setDeletingPost(null);
        }
    };

    // Delete my own reply (NIP-09), as Facebook and LinkedIn let you.
    const handleDeleteComment = async (postId, comment) => {
        if (!window.confirm(t('feed.deleteReplyConfirm', 'Delete this reply?'))) return;
        try {
            const deletion = await nostrSigner.signEvent({
                kind: 5,
                created_at: Math.floor(Date.now() / 1000),
                tags: [['e', comment.id], ['k', '1']],
                content: '',
            });
            await nostrService.publishSigned(deletion, { biesOnly: feedMode === 'private' });
            setComments(prev => ({ ...prev, [postId]: (prev[postId] || []).filter(c => c.id !== comment.id) }));
            touchCounts(postId);
            setNoteStats(prev => ({
                ...prev,
                [postId]: { ...prev[postId], replies: Math.max(0, (prev[postId]?.replies || 0) - 1) },
            }));
        } catch (err) {
            console.error('[Feed] Delete reply failed:', err);
        }
    };

    // Mute a user on this device, for this account (services/muteStore.js;
    // undone in Settings → Blocked members).
    const mutedUsers = useMuted();
    const handleMuteUser = (pubkey) => mute(user?.id, pubkey);

    // Report and Block go to BIES (terms of use §6). Not a NIP-56 report
    // event: that would publish who reported whom, for anyone to read. Someone
    // who isn't a BIES member can't be blocked on the server, so they are
    // muted on this device instead.
    const { openReport, openBlock, dialogs: moderationDialogs } = useModerationDialogs({
        onNotMember: (target) => handleMuteUser(target.pubkey),
    });

    // The signed note goes with the report: it proves who wrote it.
    const handleReport = (note) => {
        setPostMenu(null);
        const { id, pubkey, created_at, kind, tags, content, sig } = note;
        openReport(
            { type: 'note', id, event: { id, pubkey, created_at, kind, tags, content, sig } },
            { name: getDisplayName(pubkey), blockTarget: { pubkey } },
        );
    };

    const handleBlockUser = (pubkey) => {
        setPostMenu(null);
        openBlock({ pubkey }, { name: getDisplayName(pubkey) });
    };

    const formatTime = formatTimeUtil;

    const getDisplayName = (pubkey) => getDisplayNameUtil(pubkey, profiles);


    const getAvatar = (pubkey) => {
        return profiles[pubkey]?.picture || null;
    };

    // Mention autocomplete: detect @query in textarea and search profiles
    const handleMentionInput = useCallback((text, caretPos, field) => {
        const before = text.slice(0, caretPos);
        const match = before.match(/@(\S*)$/);
        if (match) {
            const query = match[1];
            setMentionAnchor({ field, startIndex: caretPos - match[0].length });
            if (mentionSearchTimer.current) clearTimeout(mentionSearchTimer.current);
            if (query.length >= 2) {
                setMentionLoading(true);
                setMentionResults([]);
                mentionSearchTimer.current = setTimeout(async () => {
                    try {
                        const results = await nostrService.searchProfiles(query, 6);
                        setMentionResults(results);
                    } catch {
                        setMentionResults([]);
                    } finally {
                        setMentionLoading(false);
                    }
                }, 350);
            } else {
                setMentionResults([]);
                setMentionLoading(false);
            }
        } else {
            setMentionAnchor(null);
            setMentionResults([]);
            setMentionLoading(false);
        }
    }, []);

    const handleMentionSelect = (profile) => {
        if (!mentionAnchor) return;
        const npub = nip19.npubEncode(profile.pubkey);
        const mention = `nostr:${npub} `;
        const insertMention = (prev) => {
            const before = prev.slice(0, mentionAnchor.startIndex);
            const after = prev.slice(mentionAnchor.startIndex).replace(/^@\S*/, '');
            return before + mention + after;
        };
        if (mentionAnchor.field === 'compose') {
            setComposeText(insertMention);
        } else {
            setReplyText(insertMention);
        }
        // Cache the mentioned profile so their name renders inline
        if (profile.name || profile.display_name) {
            setProfiles(prev => ({ ...prev, [profile.pubkey]: { ...prev[profile.pubkey], ...profile } }));
        }
        setMentionAnchor(null);
        setMentionResults([]);
        setMentionLoading(false);
    };

    // Render note text with nostr:npub mentions as styled @name spans
    const renderContent = (text) => {
        if (!text) return null;
        const parts = text.split(/(nostr:npub[a-z0-9]+)/gi);
        return parts.map((part, i) => {
            if (/^nostr:npub[a-z0-9]+$/i.test(part)) {
                const npubStr = part.slice(6); // strip "nostr:"
                try {
                    const decoded = nip19.decode(npubStr);
                    if (decoded.type === 'npub') {
                        return <span key={i} className="note-mention">@{getDisplayName(decoded.data)}</span>;
                    }
                } catch { /* fall through */ }
            }
            return <span key={i}>{part}</span>;
        });
    };

    // Only show root posts — filter out replies (events with 'e' tags referencing other events)
    // Show root posts + reposts, filter out muted users
    const isHidden = useCallback(
        (pubkey) => mutedUsers.has(pubkey) || blocks.pubkeys.has(pubkey),
        [mutedUsers, blocks.pubkeys],
    );
    const rootPosts = useMemo(() => posts.filter(p => {
        if (isHidden(p.pubkey)) return false;
        // If note was surfaced only via repost and all reposters are muted, hide it
        if (p._reposters?.length > 0 && p._reposters.every(r => isHidden(r.pubkey))) return false;
        return p._reposters?.length > 0 || !p.tags?.some(t => t[0] === 'e');
    }), [posts, isHidden]);

    useEffect(() => { onPosts?.(rootPosts, loading); }, [rootPosts, loading]);

    // The first screen of posts is drawn on its own and the rest once it has
    // painted, so the Feed shows sooner. Back to a feed kept in memory draws
    // them all at once, so the place it was left at can be scrolled back to.
    const navigationType = useNavigationType();
    const [drawAll, setDrawAll] = useState(() => navigationType === 'POP' && !!cachedFeed(feedCacheKey(accountId, author)));
    const manyPosts = rootPosts.length > FIRST_DRAW;
    useEffect(() => {
        if (drawAll || !manyPosts) return undefined;
        let timer = null;
        const frame = requestAnimationFrame(() => { timer = setTimeout(() => setDrawAll(true), 0); });
        return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
    }, [drawAll, manyPosts]);
    const shownPosts = drawAll ? rootPosts : rootPosts.slice(0, FIRST_DRAW);

    const getStats = (noteId) => noteStats[noteId] || {};

    const loadComments = useCallback(async (postId) => {
        if (fetchedComments.current.has(postId)) return;
        fetchedComments.current.add(postId);
        setLoadingComments(prev => ({ ...prev, [postId]: true }));

        // For private relay feed, subscribe directly to BIES relay for replies
        if (feedMode === 'private') {
            const commentPubkeys = [];
            const sub = nostrService.pool.subscribeMany(
                [BIES_RELAY],
                { kinds: [1], '#e': [postId], limit: 100 },
                {
                    onevent: (event) => {
                        if (!fetchedProfiles.current.has(event.pubkey)) {
                            commentPubkeys.push(event.pubkey);
                        }
                        setComments(prev => {
                            const existing = prev[postId] || [];
                            if (existing.find(e => e.id === event.id)) return prev;
                            return { ...prev, [postId]: [...existing, event].sort((a, b) => a.created_at - b.created_at) };
                        });
                    },
                    oneose: async () => {
                        sub.close();
                        setLoadingComments(prev => ({ ...prev, [postId]: false }));
                        const toFetch = [...new Set(commentPubkeys)].filter(pk => !fetchedProfiles.current.has(pk));
                        toFetch.forEach(pk => fetchedProfiles.current.add(pk));
                        if (toFetch.length === 0) return;
                        const profileMap = await nostrService.getProfiles(toFetch, [BIES_RELAY]);
                        if (profileMap.size > 0) {
                            setProfiles(prev => {
                                const next = { ...prev };
                                for (const [pk, p] of profileMap) next[pk] = p;
                                return next;
                            });
                        }
                    },
                    onclose: () => setLoadingComments(prev => ({ ...prev, [postId]: false })),
                    onauth: async (evt) => { try { return await nostrSigner.signEvent(evt); } catch { return undefined; } },
                }
            );
            return;
        }

        try {
            const result = await primalService.fetchReplies(postId, { limit: 100 });

            // Merge profiles from reply authors
            if (Object.keys(result.profiles).length > 0) {
                setProfiles(prev => ({ ...prev, ...result.profiles }));
                for (const pubkey of Object.keys(result.profiles)) {
                    fetchedProfiles.current.add(pubkey);
                }
            }

            // Set comments sorted by time
            if (result.notes.length > 0) {
                const sorted = result.notes.sort((a, b) => a.created_at - b.created_at);
                setComments(prev => {
                    const existing = prev[postId] || [];
                    const merged = [...existing];
                    for (const note of sorted) {
                        if (!merged.find(e => e.id === note.id)) {
                            merged.push(note);
                        }
                    }
                    merged.sort((a, b) => a.created_at - b.created_at);
                    return { ...prev, [postId]: merged };
                });
            }
        } catch (err) {
            console.error('[Feed] Failed to load comments via Primal:', err);
            // Remove from cache so user can retry
            fetchedComments.current.delete(postId);
        } finally {
            setLoadingComments(prev => ({ ...prev, [postId]: false }));
        }
    }, [feedMode]);

    const toggleComments = (postId) => {
        setOpenComments(prev => {
            const next = new Set(prev);
            if (next.has(postId)) {
                next.delete(postId);
            } else {
                next.add(postId);
                loadComments(postId);
            }
            return next;
        });
    };

    // Open a post from a notification, a profile or a shared link
    // (/feed?post=note1…): load it (or the post a reply belongs to) if it
    // isn't in the feed yet, open its replies and scroll to it — as tapping a
    // notification does in any social app.
    const focusTarget = embedded ? null : (location.state?.scrollToPost || sharedPostId(location.search));
    const focusHandled = useRef(null);
    // The post a shared link opened, kept: a reload (coming back to the app,
    // a relay reconnect) fetches only the newest posts, so it's put back.
    const sharedPost = useRef(null);
    useEffect(() => {
        if (!focusTarget || loading || feedMode !== 'private' || focusHandled.current === focusTarget) return;
        focusHandled.current = focusTarget;
        sharedPost.current = null;
        (async () => {
            let id = focusTarget;
            sharedPost.current = posts.find(p => p.id === id) || null;
            if (!sharedPost.current) {
                try {
                    const [ev] = await nostrService.pool.querySync([BIES_RELAY], { ids: [id] }, { onauth: relayAuth });
                    if (ev) {
                        const eTags = ev.tags.filter(t => t[0] === 'e');
                        const rootId = (eTags.find(t => t[3] === 'root') || eTags[0])?.[1];
                        let root = ev;
                        if (rootId) {
                            const [r] = await nostrService.pool.querySync([BIES_RELAY], { ids: [rootId] }, { onauth: relayAuth });
                            if (r) root = r;
                        }
                        id = root.id;
                        sharedPost.current = root;
                        mergePosts([root]);
                        ensureProfiles([root.pubkey]);
                    }
                } catch { /* not found: just show the feed */ }
            }
            setOpenComments(prev => new Set(prev).add(id));
            loadComments(id);
            setTimeout(() => {
                const el = document.querySelector(`[data-post-id="${CSS.escape(id)}"]`);
                if (!el) return;
                el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                el.style.transition = 'box-shadow 0.3s';
                el.style.boxShadow = '0 0 0 2px var(--color-secondary)';
                setTimeout(() => { el.style.boxShadow = ''; }, 2000);
            }, 400);
        })();
    }, [focusTarget, loading, feedMode, posts, loadComments, ensureProfiles]);
    // After a reload: the shared post again, with its replies open, without
    // scrolling to it again.
    useEffect(() => {
        const kept = sharedPost.current;
        if (!kept || loading || feedMode !== 'private' || posts.some(p => p.id === kept.id)) return;
        mergePosts([kept]);
        setOpenComments(prev => new Set(prev).add(kept.id));
        loadComments(kept.id);
    }, [loading, posts, feedMode]);

    // Close repost menu and post menu on outside click
    useEffect(() => {
        if (!repostMenu && !postMenu) return;
        const handler = (e) => {
            if (repostMenu && !e.target.closest('.repost-wrapper')) setRepostMenu(null);
            if (postMenu && !e.target.closest('.note-menu-wrapper')) setPostMenu(null);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [repostMenu, postMenu]);

    // Lightbox (global)
    const lightbox = useLightbox();
    const openLightbox = (src, gallery = []) => lightbox.open(src, gallery);

    // Parse note content: separate text, images, and other media
    const parseNoteContent = parseNoteContentUtil;



    // Render other media (video, audio, youtube)
    const renderOtherMediaInline = (media) => {
        if (!media || media.length === 0) return null;
        return (
            <div className="primal-note-media">
                {media.map((m, i) => {
                    if (m.type === 'video') {
                        return <video key={i} src={m.url} controls className="primal-note-video" preload="metadata" />;
                    }
                    if (m.type === 'audio') {
                        return <audio key={i} src={m.url} controls className="primal-note-audio" preload="metadata" />;
                    }
                    if (m.type === 'youtube') {
                        return (
                            <iframe
                                key={i}
                                className="primal-note-youtube"
                                src={`https://www.youtube-nocookie.com/embed/${m.id}`}
                                title="YouTube video"
                                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                                allowFullScreen
                                loading="lazy"
                            />
                        );
                    }
                    return null;
                })}
            </div>
        );
    };

    return (
        <div className={embedded ? 'primal-feed-embedded' : 'primal-feed-page'}>
            {copyToast && <div className="primal-copy-toast">{copyToast}</div>}
            <div className={embedded ? undefined : 'primal-feed-container'}>
                {/* Feed header */}
                {!embedded && (
                    <div className="primal-feed-header">
                        <div className="primal-feed-title">
                            <NostrIcon size={22} />
                            <span>{t('feed.biesFeed', 'BIES Feed')}</span>
                        </div>
                        <div className="primal-feed-tabs">
                            <button
                                className={`primal-feed-tab ${feedMode === 'private' ? 'active' : ''}`}
                                onClick={() => setFeedMode('private')}
                                data-testid="tab-private"
                            >
                                <Lock size={15} className="primal-feed-tab-icon" />
                                <span>{t('feed.privateRelay', 'Private Relay')}</span>
                            </button>
                            {exploreAllowed && (
                                <button
                                    className={`primal-feed-tab ${feedMode === 'explore' ? 'active' : ''}`}
                                    onClick={() => setFeedMode('explore')}
                                    data-testid="tab-explore"
                                >
                                    <Globe size={15} className="primal-feed-tab-icon" />
                                    <span>{t('feed.explore', 'Explore')}</span>
                                </button>
                            )}
                            <button
                                className={`primal-feed-refresh${refreshing ? ' spinning' : ''}`}
                                onClick={handleRefreshFeed}
                                disabled={loading || refreshing}
                                title={t('feed.refresh', 'Refresh feed')}
                            >
                                <RefreshCw size={15} />
                            </button>
                        </div>

                        {/* Explore dropdown */}
                        {feedMode === 'explore' && (
                            <div className="primal-explore-dropdown" ref={exploreDropdownRef} data-testid="explore-tabs">
                                <button
                                    className="primal-explore-dropdown-trigger"
                                    onClick={() => setExploreDropdownOpen(o => !o)}
                                >
                                    {(() => {
                                        const active = EXPLORE_VIEWS.find(v => v.key === exploreView);
                                        const Icon = EXPLORE_ICONS[exploreView];
                                        return (
                                            <>
                                                <Icon size={14} />
                                                <span>{active?.label}</span>
                                                <ChevronDown size={14} className={`primal-explore-chevron${exploreDropdownOpen ? ' open' : ''}`} />
                                            </>
                                        );
                                    })()}
                                </button>
                                {exploreDropdownOpen && (
                                    <div className="primal-explore-dropdown-menu">
                                        {EXPLORE_VIEWS.map(view => {
                                            const Icon = EXPLORE_ICONS[view.key];
                                            return (
                                                <button
                                                    key={view.key}
                                                    className={`primal-explore-dropdown-item${exploreView === view.key ? ' active' : ''}`}
                                                    onClick={() => {
                                                        setExploreView(view.key);
                                                        setExploreDropdownOpen(false);
                                                    }}
                                                >
                                                    <Icon size={14} />
                                                    <span>{view.label}</span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}

                {/* Compose box */}
                {showCompose && (
                    <div className="primal-compose">
                        <div className="primal-compose-row">
                            <div className="primal-compose-avatar">
                                {user?.profile?.avatar ? (
                                    <img src={getAssetUrl(user.profile.avatar)} alt="" />
                                ) : (
                                    <NostrIcon size={18} />
                                )}
                            </div>
                            <textarea
                                ref={composeInputRef}
                                className="primal-compose-input"
                                placeholder={t('feed.whatsHappening', "What's on your mind?")}
                                value={composeText}
                                onChange={(e) => {
                                    setComposeText(e.target.value);
                                    handleMentionInput(e.target.value, e.target.selectionStart, 'compose');
                                }}
                                onKeyDown={handleKeyDown}
                                onBlur={() => setTimeout(() => setMentionAnchor(null), 150)}
                                rows={2}
                                data-testid="compose-input"
                            />
                        </div>

                        {/* Mention dropdown */}
                        {mentionAnchor?.field === 'compose' && (mentionResults.length > 0 || mentionLoading) && (
                            <div className="primal-mention-dropdown">
                                {mentionLoading && mentionResults.length === 0 && (
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', color: 'var(--feed-text-tertiary)', fontSize: 13 }}>
                                        <Loader2 size={12} className="spin" /> {t('feed.searching', 'Searching...')}
                                    </div>
                                )}
                                {mentionResults.map(p => (
                                    <button key={p.pubkey} className="primal-mention-item" onMouseDown={(e) => { e.preventDefault(); handleMentionSelect(p); }}>
                                        {p.picture ? (
                                            <img src={p.picture} className="primal-mention-avatar" alt="" />
                                        ) : (
                                            <div className="primal-mention-avatar-placeholder"><NostrIcon size={12} /></div>
                                        )}
                                        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                                            <span className="primal-mention-name">{p.display_name || p.name || p.pubkey.slice(0, 10)}</span>
                                            {p.nip05 && <span className="primal-mention-nip05">{p.nip05}</span>}
                                        </div>
                                    </button>
                                ))}
                            </div>
                        )}

                        {/* Media preview */}
                        {attachedFiles.length > 0 && (
                            <div className="primal-compose-media-preview">
                                {attachedFiles.map((item, i) => (
                                    <div key={i} className="primal-compose-media-item">
                                        {item.type.startsWith('image/') ? (
                                            <img src={item.previewUrl} alt="" />
                                        ) : (
                                            <video src={item.previewUrl} muted />
                                        )}
                                        <button className="primal-compose-media-remove" onClick={() => removeAttachment(i)}>
                                            <X size={10} />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}

                        {postError && <div className="primal-compose-error">{postError}</div>}

                        <div className="primal-compose-bottom">
                            {/* In the app, posts go to the BIES feed (like a group's posts); no public option */}
                            {exploreAllowed && <button
                                className={`primal-compose-relay-toggle ${broadcastPublic ? 'public' : 'private'}`}
                                onClick={() => { manualRelayToggle.current = true; setBroadcastPublic(!broadcastPublic); }}
                                title={broadcastPublic ? t('feed.broadcastingPublic', 'Broadcasting to all relays') : t('feed.privateRelayOnly', 'Private relay only')}
                            >
                                {broadcastPublic ? <Globe size={13} /> : <Lock size={13} />}
                                <span>{broadcastPublic ? t('feed.public', 'Public') : t('feed.private', 'Private')}</span>
                            </button>}

                            <div className="primal-compose-actions">
                                <button
                                    className="primal-compose-btn"
                                    onClick={() => fileInputRef.current?.click()}
                                    title="Attach image or video"
                                    disabled={attachedFiles.length >= mediaService.MAX_ATTACHMENTS || posting || uploading}
                                >
                                    <ImagePlus size={18} />
                                </button>
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    accept="image/*,video/*"
                                    multiple
                                    style={{ display: 'none' }}
                                    onChange={handleFileSelect}
                                />
                                <div className="picker-anchor">
                                    <button
                                        className="primal-compose-btn"
                                        onClick={() => { setShowEmojiPicker(!showEmojiPicker); setShowGifPicker(false); }}
                                        title="Emoji"
                                    >
                                        <Smile size={18} />
                                    </button>
                                    {showEmojiPicker && (
                                        <EmojiPicker
                                            onSelect={(emoji) => handleComposeEmoji(emoji)}
                                            onClose={() => setShowEmojiPicker(false)}
                                            below
                                        />
                                    )}
                                </div>
                                <div className="picker-anchor">
                                    <button
                                        className="primal-compose-btn"
                                        onClick={() => { setShowGifPicker(!showGifPicker); setShowEmojiPicker(false); }}
                                        title="GIF"
                                    >
                                        <span className="gif-label">GIF</span>
                                    </button>
                                    {showGifPicker && (
                                        <NostrGifPicker
                                            onSelect={handleComposeGif}
                                            onClose={() => setShowGifPicker(false)}
                                            below
                                        />
                                    )}
                                </div>
                                <button
                                    className="primal-compose-post-btn"
                                    onClick={handlePost}
                                    disabled={(!composeText.trim() && attachedFiles.length === 0) || posting || uploading}
                                    data-testid="post-btn"
                                >
                                    {(posting || uploading) ? <Loader2 size={16} className="spin" /> : <Send size={16} />}
                                    <span>{uploading ? t('feed.uploading', 'Uploading...') : posting ? t('feed.posting', 'Posting...') : t('feed.post', 'Post')}</span>
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Feed content */}
                {loading && rootPosts.length === 0 ? (
                    <FeedSkeleton count={embedded ? 2 : 5} />
                ) : rootPosts.length === 0 ? (
                    <div className="primal-feed-empty" data-testid="feed-empty">
                        <NostrIcon size={40} />
                        <h3>{t('feed.noPostsTitle', 'No posts yet')}</h3>
                        <p>
                            {emptyText || (feedMode === 'private'
                                ? t('feed.noPostsPrivate', 'Be the first to post on the private relay!')
                                : t('feed.noPostsExplore', 'Nothing to show right now.'))}
                        </p>
                        {!embedded && feedMode === 'private' && exploreAllowed && (
                            <button className="primal-try-public-btn" onClick={() => setFeedMode('explore')}>
                                <Globe size={14} /> {t('feed.exploreNostr', 'Explore Nostr')}
                            </button>
                        )}
                    </div>
                ) : (
                    <div data-testid="feed-list">
                        {shownPosts.map(post => {
                            const stats = getStats(post.id);
                            const isLiked = likedNotes.has(post.id);
                            const isReposted = repostedNotes.has(post.id) || post._reposters?.some(r => r.pubkey === myPubkey);
                            const isReplying = replyTarget?.id === post.id;
                            const isCommentsOpen = openComments.has(post.id);
                            const postComments = (comments[post.id] || []).filter(c => !isHidden(c.pubkey));
                            const isOwnPost = myPubkey && post.pubkey === myPubkey;
                            // Don't name blocked or muted reposters in the repost header.
                            const shownPost = post._reposters?.some(r => isHidden(r.pubkey))
                                ? { ...post, _reposters: post._reposters.filter(r => !isHidden(r.pubkey)) }
                                : post;

                            return (
                                <Note
                                    key={post.id}
                                    post={shownPost}
                                    profiles={profiles}
                                    stats={stats}
                                    isLiked={isLiked}
                                    isReposted={isReposted}
                                    isCommentsOpen={isCommentsOpen}
                                    isOwnPost={isOwnPost}
                                    myPubkey={myPubkey}
                                    postMenuOpen={postMenu === post.id}
                                    repostMenuOpen={repostMenu === post.id}
                                    onToggleComments={() => toggleComments(post.id)}
                                    onLike={() => handleLike(post)}
                                    onRepostMenuToggle={() => {
                                        if (isReposted) return;
                                        setRepostMenu(repostMenu === post.id ? null : post.id);
                                    }}
                                    onRepost={(relay) => handleRepost(post, relay)}
                                    allowPublicRepost={exploreAllowed}
                                    onZap={zapsOn ? () => setZapTarget({
                                        pubkey: post.pubkey,
                                        name: getDisplayName(post.pubkey),
                                        avatar: getAvatar(post.pubkey),
                                        lud16: profiles[post.pubkey]?.lud16,
                                        eventId: post.id,
                                    }) : undefined}
                                    onShare={() => handleShare(post)}
                                    onPostMenuToggle={() => {
                                        setPostMenu(postMenu === post.id ? null : post.id);
                                    }}
                                    onDeletePost={() => handleDeletePost(post)}
                                    onMuteUser={() => { handleMuteUser(post.pubkey); setPostMenu(null); }}
                                    onBlockUser={() => handleBlockUser(post.pubkey)}
                                    onReport={() => { handleReport(post); setPostMenu(null); }}
                                    onCopyLink={() => { navigator.clipboard.writeText(postUrl(post)); setPostMenu(null); showToast(t('feed.linkCopied', 'Link copied')); }}
                                    onCopyText={() => { navigator.clipboard.writeText(post.content || ''); setPostMenu(null); showToast(t('feed.textCopied', 'Text copied')); }}
                                    onCopyId={() => { navigator.clipboard.writeText(post.id); setPostMenu(null); showToast(t('feed.idCopied', 'Note ID copied')); }}
                                    onCopyRaw={() => { navigator.clipboard.writeText(JSON.stringify(post, null, 2)); setPostMenu(null); showToast(t('feed.rawCopied', 'Raw data copied')); }}
                                    parseNoteContent={parseNoteContent}
                                    formatTime={formatTime}
                                    formatCount={formatCount}
                                    formatSats={formatSats}
                                    getDisplayName={getDisplayName}
                                    getAvatar={getAvatar}
                                    onImageClick={openLightbox}
                                    renderOtherMedia={renderOtherMediaInline}
                                    t={t}
                                >
                                    {/* Comment section — rendered as children inside Note */}
                                    {isCommentsOpen && (
                                        <div className="primal-comments">
                                            {/* Reply compose */}
                                            <div className="primal-comment-compose">
                                                <div className="primal-avatar primal-avatar-sm">
                                                    {user?.profile?.avatar ? (
                                                        <img src={getAssetUrl(user.profile.avatar)} alt="" />
                                                    ) : (
                                                        <NostrIcon size={13} />
                                                    )}
                                                </div>
                                                <div className="primal-comment-input-row">
                                                    <textarea
                                                        ref={el => { commentInputRefs.current[post.id] = el; }}
                                                        className="primal-comment-input"
                                                        placeholder={t('feed.replyTo', { name: getDisplayName(post.pubkey) })}
                                                        value={isReplying ? replyText : ''}
                                                        onChange={(e) => {
                                                            setReplyTarget({ id: post.id, pubkey: post.pubkey });
                                                            setReplyText(e.target.value);
                                                            handleMentionInput(e.target.value, e.target.selectionStart, 'reply');
                                                        }}
                                                        onFocus={() => setReplyTarget({ id: post.id, pubkey: post.pubkey })}
                                                        onBlur={() => setTimeout(() => setMentionAnchor(null), 150)}
                                                        onKeyDown={(e) => {
                                                            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleReply(post); }
                                                        }}
                                                        rows={1}
                                                    />
                                                    <div className="primal-comment-picker-btns">
                                                        <div className="picker-anchor">
                                                            <button
                                                                className="primal-comment-picker-btn"
                                                                onClick={() => { setCommentEmojiPicker(commentEmojiPicker === post.id ? null : post.id); setCommentGifPicker(null); }}
                                                            >
                                                                <Smile size={14} />
                                                            </button>
                                                            {commentEmojiPicker === post.id && (
                                                                <EmojiPicker
                                                                    onSelect={(emoji) => handleCommentEmoji(post.id, emoji)}
                                                                    onClose={() => setCommentEmojiPicker(null)}
                                                                />
                                                            )}
                                                        </div>
                                                        <div className="picker-anchor">
                                                            <button
                                                                className="primal-comment-picker-btn"
                                                                onClick={() => { setCommentGifPicker(commentGifPicker === post.id ? null : post.id); setCommentEmojiPicker(null); }}
                                                            >
                                                                <span style={{ fontSize: 11, fontWeight: 700 }}>GIF</span>
                                                            </button>
                                                            {commentGifPicker === post.id && (
                                                                <NostrGifPicker
                                                                    onSelect={(url) => handleCommentGif(post.id, post.pubkey, url)}
                                                                    onClose={() => setCommentGifPicker(null)}
                                                                />
                                                            )}
                                                        </div>
                                                    </div>
                                                    <button
                                                        className="primal-comment-send"
                                                        onClick={() => handleReply(post)}
                                                        disabled={!isReplying || !replyText.trim() || replyPosting}
                                                    >
                                                        {replyPosting && isReplying ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
                                                    </button>
                                                </div>
                                            </div>

                                            {/* Mention dropdown for replies */}
                                            {isReplying && mentionAnchor?.field === 'reply' && (mentionResults.length > 0 || mentionLoading) && (
                                                <div className="primal-mention-dropdown" style={{ marginLeft: 0 }}>
                                                    {mentionLoading && mentionResults.length === 0 && (
                                                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', color: 'var(--feed-text-tertiary)', fontSize: 13 }}>
                                                            <Loader2 size={12} className="spin" /> {t('feed.searching', 'Searching...')}
                                                        </div>
                                                    )}
                                                    {mentionResults.map(p => (
                                                        <button key={p.pubkey} className="primal-mention-item" onMouseDown={(e) => { e.preventDefault(); handleMentionSelect(p); }}>
                                                            {p.picture ? (
                                                                <img src={p.picture} className="primal-mention-avatar" alt="" />
                                                            ) : (
                                                                <div className="primal-mention-avatar-placeholder"><NostrIcon size={12} /></div>
                                                            )}
                                                            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                                                                <span className="primal-mention-name">{p.display_name || p.name || p.pubkey.slice(0, 10)}</span>
                                                                {p.nip05 && <span className="primal-mention-nip05">{p.nip05}</span>}
                                                            </div>
                                                        </button>
                                                    ))}
                                                </div>
                                            )}

                                            {loadingComments[post.id] && postComments.length === 0 && (
                                                <div className="primal-comment-loading">
                                                    <Loader2 size={14} className="spin" /> {t('feed.loadingComments', 'Loading comments...')}
                                                </div>
                                            )}

                                            {/* Comment list */}
                                            {(() => {
                                                const limit = visibleCommentCount[post.id] || 5;
                                                const latest = postComments.slice(-limit).reverse();
                                                const hiddenCount = postComments.length - limit;
                                                return (
                                                    <>
                                                        {latest.map(comment => {
                                                            const { text: ct, images: ci } = parseNoteContent(comment.content);
                                                            return (
                                                                <div key={comment.id} className="primal-comment">
                                                                    <div className="primal-avatar primal-avatar-sm">
                                                                        {getAvatar(comment.pubkey) ? (
                                                                            <img src={getAvatar(comment.pubkey)} alt="" />
                                                                        ) : (
                                                                            <NostrIcon size={13} />
                                                                        )}
                                                                    </div>
                                                                    <div className="primal-comment-body">
                                                                        <div className="primal-comment-meta">
                                                                            <span className="primal-comment-name">{getDisplayName(comment.pubkey)}</span>
                                                                            <span className="primal-comment-time">{formatTime(comment.created_at)}</span>
                                                                        </div>
                                                                        {ct && <div className="primal-comment-text">{renderContent(ct)}</div>}
                                                                        {ci.length > 0 && (
                                                                            <div className="primal-comment-images">
                                                                                {ci.map((src, idx) => (
                                                                                    <img key={idx} src={src} alt="" onClick={(e) => { e.stopPropagation(); openLightbox(src, ci); }} />
                                                                                ))}
                                                                            </div>
                                                                        )}
                                                                        <div className="primal-comment-actions">
                                                                            <button className="primal-comment-action" onClick={() => handleCommentReply(post.id, comment)}>
                                                                                Reply
                                                                            </button>
                                                                            {comment.pubkey !== myPubkey ? (
                                                                                <button className="primal-comment-action" onClick={() => handleReport(comment)}>
                                                                                    {t('moderation.menu.report')}
                                                                                </button>
                                                                            ) : (
                                                                                <button className="primal-comment-action" onClick={() => handleDeleteComment(post.id, comment)}>
                                                                                    {t('feed.deleteReply', 'Delete')}
                                                                                </button>
                                                                            )}
                                                                            <button
                                                                                className={`primal-comment-action ${likedComments.has(comment.id) ? 'liked' : ''}`}
                                                                                onClick={() => handleCommentLike(comment)}
                                                                            >
                                                                                Like
                                                                            </button>
                                                                            {zapsOn && (
                                                                                <button
                                                                                    className="primal-comment-action"
                                                                                    onClick={() => setZapTarget({
                                                                                        pubkey: comment.pubkey,
                                                                                        name: getDisplayName(comment.pubkey),
                                                                                        avatar: getAvatar(comment.pubkey),
                                                                                        eventId: comment.id,
                                                                                    })}
                                                                                >
                                                                                    Zap
                                                                                </button>
                                                                            )}
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            );
                                                        })}

                                                        {hiddenCount > 0 && (
                                                            <button
                                                                className="primal-show-more-comments"
                                                                onClick={() => setVisibleCommentCount(prev => ({
                                                                    ...prev,
                                                                    [post.id]: (prev[post.id] || 5) * 2,
                                                                }))}
                                                            >
                                                                Show {Math.min(hiddenCount, limit)} more comments
                                                            </button>
                                                        )}
                                                    </>
                                                );
                                            })()}

                                            {!loadingComments[post.id] && postComments.length === 0 && (
                                                <div className="primal-comment-empty">{t('feed.noReplies', 'No replies yet')}</div>
                                            )}
                                        </div>
                                    )}
                                </Note>
                            );
                        })}

                        {/* Infinite scroll / load more */}
                        {(feedMode === 'explore' || (feedMode === 'private' && !olderDone)) && (author || rootPosts.length >= 10) && shownPosts.length === rootPosts.length && (
                            <>
                                <Paginator onIntersect={handleLoadMore} disabled={loadingMore} />
                                {loadingMore && (
                                    <div className="primal-feed-loading" style={{ padding: '20px' }}>
                                        <Loader2 size={20} className="spin" />
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                )}

                {moderationDialogs}

                {/* Zap Modal */}
                {zapTarget && (
                    <ZapModal
                        recipients={[{ pubkey: zapTarget.pubkey, name: zapTarget.name, avatar: zapTarget.avatar, lud16: zapTarget.lud16 }]}
                        eventId={zapTarget.eventId}
                        onClose={() => setZapTarget(null)}
                    />
                )}
            </div>
        </div>
    );
};

export default Feed;
