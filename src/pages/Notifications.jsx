import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Bell, Check, Trash2, Loader2, Trophy, Award, Target, Zap, RotateCcw, XCircle } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { notificationsApi } from '../services/api';

const Notifications = () => {
    const { t } = useTranslation();
    const { refreshNotifications } = useAuth();
    const [notifications, setNotifications] = useState([]);
    const [loading, setLoading] = useState(true);
    const [page, setPage] = useState(1);
    const [totalPages, setTotalPages] = useState(1);
    const [filter, setFilter] = useState('all'); // all | unread

    useEffect(() => {
        const fetchNotifications = async () => {
            setLoading(true);
            try {
                const params = { page, limit: 20 };
                if (filter === 'unread') params.unread = true;
                const result = await notificationsApi.list(params);
                const list = result?.data || result || [];
                setNotifications(Array.isArray(list) ? list : []);
                setTotalPages(result?.pagination?.totalPages || result?.totalPages || 1);
            } catch {
                setNotifications([]);
            } finally {
                setLoading(false);
            }
        };
        fetchNotifications();
    }, [page, filter]);

    const handleMarkRead = async (id) => {
        try {
            await notificationsApi.markRead(id);
            setNotifications(prev => prev.map(n => n.id === id ? { ...n, isRead: true } : n));
            refreshNotifications();
        } catch { /* ignore */ }
    };

    const handleMarkAllRead = async () => {
        try {
            await notificationsApi.markAllRead();
            setNotifications(prev => prev.map(n => ({ ...n, isRead: true })));
            refreshNotifications();
        } catch { /* ignore */ }
    };

    const handleDelete = async (id) => {
        try {
            await notificationsApi.delete(id);
            setNotifications(prev => prev.filter(n => n.id !== id));
            refreshNotifications();
        } catch { /* ignore */ }
    };

    const unreadCount = notifications.filter(n => !n.isRead).length;

    const formatTime = (dateStr) => {
        if (!dateStr) return '';
        const d = new Date(dateStr);
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    };

    // Gamification notification types get a distinctive icon
    const typeIcon = (type) => {
        switch (type) {
            case 'LEVEL_UP':
                return { icon: <Trophy size={17} />, color: '#D97706', bg: 'rgba(217, 119, 6, 0.12)' };
            case 'BADGE_EARNED':
                return { icon: <Award size={17} />, color: '#7C3AED', bg: 'rgba(124, 58, 237, 0.12)' };
            case 'BOUNTY_SUBMISSION':
                return { icon: <Target size={17} />, color: '#2563EB', bg: 'rgba(37, 99, 235, 0.12)' };
            case 'BOUNTY_AWARDED':
                return { icon: <Trophy size={17} />, color: '#D97706', bg: 'rgba(217, 119, 6, 0.12)' };
            case 'BOUNTY_PAID':
                return { icon: <Zap size={17} />, color: '#16A34A', bg: 'rgba(22, 163, 74, 0.12)' };
            case 'BOUNTY_REFUNDED':
                return { icon: <RotateCcw size={17} />, color: '#0891B2', bg: 'rgba(8, 145, 178, 0.12)' };
            case 'BOUNTY_CANCELLED':
                return { icon: <XCircle size={17} />, color: '#DC2626', bg: 'rgba(220, 38, 38, 0.12)' };
            default:
                return null;
        }
    };

    // Deep-link for notification types that reference an entity; a notice
    // can also carry its own in-app link (e.g. the listing it's about).
    const typeLink = (notif) => {
        try {
            const data = typeof notif.data === 'string' ? JSON.parse(notif.data) : notif.data;
            if (typeof data?.link === 'string' && /^\/(?!\/)/.test(data.link)) return data.link;
            if (!notif.type?.startsWith('BOUNTY_')) return null;
            return data?.bountyId ? `/bounties/${data.bountyId}` : null;
        } catch {
            return null;
        }
    };

    return (
        <div className="container py-8">
            <div className="header">
                <div className="flex items-center gap-3 page-title-block">
                    <Bell size={28} className="text-primary" />
                    <h1>Notifications</h1>
                </div>
                <div className="header-actions">
                    {unreadCount > 0 && (
                        <button className="btn btn-outline" onClick={handleMarkAllRead}>
                            <Check size={16} style={{ marginRight: 6 }} /> Mark all read
                        </button>
                    )}
                </div>
            </div>

            <div className="filter-tabs">
                <button className={`tab ${filter === 'all' ? 'active' : ''}`} onClick={() => { setFilter('all'); setPage(1); }}>All</button>
                <button className={`tab ${filter === 'unread' ? 'active' : ''}`} onClick={() => { setFilter('unread'); setPage(1); }}>Unread</button>
            </div>

            {loading ? (
                <div style={{ textAlign: 'center', padding: '3rem' }}>
                    <Loader2 size={32} style={{ animation: 'spin 1s linear infinite', margin: '0 auto' }} />
                </div>
            ) : notifications.length === 0 ? (
                <div className="empty-state">
                    <Bell size={48} style={{ color: 'var(--color-gray-300)', marginBottom: '1rem' }} />
                    <p>{filter === 'unread' ? 'No unread notifications' : 'No notifications yet'}</p>
                </div>
            ) : (
                <div className="notifications-list">
                    {notifications.map(notif => {
                        const link = typeLink(notif);
                        const body = (
                            <>
                                <p className="notif-title">{notif.title}</p>
                                {notif.body && <p className="notif-text">{notif.body}</p>}
                                <span className="notif-time">{formatTime(notif.createdAt)}</span>
                            </>
                        );
                        return (
                            <div key={notif.id} className={`notif-item ${!notif.isRead ? 'unread' : ''}`}>
                                <div className="notif-content">
                                    {!notif.isRead && <div className="dot-indicator"></div>}
                                    {typeIcon(notif.type) && (
                                        <div
                                            className="notif-type-icon"
                                            style={{ color: typeIcon(notif.type).color, background: typeIcon(notif.type).bg }}
                                            data-testid={`notif-icon-${notif.type}`}
                                        >
                                            {typeIcon(notif.type).icon}
                                        </div>
                                    )}
                                    {link ? (
                                        <Link
                                            to={link}
                                            className="notif-body"
                                            style={{ textDecoration: 'none', color: 'inherit' }}
                                            onClick={() => { if (!notif.isRead) handleMarkRead(notif.id); }}
                                        >
                                            {body}
                                        </Link>
                                    ) : (
                                        <div className="notif-body">{body}</div>
                                    )}
                                </div>
                                <div className="notif-actions">
                                    {!notif.isRead && (
                                        <button className="action-btn" title="Mark as read" onClick={() => handleMarkRead(notif.id)}>
                                            <Check size={16} />
                                        </button>
                                    )}
                                    <button className="action-btn delete" title="Delete" onClick={() => handleDelete(notif.id)}>
                                        <Trash2 size={16} />
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {totalPages > 1 && (
                <div className="pagination">
                    <button className="btn btn-outline" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</button>
                    <span>Page {page} of {totalPages}</span>
                    <button className="btn btn-outline" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next</button>
                </div>
            )}

            <style jsx>{`
                .container { max-width: 800px; margin: 0 auto; padding: 0 1rem; width: 100%; }
                .py-8 { padding-top: var(--page-top, 2rem); padding-bottom: 2rem; }

                .header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 1.5rem;
                }
                .header h1 { margin: 0; }
                .header-actions { display: flex; gap: 0.5rem; }
                /* Phones: the title is in the top bar, so the header is only
                   "Mark all read", when there is something to mark. */
                @media (max-width: 768px) {
                    .header { margin-bottom: 0; }
                    .header-actions:not(:empty) { margin-bottom: 0.75rem; }
                }

                .filter-tabs {
                    display: flex;
                    gap: 0;
                    margin-bottom: 1.5rem;
                    border-bottom: 1px solid var(--color-gray-200);
                }
                .tab {
                    padding: 0.75rem 1.5rem;
                    font-weight: 500;
                    color: var(--color-gray-500);
                    border-bottom: 2px solid transparent;
                    transition: all 0.2s;
                }
                .tab:hover { color: var(--color-neutral-dark); }
                .tab.active { color: var(--color-primary); border-bottom-color: var(--color-primary); font-weight: 600; }

                .empty-state {
                    text-align: center;
                    padding: 4rem 2rem;
                    color: var(--color-gray-500);
                }

                .notifications-list {
                    display: flex;
                    flex-direction: column;
                }

                .notif-item {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 1rem 1.25rem;
                    border-bottom: 1px solid var(--color-gray-100);
                    transition: background 0.15s;
                }
                .notif-item:hover { background: var(--color-gray-50); }
                .notif-item.unread { background: #F0F9FF; }
                .notif-item.unread:hover { background: #E0F2FE; }

                .notif-content {
                    display: flex;
                    align-items: flex-start;
                    gap: 0.75rem;
                    flex: 1;
                }

                .dot-indicator {
                    width: 8px;
                    height: 8px;
                    background: var(--color-primary);
                    border-radius: 50%;
                    margin-top: 6px;
                    flex-shrink: 0;
                }

                .notif-type-icon {
                    width: 34px;
                    height: 34px;
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    flex-shrink: 0;
                }

                .notif-body { flex: 1; }
                .notif-title { font-size: 0.95rem; font-weight: 600; line-height: 1.4; color: var(--color-neutral-dark); margin-bottom: 2px; }
                .notif-text { font-size: 0.85rem; line-height: 1.4; color: var(--color-gray-500); }
                .notif-time { font-size: 0.8rem; color: var(--color-gray-400); margin-top: 2px; display: block; }

                .notif-actions {
                    display: flex;
                    gap: 0.25rem;
                    opacity: 0;
                    transition: opacity 0.15s;
                }
                .notif-item:hover .notif-actions { opacity: 1; }

                .action-btn {
                    padding: 6px;
                    border-radius: 4px;
                    color: var(--color-gray-400);
                }
                .action-btn:hover { background: var(--color-gray-100); color: var(--color-primary); }
                .action-btn.delete:hover { color: var(--color-error); }

                .pagination {
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    gap: 1rem;
                    margin-top: 2rem;
                }

                @media (max-width: 640px) {
                    .notif-actions { opacity: 1; }
                }
            `}</style>
        </div>
    );
};

export default Notifications;
