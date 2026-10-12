import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useUserMode } from '../context/UserModeContext';
import { useAuth } from '../context/AuthContext';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import { User, Search, ChevronDown, LogOut, Trophy } from 'lucide-react';
import NostrIcon from './NostrIcon';
import NostrNotifications from './NostrNotifications';
import { BOUNTIES_ENABLED, COWORK_ENABLED, MARKETPLACE_ENABLED } from '../config/featureFlags';
import logoHorizontalWhite from '../assets/logo-horizontal-white.svg';
import logoIconDark from '../assets/logo-icon-dark.svg';

const Navbar = () => {
  const { t } = useTranslation();
  const { mode, selectMode, clearMode } = useUserMode();
  const { user, isAuthenticated, logout } = useAuth();
  const { flags } = useFeatureFlags();
  const featureOn = (slug) => flags[slug] !== false;
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const location = useLocation();
  const navigate = useNavigate();

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      navigate(`/discover?q=${encodeURIComponent(searchQuery.trim())}`);
      setIsSearchOpen(false);
      setSearchQuery('');
    }
  };

  // `flag:` ties a link to a runtime feature toggle — disabled features
  // disappear from the nav entirely.
  // `more:` links sit under "More" on desktop, so the bar fits; `squeeze:`
  // links join them there on narrow desktops (under 1024px).
  const navLinks = [
    { label: t('nav.discover'), path: '/discover' },
    { label: t('mobileNav.farms'), path: '/farms', flag: 'directories' },
    { label: t('nav.trusted'), path: '/trusted', flag: 'directories' },
    ...(MARKETPLACE_ENABLED ? [{ label: t('marketplace.entryLabel'), path: '/market', flag: 'marketplace' }] : []),
    { label: t('nav.events'), path: '/events', flag: 'events', squeeze: true },
    { label: t('nav.media'), path: '/media', flag: 'media', squeeze: true },
    ...(BOUNTIES_ENABLED ? [{ label: t('nav.bounties'), path: '/bounties', flag: 'bounties', more: true }] : []),
    { label: t('nav.leaderboard'), path: '/leaderboard', icon: Trophy, flag: 'points', more: true },
    { label: t('nav.news'), path: '/news', flag: 'news', more: true },
    { label: t('nav.about'), path: '/about', more: true },
  ].filter((link) => !link.flag || featureOn(link.flag));
  const moreLinks = navLinks.filter((link) => link.more);
  const squeezeLinks = navLinks.filter((link) => link.squeeze);

  const isActive = (path) => location.pathname === path || location.pathname.startsWith(`${path}/`);

  // Derive mobile navbar title from route
  const getPageTitle = () => {
    const path = location.pathname;
    if (path === '/' || path === '/feed') return t('pageTitles.biesFeed');
    if (path.startsWith('/farms')) return t('pageTitles.farmDirectory');
    if (path.startsWith('/trusted')) return t('pageTitles.certifiedDirectory');
    if (path.startsWith('/market')) return t('marketplace.title');
    if (path.startsWith('/discover')) return t('pageTitles.discover', 'Discover');
    if (path.startsWith('/events')) return t('pageTitles.ecosystemEvents');
    if (path.startsWith('/bounties')) return t('pageTitles.bounties');
    if (path.startsWith('/leaderboard')) return t('pageTitles.leaderboard');
    if (path.startsWith('/news')) return t('pageTitles.news');
    if (path.startsWith('/members') || path.startsWith('/investors') || path.startsWith('/builders')) return t('pageTitles.members');
    if (path.startsWith('/media')) return t('pageTitles.media');
    if (path.startsWith('/about')) return t('pageTitles.about');
    if (path.startsWith('/cowork')) return t('pageTitles.cowork');
    if (path.startsWith('/wallet')) return t('pageTitles.wallet', 'Wallet');
    if (path.startsWith('/profile') || path.startsWith('/dashboard')) return t('pageTitles.dashboard');
    if (path.startsWith('/messages')) return t('pageTitles.messages');
    if (path === '/settings/navbar') return t('customNav.title');
    if (path.startsWith('/settings')) return t('pageTitles.settings');
    if (path.startsWith('/feedback')) return 'Feedback';
    if (path.startsWith('/admin')) return t('pageTitles.adminPanel');
    return '';
  };

  return (
    <nav className="navbar" style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 100, display: 'flex', flexDirection: 'column' }}>
      <div className="container flex items-center justify-between" style={{ minHeight: '70px', position: 'relative' }}>

        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <Link to={isAuthenticated ? "/feed" : "/"} className="logo">
            <img src={logoHorizontalWhite} alt="Build in El Salvador" className="logo-desktop" style={{ height: '40px' }} />
            <img src={logoIconDark} alt="BIES" className="logo-mobile-pwa" style={{ height: '36px', display: 'none' }} />
          </Link>
        </div>

        {/* Mobile Page Title (Absolute Centered) */}
        {getPageTitle() && (
          <div className="mobile-page-title" style={{
            position: 'absolute', left: '50%', transform: 'translateX(-50%)',
            color: 'white', fontWeight: 700, fontSize: '1.05rem', fontFamily: 'var(--font-display)',
            display: 'none', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            pointerEvents: 'none'
          }}>
            {getPageTitle()}
          </div>
        )}

        {/* Desktop Nav */}
        <div className="desktop-links flex items-center gap-lg">
          {navLinks.filter((link) => !link.more).map((link) => (
            <Link
              key={link.path}
              to={link.path}
              className={`nav-link ${link.squeeze ? 'squeeze' : ''} ${isActive(link.path) ? 'active' : ''}`}
              style={{ color: 'white', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
            >
              {link.icon && <link.icon size={15} />}
              {link.label}
            </Link>
          ))}
          {moreLinks.length > 0 && (
            <div className="more-menu relative">
              <button
                type="button"
                className={`more-btn ${moreLinks.some((link) => isActive(link.path)) ? 'active' : ''} ${squeezeLinks.some((link) => isActive(link.path)) ? 'squeeze-active' : ''}`}
                onClick={() => setIsMoreOpen(!isMoreOpen)}
                aria-haspopup="menu"
                aria-expanded={isMoreOpen}
              >
                {t('nav.more')}
                <ChevronDown size={14} style={{ transform: isMoreOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
              </button>
              {isMoreOpen && (
                <>
                  <div className="click-outside-overlay" onClick={() => setIsMoreOpen(false)}></div>
                  <div className="dropdown more-dropdown" role="menu">
                    {[...squeezeLinks, ...moreLinks].map((link) => (
                      <Link
                        key={link.path}
                        to={link.path}
                        role="menuitem"
                        className={`more-item ${link.squeeze ? 'squeeze-only' : ''} ${isActive(link.path) ? 'active' : ''}`}
                        onClick={() => setIsMoreOpen(false)}
                      >
                        {link.icon && <link.icon size={15} />}
                        {link.label}
                      </Link>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Right Actions */}
        <div className="actions flex items-center gap-md">
          <div className="search-container relative flex items-center">
            {isSearchOpen ? (
              <form onSubmit={handleSearchSubmit} className="search-form flex items-center">
                <input
                  type="text"
                  placeholder={t('common.searchPlaceholder')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="search-input"
                  autoFocus
                  onBlur={() => {
                    // Slight delay to allow submit to fire if they clicked the icon
                    setTimeout(() => {
                      if (!searchQuery) setIsSearchOpen(false);
                    }, 200);
                  }}
                />
                <button type="submit" className="icon-btn search-submit-btn" aria-label="Submit Search">
                  <Search size={20} />
                </button>
              </form>
            ) : (
              <button className="icon-btn" aria-label="Open Search" onClick={() => setIsSearchOpen(true)}>
                <Search size={20} />
              </button>
            )}
          </div>
          <div className="notifications-menu relative">
            {isAuthenticated && <NostrNotifications />}
          </div>

          {/* User Profile / Mode Switcher */}
          {isAuthenticated ? (
            <div className="user-menu relative">
              <button
                className={`profile-btn flex items-center gap-sm ${isUserMenuOpen ? 'active' : ''}`}
                onClick={() => setIsUserMenuOpen(!isUserMenuOpen)}
              >
                <div className="avatar">
                  {user?.profile?.avatar ? (
                    <img src={user.profile.avatar} alt="" style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }} />
                  ) : (
                    <User size={18} />
                  )}
                </div>
                <div className="flex flex-col items-start hidden-mobile" style={{ lineHeight: 1.2, color: 'white' }}>
                  <span className="text-sm font-semibold">{user?.profile?.name || user?.name || 'Guest'}</span>
                </div>
                <ChevronDown size={14} style={{ transform: isUserMenuOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
              </button>

              {/* Dropdown */}
              {isUserMenuOpen && (
                <>
                  <div className="click-outside-overlay" onClick={() => setIsUserMenuOpen(false)}></div>
                  <div className="dropdown user-dropdown">
                    {/* Top Section */}
                    <div className="dropdown-section vertical-stack">
                      <Link
                        to={user?.role === 'INVESTOR' ? `/investor/${user.id}` : `/builder/${user?.id || ''}`}
                        className="dropdown-item"
                        onClick={() => setIsUserMenuOpen(false)}
                      >
                        {t('nav.profile')}
                      </Link>
                      {featureOn('messages') && (
                        <Link to="/messages" className="dropdown-item" onClick={() => setIsUserMenuOpen(false)}>{t('nav.messages')}</Link>
                      )}
                      {COWORK_ENABLED && featureOn('cowork') && (
                        <Link to="/cowork" className="dropdown-item" onClick={() => setIsUserMenuOpen(false)}>{t('nav.cowork')}</Link>
                      )}
                      {featureOn('zaps') && (
                        <Link to="/wallet" className="dropdown-item" onClick={() => setIsUserMenuOpen(false)}>{t('nav.wallet', 'Wallet')}</Link>
                      )}
                      <Link to="/dashboard" className="dropdown-item" onClick={() => setIsUserMenuOpen(false)}>{t('nav.dashboard')}</Link>
                      {(user?.isAdmin || user?.role === 'MOD') && (
                        <Link to="/admin" className="dropdown-item" onClick={() => setIsUserMenuOpen(false)} style={{ color: 'var(--color-primary)', fontWeight: 600 }}>{t('nav.adminPanel')}</Link>
                      )}
                      <Link to="/settings" className="dropdown-item" onClick={() => setIsUserMenuOpen(false)}>{t('nav.settings')}</Link>
                      {featureOn('feedback') && (
                        <Link to="/feedback" className="dropdown-item" onClick={() => setIsUserMenuOpen(false)}>Feedback</Link>
                      )}
                    </div>

                    <div className="dropdown-divider"></div>

                    {isAuthenticated ? (
                      <button onClick={() => { logout(); clearMode(); setIsUserMenuOpen(false); navigate('/'); }} className="dropdown-item text-error">
                        <LogOut size={14} style={{ marginRight: 8 }} /> {t('common.logOut')}
                      </button>
                    ) : (
                      <Link to="/login" className="dropdown-item" onClick={() => setIsUserMenuOpen(false)}>
                        {t('common.logIn')}
                      </Link>
                    )}
                  </div>
                </>
              )}
            </div>
          ) : (
            <Link to="/login" className="login-btn flex items-center gap-sm" style={{ color: 'white', fontWeight: 600, fontSize: '0.9rem', padding: '6px 16px', border: '1px solid rgba(255,255,255,0.3)', borderRadius: 'var(--radius-full)' }}>
              <NostrIcon size={16} />
              <span>{t('common.login')}</span>
            </Link>
          )}

          {/* Mobile Notification Bell + Menu Toggle */}
          <div className="mobile-actions">
            {isAuthenticated && <NostrNotifications mobile />}
            <button
              className="mobile-toggle"
              onClick={() => setIsMenuOpen(!isMenuOpen)}
            >
              <div className="avatar" style={{ width: 32, height: 32 }}>
                {user?.profile?.avatar ? (
                  <img src={user.profile.avatar} alt="" style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }} />
                ) : (
                  <User size={18} />
                )}
              </div>
            </button>
          </div>
        </div>
      </div>

      {/* Mode Indicator Strip - Removed since it conflicts with the bottom orange border in this layout */}

      {/* Mobile Slide-Out Menu */}
      {isMenuOpen && (
        <>
          <div className="mobile-overlay" onClick={() => setIsMenuOpen(false)} />
          <div className="mobile-drawer">
            <div className="mobile-drawer-header">
              <img src={logoIconDark} alt="BIES" style={{ height: '32px' }} />
              <button onClick={() => setIsMenuOpen(false)} style={{ color: 'white', background: 'none', border: 'none', fontSize: '1.5rem', padding: '8px', cursor: 'pointer' }}>✕</button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '0.75rem 0', display: 'flex', flexDirection: 'column' }}>
              {/* Top Section: Profile, Messages, News, About */}
              {[
                { to: '/profile', label: t('nav.profile') },
                ...(featureOn('directories') ? [
                  { to: '/farms', label: t('directory.farmTitle') },
                  { to: '/trusted', label: t('directory.certifiedTitle') },
                ] : []),
                ...(MARKETPLACE_ENABLED && featureOn('marketplace') ? [{ to: '/market', label: t('marketplace.entryLabel') }] : []),
                ...(featureOn('messages') ? [{ to: '/messages', label: t('nav.messages') }] : []),
                ...(COWORK_ENABLED && featureOn('cowork') ? [{ to: '/cowork', label: t('nav.cowork') }] : []),
                ...(featureOn('zaps') ? [{ to: '/wallet', label: t('nav.wallet', 'Wallet') }] : []),
                ...(BOUNTIES_ENABLED && featureOn('bounties') ? [{ to: '/bounties', label: t('nav.bounties') }] : []),
                ...((user?.isAdmin || user?.role === 'MOD') ? [{ to: '/admin', label: t('nav.adminPanel'), isAdmin: true }] : []),
                ...(featureOn('points') ? [{ to: '/leaderboard', label: t('nav.leaderboard') }] : []),
                ...(featureOn('news') ? [{ to: '/news', label: t('nav.news') }] : []),
                { to: '/about', label: t('nav.about') },
              ].map((link) => {
                const active = isActive(link.to);
                const linkStyle = {
                  display: 'block',
                  padding: '0.9rem 1.5rem',
                  color: link.isAdmin ? 'var(--color-secondary)' : active ? 'white' : 'rgba(255,255,255,0.8)',
                  fontSize: '1rem',
                  fontWeight: link.isAdmin ? 700 : active ? 700 : 500,
                  textDecoration: 'none',
                  borderLeft: active ? '3px solid var(--color-secondary)' : '3px solid transparent',
                  background: active ? 'rgba(255,255,255,0.1)' : 'none',
                };
                return (
                  <Link key={link.to} to={link.to} style={linkStyle} onClick={() => setIsMenuOpen(false)}>
                    {link.label}
                  </Link>
                );
              })}
            </div>
            <div style={{ borderTop: '1px solid rgba(255,255,255,0.15)', padding: '0.5rem 0', display: 'flex', flexDirection: 'column', paddingBottom: 'calc(80px + env(safe-area-inset-bottom, 0))' }}>
              {/* Bottom Section: Feedback, FAQ, Settings, Log Out */}
              {[
                ...(featureOn('feedback') ? [{ to: '/feedback', label: 'Feedback' }] : []),
                { to: '/about', label: 'FAQ' }, // FAQ points to About for now
                { to: '/settings', label: t('nav.settings') },
              ].map(item => (
                <Link key={item.to} to={item.to} style={{ display: 'block', padding: '0.9rem 1.5rem', color: 'rgba(255,255,255,0.8)', fontSize: '1rem', fontWeight: 500, textDecoration: 'none', borderLeft: '3px solid transparent' }} onClick={() => setIsMenuOpen(false)}>
                  {item.label}
                </Link>
              ))}
              
              {isAuthenticated ? (
                <button onClick={() => { logout(); clearMode(); setIsMenuOpen(false); navigate('/'); }} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '0.9rem 1.5rem', color: '#ef4444', fontSize: '1rem', fontWeight: 500, background: 'none', border: 'none', borderLeft: '3px solid transparent', cursor: 'pointer', fontFamily: 'inherit', width: '100%', textAlign: 'left' }}>
                  <LogOut size={16} /> {t('common.logOut')}
                </button>
              ) : (
                <Link to="/login" style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '0.9rem 1.5rem', color: 'rgba(255,255,255,0.8)', fontSize: '1rem', fontWeight: 500, textDecoration: 'none', borderLeft: '3px solid transparent' }} onClick={() => setIsMenuOpen(false)}>
                  <NostrIcon size={16} /> {t('common.logIn')}
                </Link>
              )}
            </div>
          </div>
        </>
      )}

      {/* Bitcoin Orange Line — bottom box-shadow fills any sub-pixel gap between navbar and page */}
      <div className="navbar-orange-line" style={{ height: '3px', width: '100%', backgroundColor: 'var(--color-secondary)', flexShrink: 0 }} />

      {/* Sub-navigation portal target (Dashboard tab bar renders here on mobile) */}
      <div id="navbar-subnav" />

      <style jsx>{`
        .navbar {
          min-height: 70px;
          padding-top: env(safe-area-inset-top, 0px);
          background: var(--color-primary);
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          z-index: 100;
          box-shadow: var(--shadow-sm);
          -webkit-backface-visibility: hidden;
          backface-visibility: hidden;
        }

        @media (display-mode: standalone) {
          .logo-desktop { display: none !important; }
          .logo-mobile-pwa { display: block !important; }
          .mobile-page-title { display: block !important; }
          #navbar-subnav {
            padding-bottom: 6px;
          }
        }

        /* Catch-all for very narrow mobile screens even if not standalone */
        @media (max-width: 768px) {
          .navbar {
            box-shadow: 0 2px 0 0 var(--color-gray-50);
          }
          .logo-desktop { display: none !important; }
          .logo-mobile-pwa { display: block !important; }
          .mobile-page-title { display: block !important; }
        }

        /* Always match the content background so navbar navy never bleeds through */
        #navbar-subnav {
          background: var(--color-gray-50);
        }

        .logo {
          display: flex;
          align-items: center;
        }

        .logo img {
          height: 40px;
          width: auto;
        }

        .nav-link {
          font-family: var(--font-sans);
          font-weight: 400; /* Regular */
          color: white;
          font-size: 0.95rem;
          padding: 0.5rem 0;
          position: relative;
        }

        /* Links are <Link>s, which styled-jsx doesn't scope */
        .desktop-links :global(a) {
          white-space: nowrap;
        }
        .more-btn {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 0.5rem 0;
          background: none;
          border: none;
          color: white;
          font-family: var(--font-sans);
          font-size: 0.95rem;
          white-space: nowrap;
          cursor: pointer;
        }
        .more-btn.active {
          font-family: var(--font-display);
          font-weight: 700;
        }
        .more-dropdown {
          left: 0;
          right: auto;
        }
        .more-dropdown :global(.more-item) {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 0.65rem 0.9rem;
          border-radius: var(--radius-sm);
          color: var(--color-neutral-dark);
          font-size: 0.9rem;
          text-decoration: none;
          white-space: nowrap;
        }
        .more-dropdown :global(.more-item:hover) {
          background: var(--color-gray-100);
        }
        .more-dropdown :global(.more-item.active) {
          font-weight: 700;
          color: var(--color-primary);
        }
        .more-dropdown :global(.squeeze-only) {
          display: none;
        }
        @media (max-width: 1023px) {
          .desktop-links :global(.squeeze) {
            display: none !important;
          }
          .more-dropdown :global(.squeeze-only) {
            display: flex;
          }
          .more-btn.squeeze-active {
            font-family: var(--font-display);
            font-weight: 700;
          }
        }

        .nav-link:hover {
          color: rgba(255, 255, 255, 0.8);
        }

        .nav-link.active {
          color: white;
          font-family: var(--font-display);
          font-weight: 700;
        }

        .icon-btn {
          padding: 8px;
          color: white;
          border-radius: 50%;
        }
        .icon-btn:hover {
          background: rgba(255, 255, 255, 0.1);
          color: white;
        }


        .search-container {
          height: 36px;
        }

        .search-form {
          background: rgba(255, 255, 255, 0.15);
          border-radius: var(--radius-full);
          border: 1px solid rgba(255, 255, 255, 0.3);
          padding-left: 12px;
          overflow: hidden;
          transition: all 0.2s ease-out;
          width: 200px; /* Expands search to 200px */
        }
        .search-form:focus-within {
          background: rgba(255, 255, 255, 0.25);
          width: 250px;
        }

        .search-input {
          background: transparent;
          border: none;
          color: white;
          width: 100%;
          outline: none;
          font-size: 0.9rem;
          font-family: inherit;
        }
        .search-input::placeholder {
          color: rgba(255, 255, 255, 0.6);
        }

        .search-submit-btn {
          padding: 6px 12px;
        }
        .search-submit-btn:hover {
          background: transparent;
          color: rgba(255, 255, 255, 0.8);
        }

        .profile-btn {
          padding: 4px 8px 4px 4px;
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: var(--radius-full);
          transition: all 0.2s;
          color: white;
        }
        .profile-btn:hover {
          border-color: rgba(255, 255, 255, 0.4);
        }

        .avatar {
          width: 32px;
          height: 32px;
          background: rgba(255, 255, 255, 0.2);
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          color: white;
        }

        /* Dropdown */
        .click-outside-overlay {
            position: fixed;
            top: 0; 
            left: 0; 
            right: 0; 
            bottom: 0; 
            z-index: 99;
        }

        .dropdown {
          display: block;
          position: absolute;
          top: 100%;
          right: 0;
          width: 200px;
          background: var(--color-surface);
          border-radius: var(--radius-md);
          box-shadow: var(--shadow-lg);
          border: 1px solid var(--color-gray-100);
          padding: 0.5rem;
          margin-top: 0.5rem;
          z-index: 100;
          animation: slideDown 0.2s ease-out;
        }

        @keyframes slideDown {
            from { opacity: 0; transform: translateY(-10px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .dropdown-header {
          padding: 0.5rem 1rem;
          color: var(--color-gray-400);
          text-transform: uppercase;
          font-size: 0.7rem;
        }

        .dropdown-item {
          display: flex;
          align-items: center;
          width: 100%;
          padding: 0.75rem 1rem;
          font-size: 0.9rem;
          color: var(--color-neutral-dark);
          border-radius: var(--radius-sm);
          text-align: left;
        }

        .dropdown-item:hover {
          background: var(--color-gray-100);
        }

        .dropdown-item.active {
          background: var(--color-gray-100);
          font-family: var(--font-display);
          font-weight: 700;
        }

        .dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          margin-right: 10px;
        }
        .dot.builder { background: var(--color-primary); }
        .dot.investor { background: var(--color-secondary); }
        .dot.educator { background: #16a34a; }
        .dot.member { background: #7c3aed; }
        .dot.admin { background: var(--color-error); }

        .dropdown-divider {
          height: 1px;
          background: var(--color-gray-200);
          margin: 0.5rem 0;
        }

        .text-error { color: var(--color-error); }

        /* Mode Strip */
        .mode-strip {
          height: 3px;
          width: 100%;
          transition: background 0.3s;
        }
        .mode-strip.builder { background: var(--color-primary); }
        .mode-strip.investor { background: var(--color-secondary); }

        .hidden-mobile { display: block; }
        .mobile-toggle { display: none; color: white; padding: 8px; }
        .mobile-actions { display: none; align-items: center; gap: 4px; }

        /* Mobile Drawer */
        .mobile-overlay {
          position: fixed;
          top: 0; left: 0; right: 0; bottom: 0;
          background: rgba(0,0,0,0.5);
          z-index: 200;
          animation: fadeIn 0.2s ease-out;
        }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

        .mobile-drawer {
          position: fixed;
          top: 0; right: 0; bottom: 0;
          width: 180px;
          max-width: 60vw;
          background: var(--color-primary);
          z-index: 201;
          display: flex;
          flex-direction: column;
          animation: slideIn 0.25s ease-out;
          padding: env(safe-area-inset-top, 0) 0 env(safe-area-inset-bottom, 0) 0;
        }
        @keyframes slideIn { from { transform: translateX(100%); } to { transform: translateX(0); } }

        .mobile-drawer-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 1.25rem 1.5rem;
          border-bottom: 1px solid rgba(255,255,255,0.15);
        }

        .mobile-drawer-links {
          flex: 1;
          overflow-y: auto;
          padding: 0.75rem 0;
        }

        .mobile-drawer-link {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 0.9rem 1.5rem;
          color: rgba(255,255,255,0.85);
          font-size: 1rem;
          font-weight: 500;
          text-decoration: none;
          transition: background 0.15s;
          width: 100%;
          border: none;
          background: none;
          cursor: pointer;
          font-family: inherit;
        }
        .mobile-drawer-link:hover,
        .mobile-drawer-link:active {
          background: rgba(255,255,255,0.1);
        }
        .mobile-drawer-link.active {
          color: white;
          font-weight: 700;
          background: rgba(255,255,255,0.1);
          border-left: 3px solid var(--color-secondary);
        }

        .mobile-drawer-footer {
          border-top: 1px solid rgba(255,255,255,0.15);
          padding: 0.5rem 0;
        }

        @media (max-width: 768px) {
          .desktop-links { display: none; }
          .hidden-mobile { display: none; }
          .mobile-toggle { display: block; }
          .mobile-actions { display: flex; }
          .search-container { display: none; }
          .notifications-menu { display: none; }
          .user-menu { display: none; }
        }


        .vertical-stack {
            display: flex;
            flex-direction: column;
        }
      `}</style>
    </nav>
  );
};

export default Navbar;
