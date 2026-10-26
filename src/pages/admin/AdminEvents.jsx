import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Star, ExternalLink, Trash2, Loader2, Search, Plus } from 'lucide-react';
import { adminApi, eventsApi } from '../../services/api';

const AdminEvents = () => {
    const [search, setSearch] = useState('');
    const [events, setEvents] = useState([]);
    const [pagination, setPagination] = useState({ page: 1, total: 0, totalPages: 1 });
    const [loading, setLoading] = useState(true);
    const [actionLoading, setActionLoading] = useState(null);

    const fetchEvents = useCallback(async (page = 1) => {
        setLoading(true);
        try {
            const params = { page, limit: 20 };
            if (search) params.search = search;
            const res = await adminApi.listEvents(params);
            setEvents(Array.isArray(res?.data) ? res.data : []);
            setPagination(res?.pagination || { page: 1, total: 0, totalPages: 1 });
        } catch (err) {
            console.error('Failed to fetch events:', err);
        } finally {
            setLoading(false);
        }
    }, [search]);

    useEffect(() => { fetchEvents(1); }, [fetchEvents]);

    const handleFeature = async (id, currentFeatured) => {
        setActionLoading(id);
        try {
            await adminApi.featureEvent(id, !currentFeatured);
            fetchEvents(pagination.page);
        } catch (err) {
            alert('Failed to update featured status');
        } finally {
            setActionLoading(null);
        }
    };

    const handleDelete = async (id, title) => {
        if (!window.confirm(`Delete event "${title}"? This cannot be undone.`)) return;
        setActionLoading(id);
        try {
            await eventsApi.delete(id);
            fetchEvents(pagination.page);
        } catch (err) {
            alert('Failed to delete event');
        } finally {
            setActionLoading(null);
        }
    };

    const formatDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

    return (
        <>
            <div className="header">
                <div>
                    <h1>Event Management</h1>
                    <p className="subtitle">Manage platform events</p>
                </div>
                <Link to="/events/create" className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', textDecoration: 'none' }}>
                    <Plus size={18} style={{ marginRight: 8 }} /> Create Event
                </Link>
            </div>

            <div className="toolbar">
                <div className="search-wrap">
                    <Search size={16} />
                    <input
                        type="text"
                        placeholder="Search events..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                </div>
            </div>

            {loading ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
                    <Loader2 size={32} style={{ animation: 'spin 1s linear infinite' }} />
                </div>
            ) : events.length === 0 ? (
                <div className="empty-state">
                    <p>No events found.</p>
                </div>
            ) : (
                <div className="table-container">
                    <table className="data-table">
                        <thead>
                            <tr>
                                <th>Event</th>
                                <th>Host</th>
                                <th>Category</th>
                                <th>Date</th>
                                <th>Attendees</th>
                                <th>Published</th>
                                <th>Featured</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {events.map(e => (
                                <tr key={e.id}>
                                    <td className="font-semibold">{e.title}</td>
                                    <td data-label="Host">{e.host?.profile?.name || e.host?.email || '—'}</td>
                                    <td data-label="Category">{e.category}</td>
                                    <td data-label="Date">{formatDate(e.startDate)}</td>
                                    <td data-label="Attendees" className="mobile-hide">{e._count?.attendees || 0}{e.maxAttendees ? ` / ${e.maxAttendees}` : ''}</td>
                                    <td data-label="Published" className="mobile-hide">
                                        <span className={`status-badge ${e.isPublished ? 'active' : 'draft'}`}>
                                            {e.isPublished ? 'Yes' : 'No'}
                                        </span>
                                    </td>
                                    <td data-label="Featured" className="mobile-hide">
                                        <button
                                            className={`icon-btn ${e.isFeatured ? 'featured-active' : ''}`}
                                            onClick={() => handleFeature(e.id, e.isFeatured)}
                                            title={e.isFeatured ? 'Unfeature' : 'Feature'}
                                            disabled={actionLoading === e.id}
                                        >
                                            <Star size={16} fill={e.isFeatured ? 'currentColor' : 'none'} />
                                        </button>
                                    </td>
                                    <td>
                                        <div className="action-group">
                                            <Link to={`/events/${e.id}`} className="icon-btn" title="View">
                                                <ExternalLink size={16} />
                                            </Link>
                                            <button
                                                className="icon-btn delete"
                                                onClick={() => handleDelete(e.id, e.title)}
                                                title="Delete"
                                                disabled={actionLoading === e.id}
                                            >
                                                <Trash2 size={16} />
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {pagination.totalPages > 1 && (
                <div className="pagination">
                    <button disabled={pagination.page <= 1} onClick={() => fetchEvents(pagination.page - 1)}>Previous</button>
                    <span>Page {pagination.page} of {pagination.totalPages}</span>
                    <button disabled={pagination.page >= pagination.totalPages} onClick={() => fetchEvents(pagination.page + 1)}>Next</button>
                </div>
            )}

            <style jsx>{`
                .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; }
                .subtitle { color: var(--color-gray-500); }
                .toolbar { margin-bottom: 1.5rem; }
                .search-wrap {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.5rem;
                    background: var(--color-surface);
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-md);
                    padding: 0.5rem 0.75rem;
                    color: var(--color-gray-400);
                }
                .search-wrap input {
                    border: none;
                    outline: none;
                    font-size: 0.875rem;
                    background: transparent;
                    width: 200px;
                }
                .empty-state {
                    background: var(--color-surface);
                    border-radius: var(--radius-lg);
                    padding: 3rem;
                    text-align: center;
                    color: var(--color-gray-500);
                    border: 1px solid var(--color-gray-200);
                }
                .table-container {
                    background: var(--color-surface);
                    border-radius: var(--radius-lg);
                    box-shadow: var(--shadow-sm);
                    overflow-x: auto;
                }
                .data-table { width: 100%; border-collapse: collapse; }
                .data-table th {
                    text-align: left;
                    padding: 1rem 1.25rem;
                    border-bottom: 1px solid var(--color-gray-200);
                    color: var(--color-gray-500);
                    font-size: 0.8rem;
                    font-weight: 600;
                    text-transform: uppercase;
                }
                .data-table td {
                    padding: 0.875rem 1.25rem;
                    border-bottom: 1px solid var(--color-gray-100);
                    font-size: 0.9rem;
                }
                .data-table tr:last-child td { border-bottom: none; }
                .font-semibold { font-weight: 600; }
                .status-badge {
                    display: inline-block;
                    font-size: 0.7rem;
                    padding: 2px 8px;
                    border-radius: 99px;
                    font-weight: 600;
                    text-transform: uppercase;
                }
                .status-badge.active { background: var(--color-green-tint); color: var(--badge-success-text); }
                .status-badge.draft { background: var(--badge-draft-bg); color: var(--color-gray-600); }
                .action-group { display: flex; gap: 0.25rem; align-items: center; }
                .icon-btn {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    padding: 0.4rem;
                    border-radius: var(--radius-md);
                    border: none;
                    background: none;
                    cursor: pointer;
                    color: var(--color-gray-400);
                    transition: all 0.15s;
                    text-decoration: none;
                }
                .icon-btn:hover { background: var(--color-gray-100); color: var(--color-neutral-dark); }
                .icon-btn.delete { color: #dc2626; }
                .icon-btn.delete:hover { background: var(--color-red-tint); }
                .icon-btn.featured-active { color: #eab308; }
                .icon-btn:disabled { opacity: 0.5; cursor: not-allowed; }
                .pagination {
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    gap: 1rem;
                    margin-top: 1.5rem;
                }
                .pagination button {
                    padding: 0.5rem 1rem;
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-md);
                    background: var(--color-surface);
                    cursor: pointer;
                    font-size: 0.875rem;
                }
                .pagination button:disabled { opacity: 0.5; cursor: not-allowed; }
                .pagination span { font-size: 0.875rem; color: var(--color-gray-500); }
                @media (max-width: 768px) {
                    .header { flex-direction: column; align-items: flex-start; gap: 0.75rem; }
                    .header h1 { font-size: 1.25rem; }
                    .search-wrap { display: flex; width: 100%; }
                    .search-wrap input { width: 100%; }
                    .table-container { background: none; box-shadow: none; overflow: visible; }
                    .data-table,
                    .data-table thead,
                    .data-table tbody,
                    .data-table tr,
                    .data-table th,
                    .data-table td { display: block; }
                    .data-table thead { display: none; }
                    .data-table tr {
                        background: var(--color-surface);
                        border: 1px solid var(--color-gray-200);
                        border-radius: var(--radius-lg);
                        padding: 1rem;
                        margin-bottom: 0.75rem;
                    }
                    .data-table td {
                        display: flex;
                        align-items: center;
                        padding: 0.3rem 0;
                        border-bottom: none;
                        gap: 0.5rem;
                    }
                    .data-table td::before {
                        content: attr(data-label);
                        font-weight: 600;
                        font-size: 0.7rem;
                        color: var(--color-gray-400);
                        text-transform: uppercase;
                        letter-spacing: 0.05em;
                        min-width: 72px;
                        flex-shrink: 0;
                    }
                    .data-table td:first-child {
                        font-size: 1rem;
                        font-weight: 600;
                        padding-bottom: 0.5rem;
                        margin-bottom: 0.25rem;
                        border-bottom: 1px solid var(--color-gray-100);
                    }
                    .data-table td:first-child::before { display: none; }
                    .data-table td.mobile-hide { display: none; }
                    .data-table td:last-child {
                        padding-top: 0.5rem;
                        margin-top: 0.25rem;
                        border-top: 1px solid var(--color-gray-100);
                    }
                    .data-table td:last-child::before { display: none; }
                    .action-group { gap: 0.5rem; }
                    .icon-btn { padding: 0.5rem; }
                }
            `}</style>
        </>
    );
};

export default AdminEvents;
