import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Loader2, Trash2, Bug, Lightbulb, Heart, MessageSquare, Search, X, MessageCircle, MapPin, Smartphone } from 'lucide-react';
import { adminApi } from '../../services/api';
import { FEEDBACK_PAGES } from '../../config/feedbackPages';
import { getAssetUrl } from '../../utils/assets';

const TYPE_META = {
    BUG: { label: 'Bug', icon: Bug, color: '#dc2626', bg: '#fef2f2' },
    FEATURE: { label: 'Feature', icon: Lightbulb, color: '#f59e0b', bg: '#fffbeb' },
    LOVE: { label: 'Love', icon: Heart, color: '#ec4899', bg: '#fdf2f8' },
    GENERAL: { label: 'Feedback', icon: MessageSquare, color: 'var(--color-primary)', bg: 'var(--color-blue-tint)' },
};

const STATUS_OPTIONS = [
    { value: 'NEW', label: 'New', color: '#2563eb', bg: '#eff6ff' },
    { value: 'IN_REVIEW', label: 'In Review', color: '#7c3aed', bg: '#f5f3ff' },
    { value: 'PLANNED', label: 'Planned', color: '#0891b2', bg: '#ecfeff' },
    { value: 'FIXED', label: 'Fixed', color: '#16a34a', bg: '#f0fdf4' },
    { value: 'WONT_FIX', label: "Won't Fix", color: '#9ca3af', bg: '#f3f4f6' },
    { value: 'DUPLICATE', label: 'Duplicate', color: '#d97706', bg: '#fffbeb' },
    { value: 'CLOSED', label: 'Closed', color: '#6b7280', bg: '#f3f4f6' },
];

const PRIORITY_OPTIONS = [
    { value: 'LOW', label: 'Low', color: '#6b7280' },
    { value: 'NORMAL', label: 'Normal', color: '#2563eb' },
    { value: 'HIGH', label: 'High', color: '#f59e0b' },
    { value: 'URGENT', label: 'Urgent', color: '#dc2626' },
];

const getStatusMeta = (status) => STATUS_OPTIONS.find(s => s.value === status) || STATUS_OPTIONS[0];
const getPriorityMeta = (priority) => PRIORITY_OPTIONS.find(p => p.value === priority) || PRIORITY_OPTIONS[1];

const PLATFORM_NAMES = { ios: 'iOS app', android: 'Android app', web: 'Website' };

/** What the app sent with a report, in one line: where, which version, what screen. */
const deviceLine = (device = {}) => [
    PLATFORM_NAMES[device.platform],
    device.appVersion && `v${device.appVersion}${device.build ? ` (${device.build})` : ''}`,
    device.screen,
    device.path && `from ${device.path}`,
].filter(Boolean).join(' · ');

const AdminFeedback = () => {
    const { t } = useTranslation();
    const [items, setItems] = useState([]);
    const [pagination, setPagination] = useState({ page: 1, total: 0, totalPages: 1 });
    const [counts, setCounts] = useState({ new: 0, inReview: 0, fixed: 0, all: 0 });
    const [loading, setLoading] = useState(true);
    const [typeFilter, setTypeFilter] = useState('');
    const [statusFilter, setStatusFilter] = useState('');
    const [priorityFilter, setPriorityFilter] = useState('');
    const [pageFilter, setPageFilter] = useState('');
    // The screenshot open full size, and those whose 15-minute link ran out.
    const [openShot, setOpenShot] = useState('');
    const [expiredShots, setExpiredShots] = useState(() => new Set());
    const [search, setSearch] = useState('');
    const [expandedId, setExpandedId] = useState(null);
    const [noteText, setNoteText] = useState('');
    const [saving, setSaving] = useState(null);

    const fetchFeedback = useCallback(async (page = 1) => {
        setLoading(true);
        try {
            const params = { page, limit: 30 };
            if (typeFilter) params.type = typeFilter;
            if (statusFilter) params.status = statusFilter;
            if (priorityFilter) params.priority = priorityFilter;
            if (pageFilter) params.onPage = pageFilter;
            if (search) params.search = search;
            const res = await adminApi.feedback(params);
            setItems(Array.isArray(res?.data) ? res.data : []);
            setPagination(res?.pagination || { page: 1, total: 0, totalPages: 1 });
            if (res?.counts) setCounts(res.counts);
            setExpiredShots(new Set());
        } catch (err) {
            console.error('Failed to fetch feedback:', err);
        } finally {
            setLoading(false);
        }
    }, [typeFilter, statusFilter, priorityFilter, pageFilter, search]);

    useEffect(() => { fetchFeedback(1); }, [fetchFeedback]);

    const handleUpdate = async (id, data) => {
        setSaving(id);
        try {
            const updated = await adminApi.updateFeedback(id, data);
            setItems(prev => prev.map(f => f.id === id ? updated : f));
        } catch (err) {
            console.error('Failed to update feedback:', err);
        } finally {
            setSaving(null);
        }
    };

    const handleSaveNote = async (id) => {
        await handleUpdate(id, { adminNote: noteText });
    };

    const handleDelete = async (id) => {
        if (!confirm('Delete this feedback permanently?')) return;
        try {
            await adminApi.deleteFeedback(id);
            setItems(prev => prev.filter(f => f.id !== id));
        } catch (err) {
            console.error('Failed to delete feedback:', err);
        }
    };

    const toggleExpand = (id, currentNote) => {
        if (expandedId === id) {
            setExpandedId(null);
        } else {
            setExpandedId(id);
            setNoteText(currentNote || '');
        }
    };

    const pageName = (id) => (id ? t(`feedback.pages.${id}`, id) : '');

    const formatDate = (d) => new Date(d).toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });

    const formatRelative = (d) => {
        const diff = Date.now() - new Date(d).getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 60) return `${mins}m ago`;
        const hours = Math.floor(mins / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        return `${days}d ago`;
    };

    return (
        <>
            <div className="header">
                <div>
                    <h1>Feedback</h1>
                    <p className="subtitle">Manage user feedback, bug reports, and feature requests</p>
                </div>
            </div>

            {/* Summary cards */}
            <div className="summary-cards">
                <button className={`summary-card ${statusFilter === '' ? 'active' : ''}`} onClick={() => setStatusFilter('')}>
                    <span className="summary-count">{counts.all}</span>
                    <span className="summary-label">Total</span>
                </button>
                <button className={`summary-card new ${statusFilter === 'NEW' ? 'active' : ''}`} onClick={() => setStatusFilter(statusFilter === 'NEW' ? '' : 'NEW')}>
                    <span className="summary-count">{counts.new}</span>
                    <span className="summary-label">New</span>
                </button>
                <button className={`summary-card review ${statusFilter === 'IN_REVIEW' ? 'active' : ''}`} onClick={() => setStatusFilter(statusFilter === 'IN_REVIEW' ? '' : 'IN_REVIEW')}>
                    <span className="summary-count">{counts.inReview}</span>
                    <span className="summary-label">In Review</span>
                </button>
                <button className={`summary-card fixed ${statusFilter === 'FIXED' ? 'active' : ''}`} onClick={() => setStatusFilter(statusFilter === 'FIXED' ? '' : 'FIXED')}>
                    <span className="summary-count">{counts.fixed}</span>
                    <span className="summary-label">Fixed</span>
                </button>
            </div>

            {/* Filters toolbar */}
            <div className="toolbar">
                <div className="search-wrap">
                    <Search size={16} />
                    <input
                        type="text"
                        placeholder="Search feedback..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="search-input"
                    />
                    {search && (
                        <button onClick={() => setSearch('')} className="clear-btn"><X size={14} /></button>
                    )}
                </div>
                <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="filter-select">
                    <option value="">All Types</option>
                    <option value="BUG">Bug Reports</option>
                    <option value="FEATURE">Feature Requests</option>
                    <option value="LOVE">Love</option>
                    <option value="GENERAL">Feedback</option>
                </select>
                <select value={pageFilter} onChange={(e) => setPageFilter(e.target.value)} className="filter-select">
                    <option value="">All Pages</option>
                    {FEEDBACK_PAGES.map(p => (
                        <option key={p.id} value={p.id}>{pageName(p.id)}</option>
                    ))}
                </select>
                <select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)} className="filter-select">
                    <option value="">All Priority</option>
                    {PRIORITY_OPTIONS.map(p => (
                        <option key={p.value} value={p.value}>{p.label}</option>
                    ))}
                </select>
                <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="filter-select">
                    <option value="">All Status</option>
                    {STATUS_OPTIONS.map(s => (
                        <option key={s.value} value={s.value}>{s.label}</option>
                    ))}
                </select>
            </div>

            {loading ? (
                <div className="loading"><Loader2 size={24} className="spin" /></div>
            ) : items.length === 0 ? (
                <div className="empty">No feedback found.</div>
            ) : (
                <div className="feedback-list">
                    {items.map((item) => {
                        const typeMeta = TYPE_META[item.type] || TYPE_META.GENERAL;
                        const statusMeta = getStatusMeta(item.status);
                        const priorityMeta = getPriorityMeta(item.priority);
                        const TypeIcon = typeMeta.icon;
                        const isExpanded = expandedId === item.id;

                        return (
                            <div key={item.id} className={`feedback-item ${item.priority === 'URGENT' ? 'urgent' : ''}`}>
                                <div className="feedback-header">
                                    <div className="feedback-meta">
                                        <span className="type-badge" style={{ color: typeMeta.color, background: typeMeta.bg }}>
                                            <TypeIcon size={14} /> {typeMeta.label}
                                        </span>
                                        {item.page && (
                                            <span className="page-badge"><MapPin size={12} /> {pageName(item.page)}</span>
                                        )}
                                        <span className="priority-dot" style={{ background: priorityMeta.color }} title={priorityMeta.label} />
                                        <span className="feedback-time" title={formatDate(item.createdAt)}>{formatRelative(item.createdAt)}</span>
                                    </div>
                                    <div className="feedback-actions">
                                        {/* Priority selector */}
                                        <select
                                            value={item.priority}
                                            onChange={(e) => handleUpdate(item.id, { priority: e.target.value })}
                                            className="action-select priority-select"
                                            style={{ color: priorityMeta.color }}
                                        >
                                            {PRIORITY_OPTIONS.map(p => (
                                                <option key={p.value} value={p.value}>{p.label}</option>
                                            ))}
                                        </select>
                                        {/* Status selector */}
                                        <select
                                            value={item.status}
                                            onChange={(e) => handleUpdate(item.id, { status: e.target.value })}
                                            className="action-select status-select"
                                            style={{ color: statusMeta.color, background: statusMeta.bg }}
                                        >
                                            {STATUS_OPTIONS.map(s => (
                                                <option key={s.value} value={s.value}>{s.label}</option>
                                            ))}
                                        </select>
                                        {/* Note toggle */}
                                        <button
                                            onClick={() => toggleExpand(item.id, item.adminNote)}
                                            className={`icon-btn note-btn ${item.adminNote ? 'has-note' : ''}`}
                                            title={item.adminNote ? 'Edit note' : 'Add note'}
                                        >
                                            <MessageCircle size={16} />
                                        </button>
                                        {/* Delete */}
                                        <button onClick={() => handleDelete(item.id)} className="icon-btn delete-btn" title="Delete">
                                            <Trash2 size={16} />
                                        </button>
                                    </div>
                                </div>

                                <p className="feedback-message">{item.message}</p>

                                {item.screenshotUrl && (
                                    expiredShots.has(item.id) ? (
                                        <button type="button" className="shot-expired" onClick={() => fetchFeedback(pagination.page)}>
                                            Screenshot link expired. Reload
                                        </button>
                                    ) : (
                                        <button type="button" className="shot-thumb" onClick={() => setOpenShot(getAssetUrl(item.screenshotUrl))} title="See it full size">
                                            <img
                                                src={getAssetUrl(item.screenshotUrl)}
                                                alt="Screenshot sent with this report"
                                                loading="lazy"
                                                onError={() => setExpiredShots(prev => new Set(prev).add(item.id))}
                                            />
                                        </button>
                                    )
                                )}

                                {/* Admin note preview (when collapsed) */}
                                {item.adminNote && !isExpanded && (
                                    <div className="note-preview" onClick={() => toggleExpand(item.id, item.adminNote)}>
                                        <MessageCircle size={12} /> {item.adminNote}
                                    </div>
                                )}

                                {/* Expanded admin note editor */}
                                {isExpanded && (
                                    <div className="note-editor">
                                        <label className="note-label">Admin Note</label>
                                        <textarea
                                            value={noteText}
                                            onChange={(e) => setNoteText(e.target.value)}
                                            placeholder="Internal note — not visible to the user..."
                                            rows={3}
                                            className="note-textarea"
                                        />
                                        <div className="note-actions">
                                            <button
                                                onClick={() => handleSaveNote(item.id)}
                                                disabled={saving === item.id}
                                                className="note-save-btn"
                                            >
                                                {saving === item.id ? <Loader2 size={14} className="spin" /> : 'Save Note'}
                                            </button>
                                            <button onClick={() => setExpandedId(null)} className="note-cancel-btn">Cancel</button>
                                        </div>
                                    </div>
                                )}

                                <div className="feedback-footer">
                                    <span className="feedback-user">
                                        {item.user?.profile?.avatar && (
                                            <img src={item.user.profile.avatar} alt="" className="user-avatar" />
                                        )}
                                        {item.user?.profile?.name || item.user?.email || 'Unknown user'}
                                    </span>
                                    {item.resolvedAt && (
                                        <span className="resolved-date">Resolved {formatRelative(item.resolvedAt)}</span>
                                    )}
                                </div>
                                {deviceLine(item.device) && (
                                    <div className="device-line" title={item.device?.userAgent || ''}>
                                        <Smartphone size={12} /> {deviceLine(item.device)}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Over the whole app, the bottom bar included, like the side menu. */}
            {openShot && createPortal(
                <div className="admin-shot-overlay" role="dialog" aria-label="Screenshot" onClick={() => setOpenShot('')}>
                    <img src={openShot} alt="Screenshot sent with this report" />
                    <button type="button" className="admin-shot-close" onClick={() => setOpenShot('')} aria-label="Close"><X size={22} /></button>
                    <style>{`
                        .admin-shot-overlay {
                            position: fixed;
                            inset: 0;
                            z-index: 10001; /* above the bottom bar (10000) */
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            padding: calc(16px + env(safe-area-inset-top, 0px)) 16px calc(16px + env(safe-area-inset-bottom, 0px));
                            background: rgba(0, 0, 0, 0.85);
                            cursor: zoom-out;
                        }
                        .admin-shot-overlay img {
                            max-width: 100%;
                            max-height: 100%;
                            object-fit: contain;
                            border-radius: var(--radius-md);
                        }
                        .admin-shot-close {
                            position: absolute;
                            top: calc(12px + env(safe-area-inset-top, 0px));
                            right: 12px;
                            display: flex;
                            padding: 8px;
                            border: none;
                            border-radius: 50%;
                            background: rgba(255, 255, 255, 0.15);
                            color: white;
                            cursor: pointer;
                        }
                    `}</style>
                </div>,
                document.body,
            )}

            {pagination.totalPages > 1 && (
                <div className="pagination">
                    <button
                        onClick={() => fetchFeedback(pagination.page - 1)}
                        disabled={pagination.page <= 1}
                        className="page-btn"
                    >
                        Prev
                    </button>
                    <span className="page-info">Page {pagination.page} of {pagination.totalPages}</span>
                    <button
                        onClick={() => fetchFeedback(pagination.page + 1)}
                        disabled={pagination.page >= pagination.totalPages}
                        className="page-btn"
                    >
                        Next
                    </button>
                </div>
            )}

            <style jsx>{`
                .header { margin-bottom: 1.5rem; }
                .header h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 0.25rem; }
                .subtitle { color: var(--color-gray-500); font-size: 0.9rem; }

                /* Summary cards */
                .summary-cards {
                    display: grid;
                    grid-template-columns: repeat(4, 1fr);
                    gap: 0.75rem;
                    margin-bottom: 1.5rem;
                }
                .summary-card {
                    background: var(--color-surface);
                    border: 2px solid var(--color-gray-200);
                    border-radius: 0.75rem;
                    padding: 1rem;
                    text-align: center;
                    cursor: pointer;
                    transition: all 0.2s;
                }
                .summary-card:hover { border-color: var(--color-gray-400); }
                .summary-card.active { border-color: var(--color-primary); background: var(--color-blue-tint); }
                .summary-card.new .summary-count { color: #2563eb; }
                .summary-card.review .summary-count { color: #7c3aed; }
                .summary-card.fixed .summary-count { color: #16a34a; }
                .summary-count { display: block; font-size: 1.5rem; font-weight: 700; }
                .summary-label { font-size: 0.75rem; color: var(--color-gray-500); font-weight: 500; }

                /* Toolbar */
                .toolbar {
                    display: flex;
                    gap: 0.75rem;
                    margin-bottom: 1.5rem;
                    flex-wrap: wrap;
                }
                .search-wrap {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    padding: 0.4rem 0.75rem;
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-md);
                    background: var(--color-surface);
                    flex: 1;
                    min-width: 180px;
                    color: var(--color-gray-400);
                }
                .search-wrap:focus-within { border-color: var(--color-primary); }
                .search-input {
                    border: none;
                    outline: none;
                    font-size: 0.85rem;
                    background: transparent;
                    color: var(--color-text);
                    flex: 1;
                }
                .clear-btn {
                    padding: 2px;
                    border: none;
                    background: none;
                    cursor: pointer;
                    color: var(--color-gray-400);
                    border-radius: 50%;
                }
                .clear-btn:hover { color: var(--color-text); }
                .filter-select {
                    padding: 0.5rem 0.75rem;
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-md);
                    font-size: 0.85rem;
                    background: var(--color-surface);
                    color: var(--color-text);
                }

                .loading, .empty {
                    text-align: center;
                    padding: 3rem;
                    color: var(--color-gray-500);
                }

                /* Feedback list */
                .feedback-list {
                    display: flex;
                    flex-direction: column;
                    gap: 0.75rem;
                }
                .feedback-item {
                    background: var(--color-surface);
                    border: 1px solid var(--color-gray-200);
                    border-radius: 0.75rem;
                    padding: 1rem 1.25rem;
                    transition: border-color 0.2s;
                }
                .feedback-item:hover { border-color: var(--color-gray-300); }
                .feedback-item.urgent { border-left: 3px solid #dc2626; }

                .feedback-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 0.5rem;
                    flex-wrap: wrap;
                    gap: 0.5rem;
                }
                .feedback-meta {
                    display: flex;
                    gap: 0.5rem;
                    align-items: center;
                }
                .type-badge {
                    display: inline-flex;
                    align-items: center;
                    gap: 4px;
                    padding: 0.2rem 0.6rem;
                    border-radius: 9999px;
                    font-size: 0.7rem;
                    font-weight: 600;
                }
                .page-badge {
                    display: inline-flex;
                    align-items: center;
                    gap: 4px;
                    padding: 0.2rem 0.6rem;
                    border-radius: 9999px;
                    font-size: 0.7rem;
                    font-weight: 600;
                    color: var(--color-gray-600);
                    background: var(--color-gray-100);
                }
                .priority-dot {
                    width: 8px;
                    height: 8px;
                    border-radius: 50%;
                    flex-shrink: 0;
                }
                .feedback-time {
                    font-size: 0.75rem;
                    color: var(--color-gray-400);
                }
                .feedback-actions {
                    display: flex;
                    gap: 0.4rem;
                    align-items: center;
                }
                .action-select {
                    padding: 0.25rem 0.4rem;
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-sm);
                    font-size: 0.75rem;
                    font-weight: 600;
                    cursor: pointer;
                }
                .status-select { min-width: 90px; }
                .priority-select { min-width: 70px; background: var(--color-surface); }

                .icon-btn {
                    padding: 5px;
                    border: none;
                    background: none;
                    cursor: pointer;
                    border-radius: var(--radius-sm);
                    color: var(--color-gray-400);
                    transition: all 0.15s;
                }
                .note-btn:hover { color: var(--color-primary); background: var(--color-blue-tint); }
                .note-btn.has-note { color: var(--color-primary); }
                .delete-btn:hover { color: var(--color-error); background: var(--color-red-tint); }

                .feedback-message {
                    font-size: 0.9rem;
                    line-height: 1.55;
                    color: var(--color-text);
                    white-space: pre-wrap;
                    word-break: break-word;
                }

                /* Screenshot */
                .shot-thumb {
                    display: block;
                    margin-top: 0.6rem;
                    padding: 0;
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-md);
                    background: var(--color-gray-50);
                    cursor: zoom-in;
                    overflow: hidden;
                }
                .shot-thumb img {
                    display: block;
                    max-width: 140px;
                    max-height: 220px;
                    object-fit: contain;
                }
                .shot-expired {
                    margin-top: 0.6rem;
                    padding: 0.4rem 0.75rem;
                    border: 1px dashed var(--color-gray-300);
                    border-radius: var(--radius-sm);
                    background: none;
                    color: var(--color-gray-500);
                    font-size: 0.8rem;
                    cursor: pointer;
                }
                .device-line {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    margin-top: 0.4rem;
                    font-size: 0.75rem;
                    color: var(--color-gray-400);
                    word-break: break-word;
                }

                /* Note preview */
                .note-preview {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    margin-top: 0.5rem;
                    padding: 0.4rem 0.75rem;
                    background: var(--color-blue-tint);
                    border-radius: var(--radius-sm);
                    font-size: 0.8rem;
                    color: var(--color-primary);
                    cursor: pointer;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }

                /* Note editor */
                .note-editor {
                    margin-top: 0.75rem;
                    padding: 0.75rem;
                    background: var(--color-gray-50);
                    border-radius: var(--radius-md);
                    border: 1px solid var(--color-gray-200);
                }
                .note-label {
                    display: block;
                    font-size: 0.75rem;
                    font-weight: 600;
                    color: var(--color-gray-500);
                    margin-bottom: 0.4rem;
                }
                .note-textarea {
                    width: 100%;
                    padding: 0.5rem;
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-sm);
                    font-size: 0.85rem;
                    font-family: inherit;
                    resize: vertical;
                    outline: none;
                    background: var(--color-surface);
                    color: var(--color-text);
                }
                .note-textarea:focus { border-color: var(--color-primary); }
                .note-actions {
                    display: flex;
                    gap: 0.5rem;
                    margin-top: 0.5rem;
                }
                .note-save-btn {
                    padding: 0.35rem 0.75rem;
                    background: var(--color-primary);
                    color: white;
                    border: none;
                    border-radius: var(--radius-sm);
                    font-size: 0.8rem;
                    font-weight: 600;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    gap: 4px;
                }
                .note-save-btn:disabled { opacity: 0.5; }
                .note-cancel-btn {
                    padding: 0.35rem 0.75rem;
                    background: none;
                    color: var(--color-gray-500);
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-sm);
                    font-size: 0.8rem;
                    cursor: pointer;
                }

                .feedback-footer {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-top: 0.6rem;
                    padding-top: 0.5rem;
                    border-top: 1px solid var(--color-gray-100);
                }
                .feedback-user {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    font-size: 0.8rem;
                    color: var(--color-gray-500);
                    font-weight: 500;
                }
                .user-avatar {
                    width: 20px;
                    height: 20px;
                    border-radius: 50%;
                    object-fit: cover;
                }
                .resolved-date {
                    font-size: 0.75rem;
                    color: #16a34a;
                    font-weight: 500;
                }

                /* Pagination */
                .pagination {
                    display: flex;
                    gap: 0.75rem;
                    justify-content: center;
                    align-items: center;
                    margin-top: 1.5rem;
                }
                .page-btn {
                    padding: 0.4rem 1rem;
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-sm);
                    background: var(--color-surface);
                    color: var(--color-text);
                    font-size: 0.85rem;
                    cursor: pointer;
                }
                .page-btn:disabled { opacity: 0.4; cursor: not-allowed; }
                .page-btn:not(:disabled):hover { background: var(--color-gray-100); }
                .page-info { font-size: 0.85rem; color: var(--color-gray-500); }

                .spin { animation: spin 1s linear infinite; }
                @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

                @media (max-width: 768px) {
                    .summary-cards { grid-template-columns: repeat(2, 1fr); }
                    .toolbar { flex-direction: column; }
                    .feedback-header { flex-direction: column; align-items: flex-start; }
                    .feedback-actions { width: 100%; flex-wrap: wrap; }
                }
            `}</style>
        </>
    );
};

export default AdminFeedback;
