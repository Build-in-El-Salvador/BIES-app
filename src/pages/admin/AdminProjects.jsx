import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle, XCircle, Star, ExternalLink, Trash2, Loader2, Search, ArrowRightLeft } from 'lucide-react';
import { adminApi } from '../../services/api';
import TypeBadge from '../../components/opportunities/TypeBadge';

const MoveOwnerModal = ({ project, onClose, onSuccess }) => {
    const [userSearch, setUserSearch] = useState('');
    const [users, setUsers] = useState([]);
    const [searching, setSearching] = useState(false);
    const [selected, setSelected] = useState(null);
    const [submitting, setSubmitting] = useState(false);

    const searchUsers = async () => {
        if (!userSearch.trim()) return;
        setSearching(true);
        try {
            const res = await adminApi.users({ search: userSearch, limit: 10 });
            setUsers((res?.data || []).filter(u => u.id !== project.currentOwner?.id));
        } catch {
            setUsers([]);
        } finally {
            setSearching(false);
        }
    };

    const handleSubmit = async () => {
        if (!selected) return;
        if (!window.confirm(`Transfer "${project.projectTitle}" to ${selected.profile?.name || selected.email || selected.id}?`)) return;
        setSubmitting(true);
        try {
            await adminApi.changeProjectOwner(project.projectId, selected.id);
            onSuccess();
        } catch {
            alert('Failed to transfer ownership');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content" onClick={e => e.stopPropagation()}>
                <h3>Move Project Ownership</h3>
                <p className="modal-subtitle">
                    Transfer <strong>{project.projectTitle}</strong> to a new owner.
                </p>
                <p className="modal-current">
                    Current owner: <strong>{project.currentOwner?.profile?.name || project.currentOwner?.email || '—'}</strong>
                </p>

                <div className="modal-search">
                    <input
                        type="text"
                        placeholder="Search users by name or email..."
                        value={userSearch}
                        onChange={e => setUserSearch(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && searchUsers()}
                    />
                    <button onClick={searchUsers} disabled={searching || !userSearch.trim()}>
                        {searching ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : 'Search'}
                    </button>
                </div>

                {users.length > 0 && (
                    <ul className="user-list">
                        {users.map(u => (
                            <li
                                key={u.id}
                                className={`user-item ${selected?.id === u.id ? 'selected' : ''}`}
                                onClick={() => setSelected(u)}
                            >
                                <span className="user-name">{u.profile?.name || u.email || u.id}</span>
                                <span className="user-role">{u.role}</span>
                            </li>
                        ))}
                    </ul>
                )}

                <div className="modal-actions">
                    <button className="btn-cancel" onClick={onClose}>Cancel</button>
                    <button
                        className="btn-confirm"
                        disabled={!selected || submitting}
                        onClick={handleSubmit}
                    >
                        {submitting ? 'Transferring...' : 'Transfer Ownership'}
                    </button>
                </div>
            </div>
        </div>
    );
};

// Opportunities go up at once (no review), so All comes first.
const TABS = [
    { key: '', label: 'All' },
    { key: 'active', label: 'Active' },
    { key: 'draft', label: 'Draft' },
];

const AdminProjects = () => {
    const [tab, setTab] = useState('');
    const [search, setSearch] = useState('');
    const [projects, setProjects] = useState([]);
    const [pagination, setPagination] = useState({ page: 1, total: 0, totalPages: 1 });
    const [loading, setLoading] = useState(true);
    const [actionLoading, setActionLoading] = useState(null);
    const [moveModal, setMoveModal] = useState(null); // { projectId, projectTitle, currentOwner }

    const fetchProjects = useCallback(async (page = 1) => {
        setLoading(true);
        try {
            const params = { page, limit: 20 };
            if (tab) params.status = tab;
            if (search) params.search = search;
            const res = await adminApi.listProjects(params);
            setProjects(Array.isArray(res?.data) ? res.data : []);
            setPagination(res?.pagination || { page: 1, total: 0, totalPages: 1 });
        } catch (err) {
            console.error('Failed to fetch projects:', err);
        } finally {
            setLoading(false);
        }
    }, [tab, search]);

    useEffect(() => { fetchProjects(1); }, [fetchProjects]);

    const handleReview = async (id, action) => {
        const label = action === 'approve' ? 'approve' : 'reject';
        if (!window.confirm(`Are you sure you want to ${label} this project?`)) return;
        setActionLoading(id);
        try {
            await adminApi.reviewProject(id, action);
            fetchProjects(pagination.page);
        } catch (err) {
            alert(`Failed to ${label} project`);
        } finally {
            setActionLoading(null);
        }
    };

    const handleFeature = async (id, currentFeatured) => {
        setActionLoading(id);
        try {
            await adminApi.featureProject(id, !currentFeatured);
            fetchProjects(pagination.page);
        } catch (err) {
            alert('Failed to update featured status');
        } finally {
            setActionLoading(null);
        }
    };

    const handleDelete = async (id, title) => {
        if (!window.confirm(`Permanently delete "${title}"? This cannot be undone.`)) return;
        setActionLoading(id);
        try {
            await adminApi.deleteProject(id);
            fetchProjects(pagination.page);
        } catch (err) {
            alert('Failed to delete project');
        } finally {
            setActionLoading(null);
        }
    };

    const statusBadge = (status) => {
        const cls = (status || 'draft').replace(' ', '-').toLowerCase();
        const label = status === 'pending-review' ? 'Pending' : (status || 'Draft');
        return <span className={`status-badge ${cls}`}>{label}</span>;
    };

    return (
        <>
            <div className="header">
                <div>
                    <h1>Opportunities</h1>
                    <p className="subtitle">Investments, businesses for sale, jobs, partnerships and programs members post</p>
                </div>
            </div>

            <div className="toolbar">
                <div className="tabs">
                    {TABS.map(t => (
                        <button
                            key={t.key}
                            className={`tab ${tab === t.key ? 'active' : ''}`}
                            onClick={() => setTab(t.key)}
                        >
                            {t.label}
                        </button>
                    ))}
                </div>
                <div className="search-wrap">
                    <Search size={16} />
                    <input
                        type="text"
                        placeholder="Search opportunities..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                </div>
            </div>

            {loading ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
                    <Loader2 size={32} style={{ animation: 'spin 1s linear infinite' }} />
                </div>
            ) : projects.length === 0 ? (
                <div className="empty-state">
                    <p>No opportunities found{tab ? ` with status "${tab}"` : ''}.</p>
                </div>
            ) : (
                <div className="table-container">
                    <table className="data-table">
                        <thead>
                            <tr>
                                <th>Opportunity</th>
                                <th>Owner</th>
                                <th>Type</th>
                                <th>Status</th>
                                <th>Featured</th>
                                <th>Created</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {projects.map(p => (
                                <tr key={p.id}>
                                    <td className="font-semibold">{p.title}</td>
                                    <td data-label="Owner">{p.owner?.profile?.name || p.owner?.email || '—'}</td>
                                    <td data-label="Type"><TypeBadge opportunity={p} withKind /></td>
                                    <td data-label="Status">{statusBadge(p.status)}</td>
                                    <td data-label="Featured" className="mobile-hide">
                                        <button
                                            className={`icon-btn ${p.isFeatured ? 'featured-active' : ''}`}
                                            onClick={() => handleFeature(p.id, p.isFeatured)}
                                            title={p.isFeatured ? 'Unfeature' : 'Feature'}
                                            disabled={actionLoading === p.id}
                                        >
                                            <Star size={16} fill={p.isFeatured ? 'currentColor' : 'none'} />
                                        </button>
                                    </td>
                                    <td data-label="Created" className="mobile-hide">{new Date(p.createdAt).toLocaleDateString()}</td>
                                    <td>
                                        <div className="action-group">
                                            {p.status === 'pending-review' && (
                                                <>
                                                    <button
                                                        className="icon-btn approve"
                                                        onClick={() => handleReview(p.id, 'approve')}
                                                        title="Approve"
                                                        disabled={actionLoading === p.id}
                                                    >
                                                        <CheckCircle size={16} />
                                                    </button>
                                                    <button
                                                        className="icon-btn reject"
                                                        onClick={() => handleReview(p.id, 'reject')}
                                                        title="Reject"
                                                        disabled={actionLoading === p.id}
                                                    >
                                                        <XCircle size={16} />
                                                    </button>
                                                </>
                                            )}
                                            <button
                                                className="icon-btn transfer"
                                                onClick={() => setMoveModal({
                                                    projectId: p.id,
                                                    projectTitle: p.title,
                                                    currentOwner: p.owner,
                                                })}
                                                title="Move Ownership"
                                                disabled={actionLoading === p.id}
                                            >
                                                <ArrowRightLeft size={16} />
                                            </button>
                                            <Link to={`/opportunities/${p.id}`} className="icon-btn" title="View">
                                                <ExternalLink size={16} />
                                            </Link>
                                            <button
                                                className="icon-btn delete"
                                                onClick={() => handleDelete(p.id, p.title)}
                                                title="Delete"
                                                disabled={actionLoading === p.id}
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
                        onClick={() => fetchProjects(pagination.page - 1)}
                    >Previous</button>
                    <span>Page {pagination.page} of {pagination.totalPages}</span>
                    <button
                        disabled={pagination.page >= pagination.totalPages}
                        onClick={() => fetchProjects(pagination.page + 1)}
                    >Next</button>
                </div>
            )}

            {moveModal && (
                <MoveOwnerModal
                    project={moveModal}
                    onClose={() => setMoveModal(null)}
                    onSuccess={() => {
                        setMoveModal(null);
                        fetchProjects(pagination.page);
                    }}
                />
            )}

            <style jsx>{`
                .header { margin-bottom: 1.5rem; }
                .subtitle { color: var(--color-gray-500); }
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
                }
                .tab:hover { border-color: var(--color-primary); color: var(--color-primary); }
                .tab.active { background: var(--color-primary); color: white; border-color: var(--color-primary); }
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
                .icon-btn.transfer { color: #6366f1; }
                .icon-btn.transfer:hover { background: #eef2ff; }
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
                .modal-overlay {
                    position: fixed; inset: 0;
                    background: rgba(0,0,0,0.5);
                    display: flex; align-items: center; justify-content: center;
                    z-index: 1000;
                }
                .modal-content {
                    background: var(--color-surface);
                    border-radius: var(--radius-lg);
                    padding: 1.5rem;
                    width: 100%;
                    max-width: 480px;
                    box-shadow: var(--shadow-lg, 0 10px 30px rgba(0,0,0,0.2));
                }
                .modal-content h3 { margin: 0 0 0.25rem; }
                .modal-subtitle { color: var(--color-gray-500); font-size: 0.875rem; margin: 0 0 0.25rem; }
                .modal-current { color: var(--color-gray-500); font-size: 0.8rem; margin: 0 0 1rem; }
                .modal-search { display: flex; gap: 0.5rem; margin-bottom: 0.75rem; }
                .modal-search input {
                    flex: 1;
                    padding: 0.5rem 0.75rem;
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-md);
                    font-size: 0.875rem;
                    outline: none;
                }
                .modal-search input:focus { border-color: var(--color-primary); }
                .modal-search button {
                    padding: 0.5rem 1rem;
                    background: var(--color-primary);
                    color: white;
                    border: none;
                    border-radius: var(--radius-md);
                    cursor: pointer;
                    font-size: 0.875rem;
                }
                .modal-search button:disabled { opacity: 0.5; cursor: not-allowed; }
                .user-list {
                    list-style: none; padding: 0; margin: 0 0 1rem;
                    max-height: 200px; overflow-y: auto;
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-md);
                }
                .user-item {
                    display: flex; justify-content: space-between; align-items: center;
                    padding: 0.5rem 0.75rem;
                    cursor: pointer;
                    font-size: 0.875rem;
                    border-bottom: 1px solid var(--color-gray-100);
                }
                .user-item:last-child { border-bottom: none; }
                .user-item:hover { background: var(--color-gray-50, #f9fafb); }
                .user-item.selected { background: #eef2ff; border-color: #6366f1; }
                .user-name { font-weight: 500; }
                .user-role { font-size: 0.75rem; color: var(--color-gray-400); text-transform: uppercase; }
                .modal-actions { display: flex; justify-content: flex-end; gap: 0.5rem; }
                .btn-cancel {
                    padding: 0.5rem 1rem;
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-md);
                    background: var(--color-surface);
                    cursor: pointer;
                    font-size: 0.875rem;
                }
                .btn-confirm {
                    padding: 0.5rem 1rem;
                    background: #6366f1;
                    color: white;
                    border: none;
                    border-radius: var(--radius-md);
                    cursor: pointer;
                    font-size: 0.875rem;
                    font-weight: 500;
                }
                .btn-confirm:disabled { opacity: 0.5; cursor: not-allowed; }
                @media (max-width: 768px) {
                    .header h1 { font-size: 1.25rem; }
                    .toolbar { flex-direction: column; align-items: stretch; }
                    .tabs { overflow-x: auto; scrollbar-width: none; }
                    .tabs::-webkit-scrollbar { display: none; }
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

export default AdminProjects;
