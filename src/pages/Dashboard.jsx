import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { LayoutDashboard, Folder, CalendarDays, BookOpen, Heart, MessageSquare, Settings, LogOut } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useFeatureFlags } from '../context/FeatureFlagsContext';

const Dashboard = () => {
    const { t } = useTranslation();
    const location = useLocation();
    const { logout } = useAuth();
    const { theme } = useTheme();
    const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const [portalTarget, setPortalTarget] = useState(null);

    // Find the navbar subnav slot for the mobile tab bar portal
    useEffect(() => {
        const el = document.getElementById('navbar-subnav');
        if (el) setPortalTarget(el);
        return () => setPortalTarget(null);
    }, []);

    // `flag:` ties a tab to a runtime feature toggle — disabled features
    // disappear from the dashboard nav (their routes 404 via FeatureRoute).
    const { flags } = useFeatureFlags();
    const mainTabs = [
        { to: '/dashboard', label: t('dashboard.overview'), icon: LayoutDashboard, end: true },
        { to: '/opportunities?mine=1', label: t('dashboard.myOpportunities'), icon: Folder, flag: 'projects' },
        { to: '/dashboard/events', label: t('dashboard.eventsTab') || 'Events', icon: CalendarDays, flag: 'events' },
        { to: '/dashboard/courses', label: t('dashboard.courses') || 'Courses', icon: BookOpen },
        { to: '/dashboard/following', label: t('dashboard.following') || 'Following', icon: Heart },
        { to: '/dashboard/messages', label: t('dashboard.messages') || 'Messages', icon: MessageSquare, flag: 'messages' },
    ].filter((tab) => !tab.flag || flags[tab.flag] !== false);

    const isTabActive = (path, end) => end ? location.pathname === path : location.pathname.startsWith(path);

    // Scroll to top when switching tabs
    useEffect(() => {
        window.scrollTo(0, 0);
    }, [location.pathname]);

    return (
        <div className="dashboard-layout">
            {/* Desktop Sidebar */}
            <aside className="sidebar desktop-sidebar">
                <div className="sidebar-menu">
                    <div className="menu-group">
                        <p className="menu-label">{t('dashboard.main')}</p>
                        {mainTabs.map(tab => (
                            <NavLink
                                key={tab.to}
                                to={tab.to}
                                end={tab.end}
                                className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
                            >
                                <tab.icon size={18} /> <span className="link-label">{tab.label}</span>
                            </NavLink>
                        ))}
                    </div>

                    <div className="menu-group mt-auto">
                        <div className="divider"></div>
                        <NavLink
                            to="/dashboard/settings"
                            className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
                        >
                            <Settings size={18} /> <span className="link-label">{t('dashboard.settings')}</span>
                        </NavLink>
                        <button onClick={logout} className="sidebar-link text-error">
                            <LogOut size={18} /> <span className="link-label">{t('dashboard.logout')}</span>
                        </button>
                    </div>
                </div>
            </aside>

            {/* Mobile Tab Bar — portaled into the navbar so they're one fixed block */}
            {portalTarget && createPortal(
                <div className="mobile-tab-bar" style={{ display: 'none' }}>
                    {mainTabs.map(tab => {
                        const active = isTabActive(tab.to, tab.end);
                        const Icon = tab.icon;
                        return (
                            <NavLink
                                key={tab.to}
                                to={tab.to}
                                end={tab.end}
                                style={{
                                    display: 'flex',
                                    flexDirection: 'column',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    gap: '4px',
                                    flex: '1 0 0',
                                    minWidth: '48px',
                                    textDecoration: 'none',
                                    color: active ? (isDark ? '#ffffff' : 'var(--color-primary)') : 'var(--color-gray-400)',
                                    fontSize: '0.65rem',
                                    fontWeight: active ? 700 : 500,
                                    padding: '6px 0',
                                    WebkitTapHighlightColor: 'transparent',
                                }}
                            >
                                <div style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    width: '40px',
                                    height: '40px',
                                    minWidth: '40px',
                                    minHeight: '40px',
                                    borderRadius: '50%',
                                    background: active ? (isDark ? '#00004E' : 'var(--color-blue-tint)') : 'var(--color-gray-100)',
                                    color: active ? (isDark ? '#ffffff' : 'var(--color-primary)') : 'var(--color-gray-400)',
                                    border: active && isDark ? '1px solid rgba(100, 149, 237, 0.35)' : 'none',
                                    transition: 'all 0.2s',
                                }}>
                                    <Icon size={20} strokeWidth={active ? 2.5 : 1.8} />
                                </div>
                                <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>{tab.label}</span>
                            </NavLink>
                        );
                    })}
                </div>,
                portalTarget
            )}

            {/* Main Content Area */}
            <main className="dashboard-content">
                <Outlet />
            </main>

            <style>{`
        .dashboard-layout {
          display: flex;
          min-height: calc(100vh - 70px);
          background: var(--color-gray-50);
          margin: 0;
          padding: 0;
        }

        .desktop-sidebar {
          width: 260px;
          background: var(--color-surface);
          border-right: 1px solid var(--color-gray-200);
          display: flex;
          flex-direction: column;
        }

        .desktop-sidebar .sidebar-menu {
            padding: 2rem 1.5rem;
            height: 100%;
            display: flex;
            flex-direction: column;
            gap: 1rem;
        }

        .desktop-sidebar .menu-group {
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
        }

        .desktop-sidebar .menu-label {
            font-size: 0.75rem;
            text-transform: uppercase;
            color: var(--color-gray-400);
            font-weight: 700;
            margin-bottom: 0.75rem;
            padding-left: 0.5rem;
        }

        .desktop-sidebar .sidebar-link {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 0.75rem 1rem;
          color: var(--color-gray-500);
          border-radius: var(--radius-md);
          margin-bottom: 0.25rem;
          font-weight: 500;
          text-decoration: none;
          transition: all 0.2s;
          border: none;
          background: none;
          width: 100%;
          cursor: pointer;
          font-size: 0.95rem;
        }

        .desktop-sidebar .sidebar-link:hover { background: var(--color-primary-dark); color: white; }
        .desktop-sidebar .sidebar-link.active { background: var(--color-primary); color: white; font-weight: 600; }
        .desktop-sidebar .sidebar-link.text-error { color: var(--color-error); }
        .desktop-sidebar .sidebar-link.text-error:hover { background: var(--color-red-tint); }

        .desktop-sidebar .divider { height: 1px; background: var(--color-gray-200); margin: 1rem 0; }
        .desktop-sidebar .mt-auto { margin-top: auto; }

        .dashboard-content {
          flex: 1;
          padding: 2rem;
          overflow-y: auto;
          overflow-x: hidden;
        }

        .mobile-tab-bar { display: none; }

        @media (max-width: 768px) {
          .dashboard-layout {
            flex-direction: column;
            margin-top: 0;
            padding-top: 0;
          }
          .desktop-sidebar { display: none; }
          .mobile-tab-bar {
            display: flex !important;
            justify-content: space-evenly;
            align-items: flex-start;
            background: var(--color-gray-50);
            padding: 4px 0 2px;
            overflow-x: auto;
            overflow-y: hidden;
            border-bottom: 1px solid var(--color-gray-200);
            margin-top: -1px;
          }
          .dashboard-content {
            padding: 1rem;
            /* Extra space for the tab bar portaled into the navbar.
               .app-content already handles the base navbar + safe-area offset. */
            padding-top: 96px;
            flex: 1;
            min-height: 0;
            /* Override desktop overflow-y:auto / overflow-x:hidden so this element
               is NOT a scroll container on mobile. Nested scroll containers break
               position:fixed on iOS WebKit (bottom nav floats away). Let the body
               be the sole scroll container on mobile. */
            overflow: visible;
          }
        }
      `}</style>
        </div>
    );
};

export default Dashboard;
