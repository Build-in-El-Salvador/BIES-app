import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, Heart, Repeat, MessageCircle, Info } from 'lucide-react';
import { nostrService, BIES_RELAY } from '../services/nostrService';
import { nostrSigner } from '../services/nostrSigner';
import { notificationsApi } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useBlocks, useMuted } from '../hooks/useBlocks';
import { nip19 } from 'nostr-tools';

// The app's own notices that belong in the bell beside the Feed activity:
// a listing approved or taken down, a request to hand a listing over, a new
// follower, a profile view (Settings → Notifications: "everything also shows
// under the bell").
const APP_TYPES = new Set(['SYSTEM', 'FOLLOW', 'PROFILE_VIEW']);
const appData = (n) => {
    if (n.data && typeof n.data === 'object') return n.data;
    try { return JSON.parse(n.data || '{}'); } catch { return {}; }
};
// The member a follow or a profile view is about.
const appActor = (n) => {
    const { followerId, viewerId } = appData(n);
    const id = followerId || viewerId;
    return typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
};
// Only links inside the app; a follow or a view opens that member's profile.
const appLink = (n) => {
    const link = appData(n).link;
    if (typeof link === 'string' && /^\/(?![\/\\])/.test(link)) return link;
    const actor = appActor(n);
    return actor ? `/builder/${actor}` : null;
};

/**
 * NostrNotifications — subscribes to the BIES private relay for reactions,
 * reposts, and replies targeting the current user's posts.  Renders a bell
 * icon with unread count badge and a dropdown list of clickable notifications,
 * with the app's own notices (APP_TYPES) mixed in by time.
 */
const NostrNotifications = ({ mobile = false }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [notifications, setNotifications] = useState([]);
    const [profiles, setProfiles] = useState({});
    const [myPubkey, setMyPubkey] = useState(null);
    const [myPostIds, setMyPostIds] = useState(new Set());
    const [readIds, setReadIds] = useState(() => {
        try {
            return new Set(JSON.parse(localStorage.getItem('bies_notif_read') || '[]'));
        } catch { return new Set(); }
    });
    const navigate = useNavigate();
    const fetchedProfiles = useRef(new Set());
    const subRef = useRef(null);
    const postsSubRef = useRef(null);

    const { notifications: appNotifications, refreshNotifications } = useAuth();
    useEffect(() => { refreshNotifications?.(); }, []);
    // Nothing from members blocked either way, or muted on this device:
    // filtered when shown, so a new block clears what came before too.
    const blocks = useBlocks();
    const muted = useMuted();
    const hiddenActor = (pubkey) => blocks.pubkeys.has(pubkey) || muted.has(pubkey);
    const appItems = (appNotifications || [])
        .filter((n) => APP_TYPES.has(n.type) && !(appActor(n) && blocks.ids.has(appActor(n))))
        .map((n) => ({ id: `app:${n.id}`, app: n, createdAt: Math.floor(new Date(n.createdAt).getTime() / 1000) }));
    const items = [...notifications.filter((n) => !hiddenActor(n.actorPubkey)), ...appItems].sort((a, b) => b.createdAt - a.createdAt);
    const isUnread = (item) => (item.app ? !item.app.isRead : !readIds.has(item.id));
    const unreadCount = items.filter(isUnread).length;

    // Persist read IDs
    const markAllRead = useCallback(() => {
        const allIds = new Set(notifications.map(n => n.id));
        setReadIds(allIds);
        localStorage.setItem('bies_notif_read', JSON.stringify([...allIds]));
        if (appItems.some(isUnread)) {
            notificationsApi.markAllRead().then(() => refreshNotifications?.()).catch(() => {});
        }
    }, [notifications, appItems]);

    const markRead = useCallback((id) => {
        setReadIds(prev => {
            const next = new Set(prev);
            next.add(id);
            localStorage.setItem('bies_notif_read', JSON.stringify([...next]));
            return next;
        });
    }, []);

    // Get current user pubkey
    useEffect(() => {
        nostrSigner.getPublicKey().then(pk => {
            if (pk) setMyPubkey(pk);
        }).catch(() => {});
    }, []);

    // Batch-fetch profiles for notification actors
    const fetchProfiles = useCallback(async (pubkeys) => {
        const toFetch = pubkeys.filter(pk => !fetchedProfiles.current.has(pk));
        if (toFetch.length === 0) return;
        toFetch.forEach(pk => fetchedProfiles.current.add(pk));
        try {
            const profileMap = await nostrService.getProfiles(toFetch);
            if (profileMap.size > 0) {
                setProfiles(prev => {
                    const next = { ...prev };
                    for (const [pk, p] of profileMap) next[pk] = p;
                    return next;
                });
            }
        } catch { /* ignore */ }
    }, []);

    // Step 1: Subscribe to the user's own posts on BIES relay to know which post IDs are "mine"
    useEffect(() => {
        if (!myPubkey) return;

        const postIds = new Set();
        const sub = nostrService.pool.subscribeMany(
            [BIES_RELAY],
            { kinds: [1], authors: [myPubkey], limit: 200 },
            {
                onevent: (event) => {
                    postIds.add(event.id);
                },
                oneose: () => {
                    setMyPostIds(postIds);
                },
                onauth: async (evt) => { try { return await nostrSigner.signEvent(evt); } catch { return undefined; } },
            }
        );
        postsSubRef.current = sub;
        return () => { if (sub) sub.close(); };
    }, [myPubkey]);

    // Step 2: Subscribe to reactions, reposts, and replies on the BIES relay
    useEffect(() => {
        if (!myPubkey || myPostIds.size === 0) return;

        const postIdArray = [...myPostIds];
        const profileQueue = new Set();
        let debounceTimer = null;

        const sub = nostrService.pool.subscribeMany(
            [BIES_RELAY],
            { kinds: [7, 6, 1], '#e': postIdArray, limit: 200 },
            {
                onevent: (event) => {
                    // Skip own events
                    if (event.pubkey === myPubkey) return;

                    // Determine which post this targets
                    const eTags = event.tags.filter(t => t[0] === 'e');
                    const targetPostId = eTags.map(t => t[1]).find(id => myPostIds.has(id));
                    if (!targetPostId) return;

                    let type;
                    if (event.kind === 7) type = 'like';
                    else if (event.kind === 6) type = 'repost';
                    else if (event.kind === 1) type = 'reply';
                    else return;

                    const notif = {
                        id: event.id,
                        type,
                        actorPubkey: event.pubkey,
                        targetPostId,
                        content: event.kind === 1 ? event.content : null,
                        createdAt: event.created_at,
                    };

                    setNotifications(prev => {
                        if (prev.some(n => n.id === event.id)) return prev;
                        const next = [notif, ...prev];
                        next.sort((a, b) => b.createdAt - a.createdAt);
                        return next.slice(0, 100); // Keep max 100
                    });

                    // Queue profile fetch
                    profileQueue.add(event.pubkey);
                    clearTimeout(debounceTimer);
                    debounceTimer = setTimeout(() => {
                        fetchProfiles([...profileQueue]);
                        profileQueue.clear();
                    }, 500);
                },
                oneose: () => {
                    // Fetch all queued profiles
                    if (profileQueue.size > 0) {
                        fetchProfiles([...profileQueue]);
                        profileQueue.clear();
                    }
                },
                onauth: async (evt) => { try { return await nostrSigner.signEvent(evt); } catch { return undefined; } },
            }
        );

        subRef.current = sub;
        return () => {
            clearTimeout(debounceTimer);
            if (sub) sub.close();
        };
    }, [myPubkey, myPostIds, fetchProfiles]);

    // Format timestamp
    const timeAgo = (ts) => {
        const diff = Math.floor(Date.now() / 1000) - ts;
        if (diff < 60) return 'just now';
        if (diff < 3600) return `${Math.floor(diff / 60)}m`;
        if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
        if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
        return new Date(ts * 1000).toLocaleDateString();
    };

    const getDisplayName = (pubkey) => {
        const p = profiles[pubkey];
        if (p?.display_name) return p.display_name;
        if (p?.name) return p.name;
        const npub = nip19.npubEncode(pubkey);
        return npub.slice(0, 12) + '...';
    };

    const getAvatar = (pubkey) => {
        return profiles[pubkey]?.picture || null;
    };

    const getIcon = (type) => {
        switch (type) {
            case 'like': return <Heart size={10} style={{ color: '#ef4444' }} fill="#ef4444" />;
            case 'repost': return <Repeat size={10} style={{ color: '#22c55e' }} />;
            case 'reply': return <MessageCircle size={10} style={{ color: '#7c3aed' }} />;
            default: return <Bell size={10} />;
        }
    };

    const getLabel = (type) => {
        switch (type) {
            case 'like': return 'liked your post';
            case 'repost': return 'reposted your post';
            case 'reply': return 'replied to your post';
            default: return 'interacted with your post';
        }
    };

    const handleNotificationClick = (notif) => {
        setIsOpen(false);
        if (notif.app) {
            if (!notif.app.isRead) {
                notificationsApi.markRead(notif.app.id).then(() => refreshNotifications?.()).catch(() => {});
            }
            navigate(appLink(notif.app) || '/notifications');
            return;
        }
        markRead(notif.id);
        // Navigate to feed — the post should be visible in the private relay feed
        navigate('/feed', { state: { scrollToPost: notif.targetPostId } });
    };

    return (
        <div className={`nostr-notif-wrap ${mobile ? 'nostr-notif-mobile' : ''}`}>
            <button
                className="nostr-notif-btn"
                aria-label="Notifications"
                onClick={() => setIsOpen(!isOpen)}
            >
                <Bell size={mobile ? 20 : 20} />
                {unreadCount > 0 && (
                    <span className="nostr-notif-badge">
                        {unreadCount > 9 ? '9+' : unreadCount}
                    </span>
                )}
            </button>

            {isOpen && (
                <>
                    <div className="nostr-notif-overlay" onClick={() => setIsOpen(false)} />
                    <div className="nostr-notif-dropdown">
                        <div className="nostr-notif-header">
                            <span>Notifications</span>
                            {unreadCount > 0 && (
                                <button className="nostr-notif-mark-read" onClick={markAllRead}>
                                    Mark all read
                                </button>
                            )}
                        </div>
                        <div className="nostr-notif-list">
                            {items.length === 0 ? (
                                <div className="nostr-notif-empty">
                                    <Bell size={24} style={{ opacity: 0.3, marginBottom: '8px' }} />
                                    <p>No notifications yet</p>
                                    <p style={{ fontSize: '0.75rem', opacity: 0.6 }}>
                                        Likes, reposts, and replies to your posts will appear here
                                    </p>
                                </div>
                            ) : (
                                items.map(notif => notif.app ? (
                                    <button
                                        key={notif.id}
                                        className={`nostr-notif-item ${isUnread(notif) ? 'unread' : ''}`}
                                        onClick={() => handleNotificationClick(notif)}
                                    >
                                        <div className="nostr-notif-item-avatar">
                                            <div className="nostr-notif-item-avatar-placeholder nostr-notif-app-icon"><Info size={18} /></div>
                                        </div>
                                        <div className="nostr-notif-item-body">
                                            <p><strong>{notif.app.title}</strong></p>
                                            {notif.app.body && <p className="nostr-notif-item-preview">{notif.app.body}</p>}
                                            <span className="nostr-notif-item-time">{timeAgo(notif.createdAt)}</span>
                                        </div>
                                        {isUnread(notif) && <div className="nostr-notif-dot" />}
                                    </button>
                                ) : (
                                    <button
                                        key={notif.id}
                                        className={`nostr-notif-item ${!readIds.has(notif.id) ? 'unread' : ''}`}
                                        onClick={() => handleNotificationClick(notif)}
                                    >
                                        <div className="nostr-notif-item-avatar">
                                            {getAvatar(notif.actorPubkey) ? (
                                                <img src={getAvatar(notif.actorPubkey)} alt="" />
                                            ) : (
                                                <div className="nostr-notif-item-avatar-placeholder" />
                                            )}
                                            <div className="nostr-notif-item-icon">{getIcon(notif.type)}</div>
                                        </div>
                                        <div className="nostr-notif-item-body">
                                            <p>
                                                <strong>{getDisplayName(notif.actorPubkey)}</strong>{' '}
                                                {getLabel(notif.type)}
                                            </p>
                                            {notif.content && (
                                                <p className="nostr-notif-item-preview">
                                                    {notif.content.slice(0, 80)}{notif.content.length > 80 ? '...' : ''}
                                                </p>
                                            )}
                                            <span className="nostr-notif-item-time">{timeAgo(notif.createdAt)}</span>
                                        </div>
                                        {!readIds.has(notif.id) && <div className="nostr-notif-dot" />}
                                    </button>
                                ))
                            )}
                        </div>
                    </div>
                </>
            )}

            <style jsx>{`
                .nostr-notif-wrap {
                    position: relative;
                    display: flex;
                    align-items: center;
                }

                .nostr-notif-btn {
                    position: relative;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 8px;
                    color: white;
                    background: none;
                    border: none;
                    border-radius: 50%;
                    cursor: pointer;
                    transition: background 0.2s;
                }
                .nostr-notif-btn:hover {
                    background: rgba(255, 255, 255, 0.1);
                }

                .nostr-notif-badge {
                    position: absolute;
                    top: 2px;
                    right: 2px;
                    background: #ef4444;
                    color: white;
                    font-size: 10px;
                    min-width: 16px;
                    height: 16px;
                    border-radius: 8px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    border: 2px solid var(--color-primary);
                    font-weight: 700;
                    padding: 0 3px;
                    line-height: 1;
                }

                .nostr-notif-overlay {
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    z-index: 199;
                }

                .nostr-notif-dropdown {
                    position: fixed;
                    top: 73px;
                    right: 16px;
                    width: 280px;
                    background: var(--color-surface, #fff);
                    border: 1px solid var(--color-gray-100, #f3f4f6);
                    border-radius: var(--radius-md, 8px);
                    box-shadow: var(--shadow-lg, 0 4px 16px rgba(0,0,0,0.12));
                    z-index: 200;
                    animation: nostrNotifSlide 0.2s ease-out;
                    overflow: hidden;
                }

                @keyframes nostrNotifSlide {
                    from { opacity: 0; transform: translateY(-10px); }
                    to { opacity: 1; transform: translateY(0); }
                }

                .nostr-notif-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 0.5rem 0.75rem;
                    color: var(--color-gray-400, #9ca3af);
                    text-transform: uppercase;
                    font-size: 0.7rem;
                    font-weight: 600;
                    letter-spacing: 0.03em;
                }

                .nostr-notif-mark-read {
                    background: none;
                    border: none;
                    color: var(--color-primary, #1a2b6b);
                    font-size: 0.7rem;
                    font-weight: 600;
                    cursor: pointer;
                    padding: 2px 6px;
                    border-radius: var(--radius-sm, 4px);
                    text-transform: none;
                    transition: background 0.15s;
                }
                .nostr-notif-mark-read:hover {
                    background: var(--color-gray-100, #f3f4f6);
                }

                .nostr-notif-list {
                    overflow-y: auto;
                    max-height: 320px;
                }

                .nostr-notif-empty {
                    padding: 1.25rem 0.75rem;
                    text-align: center;
                    color: var(--color-gray-400, #9ca3af);
                    font-size: 0.8rem;
                }
                .nostr-notif-empty p { margin: 0; }

                .nostr-notif-item {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    width: 100%;
                    padding: 0.5rem 0.75rem;
                    background: transparent;
                    border: none;
                    cursor: pointer;
                    text-align: left;
                    transition: background 0.12s;
                    font-family: inherit;
                    color: var(--color-neutral-dark, #111);
                    border-radius: var(--radius-sm, 4px);
                    margin: 0 0.25rem;
                    width: calc(100% - 0.5rem);
                }
                .nostr-notif-item:hover {
                    background: var(--color-gray-100, #f3f4f6);
                }
                .nostr-notif-item.unread {
                    background: rgba(59, 130, 246, 0.05);
                }
                .nostr-notif-item.unread:hover {
                    background: rgba(59, 130, 246, 0.1);
                }

                .nostr-notif-item-avatar {
                    position: relative;
                    flex-shrink: 0;
                    width: 30px;
                    height: 30px;
                }
                .nostr-notif-item-avatar img {
                    width: 30px;
                    height: 30px;
                    border-radius: 50%;
                    object-fit: cover;
                }
                .nostr-notif-item-avatar-placeholder {
                    width: 30px;
                    height: 30px;
                    border-radius: 50%;
                    background: var(--color-gray-200, #e5e7eb);
                }
                .nostr-notif-app-icon {
                    display: flex; align-items: center; justify-content: center;
                    background: #e8eefb; color: var(--color-primary, #0047AB);
                }
                .nostr-notif-item-icon {
                    position: absolute;
                    bottom: -2px;
                    right: -4px;
                    background: var(--color-surface, #fff);
                    border-radius: 50%;
                    width: 16px;
                    height: 16px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    box-shadow: 0 1px 2px rgba(0,0,0,0.1);
                }

                .nostr-notif-item-body {
                    flex: 1;
                    min-width: 0;
                }
                .nostr-notif-item-body p {
                    font-size: 0.8rem;
                    line-height: 1.3;
                    margin: 0;
                }
                .nostr-notif-item-body strong {
                    font-weight: 600;
                }

                .nostr-notif-item-preview {
                    color: var(--color-gray-400, #9ca3af);
                    font-size: 0.72rem !important;
                    margin-top: 1px !important;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }

                .nostr-notif-item-time {
                    font-size: 0.68rem;
                    color: var(--color-gray-400, #9ca3af);
                    margin-top: 1px;
                    display: block;
                }

                .nostr-notif-dot {
                    width: 6px;
                    height: 6px;
                    border-radius: 50%;
                    background: var(--color-primary, #1a2b6b);
                    flex-shrink: 0;
                }

                @media (max-width: 768px) {
                    .nostr-notif-dropdown {
                        top: calc(73px + env(safe-area-inset-top, 0px));
                        right: 8px;
                        width: 300px;
                        max-width: calc(100vw - 16px);
                    }
                }

                /* Dark mode */
                :global([data-theme="dark"]) .nostr-notif-dropdown {
                    background: var(--color-surface, #1e1e2e);
                    border-color: rgba(255, 255, 255, 0.1);
                }
                :global([data-theme="dark"]) .nostr-notif-item:hover {
                    background: rgba(255, 255, 255, 0.05);
                }
                :global([data-theme="dark"]) .nostr-notif-item.unread {
                    background: rgba(59, 130, 246, 0.1);
                }
                :global([data-theme="dark"]) .nostr-notif-item.unread:hover {
                    background: rgba(59, 130, 246, 0.15);
                }
                :global([data-theme="dark"]) .nostr-notif-item-icon {
                    background: var(--color-surface, #1e1e2e);
                }
                :global([data-theme="dark"]) .nostr-notif-mark-read:hover {
                    background: rgba(255, 255, 255, 0.08);
                }
                :global([data-theme="dark"]) .nostr-notif-close:hover {
                    background: rgba(255, 255, 255, 0.08);
                }
                :global([data-theme="dark"]) .nostr-notif-badge {
                    border-color: var(--color-primary, #1a2b6b);
                }
            `}</style>
        </div>
    );
};

export default NostrNotifications;
