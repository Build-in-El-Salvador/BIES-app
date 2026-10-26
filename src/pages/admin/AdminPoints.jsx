import React, { useState, useEffect, useCallback } from 'react';
import { Loader2, Search, RefreshCw, X, Award, Trash2, Plus, Minus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { adminApi, pointsApi } from '../../services/api';
import { getAssetUrl } from '../../utils/assets';

const RARITY_COLORS = { legendary: '#D97706', rare: '#7C3AED', uncommon: '#2563EB', common: '#64748B' };
const POINT_REASONS = ['POST', 'REPLY', 'REACTION_GIVEN', 'REACTION_RECEIVED', 'QUALITY_BONUS', 'ADMIN_ADJUST'];
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const truncatePubkey = (pk) => pk ? `${pk.substring(0, 8)}...${pk.substring(pk.length - 4)}` : '—';

const compactMeta = (meta) => {
    if (!meta || typeof meta !== 'object' || Object.keys(meta).length === 0) return '—';
    const s = JSON.stringify(meta);
    return s.length > 64 ? `${s.slice(0, 61)}…` : s;
};

const fullMeta = (meta) => {
    if (!meta || typeof meta !== 'object' || Object.keys(meta).length === 0) return '';
    return JSON.stringify(meta, null, 1);
};

const AdminPoints = () => {
    const { t } = useTranslation();

    // ── User search / selection ──
    const [search, setSearch] = useState('');
    const [results, setResults] = useState([]);
    const [searching, setSearching] = useState(false);
    const [selectedUser, setSelectedUser] = useState(null);

    // ── Selected user's score + badges ──
    const [score, setScore] = useState(null);
    const [scoreLoading, setScoreLoading] = useState(false);

    // ── Adjust form ──
    const [adjustAmount, setAdjustAmount] = useState('');
    const [adjustNote, setAdjustNote] = useState('');
    const [adjusting, setAdjusting] = useState(false);
    const [flash, setFlash] = useState(null);

    // ── Badge catalog + grant/revoke ──
    const [catalog, setCatalog] = useState([]);
    const [grantBadgeId, setGrantBadgeId] = useState('');
    const [grantMonth, setGrantMonth] = useState('');
    const [granting, setGranting] = useState(false);
    const [revoking, setRevoking] = useState(null);

    // ── Ledger browser ──
    const [events, setEvents] = useState([]);
    const [evPagination, setEvPagination] = useState({ page: 1, total: 0, totalPages: 1 });
    const [evLoading, setEvLoading] = useState(true);
    const [reasonFilter, setReasonFilter] = useState('');
    const [onlySelectedUser, setOnlySelectedUser] = useState(false);

    // ── Recompute ──
    const [recomputing, setRecomputing] = useState(false);

    const badgeName = useCallback(
        (badgeId) => t(`points.badges.${badgeId}.name`, badgeId),
        [t]
    );

    // Auto-clear flash messages
    useEffect(() => {
        if (!flash) return undefined;
        const timer = setTimeout(() => setFlash(null), 5000);
        return () => clearTimeout(timer);
    }, [flash]);

    // Load badge catalog once
    useEffect(() => {
        pointsApi.badges()
            .then((res) => setCatalog(Array.isArray(res?.badges) ? res.badges : []))
            .catch(() => setCatalog([]));
    }, []);

    // Debounced search-as-you-type against the admin user list
    useEffect(() => {
        const q = search.trim();
        if (!q) { setResults([]); setSearching(false); return undefined; }
        setSearching(true);
        const timer = setTimeout(async () => {
            try {
                const res = await adminApi.users({ search: q, page: 1, limit: 10 });
                setResults(Array.isArray(res?.data) ? res.data : []);
            } catch {
                setResults([]);
            } finally {
                setSearching(false);
            }
        }, 300);
        return () => clearTimeout(timer);
    }, [search]);

    const fetchScore = useCallback(async (user) => {
        if (!user?.nostrPubkey) { setScore(null); return; }
        setScoreLoading(true);
        try {
            const res = await pointsApi.user(user.nostrPubkey);
            setScore(res);
        } catch {
            setScore(null);
        } finally {
            setScoreLoading(false);
        }
    }, []);

    const selectUser = (user) => {
        setSelectedUser(user);
        setSearch('');
        setResults([]);
        setScore(null);
        setFlash(null);
        setGrantBadgeId('');
        setGrantMonth('');
        fetchScore(user);
    };

    const clearUser = () => {
        setSelectedUser(null);
        setScore(null);
        setOnlySelectedUser(false);
        setFlash(null);
    };

    // ── Ledger ──
    const fetchEvents = useCallback(async (page = 1) => {
        setEvLoading(true);
        try {
            const params = { page, limit: 25 };
            if (reasonFilter) params.reason = reasonFilter;
            if (onlySelectedUser && selectedUser) params.userId = selectedUser.id;
            const res = await adminApi.listPointEvents(params);
            setEvents(Array.isArray(res?.data) ? res.data : []);
            setEvPagination(res?.pagination || { page: 1, total: 0, totalPages: 1 });
        } catch (err) {
            console.error('Failed to fetch point events:', err);
        } finally {
            setEvLoading(false);
        }
    }, [reasonFilter, onlySelectedUser, selectedUser]);

    useEffect(() => { fetchEvents(1); }, [fetchEvents]);

    // ── Actions ──
    const handleAdjust = async (e) => {
        e.preventDefault();
        if (!selectedUser) return;
        const points = parseInt(adjustAmount, 10);
        if (!Number.isInteger(points) || points === 0) {
            setFlash({ type: 'error', text: 'Points must be a nonzero integer.' });
            return;
        }
        if (points < -1000 || points > 1000) {
            setFlash({ type: 'error', text: 'Points must be between -1000 and 1000.' });
            return;
        }
        if (!adjustNote.trim()) {
            setFlash({ type: 'error', text: 'A reason note is required.' });
            return;
        }
        setAdjusting(true);
        try {
            const updated = await adminApi.adjustPoints({
                userId: selectedUser.id,
                points,
                reason: adjustNote.trim(),
            });
            setAdjustAmount('');
            setAdjustNote('');
            setFlash({
                type: 'success',
                text: `Adjusted by ${points > 0 ? '+' : ''}${points} — lifetime ${updated?.lifetimePoints ?? '?'}, monthly ${updated?.monthlyPoints ?? '?'}.`,
            });
            fetchScore(selectedUser);
            fetchEvents(evPagination.page);
        } catch (err) {
            setFlash({ type: 'error', text: err?.response?.data?.error || 'Failed to adjust points.' });
        } finally {
            setAdjusting(false);
        }
    };

    const handleGrant = async () => {
        if (!selectedUser || !grantBadgeId) return;
        const month = grantMonth.trim();
        if (month && !MONTH_RE.test(month)) {
            setFlash({ type: 'error', text: 'Month must be YYYY-MM (or leave it empty for a permanent badge).' });
            return;
        }
        setGranting(true);
        try {
            await adminApi.grantBadge({
                userId: selectedUser.id,
                badgeId: grantBadgeId,
                ...(month ? { month } : {}),
            });
            setFlash({ type: 'success', text: `Granted "${badgeName(grantBadgeId)}".` });
            setGrantBadgeId('');
            setGrantMonth('');
            fetchScore(selectedUser);
        } catch (err) {
            setFlash({ type: 'error', text: err?.response?.data?.error || 'Failed to grant badge.' });
        } finally {
            setGranting(false);
        }
    };

    const handleRevoke = async (badgeId) => {
        if (!selectedUser) return;
        if (!window.confirm(`Revoke "${badgeName(badgeId)}" from ${selectedUser.profile?.name || 'this user'}?`)) return;
        setRevoking(badgeId);
        try {
            await adminApi.revokeBadge(selectedUser.id, badgeId);
            setFlash({ type: 'success', text: `Revoked "${badgeName(badgeId)}".` });
            fetchScore(selectedUser);
        } catch (err) {
            setFlash({ type: 'error', text: err?.response?.data?.error || 'Failed to revoke badge.' });
        } finally {
            setRevoking(null);
        }
    };

    const handleRecompute = async () => {
        if (!window.confirm('Recompute ALL user scores from the point ledger?\n\nThis rebuilds every score row (totals, counters, levels) from the authoritative ledger. Safe, but may take a moment.')) return;
        setRecomputing(true);
        try {
            await adminApi.recomputePoints();
            setFlash({ type: 'success', text: 'All scores recomputed from the ledger.' });
            if (selectedUser) fetchScore(selectedUser);
            fetchEvents(evPagination.page);
        } catch (err) {
            setFlash({ type: 'error', text: err?.response?.data?.error || 'Failed to recompute scores.' });
        } finally {
            setRecomputing(false);
        }
    };

    const permanentBadgeIds = new Set((score?.badges || []).filter((b) => !b.month).map((b) => b.badgeId));
    const grantableBadges = catalog.filter((b) => !permanentBadgeIds.has(b.id));

    return (
        <>
            <div className="header">
                <div>
                    <h1>Points Management</h1>
                    <p className="subtitle">Adjust member points, manage badges, and browse the ledger</p>
                </div>
                <button className="recompute-btn" onClick={handleRecompute} disabled={recomputing}>
                    {recomputing ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
                    Recompute All Scores
                </button>
            </div>

            {flash && (
                <div className={`flash ${flash.type}`}>{flash.text}</div>
            )}

            {/* ── Member panel ─────────────────────────────────────────── */}
            <div className="card">
                <h2 className="card-title">Member</h2>

                {!selectedUser ? (
                    <div className="user-search">
                        <div className="search-wrap">
                            <Search size={16} />
                            <input
                                type="text"
                                placeholder="Search members by name, email, or pubkey..."
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                            />
                            {searching && <Loader2 size={16} className="spin" />}
                        </div>
                        {results.length > 0 && (
                            <div className="user-list">
                                {results.map((u) => (
                                    <div key={u.id} className="user-option" onClick={() => selectUser(u)}>
                                        <div className="user-option-info">
                                            {u.profile?.avatar ? (
                                                <img src={getAssetUrl(u.profile.avatar)} alt="" className="user-option-avatar" />
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
                                        <span className="role-tag">{u.isAdmin ? 'ADMIN' : u.role}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                        {search.trim() && !searching && results.length === 0 && (
                            <p className="muted">No members match that search.</p>
                        )}
                    </div>
                ) : (
                    <>
                        <div className="selected-user">
                            <div className="user-option-info">
                                {selectedUser.profile?.avatar ? (
                                    <img src={getAssetUrl(selectedUser.profile.avatar)} alt="" className="user-option-avatar big" />
                                ) : (
                                    <div className="user-option-avatar big placeholder">
                                        {(selectedUser.profile?.name || '?')[0].toUpperCase()}
                                    </div>
                                )}
                                <div>
                                    <div className="user-option-name">{selectedUser.profile?.name || '(unnamed)'}</div>
                                    <div className="user-option-meta">
                                        {selectedUser.email || truncatePubkey(selectedUser.nostrPubkey)}
                                    </div>
                                </div>
                            </div>
                            <button className="icon-btn" onClick={clearUser} title="Clear selection">
                                <X size={18} />
                            </button>
                        </div>

                        {scoreLoading ? (
                            <div className="center-pad"><Loader2 size={24} className="spin" /></div>
                        ) : !selectedUser.nostrPubkey ? (
                            <p className="muted">This user has no Nostr key — no score data available.</p>
                        ) : !score ? (
                            <p className="muted">No score data for this member yet.</p>
                        ) : (
                            <div className="stats-row">
                                <div className="stat">
                                    <span className="stat-value">{score.lifetimePoints}</span>
                                    <span className="stat-label">Lifetime</span>
                                </div>
                                <div className="stat">
                                    <span className="stat-value">{score.monthlyPoints}</span>
                                    <span className="stat-label">This Month</span>
                                </div>
                                <div className="stat">
                                    <span className="stat-value">L{score.level}</span>
                                    <span className="stat-label">{score.titleKey ? t(score.titleKey) : 'Level'}</span>
                                </div>
                                <div className="stat">
                                    <span className="stat-value">{score.streakDays}</span>
                                    <span className="stat-label">Streak Days</span>
                                </div>
                                <div className="stat">
                                    <span className="stat-value">{score.postCount} / {score.replyCount}</span>
                                    <span className="stat-label">Posts / Replies</span>
                                </div>
                                <div className="stat">
                                    <span className="stat-value">{score.reactionsGiven} / {score.reactionsReceived}</span>
                                    <span className="stat-label">Reactions G / R</span>
                                </div>
                            </div>
                        )}

                        {/* Adjust form */}
                        <form className="adjust-form" onSubmit={handleAdjust}>
                            <h3 className="section-title">Adjust Points</h3>
                            <div className="adjust-row">
                                <div className="adjust-amount">
                                    <button
                                        type="button"
                                        className="step-btn"
                                        onClick={() => setAdjustAmount(String((parseInt(adjustAmount, 10) || 0) - 1))}
                                        aria-label="Decrease"
                                    >
                                        <Minus size={14} />
                                    </button>
                                    <input
                                        type="number"
                                        step="1"
                                        min="-1000"
                                        max="1000"
                                        placeholder="±points"
                                        value={adjustAmount}
                                        onChange={(e) => setAdjustAmount(e.target.value)}
                                        required
                                    />
                                    <button
                                        type="button"
                                        className="step-btn"
                                        onClick={() => setAdjustAmount(String((parseInt(adjustAmount, 10) || 0) + 1))}
                                        aria-label="Increase"
                                    >
                                        <Plus size={14} />
                                    </button>
                                </div>
                                <input
                                    type="text"
                                    className="reason-input"
                                    placeholder="Reason note (required, shown in the audit log)"
                                    value={adjustNote}
                                    onChange={(e) => setAdjustNote(e.target.value)}
                                    maxLength={200}
                                    required
                                />
                                <button type="submit" className="btn-primary" disabled={adjusting}>
                                    {adjusting ? <Loader2 size={16} className="spin" /> : null}
                                    Apply
                                </button>
                            </div>
                            <p className="hint">
                                Writes a signed ADMIN_ADJUST row to the ledger. Use negative values to deduct points.
                            </p>
                        </form>

                        {/* Badges */}
                        <div className="badges-section">
                            <h3 className="section-title">Badges</h3>
                            {(score?.badges || []).length > 0 ? (
                                <div className="badge-list">
                                    {score.badges.map((b) => (
                                        <span
                                            key={`${b.badgeId}-${b.month || 'permanent'}`}
                                            className="badge-chip"
                                            style={{ borderColor: RARITY_COLORS[b.rarity] || 'var(--color-gray-200)' }}
                                            title={t(`points.badges.${b.badgeId}.desc`, '')}
                                        >
                                            <img src={`/badges/${b.badgeId}.png`} alt="" width="20" height="20" />
                                            {badgeName(b.badgeId)}
                                            {b.month && <span className="badge-month">{b.month}</span>}
                                            {!b.month && (
                                                <button
                                                    type="button"
                                                    className="badge-remove"
                                                    onClick={() => handleRevoke(b.badgeId)}
                                                    disabled={revoking === b.badgeId}
                                                    title="Revoke badge"
                                                >
                                                    {revoking === b.badgeId ? <Loader2 size={12} className="spin" /> : <X size={12} />}
                                                </button>
                                            )}
                                        </span>
                                    ))}
                                </div>
                            ) : (
                                <p className="muted">No badges yet.</p>
                            )}
                            <div className="grant-row">
                                <select
                                    value={grantBadgeId}
                                    onChange={(e) => setGrantBadgeId(e.target.value)}
                                    className="filter-select"
                                >
                                    <option value="">Grant a badge...</option>
                                    {grantableBadges.map((b) => (
                                        <option key={b.id} value={b.id}>
                                            {badgeName(b.id)} ({b.rarity}{b.monthly ? ', monthly' : ''})
                                        </option>
                                    ))}
                                </select>
                                <input
                                    type="text"
                                    className="month-input"
                                    placeholder="YYYY-MM (optional)"
                                    value={grantMonth}
                                    onChange={(e) => setGrantMonth(e.target.value)}
                                    maxLength={7}
                                />
                                <button
                                    type="button"
                                    className="btn-primary"
                                    onClick={handleGrant}
                                    disabled={!grantBadgeId || granting}
                                >
                                    {granting ? <Loader2 size={16} className="spin" /> : <Award size={16} />}
                                    Grant
                                </button>
                            </div>
                            <p className="hint">
                                Leave the month empty for a permanent badge. Only permanent badges can be revoked here — monthly
                                badges are owned by the rollover job.
                            </p>
                        </div>
                    </>
                )}
            </div>

            {/* ── Ledger browser ───────────────────────────────────────── */}
            <div className="card">
                <h2 className="card-title">Point Ledger</h2>

                <div className="toolbar">
                    <div className="filters">
                        <select
                            value={reasonFilter}
                            onChange={(e) => setReasonFilter(e.target.value)}
                            className="filter-select"
                        >
                            <option value="">All Reasons</option>
                            {POINT_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                        </select>
                        <label className={`checkbox-label ${!selectedUser ? 'disabled' : ''}`}>
                            <input
                                type="checkbox"
                                checked={onlySelectedUser && !!selectedUser}
                                onChange={(e) => setOnlySelectedUser(e.target.checked)}
                                disabled={!selectedUser}
                            />
                            Selected member only
                        </label>
                    </div>
                    <span className="total-count">{evPagination.total} entries</span>
                </div>

                {evLoading ? (
                    <div className="center-pad"><Loader2 size={32} className="spin" /></div>
                ) : events.length === 0 ? (
                    <div className="empty-state"><p>No ledger entries found.</p></div>
                ) : (
                    <div className="table-container">
                        <table className="data-table">
                            <thead>
                                <tr>
                                    <th>User</th>
                                    <th>Reason</th>
                                    <th>Points</th>
                                    <th>Month</th>
                                    <th>Date</th>
                                    <th>Meta</th>
                                </tr>
                            </thead>
                            <tbody>
                                {events.map((ev) => (
                                    <tr key={ev.id}>
                                        <td>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                                {ev.user?.profile?.avatar ? (
                                                    <img src={getAssetUrl(ev.user.profile.avatar)} alt="" style={{ width: 24, height: 24, borderRadius: '50%', objectFit: 'cover' }} />
                                                ) : (
                                                    <div style={{ width: 24, height: 24, borderRadius: '50%', background: 'var(--color-gray-200)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.65rem', color: 'var(--color-gray-500)', flexShrink: 0 }}>
                                                        {(ev.user?.profile?.name || '?')[0].toUpperCase()}
                                                    </div>
                                                )}
                                                <span className="font-semibold">
                                                    {ev.user?.profile?.name || truncatePubkey(ev.user?.nostrPubkey)}
                                                </span>
                                            </div>
                                        </td>
                                        <td data-label="Reason"><span className="reason-tag">{ev.reason}</span></td>
                                        <td data-label="Points">
                                            <span className={`points-value ${ev.points > 0 ? 'pos' : ev.points < 0 ? 'neg' : 'zero'}`}>
                                                {ev.points > 0 ? `+${ev.points}` : ev.points}
                                            </span>
                                        </td>
                                        <td data-label="Month" className="mobile-hide">{ev.month}</td>
                                        <td data-label="Date">{new Date(ev.createdAt).toLocaleString()}</td>
                                        <td data-label="Meta" className="meta-cell" title={fullMeta(ev.meta)}>
                                            {compactMeta(ev.meta)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

                {evPagination.totalPages > 1 && (
                    <div className="pagination">
                        <button disabled={evPagination.page <= 1} onClick={() => fetchEvents(evPagination.page - 1)}>Previous</button>
                        <span>Page {evPagination.page} of {evPagination.totalPages}</span>
                        <button disabled={evPagination.page >= evPagination.totalPages} onClick={() => fetchEvents(evPagination.page + 1)}>Next</button>
                    </div>
                )}
            </div>

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
                    display: inline-flex; align-items: center; gap: 0.4rem;
                    padding: 0.5rem 1rem; background: var(--color-surface);
                    color: var(--color-gray-600); border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-md); font-size: 0.875rem; font-weight: 500;
                    cursor: pointer; transition: all 0.15s; white-space: nowrap;
                }
                .recompute-btn:hover:not(:disabled) { background: var(--color-gray-100); }
                .recompute-btn:disabled { opacity: 0.5; cursor: not-allowed; }
                .flash {
                    padding: 0.75rem 1rem; border-radius: var(--radius-md);
                    font-size: 0.875rem; margin-bottom: 1rem;
                }
                .flash.success { background: var(--color-green-tint); color: var(--badge-success-text); }
                .flash.error { background: var(--color-red-tint); color: var(--badge-error-text); }
                .card {
                    background: var(--color-surface);
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-lg);
                    padding: 1.25rem 1.5rem;
                    margin-bottom: 1.5rem;
                }
                .card-title { margin: 0 0 1rem; font-size: 1rem; }
                .section-title {
                    margin: 1.25rem 0 0.6rem; font-size: 0.8rem; font-weight: 600;
                    text-transform: uppercase; color: var(--color-gray-500);
                    letter-spacing: 0.04em;
                }
                .muted { color: var(--color-gray-500); font-size: 0.875rem; }
                .hint { color: var(--color-gray-400); font-size: 0.78rem; margin-top: 0.4rem; }
                .center-pad { display: flex; justify-content: center; padding: 2rem; }

                .search-wrap {
                    display: flex; align-items: center; gap: 0.5rem;
                    background: var(--color-surface); border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-md); padding: 0.5rem 0.75rem;
                    color: var(--color-gray-400);
                }
                .search-wrap input {
                    border: none; outline: none; font-size: 0.875rem;
                    background: transparent; flex: 1; min-width: 0;
                }
                .user-list {
                    margin-top: 0.5rem; border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-md); max-height: 280px; overflow-y: auto;
                }
                .user-option {
                    display: flex; align-items: center; justify-content: space-between;
                    padding: 0.6rem 0.75rem; cursor: pointer;
                    border-bottom: 1px solid var(--color-gray-100);
                    transition: background 0.15s;
                }
                .user-option:last-child { border-bottom: none; }
                .user-option:hover { background: var(--color-gray-50); }
                .user-option-info { display: flex; align-items: center; gap: 0.5rem; min-width: 0; }
                .user-option-avatar {
                    width: 28px; height: 28px; border-radius: 50%;
                    object-fit: cover; flex-shrink: 0;
                }
                .user-option-avatar.big { width: 40px; height: 40px; }
                .user-option-avatar.placeholder {
                    background: var(--color-gray-200); display: flex;
                    align-items: center; justify-content: center;
                    font-size: 0.7rem; color: var(--color-gray-500);
                }
                .user-option-name { font-weight: 600; font-size: 0.875rem; }
                .user-option-meta { font-size: 0.75rem; color: var(--color-gray-400); word-break: break-all; }
                .role-tag {
                    font-size: 0.65rem; font-weight: 600; color: var(--color-gray-400);
                    text-transform: uppercase; flex-shrink: 0; margin-left: 0.5rem;
                }
                .selected-user {
                    display: flex; align-items: center; justify-content: space-between;
                    padding-bottom: 0.75rem; border-bottom: 1px solid var(--color-gray-100);
                    margin-bottom: 1rem;
                }
                .icon-btn {
                    display: inline-flex; align-items: center; justify-content: center;
                    padding: 0.4rem; border-radius: var(--radius-md); border: none;
                    background: none; cursor: pointer; color: var(--color-gray-400);
                }
                .icon-btn:hover { background: var(--color-gray-100); color: var(--color-neutral-dark); }

                .stats-row {
                    display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
                    gap: 0.6rem; margin-bottom: 0.5rem;
                }
                .stat {
                    background: var(--color-gray-50); border-radius: var(--radius-md);
                    padding: 0.6rem 0.75rem; display: flex; flex-direction: column; gap: 2px;
                }
                .stat-value { font-weight: 700; font-size: 1.05rem; }
                .stat-label { font-size: 0.7rem; color: var(--color-gray-500); text-transform: uppercase; letter-spacing: 0.03em; }

                .adjust-row { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
                .adjust-amount {
                    display: flex; align-items: center; border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-md); overflow: hidden;
                }
                .adjust-amount input {
                    width: 90px; border: none; outline: none; text-align: center;
                    font-size: 0.875rem; padding: 0.5rem 0.25rem; background: transparent;
                    -moz-appearance: textfield;
                }
                .adjust-amount input::-webkit-outer-spin-button,
                .adjust-amount input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
                .step-btn {
                    border: none; background: var(--color-gray-100); color: var(--color-gray-600);
                    padding: 0.55rem 0.6rem; cursor: pointer; display: flex; align-items: center;
                }
                .step-btn:hover { background: var(--color-gray-200); }
                .reason-input {
                    flex: 1; min-width: 200px; padding: 0.5rem 0.75rem;
                    border: 1px solid var(--color-gray-200); border-radius: var(--radius-md);
                    font-size: 0.875rem; background: var(--color-surface);
                }
                .btn-primary {
                    display: inline-flex; align-items: center; gap: 0.4rem;
                    padding: 0.5rem 1rem; background: var(--color-primary); color: white;
                    border: none; border-radius: var(--radius-md); font-size: 0.875rem;
                    font-weight: 500; cursor: pointer;
                }
                .btn-primary:hover:not(:disabled) { opacity: 0.9; }
                .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

                .badge-list { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 0.75rem; }
                .badge-chip {
                    display: inline-flex; align-items: center; gap: 6px;
                    border: 1px solid var(--color-gray-200); border-radius: 99px;
                    padding: 4px 8px 4px 6px; font-size: 0.78rem; font-weight: 500;
                    color: var(--color-gray-700);
                }
                .badge-chip img { border-radius: 50%; flex-shrink: 0; }
                .badge-month { font-size: 0.68rem; color: var(--color-gray-400); }
                .badge-remove {
                    display: inline-flex; align-items: center; justify-content: center;
                    border: none; background: var(--color-gray-100); color: var(--color-gray-500);
                    border-radius: 50%; width: 18px; height: 18px; cursor: pointer; padding: 0;
                }
                .badge-remove:hover { background: var(--color-red-tint); color: #dc2626; }
                .badge-remove:disabled { opacity: 0.5; cursor: not-allowed; }
                .grant-row { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
                .month-input {
                    width: 150px; padding: 0.5rem 0.75rem; border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-md); font-size: 0.875rem; background: var(--color-surface);
                }

                .toolbar {
                    display: flex; justify-content: space-between; align-items: center;
                    margin-bottom: 1rem; gap: 1rem; flex-wrap: wrap;
                }
                .filters { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; }
                .filter-select {
                    padding: 0.5rem 0.75rem; border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-md); background: var(--color-surface);
                    font-size: 0.875rem; color: var(--color-gray-600); cursor: pointer;
                    max-width: 100%;
                }
                .checkbox-label {
                    display: flex; align-items: center; gap: 0.4rem;
                    font-size: 0.85rem; color: var(--color-gray-600); cursor: pointer;
                }
                .checkbox-label.disabled { opacity: 0.5; cursor: not-allowed; }
                .checkbox-label input { cursor: pointer; }
                .total-count { font-size: 0.8rem; color: var(--color-gray-400); }
                .empty-state {
                    background: var(--color-gray-50); border-radius: var(--radius-md);
                    padding: 2rem; text-align: center; color: var(--color-gray-500);
                }

                .table-container { overflow-x: auto; }
                .data-table { width: 100%; border-collapse: collapse; }
                .data-table th {
                    text-align: left; padding: 0.75rem 1rem;
                    border-bottom: 1px solid var(--color-gray-200);
                    color: var(--color-gray-500); font-size: 0.8rem; font-weight: 600;
                    text-transform: uppercase; white-space: nowrap;
                }
                .data-table td {
                    padding: 0.6rem 1rem; border-bottom: 1px solid var(--color-gray-100);
                    font-size: 0.85rem;
                }
                .data-table tr:last-child td { border-bottom: none; }
                .font-semibold { font-weight: 600; }
                .reason-tag {
                    font-size: 0.7rem; font-weight: 600; padding: 2px 8px;
                    border-radius: 99px; background: var(--color-gray-100);
                    color: var(--color-gray-600); white-space: nowrap;
                }
                .points-value { font-weight: 700; font-variant-numeric: tabular-nums; }
                .points-value.pos { color: #16a34a; }
                .points-value.neg { color: #dc2626; }
                .points-value.zero { color: var(--color-gray-400); }
                .meta-cell {
                    font-family: var(--font-mono); font-size: 0.72rem;
                    color: var(--color-gray-500); max-width: 260px;
                    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
                }

                .pagination {
                    display: flex; justify-content: center; align-items: center;
                    gap: 1rem; margin-top: 1.25rem;
                }
                .pagination button {
                    padding: 0.5rem 1rem; border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-md); background: var(--color-surface);
                    cursor: pointer; font-size: 0.875rem;
                }
                .pagination button:disabled { opacity: 0.5; cursor: not-allowed; }
                .pagination span { font-size: 0.875rem; color: var(--color-gray-500); }
                .spin { animation: spin 1s linear infinite; }
                @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

                @media (max-width: 768px) {
                    .header { flex-direction: column; gap: 0.75rem; }
                    .header h1 { font-size: 1.25rem; }
                    .card { padding: 1rem; }
                    .adjust-row { flex-direction: column; align-items: stretch; }
                    .adjust-amount { justify-content: space-between; }
                    .adjust-amount input { flex: 1; }
                    .reason-input { min-width: 0; }
                    .grant-row { flex-direction: column; align-items: stretch; }
                    .month-input { width: 100%; }
                    .table-container { overflow: visible; }
                    .data-table, .data-table thead, .data-table tbody,
                    .data-table tr, .data-table th, .data-table td { display: block; }
                    .data-table thead { display: none; }
                    .data-table tr {
                        background: var(--color-gray-50);
                        border: 1px solid var(--color-gray-200);
                        border-radius: var(--radius-lg);
                        padding: 0.75rem 1rem;
                        margin-bottom: 0.75rem;
                    }
                    .data-table td {
                        display: flex; align-items: center;
                        padding: 0.25rem 0; border-bottom: none; gap: 0.5rem;
                    }
                    .data-table td::before {
                        content: attr(data-label);
                        font-weight: 600; font-size: 0.68rem;
                        color: var(--color-gray-400); text-transform: uppercase;
                        letter-spacing: 0.05em; min-width: 60px; flex-shrink: 0;
                    }
                    .data-table td:first-child {
                        padding-bottom: 0.4rem; margin-bottom: 0.2rem;
                        border-bottom: 1px solid var(--color-gray-200);
                    }
                    .data-table td:first-child::before { display: none; }
                    .data-table td.mobile-hide { display: none; }
                    .meta-cell { max-width: 100%; white-space: normal; word-break: break-all; }
                }
            `}</style>
        </>
    );
};

export default AdminPoints;
