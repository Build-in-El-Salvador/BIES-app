import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { User } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useTranslation } from 'react-i18next';
import { useBottomNav } from '../context/BottomNavContext';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import { visibleTabs } from '../config/navPages';

// The active tab: a solid orange pill behind a white icon, and a bold white
// label (orange text on the blue bar is only 2.7:1; white is 8.4:1).
const itemStyle = (active) => ({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '3px',
  flex: 1,
  minHeight: '48px',
  color: active ? 'white' : 'rgba(255, 255, 255, 0.85)',
  textDecoration: 'none',
  fontSize: '0.68rem',
  fontWeight: active ? 700 : 500,
  letterSpacing: '0.03em',
  WebkitTapHighlightColor: 'transparent',
});

const iconWrapStyle = (active) => ({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '52px',
  height: '30px',
  borderRadius: '15px',
  background: active ? '#FF5B00' : 'none',
});

const MobileBottomNav = () => {
  const location = useLocation();
  const { isAuthenticated } = useAuth();
  const { t } = useTranslation();

  const { tabs: tabIds } = useBottomNav();
  const { flags } = useFeatureFlags();
  // Runtime feature toggles exclude disabled pages even from user-customized
  // tab sets (the stored preference is untouched, so re-enabling restores them);
  // the default bar fills the gaps they leave.
  const enabledTabs = visibleTabs(tabIds, (tab) => !tab.flag || flags[tab.flag] !== false);
  // When logged out, auth-gated tabs collapse into a single Login entry —
  // rendering one Login link per gated tab would duplicate it.
  const firstAuthIdx = enabledTabs.findIndex((tab) => tab.auth);
  const tabs = isAuthenticated ? enabledTabs : enabledTabs.filter((tab, i) => !tab.auth || i === firstAuthIdx);

  const isActive = (path) => location.pathname === path || location.pathname.startsWith(path + '/');

  return (
    <>
      <nav style={{
        display: 'none',
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        width: '100%',
        background: 'var(--color-primary-nav, var(--color-primary))',
        borderTop: '3px solid #FF5B00',
        zIndex: 10000,
        WebkitTransform: 'translateZ(0)', /* force GPU compositing on iOS — belt-and-suspenders fix for position:fixed in scroll contexts */
      }} className="mobile-bottom-nav">
        {tabs.map((tab) => {
          if (tab.auth && !isAuthenticated) {
            return (
              <Link key={'login-' + tab.id} to="/login" style={itemStyle(false)} data-testid={'bottom-nav-' + tab.id}>
                <div style={iconWrapStyle(false)}><User size={22} strokeWidth={1.8} /></div>
                <span>{t('common.login')}</span>
              </Link>
            );
          }
          const Icon = tab.icon;
          const active = isActive(tab.path);
          return (
            <Link key={tab.path} to={tab.path} style={itemStyle(active)} data-testid={'bottom-nav-' + tab.id} aria-current={active ? 'page' : undefined}>
              <div style={iconWrapStyle(active)}>
                <Icon size={22} strokeWidth={active ? 2.5 : 1.8} />
              </div>
              <span>{t(tab.labelKey)}</span>
            </Link>
          );
        })}
      </nav>

      <style jsx>{`
        @media (max-width: 768px) {
          .mobile-bottom-nav {
            display: flex !important;
            align-items: flex-start;
            justify-content: space-around;
            padding-top: 10px;
            padding-bottom: calc(6px + env(safe-area-inset-bottom, 0px)) !important;
          }
        }
      `}</style>
    </>
  );
};

export default MobileBottomNav;
