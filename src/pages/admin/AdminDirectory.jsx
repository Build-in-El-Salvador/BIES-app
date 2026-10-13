import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle, XCircle, Star, ExternalLink, Trash2, Loader2, Search, RefreshCw, ShieldCheck } from 'lucide-react';
import { adminApi } from '../../services/api';

// Members' listings go live at once (pending only while the server's
// DIRECTORY_REQUIRE_APPROVAL is on), so staff mostly take listings down.
const STATUS_TABS = [
    { key: '', label: 'All' },
    { key: 'active', label: 'Live' },
    { key: 'pending-review', label: 'Pending Review' },
    { key: 'rejected', label: 'Rejected / Taken down' },
];

const TYPE_OPTIONS = [
    { key: '', label: 'All Types' },
    { key: 'FARM', label: 'Farms' },
    { key: 'PROVIDER', label: 'Businesses (BIES Trusted)' },
];

const AdminDirectory = () => {
    const [tab, setTab] = useState('');
    const [type, setType] = useState('');
    const [search, setSearch] = useState('');
    const [listings, setListings] = useState([]);
    const [pagination, setPagination] = useState({ page: 1, total: 0, totalPages: 1 });
    const [loading, setLoading] = useState(true);
    const [actionLoading, setActionLoading] = useState(null);
    const [recomputing, setRecomputing] = useState(false);

    const fetchListings = useCallback(async (page = 1) => {
        setLoading(true);
        try {
            const params = { page, limit: 20 };
            if (tab) params.status = tab;
            if (type) params.type = type;
            if (search) params.search = search;
            const res = await adminApi.listDirectory(params);
            setListings(Array.isArray(res?.data) ? res.data : []);
            setPagination(res?.pagination || { page: 1, total: 0, totalPages: 1 });
        } catch (err) {
            console.error('Failed to fetch directory listings:', err);
        } finally {
            setLoading(false);
        }
    }, [tab, type, search]);

    useEffect(() => { fetchListings(1); }, [fetchListings]);

    const handleReview = async (id, action, status) => {
        const label = action === 'approve'
            ? (status === 'rejected' ? 'put back' : 'approve')
            : (status === 'active' ? 'take down' : 'reject');
        if (!window.confirm(`Are you sure you want to ${label} this listing?`)) return;
        setActionLoading(id);
        try {
            await adminApi.reviewDirectoryListing(id, action);
            fetchListings(pagination.page);
        } catch (err) {
            alert(`Failed to ${label} listing`);
        } finally {
            setActionLoading(null);
        }
    };

    const handleFeature = async (id, currentFeatured) => {
        setActionLoading(id);
        try {
            await adminApi.featureDirectoryListing(id, !currentFeatured);
            fetchListings(pagination.page);
        } catch (err) {
            alert('Failed to update featured status');
        } finally {
            setActionLoading(null);
        }
    };

    const handleDelete = async (id, name) => {
        if (!window.confirm(`Permanently delete "${name}"? This cannot be undone.`)) return;
        setActionLoading(id);
        try {
            await adminApi.deleteDirectoryListing(id);
            fetchListings(pagination.page);
        } catch (err) {
            alert('Failed to delete listing');
        } finally {
            setActionLoading(null);
        }
    };

    const handleRecompute = async () => {
        setRecomputing(true);
        try {
            await adminApi.recomputeDirectoryScores();
            fetchListings(pagination.page);
        } catch (err) {
            alert('Failed to recompute scores');
        } finally {
            setRecomputing(false);
        }
    };

    const statusBadge = (status) => {
        const cls = (status || 'draft').replace(' ', '-').toLowerCase();
        const label = status === 'pending-review' ? 'Pending' : (status || 'Draft');
        return <span className={`status-badge ${cls}`}>{label}</span>;
    };

    const viewPath = (l) => `/discover/${l.type === 'FARM' ? 'farms' : 'trusted'}/${l.id}`;

    return (
        <>
            <div className="header">
                <div>
                    <h1>Directory Management</h1>
                    <p className="subtitle">Review and manage farm and business listings</p>
                </div>
                <button className="recompute-btn" onClick={handleRecompute} disabled={recomputing}>
                    {recomputing
                        ? <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} />
                        : <RefreshCw size={15} />}
                    Recompute Scores
                </button>
            </div>

            <div className="toolbar">
                <div className="tabs">
                    {STATUS_TABS.map(t => (
                        <button
                            key={t.key}
                            className={`tab ${tab === t.key ? 'active' : ''}`}
                            onClick={() => setTab(t.key)}
                        >
                            {t.label}
                        </button>
                    ))}
                </div>
                <div className="filters-right">
                    <select
                        className="type-select"
                        value={type}
                        onChange={(e) => setType(e.target.value)}
                    >
                        {TYPE_OPTIONS.map(o => (
                            <option key={o.key} value={o.key}>{o.label}</option>
                        ))}
                    </select>
                    <div className="search-wrap">
                        <Search size={16} />
                        <input
                            type="text"
                            placeholder="Search listings..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                        />
                    </div>
                </div>
            </div>

            {loading ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
                    <Loader2 size={32} style={{ animation: 'spin 1s linear infinite' }} />
                </div>
            ) : listings.length === 0 ? (
                <div className="empty-state">
                    <p>No listings found{tab ? ` with status "${tab}"` : ''}.</p>
                </div>
            ) : (
                <div className="table-container">
                    <table className="data-table">
                        <thead>
                            <tr>
                                <th>Listing</th>
                                <th>Type</th>
                                <th>Owner</th>
                                <th>Status</th>
                                <th>Trust Score</th>
                                <th>Featured</th>
                                <th>Created</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {listings.map(l => (
                                <tr key={l.id}>
                                    <td className="font-semibold">{l.name}</td>
                                    <td data-label="Type">
                                        <span className={`type-chip ${l.type === 'FARM' ? 'farm' : 'provider'}`}>
                                            {l.type === 'FARM' ? 'Farm' : 'Provider'}
                                        </span>
                                    </td>
                                    <td data-label="Owner">{l.owner?.profile?.name || l.owner?.email || '—'}</td>
                                    <td data-label="Status">{statusBadge(l.status)}</td>
                                    <td data-label="Trust Score">
                                        <span className="score-cell" title={`${l.vouchCount ?? 0} vouches, ${l.downvoteCount ?? 0} downvotes`}>
                                            {l.reputationScore > 0 ? `+${l.reputationScore}` : l.reputationScore}
                                            <span className="score-votes">↑{l.vouchCount ?? 0} ↓{l.downvoteCount ?? 0}</span>
                                            {l.isCertified && (
                                                <ShieldCheck size={15} className="certified-icon" title="BIES Trusted" />
                                            )}
                                        </span>
                                    </td>
                                    <td data-label="Featured">
                                        <button
                                            className={`icon-btn ${l.isFeatured ? 'featured-active' : ''}`}
                                            onClick={() => handleFeature(l.id, l.isFeatured)}
                                            title={l.isFeatured ? 'Unfeature' : 'Feature'}
                                            disabled={actionLoading === l.id}
                                        >
                                            <Star size={16} fill={l.isFeatured ? 'currentColor' : 'none'} />
                                        </button>
                                    </td>
                                    <td data-label="Created" className="mobile-hide">{new Date(l.createdAt).toLocaleDateString()}</td>
                                    <td>
                                        <div className="action-group">
                                            {l.status !== 'active' && (
                                                <button
                                                    className="icon-btn approve"
                                                    onClick={() => handleReview(l.id, 'approve', l.status)}
                                                    title={l.status === 'rejected' ? 'Put back' : 'Approve'}
                                                    disabled={actionLoading === l.id}
                                                >
                                                    <CheckCircle size={16} />
                                                </button>
                                            )}
                                            {l.status !== 'rejected' && (
                                                <button
                                                    className="icon-btn reject"
                                                    onClick={() => handleReview(l.id, 'reject', l.status)}
                                                    title={l.status === 'active' ? 'Take down' : 'Reject'}
                                                    disabled={actionLoading === l.id}
                                                >
                                                    <XCircle size={16} />
                                                </button>
                                            )}
                                            <Link to={viewPath(l)} className="icon-btn" title="View">
                                                <ExternalLink size={16} />
                                            </Link>
                                            <button
                                                className="icon-btn delete"
                                                onClick={() => handleDelete(l.id, l.name)}
                                                title="Delete"
                                                disabled={actionLoading === l.id}
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
                    <button
                        disabled={pagination.page <= 1}
                        onClick={() => fetchListings(pagination.page - 1)}
                    >Previous</button>
                    <span>Page {pagination.page} of {pagination.totalPages}</span>
                    <button
                        disabled={pagination.page >= pagination.totalPages}
                        onClick={() => fetchListings(pagination.page + 1)}
                    >Next</button>
                </div>
            )}

            <style jsx>{`
                .header {
                    margin-bottom: 1.5rem;
                    display: flex;
                    justify-content: space-between;
                    align-items: flex-start;
                    gap: 1rem;
                    flex-wrap: wrap;
                }
                .subtitle { color: var(--color-gray-500); }
                .recompute-btn {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.4rem;
                    padding: 0.5rem 1rem;
                    background: var(--color-primary);
                    color: white;
                    border: none;
                    border-radius: var(--radius-md);
                    cursor: pointer;
                    font-size: 0.875rem;
                    font-weight: 500;
                    white-space: nowrap;
                }
                .recompute-btn:disabled { opacity: 0.6; cursor: not-allowed; }
                .toolbar {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 1.5rem;
                    gap: 1rem;
                    flex-wrap: wrap;
                }
                .tabs { display: flex; gap: 0.5rem; }
                .tab {
                    padding: 0.5rem 1rem;
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-md);
                    background: var(--color-surface);
                    cursor: pointer;
                    font-size: 0.875rem;
                    font-weight: 500;
                    color: var(--color-gray-500);
                    transition: all 0.15s;
                    white-space: nowrap;
                }
                .tab:hover { border-color: var(--color-primary); color: var(--color-primary); }
                .tab.active { background: var(--color-primary); color: white; border-color: var(--color-primary); }
                .filters-right { display: flex; gap: 0.5rem; align-items: center; }
                .type-select {
                    padding: 0.5rem 0.75rem;
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-md);
                    background: var(--color-surface);
                    color: var(--color-gray-600);
                    font-size: 0.875rem;
                    cursor: pointer;
                    outline: none;
                }
                .search-wrap {
                    display: flex;
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
                .type-chip {
                    display: inline-block;
                    font-size: 0.7rem;
                    padding: 2px 8px;
                    border-radius: 99px;
                    font-weight: 600;
                    text-transform: uppercase;
                }
                .type-chip.farm { background: var(--color-green-tint); color: var(--badge-success-text); }
                .type-chip.provider { background: var(--color-blue-tint); color: var(--color-primary); }
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
                .status-badge.pending-review { background: var(--color-amber-tint); color: var(--badge-warning-text); }
                .status-badge.rejected { background: var(--color-red-tint); color: #dc2626; }
                .score-cell {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.3rem;
                    font-weight: 600;
                }
                .score-votes { font-weight: 400; font-size: 0.8rem; color: var(--color-gray-500); }
                /* :global() for the icon component: styled-jsx only scopes plain elements */
                .score-cell :global(.certified-icon) { color: #16a34a; flex-shrink: 0; }
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
                .icon-btn.approve { color: #16a34a; }
                .icon-btn.approve:hover { background: var(--color-green-tint); }
                .icon-btn.reject { color: #dc2626; }
                .icon-btn.reject:hover { background: var(--color-red-tint); }
                .icon-btn.delete { color: #dc2626; }
                .icon-btn.delete:hover { background: var(--color-red-tint); }
                .icon-btn.save { color: var(--color-primary); }
                .icon-btn.save:hover { background: var(--color-blue-tint); }
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
                    .header h1 { font-size: 1.25rem; }
                    .toolbar { flex-direction: column; align-items: stretch; }
                    .tabs { overflow-x: auto; scrollbar-width: none; }
                    .tabs::-webkit-scrollbar { display: none; }
                    .filters-right { flex-direction: column; align-items: stretch; }
                    .search-wrap { display: flex; }
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

export default AdminDirectory;
