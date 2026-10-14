import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Loader2, LayoutGrid, List, Grid3X3, Columns, Check, BookCheck, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { mediaApi, newsApi } from '../services/api';
import { useAuth } from '../context/AuthContext';

const VIEW_OPTIONS = [
    { id: 'card', icon: Columns, label: 'Cards' },
    { id: 'list', icon: List, label: 'List' },
    { id: 'icon', icon: LayoutGrid, label: 'Icons' },
];

// Legacy device-global keys (pre per-user namespacing) — migrated on load
const WATCHED_KEY = 'bies_watched_videos';
const READ_KEY = 'bies_read_substacks';
// localStorage is only a per-user fast-boot cache; the server is the source of truth
function storageKey(base, userId) {
    return userId ? `${base}:${userId}` : base;
}
function getStoredSet(key) {
    try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); } catch { return new Set(); }
}
function saveStoredSet(key, s) {
    localStorage.setItem(key, JSON.stringify([...s]));
}

const Media = () => {
    const { user } = useAuth();
    const userId = user?.id;
    const watchedKey = storageKey(WATCHED_KEY, userId);
    const readKey = storageKey(READ_KEY, userId);

    const [activeTab, setActiveTab] = useState('substack');
    const [substackItems, setSubstackItems] = useState([]);
    const [youtubeItems, setYoutubeItems] = useState([]);
    const [liveSettings, setLiveSettings] = useState({ livestreamUrl: '', livestreamActive: false });
    const [viewMode, setViewMode] = useState(() => localStorage.getItem('bies_media_view') || 'card');
    const [viewMenuOpen, setViewMenuOpen] = useState(false);
    const [playingVideoId, setPlayingVideoId] = useState(null);
    const [loading, setLoading] = useState(false);
    const [watchedIds, setWatchedIds] = useState(() => getStoredSet(storageKey(WATCHED_KEY, userId)));
    const [readIds, setReadIds] = useState(() => getStoredSet(storageKey(READ_KEY, userId)));
    const [contextMenu, setContextMenu] = useState(null); // { id, type, x, y }  type: 'video' | 'article'
    const [selectMode, setSelectMode] = useState(false);
    const [pendingSelections, setPendingSelections] = useState(new Set()); // items toggled during this session
    const [savingSelections, setSavingSelections] = useState(false);
    const [syncError, setSyncError] = useState('');
    const hasChanges = pendingSelections.size > 0;
    const viewRef = useRef(null);
    const longPressTimer = useRef(null);
    const contextMenuRef = useRef(null);
    // Per-item queue of in-flight toggle syncs — coalesces rapid toggles so
    // out-of-order responses can't flip an item back to a stale value.
    const syncQueueRef = useRef({ watched: new Map(), read: new Map() });
    // Latest local value of every item touched this session — reapplied on top
    // of the server response so a late GET can't undo fresh toggles.
    const mutationOverlayRef = useRef({ watched: new Map(), read: new Map() });
    // Guards against a slow GET for a previous user overwriting current state
    const loadSeqRef = useRef(0);

    // Load read state from the backend on mount (and when the user changes).
    // The server is the source of truth and REPLACES local state; localStorage
    // is only a per-user fast-boot cache.
    useEffect(() => {
        if (!userId) return;
        const seq = ++loadSeqRef.current;
        mutationOverlayRef.current = { watched: new Map(), read: new Map() };

        const wKey = storageKey(WATCHED_KEY, userId);
        const rKey = storageKey(READ_KEY, userId);

        // Legacy migration: fold the old device-global keys into this user's
        // namespaced cache, push them to the server once, then drop them.
        const hasLegacy = localStorage.getItem(WATCHED_KEY) !== null || localStorage.getItem(READ_KEY) !== null;
        const legacyWatched = hasLegacy ? [...getStoredSet(WATCHED_KEY)] : [];
        const legacyRead = hasLegacy ? [...getStoredSet(READ_KEY)] : [];

        // Seed from the per-user cache (+ legacy) while the server responds
        const cachedWatched = new Set([...getStoredSet(wKey), ...legacyWatched]);
        const cachedRead = new Set([...getStoredSet(rKey), ...legacyRead]);
        setWatchedIds(cachedWatched);
        setReadIds(cachedRead);
        saveStoredSet(wKey, cachedWatched);
        saveStoredSet(rKey, cachedRead);

        const load = async () => {
            if (hasLegacy) {
                try {
                    if (legacyWatched.length || legacyRead.length) {
                        await mediaApi.bulkReadState({ watched: legacyWatched, read: legacyRead }, {});
                    }
                    localStorage.removeItem(WATCHED_KEY);
                    localStorage.removeItem(READ_KEY);
                } catch { /* keep legacy keys so migration retries next visit */ }
            }
            try {
                const data = await mediaApi.getReadState();
                if (seq !== loadSeqRef.current) return; // stale response for a previous user
                const serverWatched = new Set(Array.isArray(data.watched) ? data.watched : []);
                const serverRead = new Set(Array.isArray(data.read) ? data.read : []);
                // Legacy items count as marked even if the bulk push failed above
                legacyWatched.forEach(id => serverWatched.add(id));
                legacyRead.forEach(id => serverRead.add(id));
                // Re-apply toggles the user made while this request was in flight
                mutationOverlayRef.current.watched.forEach((value, id) => {
                    if (value) serverWatched.add(id); else serverWatched.delete(id);
                });
                mutationOverlayRef.current.read.forEach((value, id) => {
                    if (value) serverRead.add(id); else serverRead.delete(id);
                });
                setWatchedIds(serverWatched);
                setReadIds(serverRead);
                saveStoredSet(wKey, serverWatched);
                saveStoredSet(rKey, serverRead);
            } catch {
                // Server unreachable — keep the cached state; toggles surface their own errors
            }
        };
        load();
    }, [userId]);

    // Apply a watched/read change locally (state + per-user cache + overlay).
    // itemType: 'watched' | 'read'
    const applyLocal = useCallback((itemType, id, value) => {
        mutationOverlayRef.current[itemType].set(id, value);
        const setIds = itemType === 'watched' ? setWatchedIds : setReadIds;
        const key = itemType === 'watched' ? watchedKey : readKey;
        setIds(prev => {
            const next = new Set(prev);
            if (value) next.add(id); else next.delete(id);
            saveStoredSet(key, next);
            return next;
        });
    }, [watchedKey, readKey]);

    // Sync a single toggle to the server. Optimistic: local state is already
    // updated; on failure the item rolls back to the last server-confirmed
    // value and an inline error is shown. Rapid toggles of the same item are
    // queued so only one request is in flight per item.
    const syncToggle = useCallback((itemType, id, value) => {
        const queue = syncQueueRef.current[itemType];
        const existing = queue.get(id);
        if (existing) {
            // A request for this item is already in flight — remember the
            // latest desired value; it is sent when that request settles.
            existing.desired = value;
            return;
        }
        const entry = { desired: value, baseline: !value };
        queue.set(id, entry);
        const send = (val) => {
            mediaApi.toggleReadState(id, itemType, val)
                .then(() => {
                    entry.baseline = val;
                    if (entry.desired !== val) {
                        send(entry.desired);
                    } else {
                        queue.delete(id);
                    }
                })
                .catch(() => {
                    // Roll back to the last server-confirmed value
                    queue.delete(id);
                    applyLocal(itemType, id, entry.baseline);
                    setSyncError(itemType === 'watched'
                        ? 'Could not save watched state — change reverted. Please try again.'
                        : 'Could not save read state — change reverted. Please try again.');
                });
        };
        send(value);
    }, [applyLocal]);

    const toggleWatched = useCallback((videoId) => {
        const value = !watchedIds.has(videoId);
        applyLocal('watched', videoId, value);
        syncToggle('watched', videoId, value);
        setContextMenu(null);
    }, [watchedIds, applyLocal, syncToggle]);

    const enterSelectMode = useCallback(() => {
        setPendingSelections(new Set());
        setSelectMode(true);
        setContextMenu(null);
    }, []);

    const cancelSelectMode = useCallback(() => {
        // Revert any pending toggles (they were never sent to the server)
        const itemType = activeTab === 'youtube' ? 'watched' : 'read';
        const current = activeTab === 'youtube' ? watchedIds : readIds;
        pendingSelections.forEach(id => {
            applyLocal(itemType, id, !current.has(id));
        });
        setSelectMode(false);
        setPendingSelections(new Set());
        setSyncError('');
    }, [pendingSelections, activeTab, watchedIds, readIds, applyLocal]);

    const saveSelectMode = useCallback(async () => {
        // Persist the select-mode deltas via a server-side merge — items
        // marked on other devices are never clobbered.
        const itemType = activeTab === 'youtube' ? 'watched' : 'read';
        const current = activeTab === 'youtube' ? watchedIds : readIds;
        const add = { watched: [], read: [] };
        const remove = { watched: [], read: [] };
        pendingSelections.forEach(id => {
            if (current.has(id)) add[itemType].push(id); else remove[itemType].push(id);
        });
        setSavingSelections(true);
        try {
            await mediaApi.bulkReadState(add, remove);
            setSelectMode(false);
            setPendingSelections(new Set());
            setSyncError('');
        } catch {
            // Stay in select mode so the user can retry
            setSyncError('Could not save your changes. Check your connection and try again.');
        } finally {
            setSavingSelections(false);
        }
    }, [activeTab, watchedIds, readIds, pendingSelections]);

    const toggleSelectItem = useCallback((id) => {
        setPendingSelections(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    }, []);

    const toggleRead = useCallback((link) => {
        const value = !readIds.has(link);
        applyLocal('read', link, value);
        syncToggle('read', link, value);
        setContextMenu(null);
    }, [readIds, applyLocal, syncToggle]);

    // Long-press handlers for touch + mouse
    const openContextMenu = useCallback((e, id, type) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX || rect.left + rect.width / 2;
        setContextMenu({
            id, type,
            x: Math.max(10, Math.min(x, window.innerWidth - 200)),
            y: Math.min((e.clientY || rect.top) + 4, window.innerHeight - 60),
        });
    }, []);

    const handlePointerDown = useCallback((e, id, type) => {
        const target = e.currentTarget;
        longPressTimer.current = setTimeout(() => {
            openContextMenu({ currentTarget: target, clientX: e.clientX, clientY: e.clientY, preventDefault: () => {} }, id, type);
        }, 500);
    }, [openContextMenu]);

    const handlePointerUp = useCallback(() => {
        clearTimeout(longPressTimer.current);
    }, []);

    // Clean up long-press timer on unmount
    useEffect(() => {
        return () => clearTimeout(longPressTimer.current);
    }, []);

    // Close dropdowns on outside click
    useEffect(() => {
        const handler = (e) => {
            if (viewMenuOpen && viewRef.current && !viewRef.current.contains(e.target)) {
                setViewMenuOpen(false);
            }
            if (contextMenu && contextMenuRef.current && !contextMenuRef.current.contains(e.target)) {
                setContextMenu(null);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [viewMenuOpen, contextMenu]);

    useEffect(() => {
        const fetchContent = async () => {
            setLoading(true);
            try {
                if (activeTab === 'substack' && substackItems.length === 0) {
                    const result = await mediaApi.substack();
                    const list = result?.data || result || [];
                    setSubstackItems(Array.isArray(list) ? list : []);
                } else if (activeTab === 'youtube' && youtubeItems.length === 0) {
                    const result = await mediaApi.youtube();
                    const list = result?.data || result || [];
                    setYoutubeItems(Array.isArray(list) ? list : []);
                } else if (activeTab === 'live') {
                    // Live tab doesn't need additional fetching
                }
            } catch (error) {
                console.error(`[Media] Error fetching ${activeTab}:`, error);
            } finally {
                setLoading(false);
            }
        };
        fetchContent();
    }, [activeTab]);

    // Fetch livestream settings once on mount
    useEffect(() => {
        newsApi.settings()
            .then(data => {
                setLiveSettings({ livestreamUrl: data.livestreamUrl || '', livestreamActive: data.livestreamActive || false });
            })
            .catch(() => {});
    }, []);

    // In select mode, clicking an item toggles its read/watched state instead
    // of navigating. The change is provisional — synced to the server as a
    // delta when the user hits Save (or reverted on Cancel/tab switch).
    const handleItemClick = useCallback((e, id, type) => {
        if (!selectMode) return; // let normal click/navigation happen
        e.preventDefault();
        e.stopPropagation();
        // While the bulk save is in flight, extra toggles would be wiped by
        // its success handler (setPendingSelections(new Set())) and silently
        // never persisted — ignore them until the save settles.
        if (savingSelections) return;
        // Toggle the read/watched state
        if (type === 'video') {
            applyLocal('watched', id, !watchedIds.has(id));
        } else {
            applyLocal('read', id, !readIds.has(id));
        }
        toggleSelectItem(id);
    }, [selectMode, savingSelections, watchedIds, readIds, applyLocal, toggleSelectItem]);

    // Props to spread on any media item in select mode vs normal mode
    const itemProps = useCallback((id, type) => {
        if (selectMode) {
            return {
                onClick: (e) => handleItemClick(e, id, type),
                style: { cursor: 'pointer' },
            };
        }
        return {
            onPointerDown: (e) => handlePointerDown(e, id, type),
            onPointerUp: handlePointerUp,
            onPointerLeave: handlePointerUp,
            onContextMenu: (e) => { e.preventDefault(); openContextMenu(e, id, type); },
        };
    }, [selectMode, handleItemClick, handlePointerDown, handlePointerUp, openContextMenu]);

    // Matches .watched-check position & size: bottom:4, right:4, 20x20
    const SelectBox = ({ checked }) => {
        if (!selectMode) return null;
        return (
            <div style={{
                position: 'absolute',
                bottom: 4,
                right: 4,
                width: 20,
                height: 20,
                borderRadius: '50%',
                border: checked ? '2px solid #10b981' : '2px solid white',
                background: checked ? '#16a34a' : 'rgba(255,255,255,0.85)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 5,
                pointerEvents: 'none',
                boxShadow: checked ? '0 2px 6px rgba(16,185,129,0.4)' : '0 1px 3px rgba(0,0,0,0.3)',
                transition: 'all 0.15s ease',
                color: 'white',
            }}>
                {checked && <Check size={12} strokeWidth={3} />}
            </div>
        );
    };

    const formatDate = (dateStr) => {
        if (!dateStr) return '';
        try {
            return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        } catch {
            return dateStr;
        }
    };

    const extractVideoId = (url) => {
        if (!url) return '';
        const match = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
        return match?.[1] || '';
    };

    return (
        <div className="media-page container py-12">
            <div className="header text-center mb-12 page-title-block">
                <h1 className="page-header">Media & Resources</h1>
                <p className="text-gray-500">Blogs, interviews, and updates from the community.</p>
            </div>

            {/* Tab Navigation — switching tabs mid bulk-save would locally
                revert (cancelSelectMode) changes the server then commits, so
                tabs are inert while the save is in flight. */}
            <div className="tabs">
                <button
                    className={`tab-btn ${activeTab === 'substack' ? 'active' : ''}`}
                    onClick={() => { if (savingSelections) return; if (selectMode) cancelSelectMode(); setActiveTab('substack'); }}
                >
                    Substack
                </button>
                <button
                    className={`tab-btn ${activeTab === 'youtube' ? 'active' : ''}`}
                    onClick={() => { if (savingSelections) return; if (selectMode) cancelSelectMode(); setActiveTab('youtube'); }}
                >
                    YouTube
                </button>
                <button
                    className={`tab-btn ${activeTab === 'live' ? 'active' : ''}`}
                    onClick={() => { if (savingSelections) return; if (selectMode) cancelSelectMode(); setActiveTab('live'); }}
                >
                    {liveSettings.livestreamActive && <span className="live-dot" />}
                    Live
                </button>
                {activeTab !== 'live' && (
                    selectMode ? (
                        <button
                            className={`mark-read-trigger ${hasChanges ? 'has-changes' : ''}`}
                            onClick={hasChanges ? saveSelectMode : cancelSelectMode}
                            disabled={savingSelections}
                            title={hasChanges ? 'Save changes' : 'Cancel'}
                        >
                            {savingSelections
                                ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />
                                : hasChanges ? <Check size={16} /> : <X size={16} />}
                        </button>
                    ) : (
                        <button
                            className="mark-read-trigger"
                            onClick={enterSelectMode}
                            title="Mark as Read"
                        >
                            <BookCheck size={16} />
                        </button>
                    )
                )}
                <div className="view-toggle-container" ref={viewRef}>
                    <button
                        className="view-trigger"
                        onClick={() => setViewMenuOpen(!viewMenuOpen)}
                        title="Change view"
                    >
                        {VIEW_OPTIONS.find(v => v.id === viewMode)?.icon && (() => {
                            const Icon = VIEW_OPTIONS.find(v => v.id === viewMode).icon;
                            return <Icon size={16} />;
                        })()}
                    </button>
                    {viewMenuOpen && (
                        <div className="view-menu-dropdown">
                            {VIEW_OPTIONS.map(v => (
                                <button
                                    key={v.id}
                                    onClick={() => { setViewMode(v.id); setPlayingVideoId(null); setViewMenuOpen(false); }}
                                    className={viewMode === v.id ? 'active' : ''}
                                >
                                    <v.icon size={16} /> {v.label}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* Inline sync error (failed toggle / save) */}
            {syncError && (
                <div className="sync-error" role="alert">
                    <span>{syncError}</span>
                    <button onClick={() => setSyncError('')} title="Dismiss" aria-label="Dismiss">
                        <X size={14} />
                    </button>
                </div>
            )}

            {/* Tab Content */}
            <div className="tab-content mt-8">
                {loading ? (
                    <div style={{ textAlign: 'center', padding: '3rem' }}>
                        <Loader2 size={32} style={{ animation: 'spin 1s linear infinite', margin: '0 auto' }} />
                    </div>
                ) : (
                    <>
                        {/* Substack Tab */}
                        {activeTab === 'substack' && (
                            substackItems.length === 0 ? (
                                <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--color-gray-500)' }}>
                                    No blog posts yet.
                                </div>
                            ) : viewMode === 'card' ? (
                                <div className="grid grid-cols-3 gap-lg">
                                    {substackItems.map((item, idx) => {
                                        const isRead = readIds.has(item.link);
                                        return (
                                            <div key={idx} className={`substack-card ${selectMode ? 'select-mode' : ''} ${selectMode && isRead ? 'selected' : ''}`} {...itemProps(item.link, 'article')}>
                                                {item.thumbnail && (
                                                    <div className="card-img" style={{ backgroundImage: `url(${item.thumbnail})` }}>
                                                        <SelectBox checked={isRead} />
                                                        {isRead && <div className="watched-tag">Read</div>}
                                                    </div>
                                                )}
                                                <div className="card-body">
                                                    <div className="meta">{formatDate(item.date)} • {item.author || 'Build In El Salvador'}</div>
                                                    <h3>{item.title}</h3>
                                                    <p>{item.excerpt}</p>
                                                    {!selectMode && <a href={item.link} target="_blank" rel="noopener noreferrer" className="read-more">
                                                        Read on Substack →
                                                    </a>}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            ) : viewMode === 'list' ? (
                                <div className="list-view">
                                    {substackItems.map((item, idx) => {
                                        const isRead = readIds.has(item.link);
                                        return (
                                            <a key={idx} href={selectMode ? undefined : item.link} target={selectMode ? undefined : '_blank'} rel="noopener noreferrer" className={`list-row ${selectMode ? 'select-mode' : ''} ${selectMode && isRead ? 'selected' : ''}`} {...itemProps(item.link, 'article')}>
                                                <div className="list-thumb-wrap">
                                                    {item.thumbnail && (
                                                        <div className="list-thumb" style={{ backgroundImage: `url(${item.thumbnail})` }} />
                                                    )}
                                                    <SelectBox checked={isRead} />
                                                    {!selectMode && isRead && <div className="watched-check"><Check size={12} strokeWidth={3} /></div>}
                                                </div>
                                                <div className="list-info">
                                                    <h3>{item.title}</h3>
                                                    <p>{item.excerpt}</p>
                                                </div>
                                                <div className="list-meta">
                                                    <span>{formatDate(item.date)}</span>
                                                    <span>{item.author || 'Build In El Salvador'}</span>
                                                </div>
                                            </a>
                                        );
                                    })}
                                </div>
                            ) : (
                                <div className="icon-grid">
                                    {substackItems.map((item, idx) => {
                                        const isRead = readIds.has(item.link);
                                        return (
                                            <a key={idx} href={selectMode ? undefined : item.link} target={selectMode ? undefined : '_blank'} rel="noopener noreferrer" className={`icon-tile ${selectMode ? 'select-mode' : ''} ${selectMode && isRead ? 'selected' : ''}`} {...itemProps(item.link, 'article')}>
                                                <div className="icon-thumb" style={{ backgroundImage: item.thumbnail ? `url(${item.thumbnail})` : 'none' }}>
                                                    {!item.thumbnail && <span className="icon-placeholder">📝</span>}
                                                    <SelectBox checked={isRead} />
                                                    {!selectMode && isRead && <div className="watched-check"><Check size={12} strokeWidth={3} /></div>}
                                                </div>
                                                <div className="icon-label">{item.title}</div>
                                            </a>
                                        );
                                    })}
                                </div>
                            )
                        )}

                        {/* YouTube Tab */}
                        {activeTab === 'youtube' && (
                            youtubeItems.length === 0 ? (
                                <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--color-gray-500)' }}>
                                    No videos yet.
                                </div>
                            ) : viewMode === 'card' ? (
                                <div className="grid grid-cols-2 gap-lg">
                                    {youtubeItems.map((item, idx) => {
                                        const autoplay = playingVideoId === item.videoId ? 1 : 0;
                                        const watched = watchedIds.has(item.videoId);
                                        return (
                                            <div key={idx} className={`youtube-card${autoplay ? ' yt-highlighted' : ''}${selectMode ? ' select-mode' : ''}${selectMode && watched ? ' selected' : ''}`} ref={autoplay ? (el) => el?.scrollIntoView({ behavior: 'smooth', block: 'center' }) : undefined} {...(selectMode ? itemProps(item.videoId, 'video') : {})}>
                                                {item.videoId && (
                                                    <div className="youtube-embed"
                                                        {...(selectMode ? {} : itemProps(item.videoId, 'video'))}
                                                    >
                                                        <iframe
                                                            width="100%"
                                                            height="100%"
                                                            src={`https://www.youtube.com/embed/${item.videoId}?autoplay=${autoplay}`}
                                                            title={item.title}
                                                            frameBorder="0"
                                                            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                                                            allowFullScreen
                                                        ></iframe>
                                                        <SelectBox checked={watched} />
                                                        {watched && <div className="watched-tag">Watched</div>}
                                                    </div>
                                                )}
                                                <div className="card-body">
                                                    <div className="meta">{formatDate(item.date)}</div>
                                                    <h3>{item.title}</h3>
                                                    {item.description && <p>{item.description}</p>}
                                                    <a href={item.link} target="_blank" rel="noopener noreferrer" className="read-more">
                                                        Watch on YouTube →
                                                    </a>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            ) : viewMode === 'list' ? (
                                <div className="list-view">
                                    {youtubeItems.map((item, idx) => {
                                        const watched = watchedIds.has(item.videoId);
                                        return (
                                            <div key={idx} className={`list-row ${selectMode ? 'select-mode' : ''} ${selectMode && watched ? 'selected' : ''}`}
                                                {...(selectMode ? itemProps(item.videoId, 'video') : { onClick: () => { setPlayingVideoId(item.videoId); setViewMode('card'); }, ...itemProps(item.videoId, 'video') })}
                                                style={{ cursor: 'pointer' }}
                                            >
                                                <div className="list-thumb-wrap">
                                                    <div className="list-thumb" style={{ backgroundImage: `url(https://img.youtube.com/vi/${item.videoId}/mqdefault.jpg)` }} />
                                                    <SelectBox checked={watched} />
                                                    {!selectMode && watched && <div className="watched-check"><Check size={12} strokeWidth={3} /></div>}
                                                </div>
                                                <div className="list-info">
                                                    <h3>{item.title}</h3>
                                                    {item.description && <p>{item.description}</p>}
                                                </div>
                                                <div className="list-meta">
                                                    <span>{formatDate(item.date)}</span>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            ) : (
                                <div className="icon-grid">
                                    {youtubeItems.map((item, idx) => {
                                        const watched = watchedIds.has(item.videoId);
                                        return (
                                            <div key={idx} className={`icon-tile ${selectMode ? 'select-mode' : ''} ${selectMode && watched ? 'selected' : ''}`}
                                                {...(selectMode ? itemProps(item.videoId, 'video') : { onClick: () => { setPlayingVideoId(item.videoId); setViewMode('card'); }, ...itemProps(item.videoId, 'video') })}
                                                style={{ cursor: 'pointer' }}
                                            >
                                                <div className="icon-thumb" style={{ backgroundImage: `url(https://img.youtube.com/vi/${item.videoId}/mqdefault.jpg)` }}>
                                                    <SelectBox checked={watched} />
                                                    {!selectMode && watched && <div className="watched-check"><Check size={12} strokeWidth={3} /></div>}
                                                </div>
                                                <div className="icon-label">{item.title}</div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )
                        )}

                        {/* Live Tab */}
                        {activeTab === 'live' && (() => {
                            const videoId = extractVideoId(liveSettings.livestreamUrl);
                            const embedDomain = window.location.hostname;

                            if (!liveSettings.livestreamActive || !videoId) {
                                return (
                                    <div className="live-placeholder">
                                        <div className="live-icon">📺</div>
                                        <h3>No livestream currently scheduled</h3>
                                        <p>Check back soon for live content from the Build In El Salvador community.</p>
                                    </div>
                                );
                            }

                            return (
                                <div className="live-layout">
                                    <div className="live-player">
                                        <div className="youtube-embed">
                                            <iframe
                                                src={`https://www.youtube.com/embed/${videoId}?autoplay=1`}
                                                title="Live Stream"
                                                frameBorder="0"
                                                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                                                allowFullScreen
                                            />
                                        </div>
                                    </div>
                                    <div className="live-chat">
                                        <iframe
                                            src={`https://www.youtube.com/live_chat?v=${videoId}&embed_domain=${embedDomain}`}
                                            title="Live Chat"
                                            frameBorder="0"
                                        />
                                    </div>
                                </div>
                            );
                        })()}
                    </>
                )}
            </div>

            {/* Context menu for Watched / Read */}
            {contextMenu && (
                <div ref={contextMenuRef} className="watched-context-menu" style={{ top: contextMenu.y, left: contextMenu.x }}>
                    {contextMenu.type === 'video' ? (
                        <button onClick={() => toggleWatched(contextMenu.id)}>
                            <Check size={14} />
                            {watchedIds.has(contextMenu.id) ? 'Mark as Unwatched' : 'Mark as Watched'}
                        </button>
                    ) : (
                        <button onClick={() => toggleRead(contextMenu.id)}>
                            <Check size={14} />
                            {readIds.has(contextMenu.id) ? 'Mark as Unread' : 'Mark as Read'}
                        </button>
                    )}
                </div>
            )}

            <style jsx>{`
        .tabs {
          display: flex;
          align-items: stretch;
          height: 50px;
          margin-bottom: 0;
          width: 100%;
        }

        .tab-btn {
          flex: 1 1 0%;
          min-width: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          font-size: 15px;
          font-weight: 600;
          background: none;
          border: none;
          border-bottom: 2px solid transparent;
          color: var(--feed-text-tertiary, #64748B);
          cursor: pointer;
          transition: color 0.15s, border-color 0.15s;
          padding: 0 16px;
        }
        .tab-btn:hover {
          color: var(--feed-text-secondary, #CBD5E1);
        }
        .tab-btn.active {
          color: var(--feed-text-primary, #F8FAFC);
          border-bottom-color: var(--feed-accent, #5b9cf6);
        }

        /* Substack Cards */
        .substack-card {
          background: var(--color-surface);
          border-radius: var(--radius-lg);
          overflow: hidden;
          border: 1px solid var(--color-gray-200);
          transition: transform 0.2s, box-shadow 0.2s;
        }
        .substack-card:hover {
          transform: translateY(-4px);
          box-shadow: var(--shadow-md);
        }
        .card-img {
          position: relative;
          height: 200px;
          background: var(--color-gray-200);
          background-size: cover;
          background-position: center;
          border-radius: var(--radius-lg, 12px) var(--radius-lg, 12px) 0 0;
          overflow: hidden;
        }
        .card-body {
          padding: 1.5rem;
        }
        .meta {
          font-size: 0.8rem;
          color: var(--color-gray-400);
          margin-bottom: 0.5rem;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .substack-card h3 {
          font-size: 1.25rem;
          margin-bottom: 0.75rem;
          line-height: 1.3;
          color: var(--color-gray-900);
        }
        .substack-card p {
          font-size: 0.95rem;
          color: var(--color-gray-500);
          margin-bottom: 1.5rem;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .read-more {
          color: var(--color-primary);
          font-weight: 600;
          font-size: 0.9rem;
          text-decoration: none;
          transition: color 0.2s;
        }
        .read-more:hover {
          color: var(--color-primary-dark);
        }

        /* YouTube Cards */
        .youtube-card {
          background: var(--color-surface);
          border-radius: var(--radius-lg);
          overflow: hidden;
          border: 1px solid var(--color-gray-200);
          transition: transform 0.2s, box-shadow 0.2s;
        }
        .youtube-card:hover {
          transform: translateY(-4px);
          box-shadow: var(--shadow-md);
        }
        .youtube-embed {
          width: 100%;
          padding-bottom: 56.25%; /* 16:9 aspect ratio */
          position: relative;
          height: 0;
          overflow: hidden;
          background: var(--color-gray-200);
        }
        .youtube-embed iframe {
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          border: none;
        }
        .youtube-card .card-body {
          padding: 1.5rem;
        }
        .youtube-card h3 {
          font-size: 1.15rem;
          margin-bottom: 0.5rem;
          line-height: 1.3;
          color: var(--color-gray-900);
        }
        .youtube-card p {
          font-size: 0.9rem;
          color: var(--color-gray-500);
          margin-bottom: 1.5rem;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }

        /* Live Tab - Pulsing Dot */
        .live-dot {
          display: inline-block;
          width: 6px;
          height: 6px;
          background: #EF4444;
          border-radius: 50%;
          margin-right: 4px;
          animation: pulse 1.5s ease-in-out infinite;
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.6; transform: scale(1.4); }
        }

        /* Live Layout: player left (65%), chat right (35%) */
        .live-layout {
          display: grid;
          grid-template-columns: 65fr 35fr;
          gap: 1.5rem;
          align-items: start;
        }
        .live-player {
          width: 100%;
        }
        .live-player .youtube-embed {
          width: 100%;
          padding-bottom: 56.25%;
          position: relative;
          height: 0;
        }
        .live-player .youtube-embed iframe {
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
        }
        .live-chat iframe {
          width: 100%;
          height: 600px;
          border: 1px solid var(--color-gray-200);
          border-radius: var(--radius-lg);
        }

        /* Live Placeholder */
        .live-placeholder {
          text-align: center;
          padding: 4rem 2rem;
          color: var(--color-gray-500);
        }
        .live-icon {
          font-size: 3rem;
          margin-bottom: 1rem;
        }
        .live-placeholder h3 {
          font-size: 1.25rem;
          margin-bottom: 0.5rem;
          color: var(--color-neutral-dark);
        }

        /* YouTube highlighted card (auto-playing from list/icon click) */
        .yt-highlighted {
          box-shadow: 0 0 0 2px var(--color-primary), var(--shadow-md);
        }

        /* View Toggle Dropdown */
        .view-toggle-container {
          position: relative;
          flex: 0 0 auto;
          display: flex;
          align-items: center;
          padding-left: 0.5rem;
        }
        .mark-read-trigger {
          display: flex;
          align-items: center;
          align-self: center;
          justify-content: center;
          width: 34px;
          height: 34px;
          border-radius: 8px;
          border: none;
          cursor: pointer;
          background: transparent;
          color: #9ca3af;
          transition: all 0.15s;
        }
        .mark-read-trigger:hover {
          color: var(--color-primary);
          background: var(--color-gray-100);
        }
        .mark-read-trigger.has-changes {
          color: #10b981;
          background: rgba(16, 185, 129, 0.1);
        }
        .mark-read-trigger:disabled {
          opacity: 0.6;
          cursor: default;
        }

        /* Inline sync error banner */
        .sync-error {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          margin-top: 0.75rem;
          padding: 8px 12px;
          background: rgba(239, 68, 68, 0.08);
          border: 1px solid rgba(239, 68, 68, 0.35);
          border-radius: var(--radius-md);
          color: #ef4444;
          font-size: 0.85rem;
          font-weight: 500;
        }
        .sync-error button {
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          border: none;
          background: transparent;
          color: inherit;
          cursor: pointer;
          padding: 2px;
          border-radius: 4px;
        }
        .sync-error button:hover {
          background: rgba(239, 68, 68, 0.15);
        }

        /* select-circle styles are now inline — no styled-jsx needed */

        .view-trigger {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 34px;
          height: 34px;
          border-radius: 8px;
          border: none;
          cursor: pointer;
          background: transparent;
          color: var(--feed-text-tertiary, #64748B);
          transition: color 0.15s;
        }
        .view-trigger:hover {
          color: var(--feed-text-secondary, #CBD5E1);
          background: var(--color-gray-100, #1E293B);
        }
        .view-menu-dropdown {
          position: absolute;
          top: calc(100% + 6px);
          right: 0;
          background: var(--color-surface);
          border: 1px solid var(--color-gray-200);
          border-radius: var(--radius-md);
          padding: 0.25rem;
          z-index: 50;
          box-shadow: var(--shadow-md);
          min-width: 140px;
          display: flex;
          flex-direction: column;
          gap: 2px;
          animation: viewDropIn 0.15s ease-out;
        }
        .view-menu-dropdown button {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 10px;
          border: none;
          background: transparent;
          color: inherit;
          border-radius: var(--radius-md);
          cursor: pointer;
          font-weight: 500;
          font-size: 0.85rem;
          width: 100%;
          transition: background 0.1s;
        }
        .view-menu-dropdown button:hover {
          background: var(--color-gray-100);
        }
        .view-menu-dropdown button.active {
          background: var(--color-primary);
          color: white;
        }
        @keyframes viewDropIn {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0); }
        }

        /* Watched Tag (card view) */
        .watched-tag {
          position: absolute;
          top: 8px;
          right: 8px;
          background: #16a34a;
          color: white;
          font-size: 0.7rem;
          font-weight: 700;
          padding: 3px 8px;
          border-radius: 4px;
          letter-spacing: 0.03em;
          z-index: 2;
          pointer-events: none;
        }

        /* Watched Check (list + icon thumbnails) */
        .watched-check {
          position: absolute;
          bottom: 4px;
          right: 4px;
          width: 20px;
          height: 20px;
          background: #16a34a;
          color: white;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          border: 2px solid white;
          z-index: 2;
          pointer-events: none;
        }

        /* List thumb wrapper for positioning the check */
        .list-thumb-wrap {
          position: relative;
          flex-shrink: 0;
        }

        /* Context Menu */
        .watched-context-menu {
          position: fixed;
          z-index: 9999;
          background: var(--color-surface);
          border: 1px solid var(--color-gray-200);
          border-radius: var(--radius-md);
          box-shadow: var(--shadow-lg);
          padding: 0.25rem;
          min-width: 180px;
          animation: viewDropIn 0.12s ease-out;
        }
        .watched-context-menu button {
          display: flex;
          align-items: center;
          gap: 8px;
          width: 100%;
          padding: 10px 12px;
          border: none;
          background: transparent;
          color: inherit;
          border-radius: var(--radius-sm);
          cursor: pointer;
          font-size: 0.875rem;
          font-weight: 500;
          transition: background 0.1s;
        }
        .watched-context-menu button:hover {
          background: var(--color-gray-100);
        }

        /* List View */
        .list-view {
          display: flex;
          flex-direction: column;
          gap: 1px;
          background: var(--color-gray-200);
          border: 1px solid var(--color-gray-200);
          border-radius: var(--radius-lg);
          overflow: hidden;
        }
        .list-row {
          display: flex;
          align-items: center;
          gap: 1rem;
          padding: 0.875rem 1.25rem;
          background: var(--color-surface);
          text-decoration: none;
          transition: background 0.15s;
        }
        .list-row:hover {
          background: var(--color-gray-50, #f9fafb);
        }
        .list-thumb {
          width: 72px;
          height: 48px;
          border-radius: 6px;
          background-size: cover;
          background-position: center;
          background-color: var(--color-gray-200);
          flex-shrink: 0;
        }
        .list-info {
          flex: 1;
          min-width: 0;
        }
        .list-info h3 {
          font-size: 0.95rem;
          font-weight: 600;
          color: var(--color-gray-900);
          margin: 0 0 0.2rem;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .list-info p {
          font-size: 0.8rem;
          color: var(--color-gray-500);
          margin: 0;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .list-meta {
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 0.15rem;
          flex-shrink: 0;
          white-space: nowrap;
        }
        .list-meta span {
          font-size: 0.75rem;
          color: var(--color-gray-400);
        }

        /* Icon / Grid View */
        .icon-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 1rem;
        }
        .icon-tile {
          text-decoration: none;
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
          transition: transform 0.15s;
        }
        .icon-tile:hover {
          transform: translateY(-2px);
        }
        .icon-thumb {
          position: relative;
          width: 100%;
          aspect-ratio: 1;
          border-radius: var(--radius-lg);
          background-size: cover;
          background-position: center;
          background-color: var(--color-gray-200);
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .icon-placeholder {
          font-size: 2rem;
        }
        .icon-label {
          font-size: 0.8rem;
          font-weight: 600;
          color: var(--color-gray-900);
          line-height: 1.3;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
          text-align: center;
        }

        @media (max-width: 768px) {
          .media-page { padding-top: var(--page-top, 1rem) !important; }
          .grid-cols-3,
          .grid-cols-2 {
            grid-template-columns: 1fr;
          }
          .icon-grid {
            grid-template-columns: repeat(3, 1fr);
            gap: 0.75rem;
          }
          .list-thumb {
            width: 56px;
            height: 38px;
          }
          .list-meta {
            display: none;
          }
          .page-header {
            display: none !important;
          }
          .live-layout {
            grid-template-columns: 1fr;
          }
          .live-chat iframe {
            height: 400px;
          }
        }
      `}</style>
      <style>{`
        .select-mode {
          position: relative;
          cursor: pointer !important;
          user-select: none;
          -webkit-user-select: none;
          transition: all 0.2s ease;
          border-radius: var(--radius-lg, 12px);
        }
        .select-mode.selected {
          outline: 3px solid #10b981;
          outline-offset: -1px;
          border-radius: var(--radius-lg, 12px);
        }
      `}</style>
        </div>
    );
};

export default Media;
