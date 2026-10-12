import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Flag, Loader2, Pencil, ThumbsDown, ThumbsUp, Trash2 } from 'lucide-react';
import { directoryApi } from '../../services/api';
import { getAssetUrl } from '../../utils/assets';
import TranslatableText from '../TranslatableText';
import CertifiedBadge from './CertifiedBadge';
import { objectionableMessage } from '../moderation/objectionable';

// The server's DOWNVOTE_REASON_MIN (directory.controller.ts).
const REASON_MIN = 20;

/**
 * The BIES Trust Score of a listing: vouches minus downvotes, how far it is
 * from BIES Trusted, and how the score works.
 */
export function TrustPanel({ listing }) {
    const { t } = useTranslation();
    const threshold = listing.trustedThreshold || 5;
    const score = listing.reputationScore ?? 0;
    const vouches = listing.vouchCount ?? 0;
    const downvotes = listing.downvoteCount ?? 0;
    const progress = Math.max(0, Math.min(1, score / threshold));

    return (
        <section className="dir-trust" aria-label={t('directory.reputation')}>
            <div className="dir-trust-top">
                <div className={`dir-trust-score${score < 0 ? ' negative' : ''}`}>{score > 0 ? `+${score}` : score}</div>
                <div className="dir-trust-text">
                    <div className="dir-trust-title">{t('directory.reputation')}</div>
                    <div className="dir-trust-counts">
                        <span className="up"><ThumbsUp size={14} /> {t('directory.trust.vouches', { count: vouches })}</span>
                        <span className="down"><ThumbsDown size={14} /> {t('directory.trust.downvotes', { count: downvotes })}</span>
                    </div>
                </div>
            </div>
            {listing.isCertified ? (
                <div className="dir-trust-trusted">
                    <CertifiedBadge size="md" />
                    <span>{t('directory.trust.trusted')}</span>
                </div>
            ) : (
                <>
                    <div
                        className="dir-trust-bar"
                        role="progressbar"
                        aria-label={t('directory.certifiedBadge')}
                        aria-valuemin={0}
                        aria-valuemax={threshold}
                        aria-valuenow={Math.max(0, score)}
                    >
                        <span style={{ width: `${progress * 100}%` }} />
                    </div>
                    <p className="dir-trust-note">{t('directory.trust.toGo', { count: Math.max(1, threshold - score) })}</p>
                </>
            )}
            <p className="dir-trust-how">{t('directory.trust.how', { threshold })}</p>

            <style jsx>{`
                .dir-trust {
                    margin: 0 0 1.75rem;
                    padding: 1rem 1.1rem;
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-lg, 14px);
                    background: var(--color-surface);
                }
                .dir-trust-top {
                    display: flex;
                    align-items: center;
                    gap: 0.9rem;
                }
                .dir-trust-score {
                    min-width: 3.4rem;
                    height: 3.4rem;
                    padding: 0 0.5rem;
                    border-radius: 999px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background: var(--color-blue-tint);
                    color: var(--color-primary);
                    font-size: 1.45rem;
                    font-weight: 800;
                    flex-shrink: 0;
                }
                .dir-trust-score.negative {
                    background: var(--color-red-tint);
                    color: var(--color-error);
                }
                .dir-trust-text { min-width: 0; }
                .dir-trust-title {
                    font-size: 1.05rem;
                    font-weight: 700;
                }
                .dir-trust-counts {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 0.25rem 0.9rem;
                    margin-top: 0.2rem;
                    font-size: 0.85rem;
                    color: var(--color-gray-600);
                }
                .dir-trust-counts span {
                    display: inline-flex;
                    align-items: center;
                    gap: 5px;
                }
                .dir-trust-counts .up { color: var(--color-success, #15803d); }
                .dir-trust-counts .down { color: var(--color-gray-600); }
                .dir-trust-trusted {
                    display: flex;
                    flex-wrap: wrap;
                    align-items: center;
                    gap: 0.5rem 0.75rem;
                    margin-top: 0.9rem;
                    font-size: 0.88rem;
                    color: var(--color-gray-700);
                }
                .dir-trust-bar {
                    height: 8px;
                    margin-top: 0.9rem;
                    border-radius: 999px;
                    background: var(--color-gray-100);
                    overflow: hidden;
                }
                .dir-trust-bar span {
                    display: block;
                    height: 100%;
                    border-radius: 999px;
                    background: var(--color-secondary);
                }
                .dir-trust-note {
                    margin: 0.45rem 0 0;
                    font-size: 0.85rem;
                    font-weight: 600;
                    color: var(--color-gray-700);
                }
                .dir-trust-how {
                    margin: 0.6rem 0 0;
                    font-size: 0.78rem;
                    line-height: 1.5;
                    color: var(--color-gray-500);
                }
            `}</style>
        </section>
    );
}

/**
 * Members' reviews of a listing. Each is a vouch or a downvote; a downvote
 * must say why. One per member, which they can change or remove. Whoever runs
 * the business can't review it, and reviews open once staff approve it.
 *
 * @param {() => void} onChanged  refresh the listing (scores and reviews)
 * @param {(target, opts) => void} openReport  the page's Report dialog
 */
export default function ListingReviews({ listing, user, onChanged, openReport, titleStyle }) {
    const { t, i18n } = useTranslation();
    const [mode, setMode] = useState(null); // 1 (vouch) | -1 (downvote) | null
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const reviews = Array.isArray(listing.endorsements) ? listing.endorsements : [];
    const mine = user?.id ? reviews.find((r) => r.userId === user.id) : null;
    // Mine first, then the member who added it, then newest.
    const ordered = [...reviews].sort((a, b) => {
        const rank = (r) => (r === mine ? 0 : r.userId === listing.ownerId ? 1 : 2);
        return rank(a) - rank(b) || new Date(b.createdAt) - new Date(a.createdAt);
    });

    const runsIt = !!user?.id && (listing.memberUserId === user.id || (listing.isOwnBusiness && listing.ownerId === user.id));
    const live = listing.status === 'active';
    const canReview = !!user?.id && !runsIt && live;
    const name = listing.name;

    const start = (vote) => {
        setMode(vote);
        setText(mine && mine.vote === vote ? mine.comment || '' : '');
        setError('');
    };
    const cancel = () => { setMode(null); setText(''); setError(''); };

    const reasonShort = mode === -1 && text.trim().length < REASON_MIN;

    const submit = async () => {
        if (reasonShort) {
            setError(t('directory.review.reasonRequired', { min: REASON_MIN }));
            return;
        }
        setBusy(true);
        setError('');
        try {
            await directoryApi.endorse(listing.id, { vote: mode, comment: text.trim() });
            cancel();
            await onChanged();
        } catch (err) {
            const reason = err?.data?.reason;
            setError(
                reason === 'reason_required' ? t('directory.review.reasonRequired', { min: REASON_MIN })
                    : reason === 'own_business' ? t('directory.review.cantReviewOwn')
                        : reason === 'not_live' ? t('directory.review.notLive')
                            : objectionableMessage(t, err) || err?.message || String(err),
            );
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        setBusy(true);
        setError('');
        try {
            await directoryApi.unendorse(listing.id);
            await onChanged();
        } catch (err) {
            setError(err?.message || String(err));
        } finally {
            setBusy(false);
        }
    };

    const date = (iso) => new Date(iso).toLocaleDateString(i18n.language, { day: 'numeric', month: 'short', year: 'numeric' });
    const edited = (r) => r.updatedAt && new Date(r.updatedAt) - new Date(r.createdAt) > 60_000;

    return (
        <section className="dir-detail-section dir-reviews">
            <h2 style={titleStyle}>{t('directory.endorsements')} ({reviews.length})</h2>

            {runsIt && <p className="dir-review-note">{t('directory.review.cantReviewOwn')}</p>}
            {!runsIt && !live && <p className="dir-review-note">{t('directory.review.notLive')}</p>}

            {canReview && !mine && mode === null && (
                <div className="dir-review-choice">
                    <button type="button" className="dir-vote-btn up" onClick={() => start(1)}>
                        <ThumbsUp size={16} /> {t('directory.review.vouch')}
                    </button>
                    <button type="button" className="dir-vote-btn down" onClick={() => start(-1)}>
                        <ThumbsDown size={16} /> {t('directory.review.downvote')}
                    </button>
                </div>
            )}

            {mode !== null && (
                <div className={`dir-review-form ${mode === 1 ? 'up' : 'down'}`}>
                    <label className="dir-review-form-title" htmlFor="dir-review-text">
                        {mode === 1 ? <ThumbsUp size={16} /> : <ThumbsDown size={16} />}
                        {mode === 1 ? t('directory.review.vouchTitle', { name }) : t('directory.review.downvoteTitle', { name })}
                    </label>
                    <textarea
                        id="dir-review-text"
                        className="dir-review-textarea"
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        placeholder={mode === 1 ? t('directory.endorsePlaceholder') : t('directory.review.downvotePlaceholder')}
                        maxLength={1000}
                        rows={mode === 1 ? 3 : 4}
                        aria-describedby={mode === -1 ? 'dir-review-count' : undefined}
                        autoFocus
                    />
                    {mode === -1 && (
                        <p id="dir-review-count" className={`dir-review-count${reasonShort ? '' : ' ok'}`}>
                            {t('directory.review.reasonCount', { count: text.trim().length, min: REASON_MIN })}
                        </p>
                    )}
                    {error && <p className="dir-review-error" role="alert">{error}</p>}
                    <div className="dir-review-actions">
                        <button type="button" className="dir-review-cancel" onClick={cancel} disabled={busy}>
                            {t('common.cancel')}
                        </button>
                        <button type="button" className="dir-review-submit" onClick={submit} disabled={busy || reasonShort}>
                            {busy && <Loader2 size={14} className="dir-spin" />}
                            {mine ? t('directory.review.update') : t('directory.review.post')}
                        </button>
                    </div>
                </div>
            )}

            {error && mode === null && <p className="dir-review-error" role="alert">{error}</p>}

            {ordered.length === 0 ? (
                <p className="dir-review-empty">{t('directory.noEndorsements')}</p>
            ) : (
                <ul className="dir-review-list">
                    {ordered.map((r) => {
                        const who = r.user?.profile?.name || 'Member';
                        const avatar = r.user?.profile?.avatar || '';
                        const isMine = r === mine;
                        return (
                            <li key={r.id} className="dir-review">
                                <div className="dir-review-avatar">
                                    {avatar ? <img src={getAssetUrl(avatar)} alt="" /> : <span>{who[0].toUpperCase()}</span>}
                                </div>
                                <div className="dir-review-body">
                                    <div className="dir-review-head">
                                        <span className="dir-review-name">{isMine ? t('directory.review.yourReview') : who}</span>
                                        <span className={`dir-review-vote ${r.vote < 0 ? 'down' : 'up'}`}>
                                            {r.vote < 0 ? <ThumbsDown size={12} /> : <ThumbsUp size={12} />}
                                            {r.vote < 0 ? t('directory.review.downvoted') : t('directory.review.vouched')}
                                        </span>
                                    </div>
                                    <div className="dir-review-meta">
                                        {date(r.createdAt)}
                                        {edited(r) && ` · ${t('directory.review.edited')}`}
                                        {r.userId === listing.ownerId && !listing.isOwnBusiness && ` · ${t('directory.review.addedListing')}`}
                                    </div>
                                    {r.comment && (
                                        <TranslatableText
                                            text={r.comment}
                                            style={{ marginTop: '0.3rem', fontSize: '0.9rem', lineHeight: 1.55, color: 'var(--color-gray-700)', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}
                                        />
                                    )}
                                    {isMine && mode === null && (
                                        <div className="dir-review-own-actions">
                                            <button type="button" onClick={() => start(r.vote)} disabled={busy}>
                                                <Pencil size={13} /> {t('directory.review.edit')}
                                            </button>
                                            <button type="button" onClick={() => start(r.vote < 0 ? 1 : -1)} disabled={busy}>
                                                {r.vote < 0 ? <ThumbsUp size={13} /> : <ThumbsDown size={13} />}
                                                {r.vote < 0 ? t('directory.review.vouch') : t('directory.review.downvote')}
                                            </button>
                                            <button type="button" onClick={remove} disabled={busy}>
                                                <Trash2 size={13} /> {t('directory.review.remove')}
                                            </button>
                                        </div>
                                    )}
                                    {!isMine && user?.id && (
                                        <button
                                            type="button"
                                            className="mod-inline-report"
                                            onClick={() => openReport({ type: 'endorsement', id: r.id }, { name: who, blockTarget: { userId: r.userId } })}
                                        >
                                            <Flag size={12} /> {t('moderation.menu.report')}
                                        </button>
                                    )}
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}

            <style jsx>{`
                /* The page's .dir-detail-section spacing is scoped to the page */
                .dir-reviews { margin-top: 1.75rem; }
                .dir-review-note {
                    margin: 0 0 1rem;
                    font-size: 0.88rem;
                    color: var(--color-gray-500);
                }
                .dir-review-choice {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 0.6rem;
                    margin-bottom: 1rem;
                }
                .dir-vote-btn {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    gap: 7px;
                    padding: 0.7rem 0.8rem;
                    border-radius: 999px;
                    font-size: 0.92rem;
                    font-weight: 600;
                    cursor: pointer;
                    background: var(--color-surface);
                }
                .dir-vote-btn.up {
                    border: 1px solid var(--color-primary);
                    color: var(--color-primary);
                }
                .dir-vote-btn.up:hover { background: var(--color-blue-tint); }
                .dir-vote-btn.down {
                    border: 1px solid var(--color-gray-300);
                    color: var(--color-gray-700);
                }
                .dir-vote-btn.down:hover { background: var(--color-gray-50); }
                .dir-review-form {
                    margin-bottom: 1.1rem;
                    padding: 0.9rem;
                    border-radius: 12px;
                    border: 1px solid var(--color-gray-200);
                    background: var(--color-gray-50);
                }
                .dir-review-form.down { border-color: var(--badge-error-bg, #fecaca); }
                .dir-review-form-title {
                    display: flex;
                    align-items: center;
                    gap: 7px;
                    margin-bottom: 0.55rem;
                    font-size: 0.95rem;
                    font-weight: 700;
                }
                .dir-review-textarea {
                    width: 100%;
                    box-sizing: border-box;
                    padding: 0.65rem 0.85rem;
                    border: 1px solid var(--color-gray-300);
                    border-radius: 10px;
                    background: var(--color-surface);
                    color: inherit;
                    font-size: 0.92rem;
                    font-family: inherit;
                    line-height: 1.5;
                    resize: vertical;
                    outline: none;
                }
                .dir-review-textarea:focus { border-color: var(--color-primary); }
                .dir-review-count {
                    margin: 0.35rem 0 0;
                    font-size: 0.78rem;
                    color: var(--color-error);
                }
                .dir-review-count.ok { color: var(--color-gray-500); }
                .dir-review-error {
                    margin: 0.5rem 0;
                    font-size: 0.85rem;
                    color: var(--color-error);
                }
                .dir-review-actions {
                    display: flex;
                    justify-content: flex-end;
                    gap: 0.5rem;
                    margin-top: 0.65rem;
                }
                .dir-review-cancel,
                .dir-review-submit {
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                    padding: 0.5rem 1.1rem;
                    border-radius: 999px;
                    font-size: 0.88rem;
                    font-weight: 600;
                    cursor: pointer;
                }
                .dir-review-cancel {
                    border: 1px solid var(--color-gray-300);
                    background: var(--color-surface);
                    color: var(--color-gray-700);
                }
                .dir-review-submit {
                    border: none;
                    background: var(--color-primary);
                    color: white;
                }
                .dir-review-submit:disabled,
                .dir-review-cancel:disabled { opacity: 0.55; cursor: default; }
                .dir-review-empty {
                    margin: 0;
                    font-size: 0.9rem;
                    color: var(--color-gray-500);
                }
                .dir-review-list {
                    list-style: none;
                    margin: 0;
                    padding: 0;
                }
                .dir-review {
                    display: flex;
                    align-items: flex-start;
                    gap: 0.75rem;
                    padding: 0.9rem 0;
                }
                .dir-review + .dir-review { border-top: 1px solid var(--color-gray-200); }
                .dir-review-avatar {
                    width: 38px;
                    height: 38px;
                    border-radius: 50%;
                    overflow: hidden;
                    flex-shrink: 0;
                    background: var(--color-blue-tint);
                    color: var(--color-primary);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 0.9rem;
                    font-weight: 700;
                }
                .dir-review-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
                .dir-review-body { flex: 1; min-width: 0; }
                .dir-review-head {
                    display: flex;
                    flex-wrap: wrap;
                    align-items: center;
                    gap: 0.3rem 0.5rem;
                }
                .dir-review-name { font-size: 0.92rem; font-weight: 600; }
                .dir-review-vote {
                    display: inline-flex;
                    align-items: center;
                    gap: 4px;
                    padding: 1px 8px;
                    border-radius: 999px;
                    font-size: 0.72rem;
                    font-weight: 700;
                }
                .dir-review-vote.up { background: var(--color-green-tint); color: var(--badge-success-text, #15803d); }
                .dir-review-vote.down { background: var(--color-red-tint); color: var(--color-error); }
                .dir-review-meta {
                    margin-top: 0.1rem;
                    font-size: 0.78rem;
                    color: var(--color-gray-500);
                }
                .dir-review-own-actions {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 0.4rem 1rem;
                    margin-top: 0.45rem;
                }
                .dir-review-own-actions button {
                    display: inline-flex;
                    align-items: center;
                    gap: 5px;
                    padding: 0;
                    border: none;
                    background: none;
                    color: var(--color-primary);
                    font-size: 0.82rem;
                    font-weight: 600;
                    cursor: pointer;
                }
                .dir-review-own-actions button:disabled { opacity: 0.55; cursor: default; }
                .dir-reviews :global(.dir-spin) { animation: dir-review-spin 1s linear infinite; }
                @keyframes dir-review-spin { to { transform: rotate(360deg); } }
            `}</style>
        </section>
    );
}
