import React, { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
    ArrowLeft, Zap, Trophy, Star, Clock, Loader2, AlertCircle,
    CheckCircle, XCircle, Undo2, Edit3, Send, Target,
} from 'lucide-react';
import { bountiesApi } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { getAssetUrl } from '../utils/assets';
import ZapModal from '../components/ZapModal';

// Presence check works with either an explicit flag or the raw address
const hasLightning = (u) => !!(u?.hasLightningAddress || u?.profile?.lightningAddress);

/**
 * Bounty detail page: full description, submissions list with per-submission
 * award action for the poster, submission create/edit form while OPEN, and
 * the SATS payout panel (Pay now via ZapModal / mark paid / un-award).
 */
const BountyDetail = () => {
    const { id } = useParams();
    const { t } = useTranslation();
    const { user } = useAuth();

    const [bounty, setBounty] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    const [showSubmissionForm, setShowSubmissionForm] = useState(false);
    const [submissionText, setSubmissionText] = useState('');
    const [submissionBusy, setSubmissionBusy] = useState(false);
    const [submissionError, setSubmissionError] = useState('');

    const [actionBusy, setActionBusy] = useState(false);
    const [actionError, setActionError] = useState('');
    const [showZapModal, setShowZapModal] = useState(false);

    // silent=true refreshes in place (after actions) without the full-page loader
    const fetchBounty = useCallback(async ({ silent = false } = {}) => {
        if (!silent) {
            setLoading(true);
            setError(null);
        }
        try {
            const res = await bountiesApi.get(id);
            setBounty(res?.data || res);
        } catch (err) {
            if (!silent) setError(err.message || 'Failed to load bounty');
        } finally {
            if (!silent) setLoading(false);
        }
    }, [id]);

    useEffect(() => { fetchBounty(); }, [fetchBounty]);

    if (loading) {
        return (
            <div className="container" style={{ textAlign: 'center', padding: '4rem 0' }}>
                <Loader2 size={32} style={{ animation: 'spin 1s linear infinite', margin: '0 auto', color: 'var(--color-gray-500)' }} />
            </div>
        );
    }

    if (error || !bounty) {
        return (
            <div className="container">
                <div style={{ textAlign: 'center', padding: '4rem 0' }}>
                    <h2>{t('bounties.notFound')}</h2>
                    <p style={{ color: 'var(--color-gray-500)', margin: '0.5rem 0' }}>{error}</p>
                    <Link
                        to="/bounties"
                        style={{ marginTop: '1.5rem', display: 'inline-flex', alignItems: 'center', gap: 8, textDecoration: 'none', fontWeight: 500, color: 'var(--color-primary)' }}
                    >
                        <ArrowLeft size={16} /> {t('bounties.backToBounties')}
                    </Link>
                </div>
            </div>
        );
    }

    const isPoster = !!user?.id && bounty.posterId === user.id;
    const isSats = bounty.rewardType === 'SATS';
    const isOpen = bounty.status === 'OPEN';
    const submissions = Array.isArray(bounty.submissions) ? bounty.submissions : [];
    const mySubmission = user?.id ? submissions.find((s) => s.userId === user.id) : null;
    const canSubmit = !!user?.id && !isPoster && isOpen;

    const winner = bounty.winnerSubmission
        || (bounty.winnerSubmissionId ? submissions.find((s) => s.id === bounty.winnerSubmissionId) : null);
    const winnerUser = winner?.user;
    const winnerName = winnerUser?.profile?.name || t('bounties.member');
    const zapRecipients = winnerUser?.nostrPubkey
        ? [{
            pubkey: winnerUser.nostrPubkey,
            name: winnerName,
            avatar: winnerUser.profile?.avatar || '',
            lud16: winnerUser.profile?.lightningAddress || '',
        }]
        : [];

    const posterName = bounty.poster?.profile?.name || t('bounties.member');
    const posterAvatar = bounty.poster?.profile?.avatar || '';
    const deadlineOverdue = isOpen && bounty.deadline && new Date(bounty.deadline) < new Date();

    const openSubmissionForm = () => {
        setSubmissionText(mySubmission?.content || '');
        setSubmissionError('');
        setShowSubmissionForm(true);
    };

    const handleSubmitWork = async () => {
        const content = submissionText.trim();
        if (!content) {
            setSubmissionError(t('bounties.submissionRequired'));
            return;
        }
        setSubmissionBusy(true);
        setSubmissionError('');
        try {
            if (mySubmission) await bountiesApi.updateSubmission(id, content);
            else await bountiesApi.submit(id, content);
            setShowSubmissionForm(false);
            setSubmissionText('');
            await fetchBounty({ silent: true });
        } catch (err) {
            setSubmissionError(err.message || t('bounties.submissionFailed'));
        } finally {
            setSubmissionBusy(false);
        }
    };

    const runAction = async (fn, failKey) => {
        setActionBusy(true);
        setActionError('');
        try {
            await fn();
            await fetchBounty({ silent: true });
        } catch (err) {
            setActionError(err.message || t(failKey));
        } finally {
            setActionBusy(false);
        }
    };

    const handleAward = (submission) => {
        const name = submission.user?.profile?.name || t('bounties.member');
        const confirmMsg = isSats
            ? t('bounties.awardConfirmSats', { name, amount: bounty.amount })
            : t('bounties.awardConfirmPoints', { name, amount: bounty.amount });
        if (!window.confirm(confirmMsg)) return;
        runAction(() => bountiesApi.award(id, submission.id), 'bounties.awardFailed');
    };

    const handleCancel = () => {
        const confirmMsg = isSats
            ? t('bounties.cancelConfirm')
            : t('bounties.cancelConfirmPoints', { amount: bounty.amount });
        if (!window.confirm(confirmMsg)) return;
        runAction(() => bountiesApi.cancel(id), 'bounties.cancelFailed');
    };

    const handleUnaward = () => {
        if (!window.confirm(t('bounties.unawardConfirm'))) return;
        runAction(() => bountiesApi.unaward(id), 'bounties.unawardFailed');
    };

    const handleMarkPaid = () => {
        if (!window.confirm(t('bounties.markPaidConfirm'))) return;
        runAction(() => bountiesApi.markPaid(id, 'MANUAL'), 'bounties.markPaidFailed');
    };

    // Called by ZapModal with 'paid' after a successful wallet payment of the
    // full (fixed) bounty amount — best-effort: the poster can always fall
    // back to "Mark as paid". The 'qr' status only means an invoice was
    // shown, not that it was settled, so it never auto-marks.
    const handleZapPaid = (status) => {
        if (status !== 'paid') return;
        bountiesApi.markPaid(id, 'WALLET')
            .then(() => fetchBounty({ silent: true }))
            .catch(() => setActionError(t('bounties.markPaidFailed')));
    };

    return (
        <div className="bounty-detail-page">
            <div className="container">
                <div className="bounty-detail-content">
                    <Link to="/bounties" className="bounty-back-link">
                        <ArrowLeft size={18} /> {t('bounties.backToBounties')}
                    </Link>

                    {actionError && (
                        <div className="bounty-error-banner"><AlertCircle size={16} /> {actionError}</div>
                    )}

                    {/* Header */}
                    <div className="bounty-detail-head">
                        <div className="bounty-badges">
                            <span className={`bounty-status ${bounty.status.toLowerCase()}`}>
                                {t(`bounties.status.${bounty.status.toLowerCase()}`)}
                            </span>
                            {bounty.featured && (
                                <span className="bounty-featured-badge">
                                    <Star size={12} fill="currentColor" /> {t('bounties.featured')}
                                </span>
                            )}
                            <span className={`bounty-reward ${isSats ? 'sats' : 'points'}`}>
                                {isSats ? <Zap size={15} /> : <Trophy size={15} />}
                                {Number(bounty.amount).toLocaleString()} {isSats ? t('bounties.sats') : t('bounties.points')}
                            </span>
                        </div>

                        <h1 className="bounty-detail-title">{bounty.title}</h1>

                        <div className="bounty-poster-row">
                            <span className="bounty-avatar">
                                {posterAvatar
                                    ? <img src={getAssetUrl(posterAvatar)} alt={posterName} />
                                    : <span>{posterName[0]?.toUpperCase()}</span>}
                            </span>
                            <span className="bounty-poster-name">{posterName}</span>
                            <span className="bounty-posted-date">
                                {t('bounties.postedOn', { date: new Date(bounty.createdAt).toLocaleDateString() })}
                            </span>
                        </div>

                        {bounty.deadline && (
                            <div className={`bounty-deadline ${deadlineOverdue ? 'overdue' : ''}`}>
                                <Clock size={15} />
                                {t('bounties.deadline', { date: new Date(bounty.deadline).toLocaleDateString() })}
                            </div>
                        )}
                    </div>

                    {/* Description — plain text, preserved whitespace */}
                    <section className="bounty-section">
                        <p className="bounty-description">{bounty.description}</p>
                    </section>

                    {/* Poster actions */}
                    {isPoster && isOpen && (
                        <div className="bounty-poster-actions">
                            <button
                                type="button"
                                className="bounty-btn danger-outline"
                                onClick={handleCancel}
                                disabled={actionBusy}
                            >
                                <XCircle size={15} /> {t('bounties.cancelBounty')}
                            </button>
                        </div>
                    )}

                    {/* SATS payout panel — persists until the winner is paid */}
                    {isPoster && isSats && bounty.status === 'AWARDED' && (
                        <div className="bounty-pay-panel">
                            <p className="bounty-pay-hint">
                                <Trophy size={15} style={{ color: '#eab308', flexShrink: 0 }} />
                                {t('bounties.payPanelHint', { name: winnerName, amount: bounty.amount })}
                            </p>
                            <div className="bounty-pay-actions">
                                <button
                                    type="button"
                                    className="bounty-btn zap"
                                    onClick={() => setShowZapModal(true)}
                                    disabled={actionBusy || zapRecipients.length === 0}
                                    title={zapRecipients.length === 0 ? t('bounties.winnerNoPubkey') : undefined}
                                >
                                    <Zap size={15} /> {t('bounties.payNow')}
                                </button>
                                <button
                                    type="button"
                                    className="bounty-btn outline"
                                    onClick={handleMarkPaid}
                                    disabled={actionBusy}
                                >
                                    <CheckCircle size={15} /> {t('bounties.markPaid')}
                                </button>
                                <button
                                    type="button"
                                    className="bounty-btn outline"
                                    onClick={handleUnaward}
                                    disabled={actionBusy}
                                >
                                    <Undo2 size={15} /> {t('bounties.unaward')}
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Submissions */}
                    <section className="bounty-section">
                        <div className="bounty-submissions-head">
                            <h2 className="bounty-section-title">
                                {t('bounties.submissions')} ({submissions.length})
                            </h2>
                            {canSubmit && !showSubmissionForm && (
                                <button type="button" className="bounty-btn primary" onClick={openSubmissionForm}>
                                    {mySubmission
                                        ? <><Edit3 size={15} /> {t('bounties.editSubmission')}</>
                                        : <><Send size={15} /> {t('bounties.submitWork')}</>}
                                </button>
                            )}
                        </div>

                        {showSubmissionForm && (
                            <div className="bounty-submission-form">
                                {isSats && !hasLightning(user) && (
                                    <div className="bounty-warn-banner">
                                        <AlertCircle size={15} />
                                        {t('bounties.noLightningWarn')}
                                    </div>
                                )}
                                <textarea
                                    className="bounty-textarea"
                                    value={submissionText}
                                    onChange={(e) => setSubmissionText(e.target.value)}
                                    placeholder={t('bounties.submissionPlaceholder')}
                                    rows={4}
                                    maxLength={5000}
                                />
                                {submissionError && (
                                    <p className="bounty-inline-error">{submissionError}</p>
                                )}
                                <div className="bounty-form-actions">
                                    <button
                                        type="button"
                                        className="bounty-btn outline"
                                        onClick={() => { setShowSubmissionForm(false); setSubmissionError(''); }}
                                        disabled={submissionBusy}
                                    >
                                        {t('common.cancel')}
                                    </button>
                                    <button
                                        type="button"
                                        className="bounty-btn primary"
                                        onClick={handleSubmitWork}
                                        disabled={submissionBusy || !submissionText.trim()}
                                    >
                                        {submissionBusy && <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />}
                                        {mySubmission ? t('bounties.updateSubmission') : t('bounties.sendSubmission')}
                                    </button>
                                </div>
                            </div>
                        )}

                        {submissions.length === 0 ? (
                            <div className="bounty-no-submissions">
                                <Target size={28} style={{ opacity: 0.4 }} />
                                <p>{t('bounties.noSubmissions')}</p>
                            </div>
                        ) : (
                            <div className="bounty-submission-list">
                                {submissions.map((s) => {
                                    const subUser = s.user;
                                    const subName = subUser?.profile?.name || t('bounties.member');
                                    const subAvatar = subUser?.profile?.avatar || '';
                                    const isWinner = s.id === bounty.winnerSubmissionId;
                                    return (
                                        <div key={s.id} className={`bounty-submission ${isWinner ? 'winner' : ''}`}>
                                            <span className="bounty-avatar">
                                                {subAvatar
                                                    ? <img src={getAssetUrl(subAvatar)} alt={subName} />
                                                    : <span>{subName[0]?.toUpperCase()}</span>}
                                            </span>
                                            <div className="bounty-submission-body">
                                                <div className="bounty-submission-meta">
                                                    <span className="bounty-submission-name">{subName}</span>
                                                    {hasLightning(subUser) && (
                                                        <Zap size={13} style={{ color: '#f7931a', flexShrink: 0 }} title={t('bounties.hasLightning')} />
                                                    )}
                                                    {isWinner && (
                                                        <span className="bounty-winner-badge">
                                                            <Trophy size={12} /> {t('bounties.winner')}
                                                        </span>
                                                    )}
                                                    <span className="bounty-submission-date">
                                                        {new Date(s.createdAt).toLocaleDateString()}
                                                    </span>
                                                </div>
                                                <p className="bounty-submission-content">{s.content}</p>
                                                {isPoster && isOpen && (
                                                    <button
                                                        type="button"
                                                        className="bounty-btn award"
                                                        onClick={() => handleAward(s)}
                                                        disabled={actionBusy}
                                                    >
                                                        <Trophy size={14} /> {t('bounties.award')}
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </section>
                </div>
            </div>

            {showZapModal && zapRecipients.length > 0 && (
                <ZapModal
                    recipients={zapRecipients}
                    eventId={bounty.nostrEventId || undefined}
                    fixedAmount={bounty.amount}
                    onClose={() => setShowZapModal(false)}
                    onPaid={handleZapPaid}
                />
            )}

            <style jsx>{`
                .bounty-detail-page {
                    padding-top: var(--page-top, 1.5rem);
                    padding-bottom: 4rem;
                }

                .bounty-detail-content {
                    max-width: 760px;
                    margin: 0 auto;
                }

                /* Link components don't get the styled-jsx scope hash — anchor
                   these rules on a scoped parent instead (see Leaderboard.jsx) */
                .bounty-detail-content :global(.bounty-back-link) {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.25rem;
                    color: var(--color-gray-500);
                    font-weight: 500;
                    font-size: 0.9rem;
                    text-decoration: none;
                    margin-bottom: 1rem;
                }
                .bounty-detail-content :global(.bounty-back-link:hover) { color: var(--color-primary); }

                .bounty-error-banner {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    padding: 0.75rem 1rem;
                    background: var(--color-red-tint);
                    color: var(--color-error, #B91C1C);
                    border-radius: var(--radius-md);
                    margin-bottom: 1rem;
                    font-size: 0.9rem;
                }

                .bounty-detail-head {
                    margin-bottom: 1.25rem;
                }

                .bounty-badges {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    flex-wrap: wrap;
                    margin-bottom: 0.75rem;
                }

                .bounty-status {
                    display: inline-block;
                    font-size: 0.7rem;
                    padding: 2px 8px;
                    border-radius: 99px;
                    font-weight: 600;
                    text-transform: uppercase;
                }
                .bounty-status.open { background: var(--color-green-tint); color: var(--badge-success-text); }
                .bounty-status.awarded { background: var(--color-amber-tint); color: var(--badge-warning-text); }
                .bounty-status.paid { background: var(--color-blue-tint); color: var(--color-primary); }
                .bounty-status.expired { background: var(--badge-draft-bg); color: var(--color-gray-600); }
                .bounty-status.cancelled { background: var(--color-red-tint); color: #dc2626; }

                .bounty-featured-badge {
                    display: inline-flex;
                    align-items: center;
                    gap: 3px;
                    font-size: 0.7rem;
                    padding: 2px 8px;
                    border-radius: 99px;
                    font-weight: 600;
                    text-transform: uppercase;
                    background: rgba(234, 179, 8, 0.12);
                    color: #a16207;
                }

                .bounty-reward {
                    display: inline-flex;
                    align-items: center;
                    gap: 4px;
                    margin-left: auto;
                    padding: 0.35rem 0.85rem;
                    border-radius: var(--radius-full);
                    font-size: 0.9rem;
                    font-weight: 700;
                    white-space: nowrap;
                }
                .bounty-reward.sats { background: rgba(247, 147, 26, 0.1); color: #f7931a; }
                .bounty-reward.points { background: var(--color-blue-tint); color: var(--color-primary); }

                .bounty-detail-title {
                    font-size: 1.6rem;
                    font-weight: 800;
                    margin: 0 0 0.6rem;
                    line-height: 1.25;
                    overflow-wrap: break-word;
                }

                .bounty-poster-row {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    margin-bottom: 0.4rem;
                    font-size: 0.9rem;
                }
                .bounty-poster-name { font-weight: 600; }
                .bounty-posted-date { color: var(--color-gray-500); font-size: 0.82rem; }

                .bounty-avatar {
                    width: 30px;
                    height: 30px;
                    border-radius: 50%;
                    overflow: hidden;
                    background: var(--color-blue-tint);
                    color: var(--color-primary);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 0.75rem;
                    font-weight: 700;
                    flex-shrink: 0;
                }
                .bounty-avatar img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    display: block;
                }

                .bounty-deadline {
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                    font-size: 0.85rem;
                    color: var(--color-gray-600);
                }
                .bounty-deadline.overdue { color: #dc2626; font-weight: 600; }

                .bounty-section {
                    margin-top: 1.5rem;
                }

                .bounty-section-title {
                    font-size: 1.15rem;
                    font-weight: 700;
                    margin: 0;
                }

                .bounty-description {
                    margin: 0;
                    font-size: 0.95rem;
                    line-height: 1.7;
                    color: var(--color-gray-700);
                    white-space: pre-wrap;
                    overflow-wrap: break-word;
                }

                .bounty-poster-actions {
                    display: flex;
                    justify-content: flex-end;
                    margin-top: 1.25rem;
                }

                .bounty-pay-panel {
                    margin-top: 1.5rem;
                    padding: 1rem 1.25rem;
                    border: 1px solid rgba(234, 179, 8, 0.4);
                    background: rgba(234, 179, 8, 0.06);
                    border-radius: var(--radius-lg);
                }
                .bounty-pay-hint {
                    display: flex;
                    align-items: flex-start;
                    gap: 0.5rem;
                    margin: 0 0 0.85rem;
                    font-size: 0.9rem;
                    color: var(--color-gray-700);
                    line-height: 1.5;
                }
                .bounty-pay-actions {
                    display: flex;
                    gap: 0.5rem;
                    flex-wrap: wrap;
                }

                .bounty-btn {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.4rem;
                    padding: 0.5rem 1rem;
                    border-radius: var(--radius-full);
                    border: none;
                    font-size: 0.85rem;
                    font-weight: 600;
                    cursor: pointer;
                    white-space: nowrap;
                    transition: all 0.15s;
                }
                .bounty-btn:disabled { opacity: 0.6; cursor: not-allowed; }
                .bounty-btn.primary {
                    background: var(--color-primary);
                    color: white;
                }
                .bounty-btn.outline {
                    background: var(--color-surface);
                    border: 1px solid var(--color-gray-300);
                    color: var(--color-gray-700);
                }
                .bounty-btn.outline:hover:not(:disabled) { border-color: var(--color-primary); color: var(--color-primary); }
                .bounty-btn.danger-outline {
                    background: var(--color-surface);
                    border: 1px solid #dc2626;
                    color: #dc2626;
                }
                .bounty-btn.danger-outline:hover:not(:disabled) { background: var(--color-red-tint); }
                .bounty-btn.zap {
                    background: #f7931a;
                    color: white;
                }
                .bounty-btn.zap:hover:not(:disabled) { background: #e8841a; }
                .bounty-btn.award {
                    margin-top: 0.6rem;
                    padding: 0.35rem 0.85rem;
                    font-size: 0.8rem;
                    background: var(--color-surface);
                    border: 1px solid #eab308;
                    color: #a16207;
                }
                .bounty-btn.award:hover:not(:disabled) { background: rgba(234, 179, 8, 0.1); }

                .bounty-submissions-head {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 0.75rem;
                    margin-bottom: 1rem;
                }

                .bounty-warn-banner {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    padding: 0.65rem 0.9rem;
                    border-radius: var(--radius-md);
                    background: var(--color-amber-tint);
                    color: var(--badge-warning-text, #9a3412);
                    font-size: 0.85rem;
                    margin-bottom: 0.75rem;
                }

                .bounty-submission-form {
                    margin-bottom: 1.25rem;
                }

                .bounty-textarea {
                    width: 100%;
                    box-sizing: border-box;
                    padding: 0.65rem 0.9rem;
                    border: 1px solid var(--color-gray-300);
                    border-radius: var(--radius-md);
                    background: var(--color-surface);
                    color: inherit;
                    font-size: 0.95rem;
                    font-family: inherit;
                    resize: vertical;
                    outline: none;
                    transition: border-color 0.2s, box-shadow 0.2s;
                }
                .bounty-textarea:focus {
                    border-color: var(--color-primary);
                    box-shadow: 0 0 0 3px rgba(0, 82, 204, 0.1);
                }

                .bounty-inline-error {
                    margin: 0.5rem 0 0;
                    font-size: 0.82rem;
                    color: var(--color-error, #b91c1c);
                }

                .bounty-form-actions {
                    display: flex;
                    justify-content: flex-end;
                    gap: 0.5rem;
                    margin-top: 0.65rem;
                }

                .bounty-no-submissions {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 0.5rem;
                    padding: 2rem 1rem;
                    color: var(--color-gray-500);
                    text-align: center;
                }
                .bounty-no-submissions p { margin: 0; font-size: 0.9rem; }

                .bounty-submission-list {
                    display: flex;
                    flex-direction: column;
                }

                .bounty-submission {
                    display: flex;
                    align-items: flex-start;
                    gap: 0.75rem;
                    padding: 0.9rem 0.5rem;
                }
                .bounty-submission + .bounty-submission {
                    border-top: 1px solid var(--color-gray-200);
                }
                .bounty-submission.winner {
                    background: rgba(234, 179, 8, 0.07);
                    border: 1px solid rgba(234, 179, 8, 0.45);
                    border-radius: var(--radius-lg);
                    padding: 0.9rem;
                    margin: 0.25rem 0;
                }
                .bounty-submission.winner + .bounty-submission { border-top: none; }

                .bounty-submission-body {
                    flex: 1;
                    min-width: 0;
                }

                .bounty-submission-meta {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    flex-wrap: wrap;
                }
                .bounty-submission-name {
                    font-size: 0.9rem;
                    font-weight: 600;
                }
                .bounty-submission-date {
                    font-size: 0.78rem;
                    color: var(--color-gray-400);
                }

                .bounty-winner-badge {
                    display: inline-flex;
                    align-items: center;
                    gap: 3px;
                    font-size: 0.7rem;
                    padding: 2px 8px;
                    border-radius: 99px;
                    font-weight: 700;
                    text-transform: uppercase;
                    background: rgba(234, 179, 8, 0.15);
                    color: #a16207;
                }

                .bounty-submission-content {
                    margin: 0.3rem 0 0;
                    font-size: 0.9rem;
                    line-height: 1.6;
                    color: var(--color-gray-700);
                    white-space: pre-wrap;
                    overflow-wrap: break-word;
                }

                @media (max-width: 600px) {
                    .bounty-pay-actions { flex-direction: column; }
                    .bounty-pay-actions .bounty-btn { justify-content: center; }
                    .bounty-submissions-head {
                        flex-direction: column;
                        align-items: flex-start;
                    }
                }
            `}</style>
        </div>
    );
};

export default BountyDetail;
