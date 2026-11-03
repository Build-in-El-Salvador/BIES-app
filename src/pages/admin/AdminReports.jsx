import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Flag, ExternalLink, Trash2, UserX, CheckCircle, XCircle, RotateCcw, ChevronDown, ChevronUp } from 'lucide-react';
import { nip19 } from 'nostr-tools';
import { adminApi, albumsApi, eventsApi, projectsApi, talentApi } from '../../services/api';
import { nostrService } from '../../services/nostrService';
import { nostrSigner } from '../../services/nostrSigner';
import { useAuth } from '../../context/AuthContext';
import { openExternal } from '../../utils/openExternal';
import { parseNoteContent } from '../../utils/noteUtils';
import { safeHref } from '../../utils/safeUrl';

const STATUS_TABS = [
    { value: 'OPEN', label: 'Open' },
    { value: 'ACTIONED', label: 'Actioned' },
    { value: 'DISMISSED', label: 'Dismissed' },
    { value: '', label: 'All' },
];

const TARGET_LABELS = {
    user: 'Profile',
    listing: 'Listing',
    endorsement: 'Recommendation',
    event: 'Event',
    note: 'Post',
    album: 'Album',
    photo: 'Photo',
    talent: 'Talent',
    opportunity: 'Opportunity',
};

// The terms promise a review within 24 hours (§6): flag what is getting close.
const HOURS_WARN = 18;

const hoursSince = (d) => (Date.now() - new Date(d).getTime()) / 3_600_000;

const formatAge = (d) => {
    const hours = hoursSince(d);
    if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m ago`;
    if (hours < 48) return `${Math.floor(hours)}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
};

// A reported Feed post is read here, from BIES's relay: public Nostr viewers
// (njump.me) can't read that relay, it's members only.
const isNoteId = (id) => typeof id === 'string' && /^[0-9a-f]{64}$/i.test(id);
const NOTE_WAIT_MS = 8000;

// The relay asks who's reading (NIP-42); never with a signer that needs a tap
// (Amber), as nostrService's handleRelayAuth.
const relayAuth = async (evt) => {
    if (!nostrSigner.canSignSilently) return undefined;
    try { return await nostrSigner.signEvent(evt); } catch { return undefined; }
};

/**
 * The post from BIES's relay: the event, or null when the relay says it
 * hasn't got it (removed already). Rejects when the relay doesn't answer
 * within 8 s, or the connection or its sign-in fails.
 */
function fetchReportedNote(id) {
    return new Promise((resolve, reject) => {
        let done = false;
        let sub = null;
        const finish = (settle) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            sub?.close();
            settle();
        };
        const timer = setTimeout(() => finish(() => reject(new Error('no answer'))), NOTE_WAIT_MS);
        sub = nostrService.pool.subscribeMany([nostrService.biesRelay], { ids: [id], limit: 1 }, {
            onevent: (event) => {
                if (event.id === id && event.kind === 1) finish(() => resolve(event));
            },
            // A connection that fails is "end of stored events" and then a
            // close, at once: the close says which.
            oneose: () => queueMicrotask(() => finish(() => resolve(null))),
            onclose: () => finish(() => reject(new Error('closed'))),
            onauth: relayAuth,
            // The pool's own "no answer" comes after ours.
            maxWait: NOTE_WAIT_MS + 2000,
        });
        if (done) sub.close();
    });
}

/** Its photos and videos: links in its text, and its imeta tags. */
function mediaOf(event) {
    const { images, otherMedia } = parseNoteContent(event.content);
    const tagged = (event.tags || [])
        .filter((tag) => tag[0] === 'imeta')
        .flatMap((tag) => tag.slice(1).filter((part) => typeof part === 'string' && part.startsWith('url ')).map((part) => part.slice(4).trim()));
    return [...new Set([...images, ...otherMedia.map((m) => m.url), ...tagged])].filter((url) => safeHref(url));
}

/**
 * A reported Feed post, opened under its report: who wrote it, when, its
 * text (as text, never as HTML) and links to its photos (not shown here).
 */
function ReportedNote({ report }) {
    const [state, setState] = useState({ status: 'loading', event: null });
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        let cancelled = false;
        setState({ status: 'loading', event: null });
        fetchReportedNote(report.targetId)
            .then((event) => { if (!cancelled) setState({ status: event ? 'found' : 'missing', event }); })
            .catch(() => { if (!cancelled) setState({ status: 'noAnswer', event: null }); });
        return () => { cancelled = true; };
    }, [report.targetId, attempt]);

    if (state.status === 'loading') {
        return <div className="rep-post muted" role="status"><Loader2 size={16} className="rep-spin" /> Looking for it on BIES's relay…</div>;
    }
    if (state.status === 'missing') {
        return <div className="rep-post muted" role="status">This post isn't on BIES's relay: it may have been removed already.</div>;
    }
    if (state.status === 'noAnswer') {
        return (
            <div className="rep-post muted" role="status">
                BIES's relay didn't answer, so the post can't be shown.
                <button type="button" className="rep-btn rep-retry" onClick={() => setAttempt((n) => n + 1)}>
                    <RotateCcw size={14} /> Try again
                </button>
            </div>
        );
    }
    const { event } = state;
    const member = report.targetUser && report.targetUser.nostrPubkey === event.pubkey ? report.targetUser : null;
    const author = member ? (member.name || 'A member') : report.targetUser?.deleted ? 'A deleted account' : 'Not a BIES member';
    let npub = '';
    try { npub = `${nip19.npubEncode(event.pubkey).slice(0, 16)}…`; } catch { /* not a key */ }
    const text = parseNoteContent(event.content).text;
    const media = mediaOf(event);
    return (
        <div className="rep-post">
            <p className="rep-post-meta">
                <b>{author}</b>
                {npub && <span className="rep-post-key">{npub}</span>}
                <span>· {new Date(event.created_at * 1000).toLocaleString()}</span>
            </p>
            {text ? <p className="rep-post-text">{text}</p> : <p className="rep-post-text muted">(No text)</p>}
            {media.length > 0 && (
                <ul className="rep-post-media">
                    {media.map((url) => (
                        <li key={url}>
                            <a href={safeHref(url)} target="_blank" rel="noopener noreferrer" onClick={(e) => { e.preventDefault(); openExternal(url); }}>
                                {url} <ExternalLink size={12} />
                            </a>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

/**
 * Admin → Reports: what members reported (server/src/services/moderation.service.ts).
 * Look at it, act (remove the listing or recommendation, suspend the member),
 * then close the report with a note on what was done.
 */
const AdminReports = () => {
    const { isAdmin } = useAuth();
    const [status, setStatus] = useState('OPEN');
    const [reports, setReports] = useState([]);
    const [open, setOpen] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [notes, setNotes] = useState({});
    const [busy, setBusy] = useState(null);
    const [openPost, setOpenPost] = useState(null); // the report whose Feed post is open

    const fetchReports = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const res = await adminApi.reports({ status, limit: 50 });
            setReports(res.reports || []);
            setOpen(res.open || 0);
        } catch (err) {
            setError(err.message || 'Failed to load reports');
        } finally {
            setLoading(false);
        }
    }, [status]);

    useEffect(() => { fetchReports(); }, [fetchReports]);

    const run = async (id, action) => {
        setBusy(id);
        setError('');
        try {
            await action();
            await fetchReports();
        } catch (err) {
            setError(err.message || 'That did not work');
        } finally {
            setBusy(null);
        }
    };

    const resolve = (r, next) => run(r.id, () => adminApi.resolveReport(r.id, { status: next, resolution: notes[r.id] ?? r.resolution ?? '' }));

    const REMOVE = {
        listing: { label: 'listing', confirm: 'Remove this listing for good?', action: (r) => adminApi.deleteDirectoryListing(r.targetId) },
        endorsement: { label: 'recommendation', confirm: 'Remove this recommendation for good?', action: (r) => adminApi.deleteEndorsement(r.targetId) },
        // From the BIES relay; copies on other Nostr relays are out of reach.
        note: { label: 'post', confirm: 'Remove this post from the BIES relay?', action: (r) => adminApi.removeReportedNote(r.id) },
        // Deleting an event is for admins (as on the event page).
        ...(isAdmin ? { event: { label: 'event', confirm: 'Delete this event for good?', action: (r) => eventsApi.delete(r.targetId) } } : {}),
        album: { label: 'album', confirm: 'Delete this album and its photos for good?', action: (r) => albumsApi.delete(r.targetId) },
        // The report's link is the photo's album (/albums/:id).
        photo: { label: 'photo', confirm: 'Delete this photo for good?', action: (r) => albumsApi.deletePhoto(r.link.split('/').pop(), r.targetId) },
        talent: { label: 'talent', confirm: 'Remove this talent and its proof of work for good?', action: (r) => talentApi.delete(r.targetId) },
        opportunity: { label: 'opportunity', confirm: 'Remove this opportunity and its photos for good?', action: (r) => projectsApi.delete(r.targetId) },
    };

    const removeContent = (r) => {
        const remove = REMOVE[r.targetType];
        if (!window.confirm(remove.confirm)) return;
        run(r.id, async () => {
            await remove.action(r);
            await adminApi.resolveReport(r.id, { status: 'ACTIONED', resolution: notes[r.id] || `Removed the ${remove.label}.` });
        });
    };

    const suspend = (r) => {
        if (!window.confirm(`Suspend ${r.targetUser.name || 'this member'}? They are signed out everywhere and can't sign in again.`)) return;
        run(r.id, async () => {
            await adminApi.banUser(r.targetUser.id, true);
            await adminApi.resolveReport(r.id, { status: 'ACTIONED', resolution: notes[r.id] || 'Suspended the member.' });
        });
    };

    return (
        <>
            <div className="header">
                <h1>Reports {open > 0 && <span className="rep-open-count">{open} open</span>}</h1>
                <p className="subtitle">What members reported. The terms promise a review within 24 hours.</p>
            </div>

            <div className="rep-tabs" role="tablist">
                {STATUS_TABS.map((tab) => (
                    <button
                        key={tab.value || 'all'}
                        role="tab"
                        aria-selected={status === tab.value}
                        className={`rep-tab ${status === tab.value ? 'active' : ''}`}
                        onClick={() => setStatus(tab.value)}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>

            {error && <div className="rep-error" role="alert">{error}</div>}

            {loading ? (
                <div className="rep-empty"><Loader2 size={24} className="rep-spin" /></div>
            ) : reports.length === 0 ? (
                <div className="rep-empty">
                    <Flag size={28} />
                    <p>{status === 'OPEN' ? 'No open reports.' : 'No reports here.'}</p>
                </div>
            ) : (
                <div className="rep-list">
                    {reports.map((r) => {
                        const late = r.status === 'OPEN' && hoursSince(r.createdAt) >= HOURS_WARN;
                        const removable = REMOVE[r.targetType] && (r.targetType === 'note' || r.link);
                        const canSuspend = isAdmin && r.targetUser && !r.targetUser.isBanned && !r.targetUser.deleted;
                        const working = busy === r.id;
                        // A Feed post opens here, read from BIES's relay (not njump.me).
                        const isNote = r.targetType === 'note' && isNoteId(r.targetId);
                        const postOpen = isNote && openPost === r.id;
                        return (
                            <div key={r.id} className={`rep-card ${late ? 'late' : ''}`}>
                                <div className="rep-top">
                                    <span className="rep-reason">{r.reasonLabel}</span>
                                    <span className="rep-kind">{TARGET_LABELS[r.targetType] || r.targetType}</span>
                                    <span className={`rep-age ${late ? 'late' : ''}`} title={new Date(r.createdAt).toLocaleString()}>
                                        {formatAge(r.createdAt)}
                                    </span>
                                    {r.status !== 'OPEN' && <span className={`rep-status ${r.status.toLowerCase()}`}>{r.status.toLowerCase()}</span>}
                                </div>

                                <p className="rep-target">
                                    {r.target}
                                    {isNote ? (
                                        <button type="button" className="rep-view" aria-expanded={postOpen} onClick={() => setOpenPost(postOpen ? null : r.id)}>
                                            {postOpen ? 'Hide post' : 'View post'} {postOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                                        </button>
                                    ) : r.link && (r.link.startsWith('/')
                                        ? <Link to={r.link} className="rep-view"> View <ExternalLink size={12} /></Link>
                                        : <a href={r.link} className="rep-view" onClick={(e) => { e.preventDefault(); openExternal(r.link); }}> View <ExternalLink size={12} /></a>)}
                                </p>
                                {postOpen && <ReportedNote report={r} />}
                                {r.details && <p className="rep-details">“{r.details}”</p>}
                                <p className="rep-meta">
                                    Reported by {r.reporter ? (r.reporter.name || 'a member') : 'a deleted account'}
                                    {r.targetUser && (
                                        <> · About {r.targetUser.name || 'a member'}
                                            {r.targetUser.isBanned && <span className="rep-flag">suspended</span>}
                                            {r.targetUser.deleted && <span className="rep-flag">deleted</span>}
                                        </>
                                    )}
                                    {!r.targetUser && r.targetType === 'note' && <> · Not a BIES member</>}
                                </p>
                                {r.handledBy && (
                                    <p className="rep-meta">Handled by {r.handledBy.name || 'a moderator'}{r.resolution ? `: ${r.resolution}` : ''}</p>
                                )}

                                {r.status === 'OPEN' ? (
                                    <>
                                        <textarea
                                            className="rep-note"
                                            placeholder="What you did (kept with the report)"
                                            value={notes[r.id] ?? ''}
                                            onChange={(e) => setNotes((prev) => ({ ...prev, [r.id]: e.target.value }))}
                                            maxLength={2000}
                                            rows={2}
                                        />
                                        <div className="rep-actions">
                                            {removable && (
                                                <button className="rep-btn danger" disabled={working} onClick={() => removeContent(r)}>
                                                    <Trash2 size={14} /> Remove {REMOVE[r.targetType].label}
                                                </button>
                                            )}
                                            {canSuspend && (
                                                <button className="rep-btn danger" disabled={working} onClick={() => suspend(r)}>
                                                    <UserX size={14} /> Suspend member
                                                </button>
                                            )}
                                            <button className="rep-btn" disabled={working} onClick={() => resolve(r, 'ACTIONED')}>
                                                <CheckCircle size={14} /> Mark actioned
                                            </button>
                                            <button className="rep-btn" disabled={working} onClick={() => resolve(r, 'DISMISSED')}>
                                                <XCircle size={14} /> Dismiss
                                            </button>
                                            {working && <Loader2 size={16} className="rep-spin" />}
                                        </div>
                                    </>
                                ) : (
                                    <div className="rep-actions">
                                        <button className="rep-btn" disabled={working} onClick={() => resolve(r, 'OPEN')}>
                                            <RotateCcw size={14} /> Reopen
                                        </button>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {!isAdmin && (
                <p className="rep-hint">Suspending a member needs an admin. Ask one, and say so in the note.</p>
            )}

            <style>{`
                .header { margin-bottom: 1.25rem; }
                .header h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 0.25rem; display: flex; align-items: center; gap: 0.6rem; }
                .subtitle { color: var(--color-gray-500); font-size: 0.9rem; }
                .rep-open-count { font-size: 0.8rem; font-weight: 700; color: #b91c1c; background: #fef2f2; padding: 0.15rem 0.55rem; border-radius: 9999px; }
                .rep-tabs { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-bottom: 1rem; }
                .rep-tab { padding: 0.4rem 0.9rem; border-radius: 9999px; border: 1px solid var(--color-gray-200); background: var(--color-surface); color: var(--color-gray-700); font-weight: 600; font-size: 0.85rem; cursor: pointer; }
                .rep-tab.active { background: var(--color-primary); border-color: var(--color-primary); color: #fff; }
                .rep-error { padding: 0.65rem 0.85rem; border-radius: 0.6rem; background: #fef2f2; color: #b91c1c; margin-bottom: 1rem; font-size: 0.9rem; }
                .rep-empty { display: flex; flex-direction: column; align-items: center; gap: 0.5rem; padding: 3rem 1rem; color: var(--color-gray-500); }
                .rep-list { display: flex; flex-direction: column; gap: 0.85rem; }
                .rep-card { border: 1px solid var(--color-gray-200); border-radius: 0.85rem; padding: 1rem; background: var(--color-surface); display: flex; flex-direction: column; gap: 0.5rem; }
                .rep-card.late { border-color: #fca5a5; }
                .rep-top { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
                .rep-reason { font-weight: 700; }
                .rep-kind, .rep-status, .rep-flag { font-size: 0.75rem; font-weight: 600; padding: 0.1rem 0.5rem; border-radius: 9999px; background: var(--color-gray-100); color: var(--color-gray-600); text-transform: capitalize; }
                .rep-status.actioned { background: #f0fdf4; color: #15803d; }
                .rep-flag { margin-left: 0.35rem; background: #fef2f2; color: #b91c1c; }
                .rep-age { margin-left: auto; font-size: 0.8rem; color: var(--color-gray-500); }
                .rep-age.late { color: #b91c1c; font-weight: 700; }
                .rep-target { margin: 0; font-size: 0.95rem; overflow-wrap: anywhere; }
                .rep-view { display: inline-flex; align-items: center; gap: 0.2rem; font-weight: 600; font-size: 0.85rem; color: var(--color-primary); margin-left: 0.35rem; }
                button.rep-view { background: none; border: 0; padding: 0; font-family: inherit; cursor: pointer; }
                .rep-post { display: flex; flex-direction: column; gap: 0.45rem; padding: 0.75rem 0.85rem; border: 1px solid var(--color-gray-200); border-radius: 0.6rem; background: var(--color-gray-50, #f9fafb); font-size: 0.9rem; }
                .rep-post.muted { flex-direction: row; flex-wrap: wrap; align-items: center; gap: 0.5rem; color: var(--color-gray-600); }
                .rep-post-meta { margin: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.4rem; font-size: 0.82rem; color: var(--color-gray-500); }
                .rep-post-meta b { color: var(--color-gray-900); font-size: 0.9rem; }
                .rep-post-key { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.78rem; }
                .rep-post-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--color-gray-900); }
                .rep-post-text.muted { color: var(--color-gray-500); font-style: italic; }
                .rep-post-media { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 0.3rem; }
                .rep-post-media a { display: inline-flex; align-items: center; gap: 0.25rem; max-width: 100%; font-size: 0.82rem; font-weight: 600; color: var(--color-primary); overflow-wrap: anywhere; }
                .rep-retry { padding: 0.25rem 0.65rem; }
                .rep-details { margin: 0; font-size: 0.9rem; color: var(--color-gray-700); white-space: pre-wrap; overflow-wrap: anywhere; }
                .rep-meta { margin: 0; font-size: 0.82rem; color: var(--color-gray-500); }
                .rep-note { width: 100%; box-sizing: border-box; padding: 0.55rem 0.7rem; border: 1px solid var(--color-gray-200); border-radius: 0.6rem; font: inherit; font-size: 0.9rem; resize: vertical; background: var(--color-surface); color: inherit; }
                .rep-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
                .rep-btn { display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.4rem 0.8rem; border-radius: 9999px; border: 1px solid var(--color-gray-300); background: var(--color-surface); color: var(--color-gray-700); font-size: 0.82rem; font-weight: 600; cursor: pointer; }
                .rep-btn:disabled { opacity: 0.55; cursor: not-allowed; }
                .rep-btn.danger { border-color: #fca5a5; color: #b91c1c; }
                .rep-hint { margin-top: 1rem; font-size: 0.82rem; color: var(--color-gray-500); }
                .rep-spin { animation: rep-spin 1s linear infinite; }
                @keyframes rep-spin { to { transform: rotate(360deg); } }
            `}</style>
        </>
    );
};

export default AdminReports;
