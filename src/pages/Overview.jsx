import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Eye, MessageSquare, Plus, Loader2, Zap, FolderPlus, BarChart2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { useFeature } from '../context/FeatureFlagsContext';
import { useApiQuery } from '../hooks/useApi';
import { projectsApi, analyticsApi, zapsApi, eventsApi, coursesApi } from '../services/api';

const Overview = () => {
    const { t } = useTranslation();
    const { user } = useAuth();
    const opportunitiesOn = useFeature('projects');
    
    // Fetch builder/project data
    const { data: projects, loading: projectsLoading } = useApiQuery(projectsApi.list, { ownerId: user?.id });
    const { data: stats, loading: statsLoading } = useApiQuery(analyticsApi.builderDashboard);
    
    // Fetch event data
    const { data: events, loading: eventsLoading } = useApiQuery(eventsApi.listMine);
    
    const [totalSatsReceived, setTotalSatsReceived] = useState(0);
    const [courses, setCourses] = useState([]);
    const [coursesLoading, setCoursesLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        coursesApi.listEnrolled()
            .then(res => {
                if (!cancelled) setCourses(Array.isArray(res?.data) ? res.data : []);
            })
            .catch(() => {
                if (!cancelled) setCourses([]);
            })
            .finally(() => {
                if (!cancelled) setCoursesLoading(false);
            });
        return () => { cancelled = true; };
    }, []);

    const projectList = Array.isArray(projects?.data) ? projects.data : Array.isArray(projects) ? projects : [];
    const totalRaised = stats?.totalRaised || 0;
    const totalGoal = stats?.totalGoal || 0;
    const totalViews = stats?.totalViews || 0;
    const activeEnquiries = stats?.activeEnquiries || 0;
    const progressPct = totalGoal > 0 ? Math.round((totalRaised / totalGoal) * 100) : 0;

    useEffect(() => {
        if (projectList.length === 0) return;
        let cancelled = false;
        Promise.all(
            projectList.map(p => zapsApi.projectZapStats(p.id).catch(() => null))
        ).then(results => {
            if (cancelled) return;
            const total = results.reduce((sum, r) => sum + (r?.totalSats || 0), 0);
            setTotalSatsReceived(total);
        });
        return () => { cancelled = true; };
    }, [projectList.length]);

    const formatCurrency = (val) => {
        if (val >= 1000000) return `$${(val / 1000000).toFixed(1)}M`;
        if (val >= 1000) return `$${(val / 1000).toFixed(0)}k`;
        return `$${val}`;
    };

    const formatSats = (val) => {
        if (val >= 1000000) return `${(val / 1000000).toFixed(1)}M`;
        if (val >= 1000) return `${(val / 1000).toFixed(0)}k`;
        return String(val);
    };

    if (projectsLoading && statsLoading && eventsLoading && coursesLoading) {
        return (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
                <Loader2 size={32} style={{ animation: 'spin 1s linear infinite' }} />
            </div>
        );
    }

    const eventList = Array.isArray(events?.data) ? events.data : Array.isArray(events) ? events : [];
    const courseList = courses || [];

    const hasProjects = projectList.length > 0;
    const hasEvents = eventList.length > 0;
    const hasCourses = courseList.length > 0;
    const isInvestor = user?.role === 'INVESTOR';

    return (
        <div className="page-content">
            <div className="header page-title-block">
                <div>
                    <h1>Overview</h1>
                    <p className="subtitle">Welcome back, {user?.name || user?.email || 'Builder'}</p>
                </div>
            </div>

            {/* Analytics Preview Row */}
            <div className="section-header">
                <h2>Analytics Overview</h2>
                <Link to="/dashboard/analytics" className="btn btn-outline btn-sm" style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <BarChart2 size={16} /> Deep Dive
                </Link>
            </div>
            
            <div className="stats-grid">
                <div className="stat-box featured">
                    <span className="label">Total Capital Raised</span>
                    <div className="value-row">
                        <span className="value">{formatCurrency(totalRaised)}</span>
                        <span className="fraction">/ {formatCurrency(totalGoal)} {t('dashboard.goal')}</span>
                    </div>
                    <div className="progress-bar">
                        <div className="progress-fill" style={{ width: `${Math.min(progressPct, 100)}%` }}></div>
                    </div>
                </div>
                <div className="stat-box">
                    <span className="label">{t('dashboard.totalProjectViews')}</span>
                    <div className="value-row">
                        <Eye size={20} className="text-secondary" />
                        <span className="value">{totalViews.toLocaleString()}</span>
                    </div>
                </div>
                <div className="stat-box">
                    <span className="label">{t('dashboard.activeEnquiries')}</span>
                    <div className="value-row">
                        <MessageSquare size={20} className="text-primary" />
                        <span className="value">{activeEnquiries}</span>
                    </div>
                </div>
                <div className="stat-box">
                    <span className="label">Sats Received</span>
                    <div className="value-row">
                        <Zap size={20} style={{ color: '#f7931a' }} />
                        <span className="value">{formatSats(totalSatsReceived)}</span>
                        <span style={{ fontSize: '0.85rem', color: 'var(--color-gray-400)' }}>sats</span>
                    </div>
                </div>
            </div>

            {/* Hub Links / Dynamic Sections */}
            <div className="section-header mt-4">
                <h2>Ecosystem Hubs</h2>
            </div>
            <div className="hubs-grid">
                {opportunitiesOn && (
                    <Link to="/opportunities?mine=1" className="hub-card">
                        <div className="hub-icon"><FolderPlus size={24} /></div>
                        <div className="hub-info">
                            <h3>My Opportunities</h3>
                            <p>{hasProjects ? `${projectList.length} posted.` : 'Post an investment, a job, a partnership…'}</p>
                        </div>
                    </Link>
                )}
                <Link to="/dashboard/events" className="hub-card">
                    <div className="hub-icon" style={{ background: 'var(--color-secondary-light)', color: 'var(--color-secondary-dark)' }}><Plus size={24} /></div>
                    <div className="hub-info">
                        <h3>My Events</h3>
                        <p>{hasEvents ? `${eventList.length} events hosted.` : 'Host your first ecosystem event.'}</p>
                    </div>
                </Link>
                <Link to="/dashboard/courses" className="hub-card">
                    <div className="hub-icon" style={{ background: 'var(--color-purple-tint)', color: 'var(--color-purple-dark)' }}><Plus size={24} /></div>
                    <div className="hub-info">
                        <h3>My Courses</h3>
                        <p>{hasCourses ? `${courseList.length} courses published.` : 'Educate the community.'}</p>
                    </div>
                </Link>
            </div>

            {isInvestor && (
                <div className="investor-section mt-4">
                    <div className="section-header">
                        <h2>Investor Insights</h2>
                        {opportunitiesOn && <Link to="/opportunities?type=investment" className="btn btn-outline btn-sm" style={{ textDecoration: 'none' }}>Find Investments</Link>}
                    </div>
                    <div className="stat-box" style={{ background: 'var(--color-blue-tint)', border: '1px solid var(--color-primary-light)' }}>
                        <p style={{ color: 'var(--color-primary-dark)', fontWeight: 500 }}>You are a verified Investor. Check Opportunities to find the next big thing in El Salvador.</p>
                    </div>
                </div>
            )}

            <style jsx>{`
                .header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 2rem;
                }
                .subtitle { color: var(--color-gray-500); }

                .section-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 1rem;
                }
                .section-header h2 { font-size: 1.2rem; }
                .mt-4 { margin-top: 2rem; }

                /* Stats */
                .stats-grid {
                    display: grid;
                    grid-template-columns: repeat(4, 1fr);
                    gap: 1.5rem;
                    margin-bottom: 3rem;
                }

                .stat-box {
                    background: var(--color-surface);
                    padding: 1.5rem;
                    border-radius: var(--radius-lg);
                    border: 1px solid var(--color-gray-200);
                    box-shadow: var(--shadow-sm);
                }

                .stat-box.featured {
                    background: linear-gradient(135deg, var(--color-primary) 0%, var(--color-primary-dark) 100%);
                    color: white;
                }
                .stat-box.featured .label { color: rgba(255,255,255,0.8); }
                .stat-box.featured .fraction { color: rgba(255,255,255,0.6); font-size: 0.9rem; font-weight: normal; margin-left: 8px;}

                .stat-box .label { display: block; color: var(--color-gray-400); font-size: 0.875rem; margin-bottom: 0.5rem; }
                .value-row { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.5rem; }
                .value-row .value { font-size: 1.75rem; font-weight: 700; font-family: var(--font-mono); }

                .progress-bar {
                    height: 6px;
                    background: rgba(255,255,255,0.2);
                    border-radius: 99px;
                    overflow: hidden;
                    margin-top: 0.5rem;
                }
                .progress-fill { height: 100%; background: var(--color-success); border-radius: 99px; }

                .text-success { color: var(--color-success); }
                .text-secondary { color: var(--color-secondary); }
                .text-primary { color: var(--color-primary); }

                /* Hub Links */
                .hubs-grid {
                    display: grid;
                    grid-template-columns: repeat(3, 1fr);
                    gap: 1.5rem;
                }
                .hub-card {
                    background: var(--color-surface);
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-lg);
                    padding: 1.5rem;
                    display: flex;
                    align-items: flex-start;
                    gap: 1rem;
                    text-decoration: none;
                    color: inherit;
                    transition: all 0.2s;
                }
                .hub-card:hover {
                    border-color: var(--color-primary-light);
                    transform: translateY(-2px);
                    box-shadow: var(--shadow-md);
                }
                .hub-icon {
                    width: 48px; height: 48px;
                    border-radius: 12px;
                    background: var(--color-blue-tint);
                    color: var(--color-primary);
                    display: flex; align-items: center; justify-content: center;
                    flex-shrink: 0;
                }
                .hub-info h3 { font-size: 1.1rem; margin-bottom: 0.25rem; color: var(--color-gray-800); }
                .hub-info p { font-size: 0.9rem; color: var(--color-gray-500); line-height: 1.4; }

                @media (max-width: 768px) {
                    .stats-grid {
                        grid-template-columns: 1fr 1fr;
                        gap: 0.75rem;
                    }
                    .hubs-grid {
                        grid-template-columns: 1fr;
                    }
                }
            `}</style>
        </div>
    );
};

export default Overview;
