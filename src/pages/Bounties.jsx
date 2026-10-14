import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Target, Plus, Zap, Trophy, Star, Clock, MessageSquare, Loader2 } from 'lucide-react';
import { bountiesApi } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { getAssetUrl } from '../utils/assets';

const TABS = [
    { key: 'all', tKey: 'bounties.tabs.all' },
    { key: 'open', tKey: 'bounties.tabs.open' },
    { key: 'awarded', tKey: 'bounties.tabs.awarded' },
    { key: 'paid', tKey: 'bounties.tabs.paid' },
    { key: 'mine', tKey: 'bounties.tabs.mine' },
];

/**
 * Bounty board list page: filter tabs, reward chips (sats / points),
 * featured bounties pinned on top, deadline display.
 */
const Bounties = () => {
    const { t } = useTranslation();
    const { user } = useAuth();

    const [tab, setTab] = useState('all');
    const [bounties, setBounties] = useState([]);
    const [pagination, setPagination] = useState(null);
    const [loading, setLoading] = useState(true);

    const fetchBounties = useCallback(async (page = 1) => {
        setLoading(true);
        try {
            const params = { page, limit: 20 };
            if (tab === 'mine') params.mine = true;
            else if (tab !== 'all') params.status = tab.toUpperCase();
            const res = await bountiesApi.list(params);
            const list = res?.data || res || [];
            setBounties(Array.isArray(list) ? list : []);
            setPagination(res?.pagination || null);
        } catch {
            setBounties([]);
            setPagination(null);
        } finally {
            setLoading(false);
        }
    }, [tab]);

    useEffect(() => { fetchBounties(1); }, [fetchBounties]);

    // Featured bounties pinned first, otherwise keep server order (newest first)
    const sorted = [...bounties].sort((a, b) => Number(!!b.featured) - Number(!!a.featured));

    const isOverdue = (b) => b.status === 'OPEN' && b.deadline && new Date(b.deadline) < new Date();

    return (
        <div className="bounties-page container">
            <div className="bounties-content">
                {/* Header + create CTA */}
                <div className="bounties-header">
                    <div className="bounties-header-text">
                        <h1 className="bounties-title">
                            <Target size={26} style={{ color: 'var(--color-primary)', flexShrink: 0 }} />
                            {t('bounties.title')}
                        </h1>
                        <p className="bounties-subtitle">{t('bounties.subtitle')}</p>
                    </div>
                    {user && (
                        <Link to="/bounties/new" className="bounties-create-btn">
                            <Plus size={17} strokeWidth={2.5} />
                            {t('bounties.postBounty')}
                        </Link>
                    )}
                </div>

                {/* Filter tabs */}
                <div className="bounties-tabs">
                    {TABS.filter((tb) => tb.key !== 'mine' || user).map((tb) => (
                        <button
                            key={tb.key}
                            className={`bounties-tab ${tab === tb.key ? 'active' : ''}`}
                            onClick={() => setTab(tb.key)}
                        >
                            {t(tb.tKey)}
                        </button>
                    ))}
                </div>

                {/* Bounty cards */}
                {loading ? (
                    <div className="bounties-loading">
                        <Loader2 size={32} style={{ animation: 'spin 1s linear infinite' }} />
                    </div>
                ) : sorted.length === 0 ? (
                    <div className="bounties-empty">
                        <Target size={36} style={{ opacity: 0.4 }} />
                        <p>{tab === 'mine' ? t('bounties.emptyMine') : t('bounties.empty')}</p>
                    </div>
                ) : (
                    <div className="bounties-list">
                        {sorted.map((b) => {
                            const posterName = b.poster?.profile?.name || t('bounties.member');
                            const posterAvatar = b.poster?.profile?.avatar || '';
                            const submissionCount = b._count?.submissions;
                            return (
                                <Link key={b.id} to={`/bounties/${b.id}`} className={`bounty-card ${b.featured ? 'featured' : ''}`}>
                                    <div className="bounty-card-top">
                                        <span className={`bounty-status ${b.status.toLowerCase()}`}>
                                            {t(`bounties.status.${b.status.toLowerCase()}`)}
                                        </span>
                                        {b.featured && (
                                            <span className="bounty-featured-badge">
                                                <Star size={12} fill="currentColor" /> {t('bounties.featured')}
                                            </span>
                                        )}
                                        <span className={`bounty-reward ${b.rewardType === 'SATS' ? 'sats' : 'points'}`}>
                                            {b.rewardType === 'SATS' ? <Zap size={14} /> : <Trophy size={14} />}
                                            {Number(b.amount).toLocaleString()} {b.rewardType === 'SATS' ? t('bounties.sats') : t('bounties.points')}
                                        </span>
                                    </div>

                                    <h3 className="bounty-card-title">{b.title}</h3>
                                    {b.description && <p className="bounty-card-desc">{b.description}</p>}

                                    <div className="bounty-card-meta">
                                        <span className="bounty-poster">
                                            <span className="bounty-poster-avatar">
                                                {posterAvatar
                                                    ? <img src={getAssetUrl(posterAvatar)} alt={posterName} />
                                                    : <span>{posterName[0]?.toUpperCase()}</span>}
                                            </span>
                                            {posterName}
                                        </span>
                                        {typeof submissionCount === 'number' && (
                                            <span className="bounty-meta-item">
                                                <MessageSquare size={13} />
                                                {t('bounties.submissionCount', { count: submissionCount })}
                                            </span>
                                        )}
                                        {b.deadline && (
                                            <span className={`bounty-meta-item ${isOverdue(b) ? 'overdue' : ''}`}>
                                                <Clock size={13} />
                                                {t('bounties.deadlineShort', { date: new Date(b.deadline).toLocaleDateString() })}
                                            </span>
                                        )}
                                    </div>
                                </Link>
                            );
                        })}
                    </div>
                )}

                {pagination && pagination.totalPages > 1 && (
                    <div className="bounties-pagination">
                        <button
                            disabled={pagination.page <= 1}
                            onClick={() => fetchBounties(pagination.page - 1)}
                        >{t('common.previous')}</button>
                        <span>{t('common.page', { current: pagination.page, total: pagination.totalPages })}</span>
                        <button
                            disabled={pagination.page >= pagination.totalPages}
                            onClick={() => fetchBounties(pagination.page + 1)}
                        >{t('common.next')}</button>
                    </div>
                )}
            </div>

            <style jsx>{`
                .bounties-page {
                    padding-top: var(--page-top, 2rem);
                    padding-bottom: 4rem;
                    box-sizing: border-box;
                }

                .bounties-content {
                    max-width: 760px;
                    margin: 0 auto;
                }

                .bounties-header {
                    display: flex;
                    align-items: flex-start;
                    justify-content: space-between;
                    gap: 1rem;
                    margin-bottom: 1.5rem;
                }

                .bounties-title {
                    display: flex;
                    align-items: center;
                    gap: 0.6rem;
                    font-size: 1.6rem;
                    font-weight: 700;
                    margin: 0 0 0.25rem;
                }

                .bounties-subtitle {
                    color: var(--color-gray-500);
                    font-size: 0.9rem;
                    margin: 0;
                }

                /* Link components don't get the styled-jsx scope hash — anchor
                   these rules on a scoped parent instead (see Leaderboard.jsx) */
                .bounties-header :global(.bounties-create-btn) {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.4rem;
                    padding: 0.55rem 1.1rem;
                    border-radius: var(--radius-full);
                    background: var(--color-primary);
                    color: white;
                    text-decoration: none;
                    font-size: 0.875rem;
                    font-weight: 600;
                    white-space: nowrap;
                    flex-shrink: 0;
                }

                .bounties-tabs {
                    display: flex;
                    gap: 0.5rem;
                    margin-bottom: 1.5rem;
                    overflow-x: auto;
                    scrollbar-width: none;
                }
                .bounties-tabs::-webkit-scrollbar { display: none; }

                .bounties-tab {
                    padding: 0.5rem 1rem;
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-full);
                    background: var(--color-surface);
                    cursor: pointer;
                    font-size: 0.875rem;
                    font-weight: 500;
                    color: var(--color-gray-500);
                    transition: all 0.15s;
                    white-space: nowrap;
                }
                .bounties-tab:hover { border-color: var(--color-primary); color: var(--color-primary); }
                .bounties-tab.active { background: var(--color-primary); color: white; border-color: var(--color-primary); }

                .bounties-list {
                    display: flex;
                    flex-direction: column;
                    gap: 1rem;
                }

                .bounties-list :global(.bounty-card) {
                    display: block;
                    background: var(--color-surface);
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-lg);
                    box-shadow: var(--shadow-sm);
                    padding: 1.1rem 1.25rem;
                    text-decoration: none;
                    color: inherit;
                    transition: border-color 0.15s, box-shadow 0.15s;
                }
                .bounties-list :global(.bounty-card:hover) {
                    border-color: var(--color-primary);
                    box-shadow: var(--shadow-md, 0 4px 12px rgba(0, 0, 0, 0.08));
                }
                .bounties-list :global(.bounty-card.featured) {
                    border-color: #eab308;
                }

                .bounty-card-top {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    margin-bottom: 0.6rem;
                    flex-wrap: wrap;
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
                    padding: 0.3rem 0.75rem;
                    border-radius: var(--radius-full);
                    font-size: 0.82rem;
                    font-weight: 700;
                    white-space: nowrap;
                }
                .bounty-reward.sats { background: rgba(247, 147, 26, 0.1); color: #f7931a; }
                .bounty-reward.points { background: var(--color-blue-tint); color: var(--color-primary); }

                .bounty-card-title {
                    font-size: 1.05rem;
                    font-weight: 700;
                    margin: 0 0 0.35rem;
                    overflow-wrap: break-word;
                }

                .bounty-card-desc {
                    margin: 0 0 0.75rem;
                    font-size: 0.88rem;
                    line-height: 1.5;
                    color: var(--color-gray-600);
                    display: -webkit-box;
                    -webkit-line-clamp: 2;
                    -webkit-box-orient: vertical;
                    overflow: hidden;
                }

                .bounty-card-meta {
                    display: flex;
                    align-items: center;
                    gap: 1rem;
                    flex-wrap: wrap;
                    font-size: 0.8rem;
                    color: var(--color-gray-500);
                }

                .bounty-poster {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.4rem;
                    font-weight: 500;
                    min-width: 0;
                }

                .bounty-poster-avatar {
                    width: 22px;
                    height: 22px;
                    border-radius: 50%;
                    overflow: hidden;
                    background: var(--color-blue-tint);
                    color: var(--color-primary);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 0.65rem;
                    font-weight: 700;
                    flex-shrink: 0;
                }
                .bounty-poster-avatar img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    display: block;
                }

                .bounty-meta-item {
                    display: inline-flex;
                    align-items: center;
                    gap: 4px;
                    white-space: nowrap;
                }
                .bounty-meta-item.overdue { color: #dc2626; }

                .bounties-loading {
                    display: flex;
                    justify-content: center;
                    padding: 3rem;
                    color: var(--color-gray-500);
                }

                .bounties-empty {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 0.75rem;
                    text-align: center;
                    padding: 3rem 1rem;
                    color: var(--color-gray-500);
                }
                .bounties-empty p { margin: 0; }

                .bounties-pagination {
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    gap: 1rem;
                    margin-top: 1.5rem;
                }
                .bounties-pagination button {
                    padding: 0.5rem 1rem;
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-md);
                    background: var(--color-surface);
                    cursor: pointer;
                    font-size: 0.875rem;
                }
                .bounties-pagination button:disabled { opacity: 0.5; cursor: not-allowed; }
                .bounties-pagination span { font-size: 0.875rem; color: var(--color-gray-500); }

                @media (max-width: 600px) {
                    .bounties-header {
                        flex-direction: column;
                        align-items: stretch;
                    }
                    .bounties-header :global(.bounties-create-btn) { justify-content: center; }
                }
            `}</style>
        </div>
    );
};

export default Bounties;
