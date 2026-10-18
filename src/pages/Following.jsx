import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { useFeature } from '../context/FeatureFlagsContext';
import { Link } from 'react-router-dom';
import { Users, Folder, Loader2, Search, LayoutGrid, List as ListIcon, Columns, X, UserCheck, UserPlus } from 'lucide-react';
import { useApiQuery } from '../hooks/useApi';
import { watchlistApi, profilesApi } from '../services/api';
import { stripHtml } from '../utils/text';

/** Flatten the nested backend shape { id, role, profile: { name, avatar, bio, company } }
 *  into a single flat object the renderer can use. */
const flattenUser = (item) => {
    if (!item) return item;
    const { profile, ...rest } = item;
    return profile ? { ...rest, ...profile } : rest;
};

/** Pick the right public profile route based on role */
const profileLink = (item) => {
    const role = (item.role || '').toLowerCase();
    if (role === 'investor') return `/investor/${item.id}`;
    return `/builder/${item.id}`;
};

const Following = () => {
    const { user } = useAuth();
    // Saved opportunities, while Opportunities is on.
    const opportunitiesOn = useFeature('projects');
    const [activeTab, setActiveTab] = useState(opportunitiesOn ? 'projects' : 'following');
    const [viewMode, setViewMode] = useState('standard');
    const [searchQuery, setSearchQuery] = useState('');
    const [searchExpanded, setSearchExpanded] = useState(false);
    const [viewMenuOpen, setViewMenuOpen] = useState(false);

    // Refs for outside-click dismissal
    const searchRef = useRef(null);
    const viewRef = useRef(null);
    const searchInputRef = useRef(null);

    // ── Data fetching (skip when no user id) ────────────────────────────
    const { data: watchlist, loading: watchlistLoading } = useApiQuery(watchlistApi.list, undefined, { skip: !opportunitiesOn });

    useEffect(() => {
        if (!opportunitiesOn && activeTab === 'projects') setActiveTab('following');
    }, [opportunitiesOn, activeTab]);
    const { data: followingRaw, loading: followingLoading } = useApiQuery(
        profilesApi.getFollowing, user?.id, { skip: !user?.id }
    );
    const { data: followersRaw, loading: followersLoading } = useApiQuery(
        profilesApi.getFollowers, user?.id, { skip: !user?.id }
    );

    // ── Flatten profile data once ────────────────────────────────────────
    const followingList = useMemo(() => {
        const raw = followingRaw?.data || followingRaw || [];
        return (Array.isArray(raw) ? raw : []).map(flattenUser);
    }, [followingRaw]);

    const followersList = useMemo(() => {
        const raw = followersRaw?.data || followersRaw || [];
        return (Array.isArray(raw) ? raw : []).map(flattenUser);
    }, [followersRaw]);

    const projectsList = useMemo(() => {
        const raw = watchlist?.data || watchlist || [];
        return Array.isArray(raw) ? raw : [];
    }, [watchlist]);

    // ── Tab config with live counts ─────────────────────────────────────
    const tabs = [
        opportunitiesOn && { id: 'projects', label: 'Opportunities', icon: Folder, count: projectsList.length },
        { id: 'following', label: 'Following', icon: UserCheck, count: followingList.length },
        { id: 'followers', label: 'Followers', icon: UserPlus, count: followersList.length },
    ].filter(Boolean);

    // ── Per-tab loading (only show spinner for the active tab) ───────────
    const loading =
        (activeTab === 'projects' && watchlistLoading) ||
        (activeTab === 'following' && followingLoading) ||
        (activeTab === 'followers' && followersLoading);

    // ── Filtered list ────────────────────────────────────────────────────
    const currentList = useMemo(() => {
        let list = [];
        if (activeTab === 'projects') list = projectsList;
        else if (activeTab === 'following') list = followingList;
        else if (activeTab === 'followers') list = followersList;

        if (!searchQuery) return list;

        const q = searchQuery.toLowerCase();
        return list.filter(item => {
            const data = activeTab === 'projects' ? (item.project || item) : item;
            const name = (data.title || data.name || '').toLowerCase();
            const bio = (data.description || data.bio || '').toLowerCase();
            const tagline = (data.tagline || data.company || '').toLowerCase();
            return name.includes(q) || bio.includes(q) || tagline.includes(q);
        });
    }, [activeTab, projectsList, followingList, followersList, searchQuery]);

    // ── Close dropdowns on outside click ─────────────────────────────────
    useEffect(() => {
        const handler = (e) => {
            if (searchExpanded && searchRef.current && !searchRef.current.contains(e.target)) {
                setSearchExpanded(false);
            }
            if (viewMenuOpen && viewRef.current && !viewRef.current.contains(e.target)) {
                setViewMenuOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [searchExpanded, viewMenuOpen]);

    // Auto-focus search input when expanded
    useEffect(() => {
        if (searchExpanded && searchInputRef.current) {
            searchInputRef.current.focus();
        }
    }, [searchExpanded]);

    // ── Render helpers ───────────────────────────────────────────────────
    const renderItem = useCallback((item) => {
        const isProject = activeTab === 'projects';
        const data = isProject ? (item.project || item) : item;
        const title = isProject ? data.title : (data.name || 'Unknown');
        const link = isProject ? `/opportunities/${data.id}` : profileLink(data);
        const image = isProject
            ? (data.thumbnail || data.coverImage)
            : (data.avatar || data.profilePic);
        const initial = title ? title[0] : '?';
        const key = `${activeTab}-${data.id || item.id}`;

        if (viewMode === 'icons') {
            return (
                <Link key={key} to={link} className="icon-entry" title={title}>
                    <div className="icon-avatar">
                        {image ? <img src={image} alt={title} /> : <span>{initial}</span>}
                    </div>
                    <span className="icon-label">{title}</span>
                </Link>
            );
        }

        if (viewMode === 'list') {
            return (
                <Link key={key} to={link} className="list-entry">
                    <div className="list-avatar">
                        {image ? <img src={image} alt={title} /> : <span>{initial}</span>}
                    </div>
                    <div className="list-info">
                        <h3>{title}</h3>
                        <p>{isProject ? stripHtml(data.description || '') : (data.company || data.role || 'Member')}</p>
                    </div>
                </Link>
            );
        }

        // Standard (card) view
        return (
            <Link key={key} to={link} className="card-link">
                <div className="card">
                    <div className="card-image">
                        {image
                            ? <img src={image} alt={title} />
                            : <div className="placeholder"><Users size={24} /></div>
                        }
                    </div>
                    <div className="card-info">
                        <h3>{title}</h3>
                        <p className="tagline">
                            {stripHtml((isProject ? data.description : data.bio || data.company) || '')}
                        </p>
                    </div>
                </div>
            </Link>
        );
    }, [activeTab, viewMode]);

    // ── Empty-state messaging per tab ────────────────────────────────────
    const emptyMessage = searchQuery
        ? `No results for "${searchQuery}"`
        : activeTab === 'projects'
            ? "You haven't saved any opportunities yet."
            : activeTab === 'following'
                ? "You aren't following anyone yet."
                : "No one is following you yet.";

    const emptyAction = activeTab === 'projects'
        ? { to: '/opportunities', label: 'Find Opportunities' }
        : { to: '/members', label: 'Discover Members' };

    return (
        <div className="following-wrapper">
            <div className="header page-title-block">
                <h1>Network</h1>
                <p className="subtitle">Your connections across the BIES ecosystem.</p>
            </div>

            <div className="tab-control-row">
                <div className="tabs">
                    {tabs.map(t => (
                        <button
                            key={t.id}
                            className={`tab-btn ${activeTab === t.id ? 'active' : ''}`}
                            onClick={() => { setActiveTab(t.id); setSearchQuery(''); setSearchExpanded(false); }}
                        >
                            <span>{t.label}</span>
                            {t.count > 0 && <span className="tab-count">{t.count}</span>}
                        </button>
                    ))}
                </div>

                <div className="controls">
                    <div className="search-dropdown-container" ref={searchRef}>
                        <button
                            className={`control-btn ${searchExpanded ? 'active' : ''}`}
                            onClick={() => { setSearchExpanded(!searchExpanded); setViewMenuOpen(false); }}
                            title="Search"
                        >
                            <Search size={18} />
                        </button>
                        {searchExpanded && (
                            <div className="search-dropdown">
                                <Search size={16} className="search-icon" />
                                <input
                                    ref={searchInputRef}
                                    type="text"
                                    placeholder={`Search ${activeTab}...`}
                                    value={searchQuery}
                                    onChange={e => setSearchQuery(e.target.value)}
                                />
                                {searchQuery && (
                                    <button className="clear-btn" onClick={() => setSearchQuery('')}>
                                        <X size={14} />
                                    </button>
                                )}
                            </div>
                        )}
                    </div>

                    <div className="view-toggle-container" ref={viewRef}>
                        <button
                            className="control-btn"
                            onClick={() => { setViewMenuOpen(!viewMenuOpen); setSearchExpanded(false); }}
                            title="Change view"
                        >
                            {viewMode === 'icons' && <LayoutGrid size={18} />}
                            {viewMode === 'list' && <ListIcon size={18} />}
                            {viewMode === 'standard' && <Columns size={18} />}
                        </button>
                        {viewMenuOpen && (
                            <div className="view-menu-dropdown">
                                {[
                                    { id: 'standard', icon: Columns, label: 'Cards' },
                                    { id: 'list', icon: ListIcon, label: 'List' },
                                    { id: 'icons', icon: LayoutGrid, label: 'Icons' },
                                ].map(v => (
                                    <button
                                        key={v.id}
                                        onClick={() => { setViewMode(v.id); setViewMenuOpen(false); }}
                                        className={viewMode === v.id ? 'active' : ''}
                                    >
                                        <v.icon size={16} /> {v.label}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            <div className="content">
                {loading ? (
                    <div className="loading-state">
                        <Loader2 size={28} className="spinner" />
                    </div>
                ) : currentList.length === 0 ? (
                    <div className="empty-state">
                        {activeTab === 'projects'
                            ? <Folder size={36} className="empty-icon" />
                            : <Users size={36} className="empty-icon" />
                        }
                        <h3>{searchQuery ? 'No matches' : 'Nothing here yet'}</h3>
                        <p>{emptyMessage}</p>
                        {!searchQuery && (
                            <Link to={emptyAction.to} className="btn btn-primary discover-btn">
                                {emptyAction.label}
                            </Link>
                        )}
                    </div>
                ) : (
                    <div className={`results-container mode-${viewMode}`}>
                        {currentList.map(renderItem)}
                    </div>
                )}
            </div>

            <style>{`
                .following-wrapper { max-width: 100%; }
                .header { margin-bottom: 1.5rem; }
                .header h1 { margin: 0 0 0.25rem; }
                .subtitle { color: var(--color-gray-500); margin: 0; }

                /* ── Tabs + Controls row ─────────────────────────── */
                .tab-control-row {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    border-bottom: 1px solid var(--color-gray-200);
                    margin-bottom: 1.5rem;
                    gap: 1rem;
                    flex-wrap: wrap;
                }

                .tabs { display: flex; gap: 0; }
                .tab-btn {
                    display: flex; align-items: center; gap: 6px;
                    padding: 0.75rem 1rem;
                    background: none; border: none;
                    font-weight: 500; font-size: 0.9rem;
                    color: var(--color-gray-500);
                    cursor: pointer; position: relative;
                    white-space: nowrap;
                    transition: color 0.15s;
                }
                .tab-btn:hover { color: var(--color-gray-700); }
                .tab-btn.active { color: var(--color-primary); font-weight: 600; }
                .tab-btn.active::after {
                    content: '';
                    position: absolute;
                    bottom: -1px; left: 0; right: 0;
                    height: 2px;
                    background: var(--color-primary);
                    border-radius: 2px 2px 0 0;
                }
                .tab-count {
                    font-size: 0.7rem; font-weight: 600;
                    background: var(--color-gray-100);
                    color: var(--color-gray-500);
                    padding: 1px 7px;
                    border-radius: 99px;
                    min-width: 20px; text-align: center;
                }
                .tab-btn.active .tab-count {
                    background: var(--color-primary);
                    color: white;
                }

                .controls {
                    display: flex; align-items: center;
                    gap: 0.5rem; padding-bottom: 0.5rem;
                }
                .control-btn {
                    width: 34px; height: 34px;
                    border-radius: 50%;
                    border: 1px solid var(--color-gray-200);
                    background: var(--color-surface);
                    color: var(--color-gray-500);
                    display: flex; align-items: center; justify-content: center;
                    cursor: pointer; transition: all 0.15s;
                }
                .control-btn:hover { border-color: var(--color-primary); color: var(--color-primary); }
                .control-btn.active { border-color: var(--color-primary); background: var(--color-primary); color: white; }

                /* ── Search dropdown ─────────────────────────────── */
                .search-dropdown-container { position: relative; }
                .search-dropdown {
                    position: absolute; top: calc(100% + 6px); right: 0;
                    background: var(--color-surface);
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-full);
                    padding: 0 0.75rem; z-index: 60;
                    box-shadow: var(--shadow-md);
                    min-width: 260px;
                    display: flex; align-items: center; height: 40px;
                    animation: dropIn 0.15s ease-out;
                }
                .search-dropdown input {
                    flex: 1; background: none; border: none;
                    padding: 0 0.75rem; font-size: 0.875rem;
                    outline: none; color: var(--color-gray-800);
                }
                .search-icon { color: var(--color-gray-400); flex-shrink: 0; }
                .clear-btn {
                    background: var(--color-gray-100); border: none;
                    color: var(--color-gray-500); border-radius: 50%;
                    width: 20px; height: 20px;
                    display: flex; align-items: center; justify-content: center;
                    cursor: pointer; flex-shrink: 0;
                }
                .clear-btn:hover { background: var(--color-gray-200); }

                /* ── View menu dropdown ──────────────────────────── */
                .view-toggle-container { position: relative; }
                .view-menu-dropdown {
                    position: absolute; top: calc(100% + 6px); right: 0;
                    background: var(--color-surface);
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-md);
                    padding: 0.25rem; z-index: 50;
                    box-shadow: var(--shadow-md);
                    min-width: 140px;
                    display: flex; flex-direction: column; gap: 2px;
                    animation: dropIn 0.15s ease-out;
                }
                .view-menu-dropdown button {
                    display: flex; align-items: center; gap: 8px;
                    padding: 8px 10px; border: none; background: transparent;
                    color: inherit; border-radius: var(--radius-md);
                    cursor: pointer; font-weight: 500; font-size: 0.85rem;
                    width: 100%; transition: background 0.1s;
                }
                .view-menu-dropdown button:hover { background: var(--color-gray-100); }
                .view-menu-dropdown button.active { background: var(--color-primary); color: white; }

                @keyframes dropIn {
                    from { opacity: 0; transform: translateY(-4px); }
                    to   { opacity: 1; transform: translateY(0); }
                }

                /* ── Loading ─────────────────────────────────────── */
                .loading-state {
                    display: flex; justify-content: center;
                    padding: 4rem; color: var(--color-gray-400);
                }
                .spinner { animation: spin 0.8s linear infinite; }
                @keyframes spin { to { transform: rotate(360deg); } }

                /* ── Empty state ──────────────────────────────────── */
                .empty-state {
                    background: var(--color-surface);
                    text-align: center;
                    padding: 3.5rem 2rem;
                    border-radius: var(--radius-lg);
                    border: 1px solid var(--color-gray-200);
                }
                .empty-icon { color: var(--color-gray-300); margin-bottom: 0.75rem; }
                .empty-state h3 { margin: 0 0 0.5rem; font-size: 1.1rem; }
                .empty-state p { color: var(--color-gray-500); margin: 0 0 1.25rem; }
                .discover-btn {
                    display: inline-block; text-decoration: none;
                    padding: 0.6rem 1.5rem; border-radius: var(--radius-md);
                    font-weight: 600; font-size: 0.875rem;
                }

                /* ── Standard (card) view ────────────────────────── */
                .mode-standard {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
                    gap: 1.25rem;
                }
                .card-link { text-decoration: none; color: inherit; }
                .card {
                    background: var(--color-surface);
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-lg);
                    overflow: hidden;
                    transition: transform 0.2s, box-shadow 0.2s, border-color 0.2s;
                    height: 100%;
                    display: flex; flex-direction: column;
                }
                .card:hover {
                    transform: translateY(-3px);
                    box-shadow: var(--shadow-md);
                    border-color: var(--color-primary-light);
                }
                .card-image {
                    height: 150px;
                    background: var(--color-gray-100);
                    display: flex; align-items: center; justify-content: center;
                    overflow: hidden;
                }
                .card-image img { width: 100%; height: 100%; object-fit: cover; }
                .placeholder { color: var(--color-gray-300); }
                .card-info { padding: 1rem; flex: 1; }
                .card-info h3 {
                    font-size: 1rem; margin: 0 0 0.35rem;
                    color: var(--color-gray-800);
                    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
                }
                .card-info .tagline {
                    font-size: 0.825rem; color: var(--color-gray-500);
                    line-height: 1.45; margin: 0;
                    display: -webkit-box; -webkit-line-clamp: 2;
                    -webkit-box-orient: vertical; overflow: hidden;
                }

                /* ── List view ────────────────────────────────────── */
                .mode-list { display: flex; flex-direction: column; gap: 0.5rem; }
                .list-entry {
                    display: flex; align-items: center; gap: 1rem;
                    padding: 0.75rem 1rem;
                    background: var(--color-surface);
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-lg);
                    text-decoration: none; color: inherit;
                    transition: border-color 0.15s, background 0.15s;
                }
                .list-entry:hover {
                    border-color: var(--color-primary-light);
                    background: var(--color-gray-50);
                }
                .list-avatar {
                    width: 42px; height: 42px; border-radius: 50%;
                    overflow: hidden; background: var(--color-gray-100);
                    flex-shrink: 0;
                    display: flex; align-items: center; justify-content: center;
                    color: var(--color-gray-400); font-weight: 700; font-size: 1rem;
                }
                .list-avatar img { width: 100%; height: 100%; object-fit: cover; }
                .list-info { flex: 1; min-width: 0; }
                .list-info h3 {
                    font-size: 0.925rem; margin: 0;
                    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
                }
                .list-info p {
                    font-size: 0.8rem; color: var(--color-gray-500); margin: 0.15rem 0 0;
                    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
                }

                /* ── Icons view ───────────────────────────────────── */
                .mode-icons {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(80px, 1fr));
                    gap: 1.25rem;
                    justify-items: center;
                }
                .icon-entry {
                    display: flex; flex-direction: column; align-items: center;
                    gap: 0.4rem; text-decoration: none; color: inherit; width: 80px;
                }
                .icon-avatar {
                    width: 60px; height: 60px; border-radius: 50%;
                    overflow: hidden; background: var(--color-gray-100);
                    display: flex; align-items: center; justify-content: center;
                    color: var(--color-gray-400); font-weight: 700; font-size: 1.1rem;
                    border: 2px solid transparent; transition: border-color 0.15s;
                }
                .icon-avatar img { width: 100%; height: 100%; object-fit: cover; }
                .icon-entry:hover .icon-avatar { border-color: var(--color-primary); }
                .icon-label {
                    font-size: 0.725rem; text-align: center; color: var(--color-gray-600);
                    display: -webkit-box; -webkit-line-clamp: 2;
                    -webkit-box-orient: vertical; overflow: hidden;
                    line-height: 1.3;
                }

                /* ── Mobile ──────────────────────────────────────── */
                @media (max-width: 640px) {
                    .tab-btn { padding: 0.6rem 0.75rem; font-size: 0.8rem; }
                    .tab-count { font-size: 0.65rem; padding: 1px 5px; }
                    .search-dropdown { min-width: 200px; }
                    .mode-standard {
                        grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
                    }
                }
            `}</style>
        </div>
    );
};

export default Following;
