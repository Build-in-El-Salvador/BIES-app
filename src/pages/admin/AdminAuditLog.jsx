import React, { useState, useEffect, useCallback } from 'react';
import { Loader2, Search } from 'lucide-react';
import { adminApi } from '../../services/api';

const AdminAuditLog = () => {
    const [actionFilter, setActionFilter] = useState('');
    const [search, setSearch] = useState('');
    const [logs, setLogs] = useState([]);
    const [pagination, setPagination] = useState({ page: 1, total: 0, totalPages: 1 });
    const [loading, setLoading] = useState(true);
    const [expanded, setExpanded] = useState(null);

    const fetchLogs = useCallback(async (page = 1) => {
        setLoading(true);
        try {
            const params = { page, limit: 30 };
            if (actionFilter) params.action = actionFilter;
            if (search) params.userId = search;
            const res = await adminApi.auditLogs(params);
            setLogs(Array.isArray(res?.data) ? res.data : []);
            setPagination(res?.pagination || { page: 1, total: 0, totalPages: 1 });
        } catch (err) {
            console.error('Failed to fetch audit logs:', err);
        } finally {
            setLoading(false);
        }
    }, [actionFilter, search]);

    useEffect(() => { fetchLogs(1); }, [fetchLogs]);

    const formatDate = (d) => new Date(d).toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });

    const actionColor = (action) => {
        if (action.includes('BANNED')) return '#dc2626';
        if (action.includes('APPROVED')) return '#16a34a';
        if (action.includes('DELETED') || action.includes('REJECTED')) return '#dc2626';
        if (action.includes('VERIFIED')) return '#16a34a';
        return 'var(--color-gray-600)';
    };

    return (
        <>
            <div className="header">
                <div>
                    <h1>Audit Log</h1>
                    <p className="subtitle">Track all admin actions</p>
                </div>
            </div>

            <div className="toolbar">
                <div className="filters">
                    <select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)} className="filter-select">
                        <option value="">All Actions</option>
                        <option value="USER_BANNED">User Banned</option>
                        <option value="USER_UNBANNED">User Unbanned</option>
                        <option value="USER_ROLE_CHANGED">Role Changed</option>
                        <option value="USER_VERIFIED">User Verified</option>
                        <option value="PROJECT_APPROVED">Project Approved</option>
                        <option value="PROJECT_REJECTED">Project Rejected</option>
                        <option value="PROJECT_HARD_DELETED">Project Deleted</option>
                        <option value="OPPORTUNITY_REMOVED">Opportunity Removed (report)</option>
                    </select>
                </div>
            </div>

            {loading ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
                    <Loader2 size={32} style={{ animation: 'spin 1s linear infinite' }} />
                </div>
            ) : logs.length === 0 ? (
                <div className="empty-state"><p>No audit logs found.</p></div>
            ) : (
                <div className="table-container">
                    <table className="data-table">
                        <thead>
                            <tr>
                                <th>Timestamp</th>
                                <th>Admin</th>
                                <th>Action</th>
                                <th>Resource</th>
                                <th>Details</th>
                            </tr>
                        </thead>
                        <tbody>
                            {logs.map(log => (
                                <tr key={log.id}>
                                    <td data-label="Time" style={{ whiteSpace: 'nowrap', fontSize: '0.8rem' }}>{formatDate(log.createdAt)}</td>
                                    <td data-label="Admin">{log.user?.profile?.name || log.user?.email || log.userId?.substring(0, 8) || '—'}</td>
                                    <td data-label="Action">
                                        <span className="action-tag" style={{ color: actionColor(log.action) }}>
                                            {log.action}
                                        </span>
                                    </td>
                                    <td data-label="Resource" style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>{log.resource || '—'}</td>
                                    <td data-label="Details">
                                        {log.metadata && Object.keys(log.metadata).length > 0 && (
                                            <button
                                                className="detail-toggle"
                                                onClick={() => setExpanded(expanded === log.id ? null : log.id)}
                                            >
                                                {expanded === log.id ? 'Hide' : 'Show'}
                                            </button>
                                        )}
                                        {expanded === log.id && (
                                            <pre className="metadata-block">
                                                {JSON.stringify(log.metadata, null, 2)}
                                            </pre>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {pagination.totalPages > 1 && (
                <div className="pagination">
                    <button disabled={pagination.page <= 1} onClick={() => fetchLogs(pagination.page - 1)}>Previous</button>
                    <span>Page {pagination.page} of {pagination.totalPages}</span>
                    <button disabled={pagination.page >= pagination.totalPages} onClick={() => fetchLogs(pagination.page + 1)}>Next</button>
                </div>
            )}

            <style jsx>{`
                .header { margin-bottom: 1.5rem; }
                .subtitle { color: var(--color-gray-500); }
                .toolbar { margin-bottom: 1.5rem; display: flex; gap: 1rem; flex-wrap: wrap; }
                .filters { display: flex; gap: 0.5rem; }
                .filter-select {
                    padding: 0.5rem 0.75rem;
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-md);
                    background: var(--color-surface);
                    font-size: 0.875rem;
                    color: var(--color-gray-600);
                    cursor: pointer;
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
                    padding: 0.75rem 1.25rem;
                    border-bottom: 1px solid var(--color-gray-100);
                    font-size: 0.875rem;
                    vertical-align: top;
                }
                .data-table tr:last-child td { border-bottom: none; }
                .action-tag {
                    font-family: var(--font-mono);
                    font-size: 0.8rem;
                    font-weight: 600;
                }
                .detail-toggle {
                    font-size: 0.75rem;
                    color: var(--color-primary);
                    background: none;
                    border: none;
                    cursor: pointer;
                    text-decoration: underline;
                }
                .metadata-block {
                    margin-top: 0.5rem;
                    padding: 0.5rem;
                    background: var(--color-gray-100);
                    border-radius: var(--radius-md);
                    font-size: 0.75rem;
                    font-family: var(--font-mono);
                    white-space: pre-wrap;
                    word-break: break-all;
                    max-width: 300px;
                }
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
                    .filter-select { width: 100%; }
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
                        align-items: flex-start;
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
                        min-width: 68px;
                        flex-shrink: 0;
                        padding-top: 0.1rem;
                    }
                    .action-tag { word-break: break-all; }
                    .metadata-block { max-width: 100%; }
                }
            `}</style>
        </>
    );
};

export default AdminAuditLog;
