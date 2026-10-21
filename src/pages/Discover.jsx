import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Search, MapPin, Loader2, User, LayoutGrid, List as ListIcon, Columns } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { profilesApi, preferencesApi } from '../services/api';
import ZapButton from '../components/ZapButton';
import FollowIconButton from '../components/FollowIconButton';
import Avatar from '../components/Avatar';
import { cachedList, rememberList } from '../utils/listCache';
import { useAuth } from '../context/AuthContext';
import { stripHtml } from '../utils/text';

// A member's headline: "Title at Company", or whichever they gave.
const headline = (m) => (m.title && m.company ? `${m.title} at ${m.company}` : m.title || m.company || '');

/**
 * The member directory (/members): search, with no filters for now. Members
 * don't have roles yet, so there's no role filter or role badge anywhere;
 * they'll be added as they develop (Mike, 2026-10-13). It was Discover,
 * projects and members; projects are Opportunities now (/opportunities), and
 * /discover leads here.
 */
const Discover = () => {
  const { t } = useTranslation();
  const location = useLocation();
  const { user } = useAuth();
  const [searchQuery, setSearchQuery] = useState('');
  // Icons until a member picks another layout, here or in Settings.
  const [memberViewType, setMemberViewType] = useState(() => localStorage.getItem('bies_members_view') || 'icons');
  const [viewMenuOpen, setViewMenuOpen] = useState(false);

  // A layout choice: kept on this device and in the account (as Settings does).
  const pickView = (value) => {
    setMemberViewType(value);
    setViewMenuOpen(false);
    localStorage.setItem('bies_members_view', value);
    preferencesApi.save({ membersView: value }).catch(() => {});
  };

  const [builders, setBuilders] = useState([]);
  const [buildersLoading, setBuildersLoading] = useState(false);
  const [buildersPage, setBuildersPage] = useState(1);
  const [buildersHasMore, setBuildersHasMore] = useState(false);
  const buildersRequest = useRef(0);
  const buildersEnd = useRef(null);
  const [followingIds, setFollowingIds] = useState(new Set());

  // Read the URL query param ?q= on load
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const q = params.get('q');
    if (q) {
      setSearchQuery(q);
    }
  }, [location.search]);

  // Members load a screenful or more at a time as you scroll down (Icons
  // shows many per screen, so 48; cards fewer, so 24); a new search starts
  // again from the top. Coming back shows what was loaded (utils/listCache.js).
  const pageSize = memberViewType === 'icons' ? 48 : 24;
  const listKey = `members:${pageSize}:${searchQuery}`;
  const loadBuilders = useCallback(async (pageToLoad) => {
    const request = ++buildersRequest.current;
    setBuildersLoading(true);
    try {
      // Only what the cards show; a member's page fetches their full profile.
      const params = { page: pageToLoad, limit: pageSize, fields: 'card' };
      if (searchQuery) params.search = searchQuery;

      const result = await profilesApi.list(params);
      if (request !== buildersRequest.current) return;

      const list = Array.isArray(result?.data) ? result.data : Array.isArray(result) ? result : [];
      const hasMore = pageToLoad < (result?.pagination?.totalPages || 1);
      setBuilders((prev) => {
        let next = list;
        if (pageToLoad !== 1) {
          const seen = new Set(prev.map((b) => b.id));
          next = [...prev, ...list.filter((b) => !seen.has(b.id))];
        }
        rememberList(listKey, { builders: next, page: pageToLoad, hasMore, at: Date.now() });
        return next;
      });
      setBuildersPage(pageToLoad);
      setBuildersHasMore(hasMore);
    } catch (err) {
      if (request !== buildersRequest.current) return;
      console.error('Fetch builders error:', err);
      if (pageToLoad === 1) setBuilders([]);
      setBuildersHasMore(false);
    } finally {
      if (request === buildersRequest.current) setBuildersLoading(false);
    }
  }, [searchQuery, pageSize, listKey]);

  // Shown in the last 2 minutes: as it was, scrolled-in members included.
  // Older: shown at once, then the first page is fetched again.
  useEffect(() => {
    const seen = cachedList(listKey);
    if (seen) {
      setBuilders(seen.builders);
      setBuildersPage(seen.page);
      setBuildersHasMore(seen.hasMore);
      if (Date.now() - seen.at < 2 * 60_000) return undefined;
    }
    const debounce = setTimeout(() => loadBuilders(1), seen ? 0 : 300);
    return () => clearTimeout(debounce);
  }, [loadBuilders, listKey]);

  // Who you follow, for the Follow buttons: only the List and Standard views
  // have them, so Icons doesn't wait for it. Fetched once per visit.
  const showsFollow = memberViewType !== 'icons';
  const followingLoaded = useRef(false);
  useEffect(() => {
    if (!showsFollow || !user?.id || followingLoaded.current) return;
    followingLoaded.current = true;
    profilesApi.getFollowing(user.id, { limit: 100 }).then((res) => {
      const fList = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
      setFollowingIds(new Set(fList.map((u) => u.id)));
    }).catch(() => { followingLoaded.current = false; });
  }, [showsFollow, user?.id]);

  // The next batch once the end of the list comes near the screen.
  useEffect(() => {
    const end = buildersEnd.current;
    if (!end || !buildersHasMore || buildersLoading) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) loadBuilders(buildersPage + 1);
    }, { rootMargin: '300px 0px' });
    observer.observe(end);
    return () => observer.disconnect();
  }, [buildersHasMore, buildersLoading, buildersPage, loadBuilders]);

  return (
    <div className="discover-page container">
      {/* Header */}
      <h1 className="page-header" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>{t('discover.members', 'Members')}</h1>

      <div className="search-row">
        <div style={{ display: 'flex', flex: 1, gap: '0.75rem', alignItems: 'center', minWidth: 0, maxWidth: '100%' }}>
          <div className="search-bar">
            <Search size={20} className="search-icon" />
            <input
              type="text"
              placeholder={t('discover.searchMembers')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="search-input"
            />
            <div className="view-toggle-container" style={{ position: 'relative' }}>
              <button className="mobile-filter-toggle" style={{ display: 'flex', marginRight: '0.25rem' }} onClick={() => setViewMenuOpen(!viewMenuOpen)} aria-label="Toggle View">
                {memberViewType === 'icons' && <LayoutGrid size={20} />}
                {memberViewType === 'list' && <ListIcon size={20} />}
                {memberViewType === 'standard' && <Columns size={20} />}
              </button>
              {viewMenuOpen && (
                <div className="view-menu-dropdown" style={{
                  position: 'absolute', top: '100%', right: 0, marginTop: '0.5rem',
                  background: 'var(--color-surface)', border: '1px solid var(--color-gray-200)',
                  borderRadius: 'var(--radius-md)', padding: '0.5rem', zIndex: 50,
                  boxShadow: 'var(--shadow-md)', minWidth: '160px',
                  display: 'flex', flexDirection: 'column', gap: '4px'
                }}>
                  <button onClick={() => pickView('icons')} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', border: 'none', background: memberViewType==='icons'?'var(--color-primary)':'transparent', color: memberViewType==='icons'?'white':'inherit', borderRadius: '4px', cursor:'pointer', fontWeight: 500 }}>
                    <LayoutGrid size={16}/> Icons
                  </button>
                  <button onClick={() => pickView('list')} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', border: 'none', background: memberViewType==='list'?'var(--color-primary)':'transparent', color: memberViewType==='list'?'white':'inherit', borderRadius: '4px', cursor:'pointer', fontWeight: 500 }}>
                    <ListIcon size={16}/> List
                  </button>
                  <button onClick={() => pickView('standard')} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', border: 'none', background: memberViewType==='standard'?'var(--color-primary)':'transparent', color: memberViewType==='standard'?'white':'inherit', borderRadius: '4px', cursor:'pointer', fontWeight: 500 }}>
                    <Columns size={16}/> Standard
                  </button>
                </div>
              )}
            </div>
            <button className="btn btn-primary search-btn-desktop" onClick={() => { }}>{t('common.search')}</button>
          </div>
        </div>
      </div>

      <div className="content-layout">
        <div style={{ flex: 1, width: '100%' }}>
            {buildersLoading && builders.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '3rem' }}>
                    <Loader2 size={32} style={{ animation: 'spin 1s linear infinite', margin: '0 auto' }} />
                </div>
            ) : builders.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--color-gray-500)' }}>
                    {searchQuery ? t('discover.noMembersSearch', { query: searchQuery }) : t('discover.noMembersFound', 'No members found')}
                </div>
            ) : (
                <div className={`builders-layout-${memberViewType}`}>
                    {builders.map((builder) => {
                        const targetUserId = builder.user?.id || builder.userId;
                        const avatarContent = (
                            <Avatar
                                src={builder.avatar || builder.image}
                                alt={builder.name}
                                size={memberViewType === 'icons' ? 72 : 96}
                                className="builder-avatar-img w-full h-full object-cover"
                                fallback={
                                    <div className="builder-avatar-fallback w-full h-full" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                        <User size={memberViewType === 'icons' ? 32 : 48} style={{ color: 'var(--color-gray-300)' }} />
                                    </div>
                                }
                            />
                        );
                        
                        // Like a LinkedIn card: the headline and location say who they are;
                        // a few of their own tags, and no role badges (no roles yet).
                        const tags = (builder.skills || builder.tags || []).slice(0, 3);
                        const subline = builder.location
                            ? <><MapPin size={13} aria-hidden="true" /><span className="builder-subline-text">{builder.location}</span></>
                            : !builder.title && !builder.company && builder.bio
                                ? <span className="builder-subline-text">{stripHtml(builder.bio)}</span> : '';

                        if (memberViewType === 'icons') {
                            return (
                                <Link to={`/builder/${builder.id}`} key={builder.id} className="builder-card-link-icons" title={builder.name}>
                                    <div className="builder-card-icons">
                                        <div className="builder-avatar-wrap-icons">
                                            {avatarContent}
                                        </div>
                                        <h3 className="builder-name-icons">{builder.name}</h3>
                                    </div>
                                </Link>
                            );
                        }

                        if (memberViewType === 'list') {
                            return (
                                <Link to={`/builder/${builder.id}`} key={builder.id} className="builder-card-link-list">
                                    <div className="builder-card-list">
                                        <div className="builder-avatar-wrap-list relative">
                                            {avatarContent}
                                        </div>
                                        <div className="builder-info-list" style={{ flex: 1, overflow: 'hidden' }}>
                                            <h3 className="font-semibold text-lg builder-name-clamp">{builder.name}</h3>
                                            {(builder.company || builder.title || builder.role) && (
                                                <p className="text-primary font-medium text-sm" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                                    {headline(builder)}
                                                </p>
                                            )}
                                            {subline && <p className="builder-subline">{subline}</p>}
                                            {tags.length > 0 && (
                                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '8px' }}>
                                                    {tags.map((tag, i) => (
                                                        <span key={i} className="builder-tag" style={{ padding: '2px 8px', fontSize: '0.75rem' }}>{tag}</span>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                        <div className="builder-actions-list" style={{ display: 'flex', gap: '8px' }}>
                                            {builder.user?.nostrPubkey && <ZapButton recipients={[{ pubkey: builder.user.nostrPubkey, name: builder.name, avatar: builder.avatar }]} size="sm" />}
                                            {user && targetUserId && user.id !== targetUserId && (
                                                <FollowIconButton
                                                    targetUserId={targetUserId}
                                                    isFollowing={followingIds.has(targetUserId)}
                                                    onToggle={(isFollowing) => {
                                                        const newSet = new Set(followingIds);
                                                        if (isFollowing) newSet.add(targetUserId);
                                                        else newSet.delete(targetUserId);
                                                        setFollowingIds(newSet);
                                                    }}
                                                />
                                            )}
                                        </div>
                                    </div>
                                </Link>
                            );
                        }

                        return (
                            <Link to={`/builder/${builder.id}`} key={builder.id} className="builder-card-link">
                                <div className="builder-card">
                                    <div className="h-48 bg-gray-100 relative builder-avatar-wrap-standard">
                                        {avatarContent}
                                    </div>
                                    <div className="p-5 flex-1 flex flex-col">
                                        <h3 className="font-semibold text-xl mb-1">{builder.name}</h3>
                                        {(builder.company || builder.title) && <p className="text-primary font-medium text-sm mb-2">{headline(builder)}</p>}
                                        {builder.location && <p className="builder-subline mb-2"><MapPin size={13} aria-hidden="true" /><span className="builder-subline-text">{builder.location}</span></p>}
                                        <p className="text-sm text-gray-500 line-clamp-2 mb-4">{stripHtml(builder.bio || '')}</p>

                                        {tags.length > 0 && (
                                            <div className="flex flex-wrap gap-2 mb-4">
                                                {tags.map((tag, i) => (
                                                    <span key={i} className="builder-tag">{tag}</span>
                                                ))}
                                            </div>
                                        )}

                                        <div className="builder-actions mt-auto">
                                            {user && targetUserId && user.id !== targetUserId && (
                                                <FollowIconButton
                                                    targetUserId={targetUserId}
                                                    isFollowing={followingIds.has(targetUserId)}
                                                    onToggle={(isFollowing) => {
                                                        const newSet = new Set(followingIds);
                                                        if (isFollowing) newSet.add(targetUserId);
                                                        else newSet.delete(targetUserId);
                                                        setFollowingIds(newSet);
                                                    }}
                                                />
                                            )}
                                            {builder.user?.nostrPubkey && (
                                                <ZapButton
                                                    recipients={[{ pubkey: builder.user.nostrPubkey, name: builder.name, avatar: builder.avatar }]}
                                                    size="sm"
                                                />
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </Link>
                        );
                    })}
                </div>
            )}
            {buildersHasMore && builders.length > 0 && (
                <div ref={buildersEnd} className="members-more" aria-live="polite">
                    {buildersLoading && <Loader2 size={24} style={{ animation: 'spin 1s linear infinite' }} aria-label={t('common.loading', 'Loading')} />}
                </div>
            )}
        </div>
      </div>

      <style jsx>{`
        .discover-page {
          padding-top: var(--page-top, 2rem);
          padding-bottom: 4rem;
          overflow-x: hidden;
          box-sizing: border-box;
        }

        .search-row {
          display: flex;
          align-items: center;
          gap: 2rem;
          margin-bottom: 2rem;
          max-width: 100%;
          box-sizing: border-box;
        }

        .search-bar {
          display: flex;
          align-items: center;
          flex: 1;
          min-width: 0;
          background: var(--color-surface-raised);
          padding: 0.5rem;
          border-radius: var(--radius-full);
          border: 1px solid var(--color-gray-200);
          box-shadow: var(--shadow-sm);
          transition: all 0.2s;
        }
        .search-bar:focus-within { 
            border-color: var(--color-primary); 
            box-shadow: 0 0 0 3px rgba(0, 71, 171, 0.1); 
            background: var(--color-surface-raised); 
        }

        .search-icon {
          margin-left: 1rem;
          color: var(--color-gray-400);
        }

        input {
          flex: 1;
          border: none;
          padding: 0.5rem 1rem;
          outline: none;
          font-size: 1rem;
        }
        .search-input:focus { outline: none; }

        .search-btn-desktop {
          white-space: nowrap;
          flex-shrink: 0;
        }

        /* Member cards */
        .builder-name-clamp {
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
          word-break: break-word;
        }
        .builder-subline {
          display: flex;
          align-items: center;
          gap: 4px;
          margin: 2px 0 0;
          font-size: 0.82rem;
          color: var(--color-gray-500);
          min-width: 0;
        }
        .builder-subline :global(svg) {
          flex-shrink: 0;
        }
        .builder-subline-text {
          min-width: 0;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        /* Layout */
        .content-layout {
          display: flex;
          gap: 2rem;
          align-items: flex-start;
        }

        .members-more {
          display: flex;
          justify-content: center;
          align-items: center;
          min-height: 64px;
          color: var(--color-gray-500);
        }

        .mobile-filter-toggle {
          display: none;
          align-items: center;
          justify-content: center;
          width: 40px;
          height: 40px;
          border-radius: 50%;
          border: none;
          background: none;
          color: var(--color-gray-500);
          cursor: pointer;
          flex-shrink: 0;
          position: relative;
        }

        @media (max-width: 768px) {
          .page-header { display: none !important; }
          .search-row { flex-direction: column; align-items: stretch; gap: 1rem; }
          .content-layout { flex-direction: column; align-items: stretch; }
          .mobile-filter-toggle { display: flex; }
          .search-btn-desktop { display: none; }
        }

        .builders-layout-standard {
          display: grid;
          gap: 1.5rem;
          grid-template-columns: repeat(1, 1fr);
        }
        @media (min-width: 640px) {
          .builders-layout-standard {
            grid-template-columns: repeat(2, 1fr);
          }
        }
        @media (min-width: 1024px) {
          .builders-layout-standard {
            grid-template-columns: repeat(3, 1fr);
          }
        }

        .builders-layout-icons {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(80px, 1fr));
          gap: 1.5rem;
          justify-items: center;
          padding: 1rem 0;
        }
        .builders-layout-list {
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }

        /* List View Styles */
        .builder-card-link-list { text-decoration: none; color: inherit; display: block; }
        .builder-card-list {
          display: flex;
          align-items: center;
          padding: 1rem;
          background: var(--color-surface);
          border-radius: var(--radius-xl);
          border: 1px solid var(--color-gray-200);
          gap: 1.25rem;
          transition: transform 0.2s, box-shadow 0.2s, border-color 0.2s;
        }
        .builder-card-list:hover {
          border-color: var(--color-primary-light);
          box-shadow: var(--shadow-sm);
        }
        .builder-avatar-wrap-list {
          width: 64px; height: 64px; border-radius: 50%; overflow: hidden; background: var(--color-gray-100); flex-shrink: 0;
        }

        /* Icons View Styles */
        .builder-card-link-icons { text-decoration: none; color: inherit; display: block; }
        .builder-card-icons {
          display: flex;
          flex-direction: column;
          align-items: center;
          width: 100%;
          max-width: 100px;
          gap: 0.5rem;
          text-align: center;
          transition: all 0.2s;
        }
        .builder-card-icons:hover {
          transform: translateY(-2px);
        }
        .builder-avatar-wrap-icons {
          width: 72px; height: 72px; border-radius: 50%; overflow: hidden; background: var(--color-gray-100); border: 2px solid transparent; transition: border-color 0.2s;
        }
        .builder-card-icons:hover .builder-avatar-wrap-icons { border-color: var(--color-primary); }
        .builder-name-icons {
          font-size: 0.8rem;
          font-weight: 500;
          line-height: 1.2;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
          margin: 0;
        }

        .builder-card {
          background: var(--color-surface);
          border: 1px solid var(--color-gray-200);
          border-radius: var(--radius-lg);
          overflow: hidden;
          transition: transform 0.2s, box-shadow 0.2s;
          height: 100%;
          display: flex;
          flex-direction: column;
        }
        .builder-card:hover { transform: translateY(-4px); box-shadow: var(--shadow-md); }
        .builder-card-link { display: block; text-decoration: none; color: inherit; height: 100%; }
        .h-48 { height: 12rem; }
        .bg-gray-100 { background: var(--color-gray-100); }
        .w-full { width: 100%; }
        .object-cover { object-fit: cover; }
        .builder-tag {
          font-size: 0.75rem;
          padding: 2px 10px;
          background: var(--color-surface-raised);
          border-radius: 99px;
          color: var(--color-gray-600);
          font-weight: 500;
        }
        .line-clamp-2 {
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .builder-actions {
          display: flex;
          justify-content: flex-end;
          gap: 0.75rem;
          align-items: center;
          margin-top: auto;
        }
        .flex { display: flex; }
        .flex-col { flex-direction: column; }
        .flex-1 { flex: 1; }
        .flex-wrap { flex-wrap: wrap; }
        .gap-2 { gap: 0.5rem; }
        .p-5 { padding: 1.25rem; }
        .mb-1 { margin-bottom: 0.25rem; }
        .mb-2 { margin-bottom: 0.5rem; }
        .mb-4 { margin-bottom: 1rem; }
        .mt-auto { margin-top: auto; }
        .font-semibold { font-weight: 600; }
        .font-medium { font-weight: 500; }
        .text-xl { font-size: 1.25rem; }
        .text-sm { font-size: 0.875rem; }
        .text-primary { color: var(--color-primary); }
        .text-gray-500 { color: var(--color-gray-500); }
      `}</style>
    </div>
  );
};

export default Discover;
