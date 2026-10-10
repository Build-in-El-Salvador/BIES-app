import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle, Ban, ExternalLink, Loader2, Search, Shield, Trash2, RefreshCw, X, RotateCcw, AlertTriangle, UserX } from 'lucide-react';
import { adminApi } from '../../services/api';
import { useAuth } from '../../context/AuthContext';

const ROLE_OPTIONS = ['', 'MEMBER', 'BUILDER', 'INVESTOR', 'EVENT_HOST', 'EDUCATOR', 'MOD', 'ADMIN'];

// ─── Sync Modal ──────────────────────────────────────────────────────────────

const SyncModal = ({ isOpen, onClose, users, onSync }) => {
    const [sourceId, setSourceId] = useState('');
    const [targetId, setTargetId] = useState('');
    const [deleteSource, setDeleteSource] = useState(false);
    const [step, setStep] = useState(1); // 1 = select, 2 = confirm
    const [syncing, setSyncing] = useState(false);
    const [result, setResult] = useState(null);
    const [searchSource, setSearchSource] = useState('');
    const [searchTarget, setSearchTarget] = useState('');

    const resetModal = () => {
        setSourceId('');
        setTargetId('');
        setDeleteSource(false);
        setStep(1);
        setSyncing(false);
        setResult(null);
        setSearchSource('');
        setSearchTarget('');
    };

    const handleClose = () => {
        resetModal();
        onClose();
    };

    const sourceUser = users.find(u => u.id === sourceId);
    const targetUser = users.find(u => u.id === targetId);

    const filterUsers = (list, search, excludeId) =>
        list.filter(u => {
            if (u.id === excludeId) return false;
            if (!search) return true;
            const s = search.toLowerCase();
            return (
                (u.profile?.name || '').toLowerCase().includes(s) ||
                (u.email || '').toLowerCase().includes(s) ||
                (u.nostrPubkey || '').toLowerCase().includes(s)
            );
        });

    const handleConfirm = async () => {
        setSyncing(true);
        try {
            const res = await adminApi.syncAccounts(sourceId, targetId, deleteSource);
            setResult(res);
            onSync();
        } catch (err) {
            setResult({ error: err?.response?.data?.error || 'Sync failed' });
        } finally {
            setSyncing(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="modal-overlay" onClick={handleClose}>
            <div className="modal-content" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <h2>Sync Accounts</h2>
                    <button className="modal-close" onClick={handleClose}><X size={20} /></button>
                </div>

                {result ? (
                    <div className="modal-body">
                        {result.error ? (
                            <div className="sync-error">{result.error}</div>
                        ) : (
                            <div className="sync-success">
                                <h3>Sync Complete</h3>
                                <ul>
                                    {result.results?.map((r, i) => <li key={i}>{r}</li>)}
                                </ul>
                            </div>
                        )}
                        <div className="modal-actions">
                            <button className="btn btn-primary" onClick={handleClose}>Done</button>
                        </div>
                    </div>
                ) : step === 1 ? (
                    <div className="modal-body">
                        <p className="sync-desc">
                            Transfer all data (profile, projects, events, investments, follows) from one account to another.
                            This is an <strong>admin-only</strong> action.
                        </p>

                        <div className="sync-field">
                            <label>Source Account (copy FROM)</label>
                            <input
                                type="text"
                                placeholder="Search by name, email, or pubkey..."
                                value={searchSource}
                                onChange={e => setSearchSource(e.target.value)}
                                className="sync-search"
                            />
                            <div className="user-list">
                                {filterUsers(users, searchSource, targetId).map(u => (
                                    <div
                                        key={u.id}
                                        className={`user-option ${sourceId === u.id ? 'selected' : ''}`}
                                        onClick={() => setSourceId(u.id)}
                                    >
                                        <div className="user-option-info">
                                            {u.profile?.avatar ? (
                                                <img src={u.profile.avatar} alt="" className="user-option-avatar" />
                                            ) : (
                                                <div className="user-option-avatar placeholder">
                                                    {(u.profile?.name || '?')[0].toUpperCase()}
                                                </div>
                                            )}
                                            <div>
                                                <div className="user-option-name">{u.profile?.name || '(unnamed)'}</div>
                                                <div className="user-option-meta">{u.email || truncatePubkey(u.nostrPubkey)}</div>
                                            </div>
                                        </div>
                                        <span className={`role-badge ${(u.role || '').toLowerCase()}`}>{u.role}</span>
                                    </div>
                                ))}
                            </div>
                        </div>

                        <div className="sync-field">
                            <label>Target Account (copy TO)</label>
                            <input
                                type="text"
                                placeholder="Search by name, email, or pubkey..."
                                value={searchTarget}
                                onChange={e => setSearchTarget(e.target.value)}
                                className="sync-search"
                            />
                            <div className="user-list">
                                {filterUsers(users, searchTarget, sourceId).map(u => (
                                    <div
                                        key={u.id}
                                        className={`user-option ${targetId === u.id ? 'selected' : ''}`}
                                        onClick={() => setTargetId(u.id)}
                                    >
                                        <div className="user-option-info">
                                            {u.profile?.avatar ? (
                                                <img src={u.profile.avatar} alt="" className="user-option-avatar" />
                                            ) : (
                                                <div className="user-option-avatar placeholder">
                                                    {(u.profile?.name || '?')[0].toUpperCase()}
                                                </div>
                                            )}
                                            <div>
                                                <div className="user-option-name">{u.profile?.name || '(unnamed)'}</div>
                                                <div className="user-option-meta">{u.email || truncatePubkey(u.nostrPubkey)}</div>
                                            </div>
                                        </div>
                                        <span className={`role-badge ${(u.role || '').toLowerCase()}`}>{u.role}</span>
                                    </div>
                                ))}
                            </div>
                        </div>

                        <div className="modal-actions">
                            <button className="btn btn-secondary" onClick={handleClose}>Cancel</button>
                            <button
                                className="btn btn-primary"
                                disabled={!sourceId || !targetId}
                                onClick={() => setStep(2)}
                            >
                                Next
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="modal-body">
                        <h3>Confirm Sync</h3>
                        <div className="sync-confirm-details">
                            <div className="sync-confirm-row">
                                <span className="sync-label">From:</span>
                                <strong>{sourceUser?.profile?.name || '(unnamed)'}</strong>
                                <span className="sync-meta">{sourceUser?.email || truncatePubkey(sourceUser?.nostrPubkey)}</span>
                            </div>
                            <div className="sync-arrow">&#8595;</div>
                            <div className="sync-confirm-row">
                                <span className="sync-label">To:</span>
                                <strong>{targetUser?.profile?.name || '(unnamed)'}</strong>
                                <span className="sync-meta">{targetUser?.email || truncatePubkey(targetUser?.nostrPubkey)}</span>
                            </div>
                        </div>

                        <div className="sync-delete-option">
                            <label className="checkbox-label">
                                <input
                                    type="checkbox"
                                    checked={deleteSource}
                                    onChange={e => setDeleteSource(e.target.checked)}
                                />
                                Delete the source account after syncing
                            </label>
                            {deleteSource && (
                                <p className="sync-warning">
                                    The source account will be permanently deleted after data is transferred. This cannot be undone.
                                </p>
                            )}
                        </div>

                        <p className="sync-info">
                            This will transfer profile data, projects, events, investments, team memberships,
                            watchlist items, follows, and event RSVPs to the target account. Non-empty target profile
                            fields will be overwritten with source data.
                        </p>

                        <div className="modal-actions">
                            <button className="btn btn-secondary" onClick={() => setStep(1)}>Back</button>
                            <button
                                className="btn btn-danger"
                                onClick={handleConfirm}
                                disabled={syncing}
                            >
                                {syncing ? <><Loader2 size={16} className="spin" /> Syncing...</> : 'Are you sure? Sync Now'}
                            </button>
                        </div>
                    </div>
                )}
            </div>

            <style jsx>{`
                .modal-overlay {
                    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
                    background: rgba(0,0,0,0.5); display: flex;
                    align-items: center; justify-content: center; z-index: 1000;
                }
                .modal-content {
                    background: var(--color-surface); border-radius: var(--radius-lg);
                    width: 90%; max-width: 600px; max-height: 85vh;
                    overflow-y: auto; box-shadow: var(--shadow-xl);
                }
                .modal-header {
                    display: flex; justify-content: space-between; align-items: center;
                    padding: 1.25rem 1.5rem; border-bottom: 1px solid var(--color-gray-200);
                }
                .modal-header h2 { margin: 0; font-size: 1.1rem; }
                .modal-close {
                    background: none; border: none; cursor: pointer;
                    color: var(--color-gray-400); padding: 0.25rem;
                    border-radius: var(--radius-md);
                }
                .modal-close:hover { background: var(--color-gray-100); color: var(--color-gray-600); }
                .modal-body { padding: 1.5rem; }
                .modal-actions {
                    display: flex; gap: 0.75rem; justify-content: flex-end;
                    margin-top: 1.5rem; padding-top: 1rem;
                    border-top: 1px solid var(--color-gray-100);
                }
                .sync-desc { color: var(--color-gray-600); margin-bottom: 1.25rem; font-size: 0.9rem; line-height: 1.5; }
                .sync-field { margin-bottom: 1.25rem; }
                .sync-field label { display: block; font-weight: 600; margin-bottom: 0.5rem; font-size: 0.875rem; }
                .sync-search {
                    width: 100%; padding: 0.5rem 0.75rem; border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-md); font-size: 0.875rem; margin-bottom: 0.5rem;
                    box-sizing: border-box;
                }
                .user-list {
                    max-height: 180px; overflow-y: auto; border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-md);
                }
                .user-option {
                    display: flex; align-items: center; justify-content: space-between;
                    padding: 0.6rem 0.75rem; cursor: pointer;
                    border-bottom: 1px solid var(--color-gray-100);
                    transition: background 0.15s;
                }
                .user-option:last-child { border-bottom: none; }
                .user-option:hover { background: var(--color-gray-50); }
                .user-option.selected { background: var(--color-blue-tint); border-left: 3px solid var(--color-primary); }
                .user-option-info { display: flex; align-items: center; gap: 0.5rem; }
                .user-option-avatar {
                    width: 28px; height: 28px; border-radius: 50%;
                    object-fit: cover; flex-shrink: 0;
                }
                .user-option-avatar.placeholder {
                    background: var(--color-gray-200); display: flex;
                    align-items: center; justify-content: center;
                    font-size: 0.7rem; color: var(--color-gray-500);
                }
                .user-option-name { font-weight: 500; font-size: 0.875rem; }
                .user-option-meta { font-size: 0.75rem; color: var(--color-gray-400); }
                .sync-confirm-details {
                    background: var(--color-gray-50); border-radius: var(--radius-md);
                    padding: 1rem; margin: 1rem 0;
                }
                .sync-confirm-row { display: flex; align-items: center; gap: 0.5rem; }
                .sync-label { color: var(--color-gray-500); min-width: 40px; font-size: 0.875rem; }
                .sync-meta { color: var(--color-gray-400); font-size: 0.8rem; }
                .sync-arrow { text-align: center; font-size: 1.2rem; color: var(--color-gray-400); margin: 0.5rem 0; }
                .sync-delete-option { margin: 1rem 0; }
                .checkbox-label {
                    display: flex; align-items: center; gap: 0.5rem;
                    font-size: 0.9rem; cursor: pointer;
                }
                .checkbox-label input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; }
                .sync-warning {
                    color: var(--color-error); font-size: 0.8rem; margin-top: 0.5rem;
                    padding: 0.5rem; background: var(--color-red-tint); border-radius: var(--radius-md);
                }
                .sync-info {
                    color: var(--color-gray-500); font-size: 0.8rem;
                    line-height: 1.5; margin-top: 0.75rem;
                }
                .sync-success {
                    background: var(--color-green-tint); color: var(--badge-success-text); padding: 1rem;
                    border-radius: var(--radius-md);
                }
                .sync-success h3 { margin: 0 0 0.5rem; }
                .sync-success ul { margin: 0; padding-left: 1.25rem; }
                .sync-success li { margin-bottom: 0.25rem; font-size: 0.875rem; }
                .sync-error {
                    background: var(--color-red-tint); color: var(--badge-error-text); padding: 1rem;
                    border-radius: var(--radius-md); font-size: 0.9rem;
                }
                .btn {
                    padding: 0.5rem 1rem; border-radius: var(--radius-md);
                    font-size: 0.875rem; font-weight: 500; cursor: pointer;
                    border: 1px solid transparent; display: inline-flex;
                    align-items: center; gap: 0.4rem;
                }
                .btn:disabled { opacity: 0.5; cursor: not-allowed; }
                .btn-primary { background: var(--color-primary); color: white; }
                .btn-primary:hover:not(:disabled) { opacity: 0.9; }
                .btn-secondary { background: var(--color-surface); color: var(--color-gray-600); border-color: var(--color-gray-200); }
                .btn-secondary:hover:not(:disabled) { background: var(--color-gray-50); }
                .btn-danger { background: #dc2626; color: white; }
                .btn-danger:hover:not(:disabled) { background: #b91c1c; }
                .spin { animation: spin 1s linear infinite; }
                @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
            `}</style>
        </div>
    );
};

const truncatePubkey = (pk) => pk ? `${pk.substring(0, 8)}...${pk.substring(pk.length - 4)}` : '—';

// ─── Main Component ──────────────────────────────────────────────────────────

const AdminUsers = () => {
    const { isAdmin } = useAuth();
    const [view, setView] = useState('active'); // 'active' | 'trash'
    const [roleFilter, setRoleFilter] = useState('');
    const [bannedFilter, setBannedFilter] = useState('');
    const [search, setSearch] = useState('');
    const [users, setUsers] = useState([]);
    const [pagination, setPagination] = useState({ page: 1, total: 0, totalPages: 1 });
    const [loading, setLoading] = useState(true);
    const [actionLoading, setActionLoading] = useState(null);
    const [syncModalOpen, setSyncModalOpen] = useState(false);

    // Trash state
    const [trashUsers, setTrashUsers] = useState([]);
    const [trashPagination, setTrashPagination] = useState({ page: 1, total: 0, totalPages: 1 });
    const [trashSearch, setTrashSearch] = useState('');
    const [trashLoading, setTrashLoading] = useState(false);

    const fetchUsers = useCallback(async (page = 1) => {
        setLoading(true);
        try {
            const params = { page, limit: 20 };
            if (roleFilter) params.role = roleFilter;
            if (bannedFilter) params.banned = bannedFilter;
            if (search) params.search = search;
            const res = await adminApi.users(params);
            setUsers(Array.isArray(res?.data) ? res.data : []);
            setPagination(res?.pagination || { page: 1, total: 0, totalPages: 1 });
        } catch (err) {
            console.error('Failed to fetch users:', err);
        } finally {
            setLoading(false);
        }
    }, [roleFilter, bannedFilter, search]);

    const fetchTrash = useCallback(async (page = 1) => {
        setTrashLoading(true);
        try {
            const params = { page, limit: 20 };
            if (trashSearch) params.search = trashSearch;
            const res = await adminApi.trashedUsers(params);
            setTrashUsers(Array.isArray(res?.data) ? res.data : []);
            setTrashPagination(res?.pagination || { page: 1, total: 0, totalPages: 1 });
        } catch (err) {
            console.error('Failed to fetch trash:', err);
        } finally {
            setTrashLoading(false);
        }
    }, [trashSearch]);

    useEffect(() => { fetchUsers(1); }, [fetchUsers]);
    useEffect(() => { if (view === 'trash') fetchTrash(1); }, [view, fetchTrash]);

    const handleBan = async (id, currentBanned, name) => {
        const action = currentBanned ? 'unban' : 'ban';
        if (!window.confirm(`Are you sure you want to ${action} ${name || 'this user'}? ${!currentBanned ? 'This will also remove their npub from the relay whitelist.' : 'This will restore their relay access.'}`)) return;
        setActionLoading(id);
        try {
            await adminApi.banUser(id, !currentBanned);
            fetchUsers(pagination.page);
        } catch (err) {
            alert(`Failed to ${action} user`);
        } finally {
            setActionLoading(null);
        }
    };

    const handleVerify = async (id) => {
        setActionLoading(id);
        try {
            await adminApi.verifyUser(id);
            fetchUsers(pagination.page);
        } catch (err) {
            alert('Failed to verify user');
        } finally {
            setActionLoading(null);
        }
    };

    const handleRoleChange = async (id, newRole) => {
        const isGrantingAdmin = newRole === 'ADMIN';
        const confirmMsg = isGrantingAdmin
            ? 'Grant ADMIN access to this user? They will have full admin panel privileges.'
            : `Change role to ${newRole}?`;
        if (!window.confirm(confirmMsg)) return;
        setActionLoading(id);
        try {
            if (isGrantingAdmin) {
                // Grant admin flag (keeps their current role)
                await adminApi.setAdmin(id, true);
            } else {
                // If user was admin and we're changing to a non-admin role, revoke admin
                const user = users.find(u => u.id === id);
                if (user?.isAdmin) {
                    await adminApi.setAdmin(id, false);
                }
                await adminApi.setRole(id, newRole);
            }
            fetchUsers(pagination.page);
        } catch (err) {
            alert(err?.message || 'Failed to change role');
        } finally {
            setActionLoading(null);
        }
    };

    const handleDelete = async (id, name) => {
        if (!window.confirm(`Move "${name || 'this user'}" to trash?\n\nThey will be signed out and hidden from the platform. You can restore them from the Trash tab or permanently delete them later.`)) return;
        setActionLoading(id);
        try {
            await adminApi.deleteUser(id);
            fetchUsers(pagination.page);
        } catch (err) {
            alert(err?.response?.data?.error || 'Failed to move user to trash');
        } finally {
            setActionLoading(null);
        }
    };

    const handleRestore = async (id, name) => {
        if (!window.confirm(`Restore "${name || 'this user'}" from trash? Their account will be re-activated.`)) return;
        setActionLoading(id);
        try {
            await adminApi.restoreUser(id);
            fetchTrash(trashPagination.page);
        } catch (err) {
            alert(err?.response?.data?.error || 'Failed to restore user');
        } finally {
            setActionLoading(null);
        }
    };

    // deletionRequest: the member asked to be deleted (e.g. by email). Relays
    // then forget the account too: BIES's relay deletes their posts, and for
    // an email account other relays are asked to. Leave it off for spam and
    // merged accounts (a merged account's posts now belong to the other one).
    const handlePurge = async (id, name, { deletionRequest = false } = {}) => {
        const what = deletionRequest
            ? `Delete "${name || 'this user'}" at their request?\n\nThis removes ALL their data, and their posts from the BIES relay; for an email account, other Nostr relays are asked to delete them too. It cannot be undone.`
            : `Permanently delete "${name || 'this user'}"?\n\nThis will remove ALL their data (profile, projects, messages, etc.) and cannot be undone. Their posts stay on the relays.`;
        if (!window.confirm(what)) return;
        if (!window.confirm(`FINAL WARNING: Permanently delete "${name || id}"? This cannot be undone.`)) return;
        setActionLoading(id);
        try {
            await adminApi.purgeUser(id, { deletionRequest });
            fetchTrash(trashPagination.page);
        } catch (err) {
            alert(err?.response?.data?.error || 'Failed to purge user');
        } finally {
            setActionLoading(null);
        }
    };

    return (
        <>
            <div className="header">
                <div>
                    <h1>User Management</h1>
                    <p className="subtitle">Manage platform users and access</p>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    {isAdmin && (
                        <button className="sync-btn" onClick={() => setSyncModalOpen(true)}>
                            <RefreshCw size={16} /> Sync Accounts
                        </button>
                    )}
                    {isAdmin && (
                        <button
                            className={`tab-btn ${view === 'trash' ? 'tab-btn-active' : ''}`}
                            onClick={() => setView(view === 'trash' ? 'active' : 'trash')}
                        >
                            <Trash2 size={16} /> Trash
                        </button>
                    )}
                </div>
            </div>

            {view === 'active' ? (
                <>
                    <div className="toolbar">
                        <div className="filters">
                            <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} className="filter-select">
                                <option value="">All Roles</option>
                                {ROLE_OPTIONS.filter(Boolean).map(r => <option key={r} value={r}>{r}</option>)}
                            </select>
                            <select value={bannedFilter} onChange={(e) => setBannedFilter(e.target.value)} className="filter-select">
                                <option value="">All Status</option>
                                <option value="true">Banned</option>
                                <option value="false">Active</option>
                            </select>
                        </div>
                        <div className="search-wrap">
                            <Search size={16} />
                            <input
                                type="text"
                                placeholder="Search by name or email..."
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                            />
                        </div>
                    </div>

                    {loading ? (
                        <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
                            <Loader2 size={32} style={{ animation: 'spin 1s linear infinite' }} />
                        </div>
                    ) : users.length === 0 ? (
                        <div className="empty-state"><p>No users found.</p></div>
                    ) : (
                        <div className="table-container">
                            <table className="data-table">
                                <thead>
                                    <tr>
                                        <th>User</th>
                                        <th>Email</th>
                                        <th>Npub</th>
                                        <th>Role</th>
                                        <th>Projects</th>
                                        <th>Verified</th>
                                        <th>Status</th>
                                        <th>Joined</th>
                                        <th>Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {users.map(u => (
                                        <tr key={u.id} className={u.isBanned ? 'row-banned' : ''}>
                                            <td>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                                    {u.profile?.avatar ? (
                                                        <img src={u.profile.avatar} alt="" style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover' }} />
                                                    ) : (
                                                        <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--color-gray-200)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.7rem', color: 'var(--color-gray-500)' }}>
                                                            {(u.profile?.name || '?')[0].toUpperCase()}
                                                        </div>
                                                    )}
                                                    <span className="font-semibold">{u.profile?.name || '—'}</span>
                                                </div>
                                            </td>
                                            <td data-label="Email">{u.email || '—'}</td>
                                            <td data-label="Npub" className="mobile-hide" style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>{truncatePubkey(u.nostrPubkey)}</td>
                                            <td data-label="Role">
                                                <select
                                                    value={u.isAdmin ? 'ADMIN' : u.role}
                                                    onChange={(e) => handleRoleChange(u.id, e.target.value)}
                                                    disabled={actionLoading === u.id || ((u.isAdmin || u.role === 'MOD') && !isAdmin)}
                                                    className="role-select"
                                                    title={(u.isAdmin || u.role === 'MOD') && !isAdmin ? 'Only admins can change admin/mod roles' : ''}
                                                >
                                                    <option value="MEMBER">MEMBER</option>
                                                    <option value="BUILDER">BUILDER</option>
                                                    <option value="INVESTOR">INVESTOR</option>
                                                    <option value="EVENT_HOST">EVENT HOST</option>
                                                    <option value="EDUCATOR">EDUCATOR</option>
                                                    {isAdmin && <option value="MOD">MOD</option>}
                                                    {!isAdmin && u.role === 'MOD' && <option value="MOD">MOD</option>}
                                                    {isAdmin && <option value="ADMIN">ADMIN</option>}
                                                    {!isAdmin && u.isAdmin && <option value="ADMIN">ADMIN</option>}
                                                </select>
                                            </td>
                                            <td data-label="Projects" className="mobile-hide">{u._count?.projects || 0}</td>
                                            <td data-label="Verified" className="mobile-hide">
                                                {u.isVerified ? (
                                                    <CheckCircle size={16} style={{ color: '#16a34a' }} />
                                                ) : (
                                                    <button
                                                        className="icon-btn approve"
                                                        onClick={() => handleVerify(u.id)}
                                                        title="Verify user"
                                                        disabled={actionLoading === u.id}
                                                    >
                                                        <Shield size={16} />
                                                    </button>
                                                )}
                                            </td>
                                            <td data-label="Status">
                                                <span className={`status-badge ${u.isBanned ? 'banned' : 'active'}`}>
                                                    {u.isBanned ? 'Banned' : 'Active'}
                                                </span>
                                            </td>
                                            <td data-label="Joined" className="mobile-hide">{new Date(u.createdAt).toLocaleDateString()}</td>
                                            <td>
                                                <div className="action-group">
                                                    {/* Ban / Unban — admin only */}
                                                    {isAdmin && (
                                                    <button
                                                        className={`icon-btn ${u.isBanned ? 'approve' : 'delete'}`}
                                                        onClick={() => handleBan(u.id, u.isBanned, u.profile?.name)}
                                                        title={u.isBanned ? 'Unban (restore relay access)' : 'Ban (remove from relay whitelist)'}
                                                        disabled={actionLoading === u.id}
                                                    >
                                                        <Ban size={16} />
                                                    </button>
                                                    )}
                                                    {/* Move to trash — admin only */}
                                                    {isAdmin && (
                                                        <button
                                                            className="icon-btn delete"
                                                            onClick={() => handleDelete(u.id, u.profile?.name)}
                                                            title="Move to trash"
                                                            disabled={actionLoading === u.id}
                                                        >
                                                            <Trash2 size={16} />
                                                        </button>
                                                    )}
                                                    {/* View profile */}
                                                    <Link
                                                        to={`/${u.role === 'INVESTOR' ? 'investor' : 'builder'}/${u.id}`}
                                                        className="icon-btn"
                                                        title="View profile"
                                                    >
                                                        <ExternalLink size={16} />
                                                    </Link>
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
                            <button disabled={pagination.page <= 1} onClick={() => fetchUsers(pagination.page - 1)}>Previous</button>
                            <span>Page {pagination.page} of {pagination.totalPages}</span>
                            <button disabled={pagination.page >= pagination.totalPages} onClick={() => fetchUsers(pagination.page + 1)}>Next</button>
                        </div>
                    )}
                </>
            ) : (
                <>
                    <div className="trash-banner">
                        <AlertTriangle size={16} />
                        <span>Trashed accounts are hidden from the platform. Restore them to re-activate or permanently delete to remove all data.</span>
                    </div>

                    <div className="toolbar">
                        <div />
                        <div className="search-wrap">
                            <Search size={16} />
                            <input
                                type="text"
                                placeholder="Search trash by name or email..."
                                value={trashSearch}
                                onChange={(e) => setTrashSearch(e.target.value)}
                            />
                        </div>
                    </div>

                    {trashLoading ? (
                        <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
                            <Loader2 size={32} style={{ animation: 'spin 1s linear infinite' }} />
                        </div>
                    ) : trashUsers.length === 0 ? (
                        <div className="empty-state"><p>Trash is empty.</p></div>
                    ) : (
                        <div className="table-container">
                            <table className="data-table">
                                <thead>
                                    <tr>
                                        <th>User</th>
                                        <th>Email</th>
                                        <th>Npub</th>
                                        <th>Role</th>
                                        <th>Projects</th>
                                        <th>Deleted</th>
                                        <th>Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {trashUsers.map(u => (
                                        <tr key={u.id} style={{ opacity: 0.75 }}>
                                            <td>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                                    {u.profile?.avatar ? (
                                                        <img src={u.profile.avatar} alt="" style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover', filter: 'grayscale(1)' }} />
                                                    ) : (
                                                        <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--color-gray-200)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.7rem', color: 'var(--color-gray-500)' }}>
                                                            {(u.profile?.name || '?')[0].toUpperCase()}
                                                        </div>
                                                    )}
                                                    <span className="font-semibold">{u.profile?.name || '—'}</span>
                                                </div>
                                            </td>
                                            <td data-label="Email">{u.email || '—'}</td>
                                            <td data-label="Npub" className="mobile-hide" style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>{truncatePubkey(u.nostrPubkey)}</td>
                                            <td data-label="Role"><span style={{ fontSize: '0.8rem', color: 'var(--color-gray-500)' }}>{u.role}</span></td>
                                            <td data-label="Projects" className="mobile-hide">{u._count?.projects || 0}</td>
                                            <td data-label="Deleted" style={{ fontSize: '0.8rem', color: 'var(--color-gray-500)' }}>
                                                {u.deletedAt ? new Date(u.deletedAt).toLocaleDateString() : '—'}
                                            </td>
                                            <td>
                                                <div className="action-group">
                                                    <button
                                                        className="icon-btn approve"
                                                        onClick={() => handleRestore(u.id, u.profile?.name)}
                                                        title="Restore account"
                                                        disabled={actionLoading === u.id}
                                                    >
                                                        <RotateCcw size={16} />
                                                    </button>
                                                    <button
                                                        className="icon-btn delete"
                                                        onClick={() => handlePurge(u.id, u.profile?.name)}
                                                        title="Permanently delete (posts stay on the relays)"
                                                        disabled={actionLoading === u.id}
                                                    >
                                                        <Trash2 size={16} />
                                                    </button>
                                                    <button
                                                        className="icon-btn delete"
                                                        onClick={() => handlePurge(u.id, u.profile?.name, { deletionRequest: true })}
                                                        title="Delete at the member's request (also removes their posts from the relays)"
                                                        disabled={actionLoading === u.id}
                                                    >
                                                        <UserX size={16} />
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}

                    {trashPagination.totalPages > 1 && (
                        <div className="pagination">
                            <button disabled={trashPagination.page <= 1} onClick={() => fetchTrash(trashPagination.page - 1)}>Previous</button>
                            <span>Page {trashPagination.page} of {trashPagination.totalPages}</span>
                            <button disabled={trashPagination.page >= trashPagination.totalPages} onClick={() => fetchTrash(trashPagination.page + 1)}>Next</button>
                        </div>
                    )}
                </>
            )}

            {/* Sync Modal — admin only */}
            <SyncModal
                isOpen={syncModalOpen}
                onClose={() => setSyncModalOpen(false)}
                users={users}
                onSync={() => fetchUsers(pagination.page)}
            />

            <style jsx>{`
                .header {
                    margin-bottom: 1.5rem;
                    display: flex;
                    justify-content: space-between;
                    align-items: flex-start;
                }
                .subtitle { color: var(--color-gray-500); }
                .sync-btn {
                    display: inline-flex; align-items: center; gap: 0.4rem;
                    padding: 0.5rem 1rem; background: var(--color-primary);
                    color: white; border: none; border-radius: var(--radius-md);
                    font-size: 0.875rem; font-weight: 500; cursor: pointer;
                    transition: opacity 0.15s;
                }
                .sync-btn:hover { opacity: 0.9; }
                .tab-btn {
                    display: inline-flex; align-items: center; gap: 0.4rem;
                    padding: 0.5rem 1rem; background: var(--color-surface);
                    color: var(--color-gray-500); border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-md); font-size: 0.875rem; font-weight: 500;
                    cursor: pointer; transition: all 0.15s;
                }
                .tab-btn:hover { background: var(--color-gray-100); color: var(--color-neutral-dark); }
                .tab-btn-active { background: var(--color-red-tint); color: #dc2626; border-color: #fca5a5; }
                .tab-btn-active:hover { background: var(--color-red-tint); color: #b91c1c; }
                .trash-banner {
                    display: flex; align-items: center; gap: 0.5rem;
                    background: var(--color-amber-tint); color: var(--badge-warning-text);
                    border: 1px solid #fcd34d; border-radius: var(--radius-md);
                    padding: 0.75rem 1rem; margin-bottom: 1.5rem; font-size: 0.875rem;
                }
                .toolbar {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 1.5rem;
                    gap: 1rem;
                    flex-wrap: wrap;
                }
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
                    width: 220px;
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
                    padding: 1rem 1rem;
                    border-bottom: 1px solid var(--color-gray-200);
                    color: var(--color-gray-500);
                    font-size: 0.8rem;
                    font-weight: 600;
                    text-transform: uppercase;
                    white-space: nowrap;
                }
                .data-table td {
                    padding: 0.75rem 1rem;
                    border-bottom: 1px solid var(--color-gray-100);
                    font-size: 0.875rem;
                }
                .data-table tr:last-child td { border-bottom: none; }
                .row-banned { background: var(--color-red-tint); }
                .font-semibold { font-weight: 600; }
                .role-select {
                    padding: 0.25rem 0.5rem;
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-md);
                    font-size: 0.8rem;
                    background: var(--color-surface);
                    cursor: pointer;
                }
                .status-badge {
                    display: inline-block;
                    font-size: 0.7rem;
                    padding: 2px 8px;
                    border-radius: 99px;
                    font-weight: 600;
                    text-transform: uppercase;
                }
                .status-badge.active { background: var(--color-green-tint); color: var(--badge-success-text); }
                .status-badge.banned { background: var(--color-red-tint); color: var(--badge-error-text); }
                .role-badge {
                    display: inline-block;
                    font-size: 0.7rem;
                    padding: 2px 8px;
                    border-radius: 99px;
                    font-weight: 600;
                    text-transform: uppercase;
                }
                .role-badge.mod { background: var(--badge-info-bg); color: var(--badge-info-text); }
                .role-badge.admin { background: var(--color-blue-tint); color: var(--color-primary); }
                .role-badge.builder { background: var(--color-blue-tint); color: var(--badge-info-text); }
                .role-badge.investor { background: var(--color-amber-tint); color: var(--badge-warning-text); }
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
                .icon-btn.delete { color: #dc2626; }
                .icon-btn.delete:hover { background: var(--color-red-tint); }
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
                    .header { flex-direction: column; gap: 0.75rem; }
                    .header h1 { font-size: 1.25rem; }
                    .toolbar { flex-direction: column; align-items: stretch; }
                    .filters { flex-wrap: wrap; }
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
                    .data-table tr.row-banned {
                        border-color: #fca5a5;
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
                        min-width: 60px;
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
                    .role-select { min-height: 36px; }
                }
            `}</style>
        </>
    );
};

export default AdminUsers;
