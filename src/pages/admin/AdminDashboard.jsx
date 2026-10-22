import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Navigate, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LayoutDashboard, Folder, Calendar, Users, Trophy, FileText, Newspaper, MessageSquare, ShieldCheck, Store, GraduationCap, Ticket, Target, SlidersHorizontal, LogOut, Flag } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';

const AdminDashboard = () => {
  const { t } = useTranslation();
  const { logout, user } = useAuth();
  // Moderators moderate: Reports and the Directory. The rest (members'
  // emails, points, roles, settings) is for admins (admin.routes.ts).
  const isAdmin = !!user?.isAdmin;
  const { theme } = useTheme();
  const location = useLocation();
  const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [portalTarget, setPortalTarget] = useState(null);

  useEffect(() => {
    const el = document.getElementById('navbar-subnav');
    if (el) setPortalTarget(el);
    return () => setPortalTarget(null);
  }, []);

  const allTabs = [
    { to: '/admin', label: 'Overview', icon: LayoutDashboard, end: true },
    { to: '/admin/reports', label: 'Reports', icon: Flag },
    // Testers' reports and members' feedback (Report / Feedback), near the
    // front so it shows without scrolling the tabs on a phone.
    { to: '/admin/feedback', label: 'Feedback', icon: MessageSquare },
    { to: '/admin/projects', label: 'Opportunities', icon: Folder },
    { to: '/admin/events', label: 'Events', icon: Calendar },
    { to: '/admin/directory', label: 'Directory', icon: Store },
    { to: '/admin/courses', label: 'Courses', icon: GraduationCap },
    { to: '/admin/bounties', label: 'Bounties', icon: Target },
    { to: '/admin/users', label: 'Users', icon: Users },
    { to: '/admin/points', label: 'Points', icon: Trophy },
    { to: '/admin/audit-log', label: 'Audit', icon: FileText },
    { to: '/admin/news-settings', label: 'News', icon: Newspaper },
    { to: '/admin/investor-vetting', label: 'Vetting', icon: ShieldCheck },
    { to: '/admin/vouchers', label: t('admin.vouchers.nav'), icon: Ticket },
    { to: '/admin/features', label: t('features.tab'), icon: SlidersHorizontal },
  ];
  const MODERATOR_TABS = ['/admin/reports', '/admin/directory'];
  const tabs = isAdmin ? allTabs : allTabs.filter((tab) => MODERATOR_TABS.includes(tab.to));

  const isTabActive = (path, end) => end ? location.pathname === path : location.pathname.startsWith(path);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  return (
    <div className="dashboard-layout">
      {/* Desktop Sidebar */}
      <aside className="desktop-sidebar">
        <div className="sidebar-menu">
          <div className="menu-group">
            <p className="menu-label">Admin Panel</p>
            {tabs.map(tab => (
              <NavLink
                key={tab.to}
                to={tab.to}
                end={tab.end}
                className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
              >
                <tab.icon size={18} /> <span>{tab.label}</span>
              </NavLink>
            ))}
          </div>

          <div className="menu-group mt-auto">
            <div className="divider"></div>
            <button onClick={logout} className="sidebar-link text-error">
              <LogOut size={18} /> <span>Logout</span>
            </button>
          </div>
        </div>
      </aside>

      {/* Mobile Tab Bar — portaled into the navbar */}
      {portalTarget && createPortal(
        <div className="admin-mobile-tabs" style={{ display: 'none' }}>
          {tabs.map(tab => {
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

      <main className="dashboard-content">
        {!isAdmin && !MODERATOR_TABS.some((path) => location.pathname.startsWith(path))
          ? <Navigate to="/admin/reports" replace />
          : <Outlet />}
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

        .admin-mobile-tabs { display: none; }

        @media (max-width: 768px) {
          .dashboard-layout {
            flex-direction: column;
            margin-top: 0;
            padding-top: 0;
          }
          .desktop-sidebar { display: none; }
          .admin-mobile-tabs {
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
            padding-top: 96px;
            flex: 1;
            min-height: 0;
            overflow: visible;
          }
        }
      `}</style>
    </div>
  );
};

export default AdminDashboard;
