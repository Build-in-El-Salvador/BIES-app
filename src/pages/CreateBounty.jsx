import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Target, Zap, Trophy, Loader2, AlertCircle, Info } from 'lucide-react';
import { getEventHash } from 'nostr-tools';
import { bountiesApi, pointsApi } from '../services/api';
import { nostrService } from '../services/nostrService';
import { nostrSigner } from '../services/nostrSigner';

const LIMITS = {
    SATS: { min: 100, max: 1000000 },
    POINTS: { min: 5, max: 10000 },
};

/**
 * Bounty create form: reward type toggle (sats / points), amount within the
 * per-type limits, optional deadline. POINTS bounties show the spendable
 * balance and escrow explainer — the amount is debited at post time.
 */
const CreateBounty = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();

    const [rewardType, setRewardType] = useState('SATS');
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [amount, setAmount] = useState('');
    const [deadline, setDeadline] = useState('');
    const [points, setPoints] = useState(null);
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState('');

    useEffect(() => {
        pointsApi.me().then(setPoints).catch(() => { });
    }, []);

    const limits = LIMITS[rewardType];
    const amountNum = parseInt(amount, 10);
    const spendable = points == null
        ? null
        : points.spendablePoints ?? (points.lifetimePoints || 0) + (points.bountyPoints || 0);
    const insufficient = rewardType === 'POINTS'
        && spendable != null
        && Number.isInteger(amountNum)
        && amountNum > spendable;

    // Local calendar date (en-CA = YYYY-MM-DD) — toISOString would shift the
    // picker's minimum a day off for anyone west of UTC.
    const todayStr = new Date().toLocaleDateString('en-CA');
    // A picked date means "until the end of that local day" — so today is a
    // valid pick and a "tomorrow" pick doesn't collapse to 00:00 UTC tonight.
    const deadlineDate = deadline ? new Date(`${deadline}T23:59:59.999`) : null;

    // Best-effort Nostr mirror: nostr-native users sign+publish the kind-1
    // note client-side (the id is hashed locally since publishEvent doesn't
    // return the signed event); custodial users let the server publish it.
    const mirrorBounty = async (created) => {
        try {
            if (nostrSigner.signsOnDevice) {
                const pubkey = await nostrSigner.getPublicKey();
                const rewardLabel = `${Number(created.amount).toLocaleString()} ${rewardType === 'SATS' ? 'sats' : 'points'}`;
                const event = {
                    kind: 1,
                    pubkey,
                    created_at: Math.floor(Date.now() / 1000),
                    tags: [['t', 'bounty']],
                    content: `🎯 New bounty: ${created.title} — ${rewardLabel}\n\n${window.location.origin}/bounties/${created.id}`,
                };
                const eventId = getEventHash(event);
                await nostrService.publishEvent(event);
                await bountiesApi.mirror(created.id, eventId);
            } else {
                await bountiesApi.mirror(created.id);
            }
        } catch { /* non-blocking */ }
    };

    const handleSubmit = async () => {
        setSubmitError('');
        if (!title.trim()) {
            setSubmitError(t('bounties.titleRequired'));
            return;
        }
        if (!description.trim()) {
            setSubmitError(t('bounties.descriptionRequired'));
            return;
        }
        if (!Number.isInteger(amountNum) || amountNum < limits.min || amountNum > limits.max) {
            setSubmitError(t('bounties.amountRange', {
                min: limits.min.toLocaleString(),
                max: limits.max.toLocaleString(),
                unit: rewardType === 'SATS' ? t('bounties.sats') : t('bounties.points'),
            }));
            return;
        }
        if (insufficient) {
            setSubmitError(t('bounties.insufficientPoints', { spendable }));
            return;
        }
        // Mirror the server's "deadline must be in the future" rule so the
        // form fails fast instead of round-tripping a 400.
        if (deadlineDate && (isNaN(deadlineDate.getTime()) || deadlineDate.getTime() <= Date.now())) {
            setSubmitError(t('bounties.deadlinePast'));
            return;
        }
        setSubmitting(true);
        try {
            const payload = {
                title: title.trim(),
                description: description.trim(),
                rewardType,
                amount: amountNum,
            };
            if (deadlineDate) payload.deadline = deadlineDate.toISOString();
            const res = await bountiesApi.create(payload);
            const created = res?.data || res;
            await mirrorBounty({ ...payload, ...created });
            navigate(`/bounties/${created.id}`);
        } catch (err) {
            setSubmitError(err.message || t('bounties.createFailed'));
            window.scrollTo({ top: 0, behavior: 'smooth' });
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="create-bounty-page">
            <div className="container">
                <div className="create-bounty-content">

                    {/* Header */}
                    <div className="create-bounty-header">
                        <button onClick={() => navigate(-1)} className="create-bounty-back" type="button">
                            <ArrowLeft size={18} /> {t('common.back')}
                        </button>
                        <h1 className="create-bounty-title">
                            <Target size={24} style={{ color: 'var(--color-primary)', flexShrink: 0 }} />
                            {t('bounties.createTitle')}
                        </h1>
                        <p className="create-bounty-subtitle">{t('bounties.createSubtitle')}</p>
                    </div>

                    {submitError && (
                        <div className="create-bounty-error"><AlertCircle size={16} /> {submitError}</div>
                    )}

                    {/* Reward */}
                    <div className="create-bounty-card">
                        <h3 className="create-bounty-heading">{t('bounties.rewardSection')}</h3>

                        <div className="reward-type-toggle">
                            <button
                                type="button"
                                className={`reward-type-btn sats ${rewardType === 'SATS' ? 'active' : ''}`}
                                onClick={() => setRewardType('SATS')}
                            >
                                <Zap size={18} />
                                <span>{t('bounties.rewardSats')}</span>
                                <small>{t('bounties.rewardSatsHint')}</small>
                            </button>
                            <button
                                type="button"
                                className={`reward-type-btn points ${rewardType === 'POINTS' ? 'active' : ''}`}
                                onClick={() => setRewardType('POINTS')}
                            >
                                <Trophy size={18} />
                                <span>{t('bounties.rewardPoints')}</span>
                                <small>{t('bounties.rewardPointsHint')}</small>
                            </button>
                        </div>

                        <div className="create-bounty-group">
                            <label className="create-bounty-label">
                                {t('bounties.amountLabel')} ({rewardType === 'SATS' ? t('bounties.sats') : t('bounties.points')}) *
                            </label>
                            <input
                                type="number"
                                className="create-bounty-input"
                                value={amount}
                                onChange={(e) => setAmount(e.target.value)}
                                min={limits.min}
                                max={limits.max}
                                step={1}
                                placeholder={`${limits.min} – ${limits.max.toLocaleString()}`}
                            />
                            <p className="create-bounty-hint">
                                {t('bounties.amountRange', {
                                    min: limits.min.toLocaleString(),
                                    max: limits.max.toLocaleString(),
                                    unit: rewardType === 'SATS' ? t('bounties.sats') : t('bounties.points'),
                                })}
                            </p>
                            {insufficient && (
                                <p className="create-bounty-insufficient">
                                    {t('bounties.insufficientPoints', { spendable })}
                                </p>
                            )}
                        </div>

                        {rewardType === 'POINTS' && (
                            <div className="escrow-note">
                                <Info size={16} style={{ flexShrink: 0, marginTop: 2 }} />
                                <div>
                                    {spendable != null && (
                                        <p className="escrow-balance">
                                            {t('bounties.spendableBalance', { points: spendable.toLocaleString() })}
                                        </p>
                                    )}
                                    <p className="escrow-text">{t('bounties.escrowExplainer')}</p>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Details */}
                    <div className="create-bounty-card">
                        <h3 className="create-bounty-heading">{t('bounties.detailsSection')}</h3>

                        <div className="create-bounty-group">
                            <label className="create-bounty-label">{t('bounties.titleLabel')} *</label>
                            <input
                                type="text"
                                className="create-bounty-input"
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                maxLength={120}
                            />
                        </div>

                        <div className="create-bounty-group">
                            <label className="create-bounty-label">{t('bounties.descriptionLabel')} *</label>
                            <textarea
                                className="create-bounty-input"
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                rows={6}
                                maxLength={5000}
                                placeholder={t('bounties.descriptionPlaceholder')}
                            />
                        </div>

                        <div className="create-bounty-group" style={{ marginBottom: 0 }}>
                            <label className="create-bounty-label">{t('bounties.deadlineLabel')}</label>
                            <input
                                type="date"
                                className="create-bounty-input"
                                value={deadline}
                                onChange={(e) => setDeadline(e.target.value)}
                                min={todayStr}
                            />
                            <p className="create-bounty-hint">{t('bounties.deadlineHint')}</p>
                        </div>
                    </div>

                    {/* Actions */}
                    <div className="create-bounty-actions">
                        <button type="button" onClick={() => navigate(-1)} className="btn btn-outline" disabled={submitting}>
                            {t('common.cancel')}
                        </button>
                        <button type="button" onClick={handleSubmit} disabled={submitting || insufficient} className="btn btn-primary">
                            {submitting && <Loader2 size={16} style={{ animation: 'spin 1s linear infinite', marginRight: 6, verticalAlign: '-3px' }} />}
                            {t('bounties.postBounty')}
                        </button>
                    </div>
                </div>
            </div>

            <style jsx>{`
                .create-bounty-page {
                    padding-top: 1.5rem;
                    padding-bottom: 4rem;
                }

                .create-bounty-content {
                    max-width: 640px;
                    margin: 0 auto;
                }

                .create-bounty-header {
                    margin-bottom: 1.25rem;
                }

                .create-bounty-back {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.25rem;
                    color: var(--color-gray-500);
                    font-weight: 500;
                    font-size: 0.9rem;
                    background: none;
                    border: none;
                    cursor: pointer;
                    padding: 0;
                    margin-bottom: 0.75rem;
                }
                .create-bounty-back:hover { color: var(--color-primary); }

                .create-bounty-title {
                    display: flex;
                    align-items: center;
                    gap: 0.6rem;
                    font-size: 1.6rem;
                    font-weight: 700;
                    margin: 0 0 0.25rem;
                    color: var(--color-gray-900);
                }
                .create-bounty-subtitle {
                    color: var(--color-gray-500);
                    font-size: 0.9rem;
                    margin: 0;
                }

                .create-bounty-error {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    padding: 0.75rem 1rem;
                    background: var(--color-red-tint);
                    color: var(--color-error, #B91C1C);
                    border-radius: var(--radius-md);
                    margin-bottom: 1.25rem;
                    font-size: 0.9rem;
                }

                .create-bounty-card {
                    background: var(--color-surface);
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-lg);
                    box-shadow: var(--shadow-sm);
                    padding: 1.5rem;
                    margin-bottom: 1.25rem;
                }

                .create-bounty-heading {
                    font-size: 1.05rem;
                    font-weight: 700;
                    margin: 0 0 1.25rem;
                    padding-bottom: 0.75rem;
                    border-bottom: 1px solid var(--color-gray-200);
                }

                .reward-type-toggle {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 0.75rem;
                    margin-bottom: 1.25rem;
                }

                .reward-type-btn {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 0.3rem;
                    padding: 0.9rem 0.75rem;
                    border: 1.5px solid var(--color-gray-200);
                    border-radius: var(--radius-lg);
                    background: var(--color-surface);
                    cursor: pointer;
                    color: var(--color-gray-600);
                    font-family: inherit;
                    transition: all 0.15s;
                }
                .reward-type-btn span {
                    font-size: 0.9rem;
                    font-weight: 700;
                }
                .reward-type-btn small {
                    font-size: 0.75rem;
                    color: var(--color-gray-500);
                    line-height: 1.35;
                }
                .reward-type-btn.sats.active {
                    border-color: #f7931a;
                    color: #f7931a;
                    background: rgba(247, 147, 26, 0.06);
                }
                .reward-type-btn.points.active {
                    border-color: var(--color-primary);
                    color: var(--color-primary);
                    background: var(--color-blue-tint);
                }

                .create-bounty-group {
                    margin-bottom: 1.1rem;
                }

                .create-bounty-label {
                    display: block;
                    font-size: 0.85rem;
                    font-weight: 600;
                    color: var(--color-gray-700);
                    margin-bottom: 0.4rem;
                }

                .create-bounty-input {
                    width: 100%;
                    padding: 0.65rem 0.9rem;
                    border: 1px solid var(--color-gray-300);
                    background: var(--color-surface);
                    color: inherit;
                    border-radius: var(--radius-md);
                    outline: none;
                    font-size: 0.95rem;
                    font-family: inherit;
                    transition: border-color 0.2s, box-shadow 0.2s;
                    box-sizing: border-box;
                }
                .create-bounty-input:focus {
                    border-color: var(--color-primary);
                    box-shadow: 0 0 0 3px rgba(0, 82, 204, 0.1);
                }
                textarea.create-bounty-input { resize: vertical; }

                .create-bounty-hint {
                    margin: 0.4rem 0 0;
                    font-size: 0.78rem;
                    line-height: 1.45;
                    color: var(--color-gray-500);
                }

                .create-bounty-insufficient {
                    margin: 0.4rem 0 0;
                    font-size: 0.82rem;
                    font-weight: 600;
                    color: var(--color-error, #b91c1c);
                }

                .escrow-note {
                    display: flex;
                    align-items: flex-start;
                    gap: 0.6rem;
                    padding: 0.85rem 1rem;
                    border-radius: var(--radius-md);
                    background: var(--color-blue-tint);
                    color: var(--color-primary);
                }
                .escrow-balance {
                    margin: 0 0 0.25rem;
                    font-size: 0.88rem;
                    font-weight: 700;
                }
                .escrow-text {
                    margin: 0;
                    font-size: 0.82rem;
                    line-height: 1.5;
                }

                .create-bounty-actions {
                    display: flex;
                    justify-content: flex-end;
                    gap: 0.75rem;
                    margin-top: 1.5rem;
                }

                @media (max-width: 600px) {
                    .reward-type-toggle {
                        grid-template-columns: 1fr;
                    }
                    .create-bounty-actions {
                        flex-direction: column-reverse;
                    }
                    .create-bounty-actions button {
                        width: 100%;
                    }
                }
            `}</style>
        </div>
    );
};

export default CreateBounty;
