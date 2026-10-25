import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Search, MapPin, Loader2, User, LayoutGrid, List as ListIcon, Columns, ArrowUpDown, CalendarDays, Lock } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { profilesApi, preferencesApi } from '../services/api';
import ZapButton from '../components/ZapButton';
import FollowIconButton from '../components/FollowIconButton';
import Avatar from '../components/Avatar';
import { cachedList, rememberList } from '../utils/listCache';
import useVisitState from '../hooks/useVisitState';
import { MEMBER_SORTS, sortOf } from '../utils/listSorts';
import { joinPages, listOf, membersKey, membersPageSize, membersWithNetwork, morePages } from '../utils/listRequests';
import { prefetchDetail } from '../utils/detailCache';
import { profilePage } from '../utils/detailPages';
import { useAuth } from '../context/AuthContext';
import { stripHtml } from '../utils/text';
import { joinedDate } from '../utils/joinedDate';

// A member's headline: "Title at Company", or whichever they gave.
const headline = (m) => (m.title && m.company ? `${m.title} at ${m.company}` : m.title || m.company || '');

// A translation with a person's name in bold: the name goes in as a marker,
// so each language keeps its own word order around it.
const NAME = '\u0001name\u0001';
const withName = (text, name) => {
  const [before, after = ''] = text.split(NAME);
  return <>{before}<b>{name}</b>{after}</>;
};

/**
 * The line at the foot of a member card: people you follow who follow them
 * ("Followed by Ana and 6 others you follow"), else the size of their
 * network, else, when they keep it private, their follower count alone.
 * The server works it out for the viewer (server/src/services/memberNetwork.ts).
 */
const NetworkLine = ({ network }) => {
  const { t } = useTranslation();
  if (!network || (network.hidden ? !network.followers : !network.total)) return null;
  const first = network.people?.[0];
  const text = network.hidden
    ? t('discover.card.networkPrivate', { count: network.followers })
    : network.youFollow > 0 && first
      ? withName(network.youFollow > 1
        ? t('discover.card.followedByMore', { name: NAME, count: network.youFollow - 1 })
        : t('discover.card.followedBy', { name: NAME }), first.name)
      : network.youFollow > 0
        ? t('discover.card.followedByCount', { count: network.youFollow })
        : t('discover.card.network', { count: network.total });
  return (
    <div className="mc-network">
      {network.hidden ? (
        <span className="mc-network-lock"><Lock size={13} aria-hidden="true" /></span>
      ) : network.people.length > 0 && (
        <span className="mc-faces" aria-hidden="true">
          {network.people.map((p) => (
            <span key={p.id} className="mc-face"><Avatar src={p.avatar} size={26} fallback={<User size={14} />} /></span>
          ))}
        </span>
      )}
      <span className="mc-network-text">{text}</span>
      <style jsx>{`
        .mc-network {
          display: flex;
          align-items: center;
          gap: 0.6rem;
          margin-top: auto;
          padding-top: 0.75rem;
          border-top: 1px solid var(--color-gray-200);
          font-size: 0.82rem;
          line-height: 1.35;
          color: var(--color-gray-500);
          min-width: 0;
        }
        .mc-network-text { min-width: 0; }
        .mc-network-text :global(b) { color: var(--color-gray-900); font-weight: 600; }
        .mc-faces { display: flex; flex-shrink: 0; }
        .mc-face {
          width: 26px;
          height: 26px;
          border-radius: 50%;
          overflow: hidden;
          border: 2px solid var(--color-surface);
          background: var(--color-gray-100);
          margin-left: -9px;
          box-sizing: border-box;
          display: grid;
          place-items: center;
          color: var(--color-gray-400);
        }
        .mc-face:first-child { margin-left: 0; }
        .mc-face :global(img) { width: 100%; height: 100%; object-fit: cover; display: block; }
        .mc-network-lock {
          width: 26px;
          height: 26px;
          border-radius: 50%;
          display: grid;
          place-items: center;
          background: var(--color-gray-100);
          flex-shrink: 0;
        }
      `}</style>
    </div>
  );
};

/**
 * The member directory (/members): search, with no filters for now. Members
 * don't have roles yet, so there's no role filter or role badge anywhere;
 * they'll be added as they develop (Mike, 2026-10-13). It was Discover,
 * projects and members; projects are Opportunities now (/opportunities), and
 * /discover leads here.
 */
const Discover = () => {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const { user } = useAuth();
  // As Back brings it back (hooks/useVisitState.js): the same members, at the same place.
  const [searchQuery, setSearchQuery] = useVisitState('members.search', '');
  // Most viewed (''), or another order (utils/listSorts.js), picked in the layout menu.
  const [sortChoice, setSort] = useVisitState('members.sort', '');
  const sort = sortOf(MEMBER_SORTS, sortChoice);
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

  // Members load a screenful or more at a time as you scroll down (Icons
  // shows many per screen, so 48; cards fewer, so 24); a new search starts
  // again from the top. Coming back shows what was loaded (utils/listCache.js),
  // from the first frame.
  const pageSize = membersPageSize(memberViewType);
  const network = membersWithNetwork(memberViewType);
  const listKey = membersKey(pageSize, searchQuery, sort, network);
  const firstSeen = () => cachedList(listKey);
  const [builders, setBuilders] = useState(() => firstSeen()?.builders || []);
  // Loading until the first answer: a spinner, never a moment of "No members found".
  const [buildersLoading, setBuildersLoading] = useState(() => !firstSeen());
  const [buildersPage, setBuildersPage] = useState(() => firstSeen()?.page || 1);
  const [buildersHasMore, setBuildersHasMore] = useState(() => firstSeen()?.hasMore || false);
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

  // Pages pageToLoad to upTo: the next page, or a refresh of every page shown
  // (so the list keeps its length, and Back its place in it).
  const loadBuilders = useCallback(async (pageToLoad, upTo = pageToLoad) => {
    const request = ++buildersRequest.current;
    setBuildersLoading(true);
    try {
      // Only what the cards show; a member's page fetches their full profile.
      const params = (page) => ({
        page, limit: pageSize, fields: 'card', ...(network ? { network: 1 } : {}), ...(searchQuery ? { search: searchQuery } : {}), ...(sort ? { sort } : {}),
      });
      const pages = Array.from({ length: upTo - pageToLoad + 1 }, (_, i) => pageToLoad + i);
      const answers = await Promise.all(pages.map((page) => profilesApi.list(params(page))));
      if (request !== buildersRequest.current) return;

      const list = joinPages(answers.map(listOf));
      const hasMore = morePages(answers[answers.length - 1], upTo);
      setBuilders((prev) => {
        const next = pageToLoad === 1 ? list : joinPages([prev, list]);
        rememberList(listKey, { builders: next, page: upTo, hasMore, at: Date.now() });
        return next;
      });
      setBuildersPage(upTo);
      setBuildersHasMore(hasMore);
    } catch (err) {
      if (request !== buildersRequest.current) return;
      console.error('Fetch builders error:', err);
      if (pageToLoad === 1) setBuilders([]);
      setBuildersHasMore(false);
    } finally {
      if (request === buildersRequest.current) setBuildersLoading(false);
    }
  }, [searchQuery, sort, pageSize, network, listKey]);

  // Shown in the last 2 minutes: as it was, scrolled-in members included.
  // Older: shown at once, then its pages are fetched again. Only typing
  // in search waits (300 ms after the last key); opening the page doesn't.
  const lastSearch = useRef(searchQuery);
  useEffect(() => {
    const typing = searchQuery !== lastSearch.current;
    lastSearch.current = searchQuery;
    const seen = cachedList(listKey);
    if (seen) {
      setBuilders(seen.builders);
      setBuildersPage(seen.page);
      setBuildersHasMore(seen.hasMore);
      if (Date.now() - seen.at < 2 * 60_000) {
        setBuildersLoading(false);
        return undefined;
      }
    }
    const debounce = setTimeout(() => loadBuilders(1, seen?.page || 1), typing && !seen ? 300 : 0);
    return () => clearTimeout(debounce);
  }, [loadBuilders, listKey, searchQuery]);

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
                  <div role="group" aria-labelledby="members-sort-label" style={{ borderTop: '1px solid var(--color-gray-200)', marginTop: '4px', paddingTop: '6px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <span id="members-sort-label" style={{ padding: '0 8px', fontSize: '0.8rem', fontWeight: 600, color: 'var(--color-gray-500)' }}>{t('sort.label')}</span>
                    {MEMBER_SORTS.map((s) => (
                      <button
                        key={s || 'usual'}
                        type="button"
                        aria-pressed={sort === s}
                        onClick={() => { setSort(s); setViewMenuOpen(false); }}
                        style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', border: 'none', background: sort === s ? 'var(--color-primary)' : 'transparent', color: sort === s ? 'white' : 'inherit', borderRadius: '4px', cursor: 'pointer', fontWeight: 500, textAlign: 'left' }}
                      >
                        <ArrowUpDown size={16} aria-hidden="true" /> {t(`sort.members.${s || 'usual'}`)}
                      </button>
                    ))}
                  </div>
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
                                size={memberViewType === 'icons' ? 72 : memberViewType === 'list' ? 64 : 88}
                                className="builder-avatar-img"
                                fallback={
                                    <div className="builder-avatar-fallback w-full h-full" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                        <User size={memberViewType === 'icons' ? 32 : 40} style={{ color: 'var(--color-gray-300)' }} />
                                    </div>
                                }
                            />
                        );
                        
                        // Like a LinkedIn card: the headline and location say who they are;
                        // a few of their own tags, and no role badges (no roles yet).
                        // Skills if they listed any, else their tags: an empty skills list mustn't hide the tags.
                        const tags = (builder.skills?.length ? builder.skills : builder.tags || []).slice(0, 3);
                        const subline = builder.location
                            ? <><MapPin size={13} aria-hidden="true" /><span className="builder-subline-text">{builder.location}</span></>
                            : !builder.title && !builder.company && builder.bio
                                ? <span className="builder-subline-text">{stripHtml(builder.bio)}</span> : '';

                        if (memberViewType === 'icons') {
                            return (
                                <Link to={`/builder/${builder.id}`} key={builder.id} state={{ preview: builder }} onPointerDown={() => prefetchDetail(...profilePage(builder.id))} className="builder-card-link-icons" title={builder.name}>
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
                                <Link to={`/builder/${builder.id}`} key={builder.id} state={{ preview: builder }} onPointerDown={() => prefetchDetail(...profilePage(builder.id))} className="builder-card-link-list">
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

                        // Cards (Mike's pick, 2026-10-24): the photo, then the name and
                        // Follow beside it, as Facebook's "People you may know"; the
                        // details below, and who follows them at the foot. A circle,
                        // cropped like everywhere else, never stretched to the card.
                        const joined = joinedDate(builder.joinedAt, i18n.language);
                        const bio = stripHtml(builder.bio || '');
                        return (
                            <Link to={`/builder/${builder.id}`} key={builder.id} state={{ preview: builder }} onPointerDown={() => prefetchDetail(...profilePage(builder.id))} className="builder-card-link">
                                <article className="member-card">
                                    <div className="mc-top">
                                        <div className="mc-photo">{avatarContent}</div>
                                        <div className="mc-id">
                                            <h3 className="mc-name">{builder.name}</h3>
                                            {(builder.company || builder.title) && <p className="mc-headline">{headline(builder)}</p>}
                                            <div className="mc-actions">
                                                {user && targetUserId && user.id !== targetUserId && (
                                                    <FollowIconButton
                                                        targetUserId={targetUserId}
                                                        isFollowing={followingIds.has(targetUserId)}
                                                        variant="filled"
                                                        onToggle={(isFollowing) => {
                                                            const newSet = new Set(followingIds);
                                                            if (isFollowing) newSet.add(targetUserId);
                                                            else newSet.delete(targetUserId);
                                                            setFollowingIds(newSet);
                                                        }}
                                                    />
                                                )}
                                                {/* Only while the zaps switch is on (Admin → Features): off until the wallet is ready. */}
                                                {builder.user?.nostrPubkey && (
                                                    <ZapButton
                                                        recipients={[{ pubkey: builder.user.nostrPubkey, name: builder.name, avatar: builder.avatar }]}
                                                        size="sm"
                                                    />
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                    {(builder.location || joined) && (
                                        <p className="mc-meta">
                                            {builder.location && <span className="mc-meta-item"><MapPin size={14} aria-hidden="true" /><span className="builder-subline-text">{builder.location}</span></span>}
                                            {joined && <span className="mc-meta-item"><CalendarDays size={14} aria-hidden="true" /><span>{t('profileView.joined', { date: joined })}</span></span>}
                                        </p>
                                    )}
                                    {bio && <p className="mc-bio">{bio}</p>}
                                    {tags.length > 0 && (
                                        <div className="mc-tags">
                                            {tags.map((tag, i) => (
                                                <span key={i} className="builder-tag">{tag}</span>
                                            ))}
                                        </div>
                                    )}
                                    <NetworkLine network={builder.network} />
                                </article>
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
          /* minmax(0, …): a long headline is cut short, never widens the card past the screen */
          grid-template-columns: minmax(0, 1fr);
        }
        @media (min-width: 640px) {
          .builders-layout-standard {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
        }
        @media (min-width: 1024px) {
          .builders-layout-standard {
            grid-template-columns: repeat(3, minmax(0, 1fr));
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
        /* Photos fill their circle cropped, never squeezed (Avatar's img isn't scoped to this page). */
        .builder-avatar-wrap-list :global(img),
        .builder-avatar-wrap-icons :global(img),
        .mc-photo :global(img) {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
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

        /* Cards view */
        .builder-card-link { display: block; text-decoration: none; color: inherit; height: 100%; }
        .member-card {
          background: var(--color-surface);
          border: 1px solid var(--color-gray-200);
          border-radius: var(--radius-lg);
          padding: 1rem;
          height: 100%;
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
          transition: transform 0.2s, box-shadow 0.2s;
        }
        .member-card:hover { transform: translateY(-4px); box-shadow: var(--shadow-md); }
        .mc-top { display: flex; align-items: center; gap: 0.875rem; min-width: 0; }
        .mc-photo {
          width: 88px;
          height: 88px;
          border-radius: 50%;
          overflow: hidden;
          background: var(--color-gray-100);
          flex-shrink: 0;
        }
        .mc-id { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
        .mc-name {
          font-size: 1.35rem;
          line-height: 1.1;
          margin: 0;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
          overflow-wrap: anywhere;
        }
        .mc-headline {
          margin: 0;
          color: var(--color-primary);
          font-size: 0.85rem;
          font-weight: 600;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .mc-actions { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.4rem; }
        .mc-actions:empty { display: none; }
        .mc-meta {
          display: flex;
          flex-wrap: wrap;
          gap: 4px 14px;
          margin: 0;
          font-size: 0.82rem;
          color: var(--color-gray-500);
          min-width: 0;
        }
        .mc-meta-item { display: inline-flex; align-items: center; gap: 4px; min-width: 0; max-width: 100%; }
        .mc-meta-item :global(svg) { flex-shrink: 0; }
        .mc-bio {
          margin: 0;
          font-size: 0.9rem;
          line-height: 1.45;
          color: var(--color-gray-700);
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .mc-tags { display: flex; flex-wrap: wrap; gap: 0.375rem; }
        .builder-tag {
          font-size: 0.75rem;
          padding: 2px 10px;
          background: var(--color-surface-raised);
          border-radius: 99px;
          color: var(--color-gray-600);
          font-weight: 500;
        }
        .font-semibold { font-weight: 600; }
        .font-medium { font-weight: 500; }
        .text-sm { font-size: 0.875rem; }
        .text-primary { color: var(--color-primary); }
      `}</style>
    </div>
  );
};

export default Discover;
