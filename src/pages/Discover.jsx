import React, { useState, useEffect } from 'react';
import { Search, Filter, SlidersHorizontal, MapPin, DollarSign, Download, Heart, Loader2, Plus, X, User, LayoutGrid, List as ListIcon, Columns } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { projectsApi, watchlistApi, profilesApi } from '../services/api';
import ZapButton from '../components/ZapButton';
import FollowIconButton from '../components/FollowIconButton';
import { useAuth } from '../context/AuthContext';
import { useUserMode } from '../context/UserModeContext';
import { useViewPreference } from '../context/ViewContext';
import { getAssetUrl } from '../utils/assets';
import { stripHtml } from '../utils/text';

const ProjectCard = ({ project, t, viewType = 'standard' }) => {
  const [isLiked, setIsLiked] = useState(project._watchlisted || false);

  useEffect(() => {
    setIsLiked(project._watchlisted || false);
  }, [project._watchlisted]);

  const toggleWatchlist = async () => {
    try {
      if (isLiked) {
        await watchlistApi.remove(project.id);
      } else {
        await watchlistApi.add(project.id);
      }
      setIsLiked(!isLiked);
    } catch {
      // Silently fail (user might not be logged in)
      setIsLiked(!isLiked);
    }
  };

  const formatFunding = (val) => {
    if (!val) return '—';
    if (val >= 1000000) return `${(val / 1000000).toFixed(1)}M`;
    if (val >= 1000) return `${(val / 1000).toFixed(0)}K`;
    return `${val}`;
  };

  const categoryLabel = (c) => {
    if (!c) return '—';
    const special = {
      SAAS: 'SaaS', ECOMMERCE: 'E-Commerce', WEB3: 'Web3', REAL_ESTATE: 'Real Estate'
    };
    if (special[c]) return special[c];
    return c.split('_').map(w => w[0] + w.slice(1).toLowerCase()).join(' ');
  };

  const builderName = project.owner?.profile?.name || project.owner?.name || project.builder;
  const builderId = project.ownerId || project.owner?.id;
  const builderAvatar = project.owner?.profile?.avatar || project.owner?.avatar;

  const tags = [categoryLabel(project.category || project.industry), project.stage].filter(Boolean);
  const hasImage = project.thumbnail || project.coverImage || project.image;

  return (
    <>
      {viewType === 'list' ? (
        <Link to={`/project/${project.id}`} className="project-card-link-list">
          <div className="project-list-card" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '1.25rem', padding: '1rem', background: 'var(--color-surface)', borderRadius: 'var(--radius-xl)', border: '1px solid var(--color-gray-200)', position: 'relative' }}>
            <div className="project-list-avatar relative" style={{ width: '64px', height: '64px', borderRadius: '50%', overflow: 'hidden', background: 'var(--color-gray-100)', flexShrink: 0 }}>
              {hasImage ? (
                <img 
                  src={getAssetUrl(project.thumbnail || project.coverImage || project.image)} 
                  alt={project.title || project.name} 
                  className="w-full h-full object-cover" 
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              ) : (
                <div 
                  className="w-full h-full"
                  style={{
                    width: '100%', height: '100%',
                    backgroundColor: project.color || 'var(--color-blue-tint)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center'
                  }} 
                >
                  <LayoutGrid size={24} style={{ color: 'rgba(255,255,255,0.7)' }} />
                </div>
              )}
            </div>
            <div className="project-list-info" style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <h3 className="font-semibold text-lg" style={{ fontSize: '1.1rem', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginBottom: 2, margin: 0 }}>{project.title || project.name}</h3>
              <div style={{ display: 'flex', gap: '1rem', marginTop: '4px', fontSize: '0.8rem', color: 'var(--color-gray-500)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <MapPin size={13} />
                  <span>{project.location || 'El Salvador'}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <DollarSign size={13} />
                  <span>{formatFunding(project.fundingGoal || project.funding)}</span>
                </div>
              </div>
              
              {tags.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '6px' }}>
                  {tags.map((tag, i) => (
                    <span key={i} className="project-list-tag" style={{ padding: '2px 8px', fontSize: '0.7rem', background: 'var(--color-surface-raised)', borderRadius: '99px', color: 'var(--color-gray-600)', fontWeight: 500 }}>{tag}</span>
                  ))}
                </div>
              )}
            </div>
            <div className="project-list-actions" style={{ display: 'flex', gap: '8px', flexShrink: 0, marginLeft: 'auto' }}>
              <button
                className={`icon-btn ${isLiked ? 'liked' : ''}`}
                title={t('discover.addToWatchlist')}
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleWatchlist(); }}
              >
                <Heart size={18} fill={isLiked ? "currentColor" : "none"} />
              </button>
              {project.owner?.nostrPubkey && (
                <ZapButton
                  recipients={[{ pubkey: project.owner.nostrPubkey, name: builderName || 'Builder', avatar: builderAvatar || '' }]}
                  size="sm"
                />
              )}
            </div>
          </div>
        </Link>
      ) : (
        <div className="project-card">
          <Link to={`/project/${project.id}`} className="card-image-link">
            <div
              className="card-image"
              style={{
                backgroundColor: project.color || 'var(--color-blue-tint)',
                backgroundImage: (project.thumbnail || project.coverImage || project.image) ? `url(${getAssetUrl(project.thumbnail || project.coverImage || project.image)})` : 'none'
              }}
            >
              <span className="industry-badge">{categoryLabel(project.category || project.industry)}</span>
              <span className="stage-badge">{project.stage || '—'}</span>
            </div>
          </Link>
          <div className="card-body">
            <Link to={`/project/${project.id}`} className="card-title-link">
              <h3>{project.title || project.name}</h3>
            </Link>
            <p className="description">{stripHtml(project.description || '')}</p>

            <div className="meta-row">
              <div className="meta-item">
                <MapPin size={14} />
                <span>{project.location || 'El Salvador'}</span>
              </div>
              <div className="meta-item">
                <DollarSign size={14} />
                <span>{formatFunding(project.fundingGoal || project.funding)}</span>
              </div>
            </div>

            {builderName && (
              <Link to={builderId ? `/builder/${builderId}` : '#'} className="builder-row builder-link" style={{ display: 'flex', alignItems: 'center', marginTop: '0.35rem', marginBottom: '0.85rem' }}>
                {builderAvatar ? (
                  <img src={getAssetUrl(builderAvatar)} alt={builderName} className="avatar-img" />
                ) : (
                  <div className="avatar">{(builderName || '?')[0]}</div>
                )}
                <span className="builder-name-text" style={{ marginTop: '-6px' }}>{builderName}</span>
              </Link>
            )}

            <div className="actions">
              <Link to={`/project/${project.id}`} className="btn btn-outline btn-xs view-details-btn">{t('common.details')}</Link>
              <button
                className={`icon-btn ${isLiked ? 'liked' : ''}`}
                title={t('discover.addToWatchlist')}
                onClick={toggleWatchlist}
              >
                <Heart size={18} fill={isLiked ? "currentColor" : "none"} />
              </button>
              <button className="icon-btn btn-secondary-icon" title={t('discover.requestPitchDeck')}><Download size={18} /></button>
              {project.owner?.nostrPubkey && (
                <ZapButton
                  recipients={[{ pubkey: project.owner.nostrPubkey, name: project.owner?.profile?.name || project.owner?.name || 'Builder', avatar: project.owner?.profile?.avatar || '', lud16: project.owner?.profile?.lightningAddress, bolt12Offer: project.owner?.profile?.bolt12Offer }]}
                  size="sm"
                />
              )}
            </div>
          </div>
        </div>
      )}
      <style jsx>{`
        .project-card {
          background: var(--color-surface);
          border-radius: var(--radius-lg);
          overflow: hidden;
          border: 1px solid var(--color-gray-200);
          transition: transform 0.2s, box-shadow 0.2s;
          display: flex;
          flex-direction: column;
        }
        .project-card:hover {
          transform: translateY(-4px);
          box-shadow: var(--shadow-md);
        }

        .card-image-link {
          text-decoration: none;
          display: block;
        }

        .card-image {
          height: 160px;
          position: relative;
          padding: 1rem;
          background-size: cover;
          background-position: center;
          cursor: pointer;
        }

        .card-title-link {
          text-decoration: none;
          color: inherit;
        }
        .card-title-link:hover h3 {
          color: var(--color-primary);
        }

        .builder-link {
          text-decoration: none;
          color: inherit;
          cursor: pointer;
        }
        .builder-link:hover span {
          color: var(--color-primary);
        }
        
        .industry-badge {
          position: absolute;
          top: 1rem;
          left: 1rem;
          background: rgba(75, 85, 99, 0.85);
          padding: 4px 8px;
          border-radius: 4px;
          font-size: 0.75rem;
          font-weight: 600;
          color: white;
        }

        .stage-badge {
          position: absolute;
          bottom: 1rem;
          left: 1rem;
          background: rgba(0,0,0,0.6);
          color: white;
          padding: 2px 8px;
          border-radius: 99px;
          font-size: 0.75rem;
        }

        .card-body { padding: 1.5rem; flex: 1; display: flex; flex-direction: column; overflow: hidden; }
        
        h3 { font-size: 1.1rem; margin-bottom: 0.5rem; }
        
        .description {
          font-size: 0.9rem;
          color: var(--color-gray-500);
          margin-bottom: 1rem;
          line-height: 1.4;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }

        .meta-row {
          display: flex;
          gap: 1rem;
          margin-bottom: 1rem;
          font-size: 0.85rem;
          color: var(--color-gray-500);
        }
        .meta-item { display: flex; align-items: center; gap: 4px; }

        .builder-row {
          display: flex;
          align-items: center;
          font-size: 0.85rem;
          color: var(--color-neutral-dark);
          font-weight: 500;
        }

        .avatar {
          width: 24px;
          height: 24px;
          background: var(--color-surface-raised);
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 0.7rem;
          color: var(--color-gray-600);
          flex-shrink: 0;
          margin-right: 12px;
        }

        .avatar-img {
          width: 24px;
          height: 24px;
          border-radius: 50%;
          object-fit: cover;
          flex-shrink: 0;
          margin-right: 12px;
        }

        .builder-name-text {
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .actions {
          display: flex;
          gap: 0.5rem;
          align-items: center;
          justify-content: space-between;
          margin-top: auto;
        }

        .actions > button.icon-btn:first-of-type {
            margin-left: auto;
        }

        .view-details-btn {
            flex: 1;
            white-space: nowrap !important;
            font-size: 0.85rem;
            padding: 0 12px !important;
            height: 36px !important;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-width: fit-content;
        }
        
        .icon-btn {
          width: 36px;
          height: 36px;
          border-radius: var(--radius-md);
          border: 1.5px solid var(--color-gray-200);
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--color-gray-400);
          transition: all 0.2s;
          flex-shrink: 0;
        }
        .icon-btn:hover { border-color: var(--color-primary); color: var(--color-primary); }
        .icon-btn.liked { color: var(--color-error); border-color: var(--color-error); }
        
        .btn-secondary-icon:hover { 
          background: var(--color-secondary); 
          border-color: var(--color-secondary); 
          color: white; 
        }

        /* List View Styles */
        .project-card-link-list { text-decoration: none; color: inherit; display: block; }
        .project-list-avatar {
          width: 64px; height: 64px; border-radius: 50%; overflow: hidden; background: var(--color-gray-100); flex-shrink: 0;
        }

        .project-list-card {
          display: flex;
          align-items: center;
          padding: 1rem;
          background: var(--color-surface);
          border-radius: var(--radius-xl);
          border: 1px solid var(--color-gray-200);
          gap: 1.25rem;
          transition: transform 0.2s, box-shadow 0.2s, border-color 0.2s;
          position: relative;
        }
        .project-list-card:hover {
          border-color: var(--color-primary-light);
          box-shadow: var(--shadow-sm);
        }
        .project-list-tag {
          font-size: 0.7rem;
          padding: 2px 10px;
          background: var(--color-surface-raised);
          border-radius: 99px;
          color: var(--color-gray-600);
          font-weight: 500;
        }

      `}</style>
    </>
  );
};

const Discover = () => {
  const { t } = useTranslation();
  const location = useLocation();
  const { user } = useAuth();
  const { mode } = useUserMode();
  const { defaultView } = useViewPreference();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIndustries, setSelectedIndustries] = useState([]);
  const [selectedStages, setSelectedStages] = useState([]);
  const [selectedLocations, setSelectedLocations] = useState([]);
  const [selectedRoles, setSelectedRoles] = useState([]);
  const [minFunding, setMinFunding] = useState('');
  const [maxFunding, setMaxFunding] = useState('');
  const [memberViewType, setMemberViewType] = useState(() => localStorage.getItem('bies_members_view') || defaultView);
  const [projectViewType, setProjectViewType] = useState(() => localStorage.getItem('bies_projects_view') || defaultView);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [viewMenuOpenProjects, setViewMenuOpenProjects] = useState(false);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const isPWA = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

  const [discoverView, setDiscoverView] = useState('projects');
  const [showProjects, setShowProjects] = useState(true);
  const [showMembers, setShowMembers] = useState(true);
  const [builders, setBuilders] = useState([]);
  const [buildersLoading, setBuildersLoading] = useState(false);
  const [buildersPage, setBuildersPage] = useState(1);
  const [buildersTotalPages, setBuildersTotalPages] = useState(1);
  const [followingIds, setFollowingIds] = useState(new Set());
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // On mobile: use tab toggle. On desktop: use checkboxes (show both if both checked).
  const currentView = isMobile ? discoverView : (showProjects && !showMembers ? 'projects' : !showProjects && showMembers ? 'members' : 'both');

  const categories = [
    { id: 'FINTECH', label: 'Fintech' },
    { id: 'INFRASTRUCTURE', label: 'Infrastructure' },
    { id: 'ENERGY', label: 'Energy' },
    { id: 'TOURISM', label: 'Tourism' },
    { id: 'AGRICULTURE', label: 'Agriculture' },
    { id: 'REAL_ESTATE', label: 'Real Estate' },
    { id: 'TECHNOLOGY', label: 'Technology' },
    { id: 'FITNESS', label: 'Fitness / Sports' },
    { id: 'HEALTH', label: 'Health / Wellness' },
    { id: 'SAAS', label: 'SaaS' },
    { id: 'ECOMMERCE', label: 'E-Commerce' },
    { id: 'WEB3', label: 'Web3' },
    { id: 'ENTERTAINMENT', label: 'Entertainment' },
    { id: 'LOGISTICS', label: 'Logistics' },
    { id: 'EDUCATION', label: 'Education' }
  ];

  const memberRoles = [
    { id: 'BUILDER', label: t('discover.roles.builders', 'Builders') },
    { id: 'INVESTOR', label: t('discover.roles.investors', 'Investors') },
    { id: 'EDUCATOR', label: t('discover.roles.educators', 'Educators') },
    { id: 'EVENT_HOST', label: t('discover.roles.eventHosts', 'Event Hosts') },
    { id: 'MEMBER', label: t('discover.roles.members', 'Members') }
  ];

  const handleIndustryChange = (industryId) => {
    setSelectedIndustries(prev =>
      prev.includes(industryId) ? prev.filter(i => i !== industryId) : [...prev, industryId]
    );
    setPage(1);
  };

  const handleStageChange = (stage) => {
    setSelectedStages(prev =>
      prev.includes(stage) ? prev.filter(s => s !== stage) : [...prev, stage]
    );
    setPage(1);
  };

  // Read the URL query param ?q= on load
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const q = params.get('q');
    if (q) {
      setSearchQuery(q);
    }
  }, [location.search]);

  // Fetch projects from API
  useEffect(() => {
    const fetchProjects = async () => {
      setLoading(true);
      try {
        const params = {
          page,
          limit: 12,
        };
        if (searchQuery) params.search = searchQuery;
        if (selectedIndustries.length === 1) params.category = selectedIndustries[0];
        if (selectedStages.length === 1) params.stage = selectedStages[0];
        if (minFunding) params.minFunding = minFunding;
        if (maxFunding) params.maxFunding = maxFunding;

        const [result, wlRes] = await Promise.all([
          projectsApi.list(params),
          user?.id ? watchlistApi.list().catch(() => null) : Promise.resolve(null)
        ]);

        const list = result?.data || result || [];
        const wl = Array.isArray(wlRes?.data) ? wlRes.data : Array.isArray(wlRes) ? wlRes : [];
        const wlIds = new Set(wl.map(w => w.projectId || w.project?.id));

        const listWithWatchlist = (Array.isArray(list) ? list : []).map(p => ({
          ...p,
          _watchlisted: wlIds.has(p.id)
        }));

        setProjects(listWithWatchlist);
        setTotalPages(result?.totalPages || 1);
      } catch {
        setProjects([]);
      } finally {
        setLoading(false);
      }
    };

    const debounce = setTimeout(fetchProjects, 300);
    return () => clearTimeout(debounce);
  }, [searchQuery, selectedIndustries, selectedStages, minFunding, maxFunding, page, user?.id]);

  useEffect(() => {
    if (currentView !== 'members' && currentView !== 'both') return;
    const fetchBuilders = async () => {
      setBuildersLoading(true);
      try {
        const params = { page: buildersPage, limit: 12 };
        if (searchQuery) params.search = searchQuery;
        if (selectedLocations.length === 1) params.location = selectedLocations[0];
        if (selectedRoles.length === 1) params.role = selectedRoles[0];
        // If zero or multiple roles are selected, we don't pass 'role' natively since the API might only support strings. Client-side filtering applies below.

        const [result, followingRes] = await Promise.all([
          profilesApi.list(params),
          user?.id ? profilesApi.getFollowing(user.id, { limit: 100 }).catch(() => null) : Promise.resolve(null)
        ]);

        const list = result?.data || result || [];
        setBuilders(Array.isArray(list) ? list : []);
        setBuildersTotalPages(result?.totalPages || 1);

        if (followingRes) {
          const fList = Array.isArray(followingRes?.data) ? followingRes.data : Array.isArray(followingRes) ? followingRes : [];
          setFollowingIds(new Set(fList.map(u => u.id)));
        }
      } catch (err) {
        console.error('Fetch builders error:', err);
        setBuilders([]);
      } finally {
        setBuildersLoading(false);
      }
    };
    const debounce = setTimeout(fetchBuilders, 300);
    return () => clearTimeout(debounce);
  }, [searchQuery, buildersPage, user?.id, currentView, selectedLocations, selectedRoles]);

  // Client-side multi-filter (API may not support multi-select)
  const filteredProjects = projects.filter(p => {
    if (selectedIndustries.length > 1) {
      const cat = p.category || p.industry || '';
      if (!selectedIndustries.some(i => i.toLowerCase() === cat.toLowerCase())) return false;
    }
    if (selectedStages.length > 1) {
      const stage = p.stage || '';
      if (!selectedStages.some(s => s.toLowerCase() === stage.toLowerCase())) return false;
    }
    return true;
  });

  const filteredBuilders = builders.filter(b => {
    if (selectedLocations.length > 1) {
      const loc = b.location || b.profile?.location || '';
      if (!selectedLocations.some(l => l.toLowerCase() === loc.toLowerCase())) return false;
    }
    if (selectedRoles.length > 1) {
      const role = b.role || '';
      if (!selectedRoles.includes(role)) return false;
    }
    return true;
  });

  return (
    <div className="discover-page container">
      {/* Header */}
      <h1 className="page-header" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>{t('discover.title')}</h1>

      <div className="search-row">
        <div className="search-left-column">
          {(mode === 'builder' || user?.role === 'BUILDER' || user?.isAdmin || user?.role === 'MOD') && (
            <Link to="/dashboard/builder/new-project" className="btn btn-primary create-project-btn" style={{ display: 'flex', width: '100%', boxSizing: 'border-box', gap: '0.5rem', justifyContent: 'center' }}>
              <Plus size={18} /><span>{t('discover.newProject')}</span>
            </Link>
          )}
        </div>
        <div style={{ display: 'flex', flex: 1, gap: '0.75rem', alignItems: 'center', minWidth: 0, maxWidth: '100%' }}>
          <div className="search-bar">
            <Search size={20} className="search-icon" />
            <input
              type="text"
              placeholder={t('discover.searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="search-input"
            />
            {(currentView === 'members') && (
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
                    <button onClick={() => { setMemberViewType('icons'); setViewMenuOpen(false); }} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', border: 'none', background: memberViewType==='icons'?'var(--color-primary)':'transparent', color: memberViewType==='icons'?'white':'inherit', borderRadius: '4px', cursor:'pointer', fontWeight: 500 }}>
                      <LayoutGrid size={16}/> Icons
                    </button>
                    <button onClick={() => { setMemberViewType('list'); setViewMenuOpen(false); }} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', border: 'none', background: memberViewType==='list'?'var(--color-primary)':'transparent', color: memberViewType==='list'?'white':'inherit', borderRadius: '4px', cursor:'pointer', fontWeight: 500 }}>
                      <ListIcon size={16}/> List
                    </button>
                    <button onClick={() => { setMemberViewType('standard'); setViewMenuOpen(false); }} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', border: 'none', background: memberViewType==='standard'?'var(--color-primary)':'transparent', color: memberViewType==='standard'?'white':'inherit', borderRadius: '4px', cursor:'pointer', fontWeight: 500 }}>
                      <Columns size={16}/> Standard
                    </button>
                  </div>
                )}
              </div>
            )}
            {(currentView === 'projects' || currentView === 'both') && (
              <div className="view-toggle-container" style={{ position: 'relative' }}>
                <button className="mobile-filter-toggle" style={{ display: 'flex', marginRight: '0.25rem' }} onClick={() => setViewMenuOpenProjects(!viewMenuOpenProjects)} aria-label="Toggle View">
                  {projectViewType === 'list' && <ListIcon size={20} />}
                  {projectViewType === 'standard' && <LayoutGrid size={20} />}
                </button>
                {viewMenuOpenProjects && (
                  <div className="view-menu-dropdown" style={{
                    position: 'absolute', top: '100%', right: 0, marginTop: '0.5rem',
                    background: 'var(--color-surface)', border: '1px solid var(--color-gray-200)',
                    borderRadius: 'var(--radius-md)', padding: '0.5rem', zIndex: 50,
                    boxShadow: 'var(--shadow-md)', minWidth: '160px',
                    display: 'flex', flexDirection: 'column', gap: '4px'
                  }}>
                    <button onClick={() => { setProjectViewType('list'); setViewMenuOpenProjects(false); }} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', border: 'none', background: projectViewType==='list'?'var(--color-primary)':'transparent', color: projectViewType==='list'?'white':'inherit', borderRadius: '4px', cursor:'pointer', fontWeight: 500 }}>
                      <ListIcon size={16}/> List
                    </button>
                    <button onClick={() => { setProjectViewType('standard'); setViewMenuOpenProjects(false); }} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', border: 'none', background: projectViewType==='standard'?'var(--color-primary)':'transparent', color: projectViewType==='standard'?'white':'inherit', borderRadius: '4px', cursor:'pointer', fontWeight: 500 }}>
                      <LayoutGrid size={16}/> Grid
                    </button>
                  </div>
                )}
              </div>
            )}
            
            <button className="mobile-filter-toggle" style={{ display: 'flex' }} onClick={() => setMobileFiltersOpen(!mobileFiltersOpen)}>
              <SlidersHorizontal size={20} />
              {(selectedIndustries.length + selectedStages.length + selectedLocations.length + selectedRoles.length) > 0 && (
                <span className="filter-badge">{selectedIndustries.length + selectedStages.length + selectedLocations.length + selectedRoles.length}</span>
              )}
            </button>
            <button className="btn btn-primary search-btn-desktop" onClick={() => { }}>{t('common.search')}</button>
          </div>
          {isPWA && (mode === 'builder' || user?.role === 'BUILDER' || user?.isAdmin || user?.role === 'MOD') && (
            <Link to="/dashboard/builder/new-project" className="pwa-create-btn" title={t('discover.newProject')} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 44, height: 44, minWidth: 44, borderRadius: '50%',
              background: 'var(--color-primary)', color: 'white', textDecoration: 'none', flexShrink: 0
            }}>
              <Plus size={24} strokeWidth={2.5} />
            </Link>
          )}
        </div>

        <div className="discover-mobile-tabs">
          <button
            className={`discover-tab ${discoverView === 'projects' ? 'active' : ''}`}
            onClick={() => setDiscoverView('projects')}
          >
            <span>{t('discover.projects', 'Projects')}</span>
          </button>
          <button
            className={`discover-tab ${discoverView === 'members' ? 'active' : ''}`}
            onClick={() => setDiscoverView('members')}
          >
            <span>{t('discover.members', 'Members')}</span>
          </button>
        </div>
      </div>

      <div className="content-layout">
        {/* Filters Sidebar */}
        <div className={`filters-column ${mobileFiltersOpen ? 'mobile-open' : ''}`}>
          <aside className="filters">
            <div className="filter-header" style={{ justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <SlidersHorizontal size={18} />
                <span>{t('common.filters')}</span>
              </div>
              {isMobile && (
                <button
                  onClick={() => setMobileFiltersOpen(false)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'none',
                    border: 'none',
                    padding: '4px',
                    cursor: 'pointer',
                    color: 'var(--color-gray-500)'
                  }}
                  aria-label="Close filters"
                >
                  <X size={20} />
                </button>
              )}
            </div>

            <div className="filter-group type-filter-desktop">
              <label>{t('discover.type', 'Type')}</label>
              <div className="checkbox-list">
                <label>
                  <input
                    type="checkbox"
                    checked={showProjects}
                    onChange={() => {
                      const next = !showProjects;
                      if (!next && !showMembers) return;
                      setShowProjects(next);
                    }}
                  />
                  {t('discover.projects', 'Projects')}
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={showMembers}
                    onChange={() => {
                      const next = !showMembers;
                      if (!next && !showProjects) return;
                      setShowMembers(next);
                    }}
                  />
                  {t('discover.members', 'Members')}
                </label>
              </div>
            </div>

            {(currentView === 'projects' || currentView === 'both') && (
              <>
            <div className="filter-group">
              <label>{t('discover.industry')}</label>
              <div className="checkbox-list">
                {categories.map(cat => (
                  <label key={cat.id}>
                    <input
                      type="checkbox"
                      checked={selectedIndustries.includes(cat.id)}
                      onChange={() => handleIndustryChange(cat.id)}
                    />
                    {cat.label}
                  </label>
                ))}
              </div>
            </div>

            <div className="filter-group">
              <label>{t('discover.stage')}</label>
              <div className="checkbox-list">
                {['Idea', 'MVP', 'Seed', 'Series A', 'Early Revenue', 'Scaling'].map(stg => (
                  <label key={stg}>
                    <input
                      type="checkbox"
                      checked={selectedStages.includes(stg)}
                      onChange={() => handleStageChange(stg)}
                    />
                    {stg}
                  </label>
                ))}
              </div>
            </div>

            <div className="filter-group">
              <label>{t('discover.fundingGoal')}</label>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <select
                  value={minFunding}
                  onChange={(e) => { setMinFunding(e.target.value); setPage(1); }}
                  style={{ flex: 1, padding: '0.5rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-gray-300)', background: 'var(--color-surface)', fontSize: '0.85rem' }}
                >
                  <option value="">Min</option>
                  <option value="0">$0</option>
                  <option value="10000">$10k</option>
                  <option value="50000">$50k</option>
                  <option value="100000">$100k</option>
                  <option value="500000">$500k</option>
                  <option value="1000000">$1M</option>
                  <option value="5000000">$5M</option>
                </select>
                <span style={{ color: 'var(--color-gray-500)' }}>-</span>
                <select
                  value={maxFunding}
                  onChange={(e) => { setMaxFunding(e.target.value); setPage(1); }}
                  style={{ flex: 1, padding: '0.5rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-gray-300)', background: 'var(--color-surface)', fontSize: '0.85rem' }}
                >
                  <option value="">Max</option>
                  <option value="10000">$10k</option>
                  <option value="50000">$50k</option>
                  <option value="100000">$100k</option>
                  <option value="500000">$500k</option>
                  <option value="1000000">$1M</option>
                  <option value="5000000">$5M+</option>
                </select>
              </div>
            </div>
              </>
            )}

            {(currentView === 'members' || currentView === 'both') && (
              <>
                <div className="filter-group">
                  <label>{t('discover.role', 'Role')}</label>
                  <div className="checkbox-list">
                    {memberRoles.map(role => (
                      <label key={role.id}>
                        <input
                          type="checkbox"
                          checked={selectedRoles.includes(role.id)}
                          onChange={() => {
                            setSelectedRoles(prev =>
                              prev.includes(role.id) ? prev.filter(r => r !== role.id) : [...prev, role.id]
                            );
                            setBuildersPage(1);
                          }}
                        />
                        {role.label}
                      </label>
                    ))}
                  </div>
                </div>

                <div className="filter-group">
                  <label>{t('discover.location', 'Location')}</label>
                  <div className="checkbox-list">
                    {['El Salvador', 'Remote', 'USA', 'Europe', 'Latin America'].map(loc => (
                      <label key={loc}>
                        <input
                          type="checkbox"
                          checked={selectedLocations.includes(loc)}
                          onChange={() => {
                            setSelectedLocations(prev =>
                              prev.includes(loc) ? prev.filter(l => l !== loc) : [...prev, loc]
                            );
                            setBuildersPage(1);
                          }}
                        />
                        {loc}
                      </label>
                    ))}
                  </div>
                </div>
              </>
            )}
          </aside>
        </div>

        {/* Content Section */}
        <div style={{ flex: 1, width: '100%' }}>
          {(currentView === 'projects' || currentView === 'both') && (
            <>
              {currentView === 'both' && <h3 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: '1rem' }}>{t('discover.projects', 'Projects')}</h3>}
              <div className={projectViewType === 'list' ? 'project-list-layout' : 'project-grid'}>
                {loading ? (
                  <div style={{ gridColumn: '1 / -1', textAlign: 'center', padding: '3rem' }}>
                    <Loader2 size={32} style={{ animation: 'spin 1s linear infinite', margin: '0 auto' }} />
                  </div>
                ) : filteredProjects.length > 0 ? (
                  filteredProjects.map(p => <ProjectCard key={p.id} project={p} t={t} viewType={projectViewType} />)
                ) : (
                  <div className="no-results" style={{ gridColumn: '1 / -1', textAlign: 'center', padding: '3rem', color: 'var(--color-gray-500)' }}>
                    {searchQuery ? t('discover.noProjectsSearch', { query: searchQuery }) : t('discover.noProjects')}
                  </div>
                )}
              </div>
              {totalPages > 1 && (
                <div className="pagination">
                  <button className="btn btn-outline" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>{t('common.previous')}</button>
                  <span>{t('common.page', { current: page, total: totalPages })}</span>
                  <button className="btn btn-outline" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>{t('common.next')}</button>
                </div>
              )}
            </>
          )}

          {(currentView === 'members' || currentView === 'both') && (
            <>
              {currentView === 'both' && <h3 style={{ fontSize: '1.25rem', fontWeight: 700, marginTop: '2.5rem', marginBottom: '1rem' }}>{t('discover.members', 'Members')}</h3>}
            {buildersLoading ? (
                <div style={{ textAlign: 'center', padding: '3rem' }}>
                    <Loader2 size={32} style={{ animation: 'spin 1s linear infinite', margin: '0 auto' }} />
                </div>
            ) : filteredBuilders.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--color-gray-500)' }}>
                    {searchQuery ? t('discover.noProjectsSearch', { query: searchQuery }) : t('discover.noMembersFound', 'No members found')}
                </div>
            ) : (
                <div className={`builders-layout-${memberViewType}`}>
                    {filteredBuilders.map((builder) => {
                        const targetUserId = builder.user?.id || builder.userId;
                        const avatarContent = builder.avatar || builder.image ? (
                            <img src={builder.avatar || builder.image} alt={builder.name} className="builder-avatar-img w-full h-full object-cover" />
                        ) : (
                            <div className="builder-avatar-fallback w-full h-full" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <User size={memberViewType === 'icons' ? 32 : 48} style={{ color: 'var(--color-gray-300)' }} />
                            </div>
                        );
                        
                        const roleTags = [];
                        if (builder.user?.role === 'INVESTOR') roleTags.push('Investor');
                        if (builder.user?.isAdmin) roleTags.push('Admin');
                        if (builder.user?.role === 'MOD') roleTags.push('Moderator');
                        if (builder.user?._count?.projects > 0) roleTags.push('Builder');
                        if (builder.user?._count?.hostedEvents > 0) roleTags.push('Event Host');
                        if (roleTags.length === 0) roleTags.push('Member');

                        const tags = [...roleTags, ...(builder.skills || builder.tags || [])];

                        if (memberViewType === 'icons') {
                            return (
                                <Link to={`/builder/${builder.id}`} key={builder.id} className="builder-card-link-icons" title={builder.name}>
                                    <div className="builder-card-icons">
                                        <div className="builder-avatar-wrap-icons">
                                            {avatarContent}
                                            {builder.user?.role === 'MOD' && <div className="badge-shield" title="Moderator">🛡️</div>}
                                            {builder.user?.isAdmin && <div className="badge-shield" title="Admin">👑</div>}
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
                                            {builder.user?.role === 'MOD' && <div className="badge-shield list-badge" title="Moderator">🛡️</div>}
                                            {builder.user?.isAdmin && <div className="badge-shield list-badge" title="Admin">👑</div>}
                                        </div>
                                        <div className="builder-info-list" style={{ flex: 1, overflow: 'hidden' }}>
                                            <h3 className="font-semibold text-lg" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{builder.name}</h3>
                                            {(builder.company || builder.title || builder.role) && (
                                                <p className="text-primary font-medium text-sm" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                                    {builder.title ? `${builder.title} at ${builder.company || builder.role}` : builder.company || builder.role}
                                                </p>
                                            )}
                                            {tags.length > 0 && (
                                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '8px' }}>
                                                    {tags.map((tag, i) => (
                                                        <span key={i} className={`builder-tag ${roleTags.includes(tag) ? 'role-tag-highlight' : ''}`} style={{ padding: '2px 8px', fontSize: '0.75rem' }}>{tag}</span>
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
                                        {builder.user?.role === 'MOD' && <div className="badge-shield standard-badge" title="Moderator">🛡️</div>}
                                        {builder.user?.isAdmin && <div className="badge-shield standard-badge" title="Admin">👑</div>}
                                    </div>
                                    <div className="p-5 flex-1 flex flex-col">
                                        <h3 className="font-semibold text-xl mb-1">{builder.name}</h3>
                                        {(builder.company || builder.title || builder.role) && <p className="text-primary font-medium text-sm mb-2">{builder.title ? `${builder.title} at ${builder.company || builder.role}` : builder.company || builder.role}</p>}
                                        <p className="text-sm text-gray-500 line-clamp-2 mb-4">{stripHtml(builder.bio || '')}</p>

                                        {tags.length > 0 && (
                                            <div className="flex flex-wrap gap-2 mb-4">
                                                {tags.map((tag, i) => (
                                                    <span key={i} className={`builder-tag ${roleTags.includes(tag) ? 'role-tag-highlight' : ''}`}>{tag}</span>
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
            {buildersTotalPages > 1 && (
                <div className="pagination">
                    <button className="btn btn-outline" disabled={buildersPage <= 1} onClick={() => setBuildersPage(p => p - 1)}>{t('common.previous')}</button>
                    <span>{t('common.page', { current: buildersPage, total: buildersTotalPages })}</span>
                    <button className="btn btn-outline" disabled={buildersPage >= buildersTotalPages} onClick={() => setBuildersPage(p => p + 1)}>{t('common.next')}</button>
                </div>
            )}
            </>
          )}
        </div>
      </div>

      <style jsx>{`
        .discover-page {
          padding-top: 2rem;
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

        .search-left-column {
          width: 250px;
          flex-shrink: 0;
        }

        .create-project-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 0.5rem;
          text-decoration: none;
          white-space: nowrap;
          width: 100%;
          box-sizing: border-box;
        }

        .filters-column {
          width: 250px;
          display: flex;
          flex-direction: column;
          flex-shrink: 0;
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

        /* Layout */
        .content-layout {
          display: flex;
          gap: 2rem;
          align-items: flex-start;
        }

        .filters {
          width: 250px;
          background: var(--color-surface);
          padding: 1.5rem;
          border-radius: var(--radius-lg);
          height: fit-content;
          border: 1px solid var(--color-gray-200);
          display: flex;
          flex-direction: column;
        }

        .filter-header {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          font-weight: 600;
          margin-bottom: 1.5rem;
          padding-bottom: 1rem;
          border-bottom: 1px solid var(--color-gray-200);
        }

        .filter-group { margin-bottom: 1.5rem; }
        .filter-group label {
          display: block;
          font-size: 0.9rem;
          font-weight: 600;
          margin-bottom: 0.75rem;
        }

        @media (max-width: 768px) {
          .type-filter-desktop { display: none; }
        }

        .checkbox-list {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
          align-items: flex-start;
        }

        .checkbox-list label {
          font-weight: normal;
          font-size: 0.9rem;
          color: var(--color-gray-600);
          display: flex;
          align-items: center;
          justify-content: flex-start;
          cursor: pointer;
          width: auto; /* Allow shrink wrap */
          padding: 2px 0;
          margin: 0;
          gap: 8px; /* Use gap instead of margin */
        }
        
        .checkbox-list input[type="checkbox"] {
            margin: 0;
            padding: 0;
            display: block;
            width: 16px !important;
            min-width: 16px;
            max-width: 16px;
            height: 16px !important;
            min-height: 16px;
            max-height: 16px;
            accent-color: var(--color-primary);
            flex: 0 0 16px;
            cursor: pointer;
            appearance: none;
            -webkit-appearance: none;
            background: var(--color-surface-raised);
            border: 1px solid var(--color-gray-200);
            border-radius: 3px;
            position: relative;
            box-sizing: content-box;
        }
        .checkbox-list input[type="checkbox"]:checked {
            background: var(--color-primary);
        }
        .checkbox-list input[type="checkbox"]:checked::after {
            content: '✓';
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            color: white;
            font-size: 11px;
            font-weight: 700;
        }

        .project-grid {
          flex: 1;
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 1.5rem;
          align-content: flex-start;
        }

        .project-list-layout {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }

        @media (max-width: 1024px) {
          .project-grid { grid-template-columns: repeat(2, 1fr); }
        }

        .pagination {
          display: flex;
          justify-content: center;
          align-items: center;
          gap: 1rem;
          margin-top: 2rem;
          padding: 1rem;
        }
        .pagination span { font-size: 0.9rem; color: var(--color-gray-500); }

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
        .filter-badge {
          position: absolute;
          top: 2px;
          right: 2px;
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: var(--color-secondary);
          color: white;
          font-size: 0.65rem;
          font-weight: 700;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        @media (max-width: 768px) {
          .search-left-column { display: none !important; }
          .page-header { display: none !important; }
        }

        @media (max-width: 768px) {
          .search-row { flex-direction: column; align-items: stretch; gap: 1rem; }
          .search-left-column { display: none !important; }
          .content-layout { flex-direction: column; align-items: stretch; }
          .filters-column {
            width: 100%;
            display: none;
          }
          .filters-column.mobile-open {
            display: flex;
          }
          .filters { width: 100%; }
          .project-grid { grid-template-columns: 1fr; }
          .mobile-filter-toggle { display: flex; }
          .search-btn-desktop { display: none; }
        }

        .discover-mobile-tabs {
          display: none;
          align-items: stretch;
          height: 50px;
          width: 100%;
          box-sizing: border-box;
        }
        @media (max-width: 768px) {
          .discover-mobile-tabs {
            display: flex;
          }
        }
        .discover-tab {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          padding: 0 16px;
          font-size: 15px;
          font-weight: 600;
          border: none;
          border-bottom: 2px solid transparent;
          cursor: pointer;
          transition: color 0.15s, border-color 0.15s;
          background: none;
          color: var(--feed-text-tertiary);
        }
        .discover-tab:hover {
          color: var(--feed-text-secondary);
        }
        .discover-tab.active {
          color: var(--feed-text-primary);
          border-bottom-color: var(--feed-accent);
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
        .role-tag-highlight {
          background: var(--color-primary-light);
          color: white;
          background-color: var(--color-primary);
        }
        .badge-shield {
          position: absolute;
          bottom: 0px;
          right: 0px;
          background: white;
          border-radius: 50%;
          font-size: 14px;
          line-height: 1;
          padding: 2px;
          box-shadow: var(--shadow-sm);
        }
        .list-badge {
          bottom: -2px;
          right: -2px;
        }
        .standard-badge {
          bottom: 8px;
          right: 8px;
          font-size: 20px;
          padding: 4px;
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
