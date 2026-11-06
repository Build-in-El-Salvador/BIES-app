import React, { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Trophy } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { pointsApi } from '../services/api';
import { getAssetUrl } from '../utils/assets';
import InitialAvatar from '../components/InitialAvatar';

const MEDAL_COLORS = {
    1: { bg: '#F5B301', text: '#3D2E00' }, // gold
    2: { bg: '#C0C7D1', text: '#2B3440' }, // silver
    3: { bg: '#CD7F32', text: '#3B2410' }, // bronze
};

const RARITY_ORDER = ['legendary', 'rare', 'uncommon', 'common'];

const RARITY_COLORS = {
    legendary: '#D97706',
    rare: '#7C3AED',
    uncommon: '#2563EB',
    common: '#64748B',
};

/** 'YYYY-MM' for a Date (UTC — matches the server's monthOf). */
const monthOf = (date) => date.toISOString().slice(0, 7);

/** The current month + the 12 preceding months as 'YYYY-MM' strings. */
const buildMonthOptions = () => {
    const now = new Date();
    const options = [];
    for (let i = 1; i <= 12; i++) {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
        options.push(monthOf(d));
    }
    return options;
};

const Leaderboard = () => {
    const { t, i18n } = useTranslation();
    const { user } = useAuth();

    const [scope, setScope] = useState('monthly');
    const [selectedMonth, setSelectedMonth] = useState(''); // '' = current (live)
    const [data, setData] = useState(null);        // live leaderboard response
    const [snapshot, setSnapshot] = useState(null); // past-month snapshot response
    const [badges, setBadges] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);

    const pastMonths = useMemo(buildMonthOptions, []);
    const isSnapshotView = selectedMonth !== '';

    // Live leaderboard (current month / lifetime)
    useEffect(() => {
        if (isSnapshotView) return;
        let cancelled = false;
        setLoading(true);
        setError(false);
        pointsApi.leaderboard({ scope, limit: 50 })
            .then((res) => { if (!cancelled) setData(res); })
            .catch(() => { if (!cancelled) setError(true); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [scope, isSnapshotView]);

    // Past-month frozen snapshot
    useEffect(() => {
        if (!isSnapshotView) return;
        let cancelled = false;
        setLoading(true);
        setError(false);
        pointsApi.month(selectedMonth)
            .then((res) => { if (!cancelled) setSnapshot(res); })
            .catch(() => { if (!cancelled) setError(true); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [selectedMonth, isSnapshotView]);

    // Badge catalog (once)
    useEffect(() => {
        pointsApi.badges().then((res) => setBadges(res.badges || [])).catch(() => {});
    }, []);

    const monthLabel = (m) => {
        const [y, mo] = m.split('-').map(Number);
        return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString(i18n.language, {
            month: 'long', year: 'numeric', timeZone: 'UTC',
        });
    };

    const entries = isSnapshotView ? (snapshot?.entries || []) : (data?.entries || []);
    const me = !isSnapshotView ? data?.me : null;
    const myUserId = me?.userId || user?.id;
    const meInList = Boolean(myUserId && entries.some((e) => e.userId === myUserId));
    const showPinnedRow = !isSnapshotView && me && !meInList;

    const badgesByRarity = useMemo(() => {
        const groups = {};
        for (const b of badges) {
            (groups[b.rarity] = groups[b.rarity] || []).push(b);
        }
        return RARITY_ORDER.filter((r) => groups[r]?.length).map((r) => ({ rarity: r, badges: groups[r] }));
    }, [badges]);

    const renderAvatar = (name, avatar, size = 40) => (
        avatar ? (
            <img
                src={getAssetUrl(avatar)}
                alt=""
                className="lb-avatar"
                style={{ width: size, height: size }}
            />
        ) : (
            <InitialAvatar name={name} size={size} />
        )
    );

    const renderRank = (rank) => {
        const medal = MEDAL_COLORS[rank];
        return (
            <div
                className="lb-rank"
                style={medal ? { background: medal.bg, color: medal.text, fontWeight: 800 } : undefined}
            >
                {rank ?? '—'}
            </div>
        );
    };

    const renderRow = (entry, { pinned = false } = {}) => {
        const isMe = Boolean(myUserId && entry.userId === myUserId);
        const hasLevel = entry.level !== undefined && entry.level !== null;
        return (
            <div
                key={pinned ? 'pinned-me' : `${entry.rank}-${entry.userId}`}
                className={`lb-row ${isMe || pinned ? 'lb-row-me' : ''}`}
                data-testid={pinned ? 'lb-pinned-row' : 'lb-row'}
            >
                {renderRank(entry.rank)}
                {renderAvatar(entry.name, entry.avatar)}
                <div className="lb-row-main">
                    <Link
                        to={`/builder/${entry.pubkey}`}
                        style={{
                            color: 'var(--color-gray-900)', fontWeight: 600, fontSize: '0.95rem',
                            textDecoration: 'none', display: 'block', whiteSpace: 'nowrap',
                            overflow: 'hidden', textOverflow: 'ellipsis',
                        }}
                    >
                        {pinned ? (entry.name || t('common.you')) : (entry.name || t('common.unnamed'))}
                    </Link>
                    {hasLevel && (
                        <span className="lb-level-chip">
                            Lv {entry.level} · {t(entry.titleKey)}
                        </span>
                    )}
                </div>
                <div className="lb-points">{entry.points}</div>
            </div>
        );
    };

    return (
        <div className="container py-8 lb-page">
            {/* Header */}
            <div className="lb-header">
                <Trophy size={26} style={{ color: 'var(--color-secondary)', flexShrink: 0 }} />
                <h1 className="lb-title">{t('points.leaderboard.title')}</h1>
            </div>

            {/* Controls */}
            <div className="lb-controls">
                {!isSnapshotView && (
                    <div className="lb-scope-toggle" role="tablist">
                        <button
                            role="tab"
                            aria-selected={scope === 'monthly'}
                            className={`lb-scope-btn ${scope === 'monthly' ? 'active' : ''}`}
                            onClick={() => setScope('monthly')}
                        >
                            {t('points.leaderboard.monthly')}
                        </button>
                        <button
                            role="tab"
                            aria-selected={scope === 'lifetime'}
                            className={`lb-scope-btn ${scope === 'lifetime' ? 'active' : ''}`}
                            onClick={() => setScope('lifetime')}
                        >
                            {t('points.leaderboard.lifetime')}
                        </button>
                    </div>
                )}
                <select
                    className="lb-month-select"
                    value={selectedMonth}
                    onChange={(e) => setSelectedMonth(e.target.value)}
                    aria-label={t('points.leaderboard.pastMonths')}
                >
                    <option value="">{t('points.leaderboard.currentMonth')}</option>
                    {pastMonths.map((m) => (
                        <option key={m} value={m}>{monthLabel(m)}</option>
                    ))}
                </select>
            </div>

            {/* List */}
            {loading ? (
                <div className="lb-list">
                    {[...Array(6)].map((_, i) => (
                        <div key={i} className="lb-row lb-skeleton">
                            <div className="lb-rank lb-skeleton-block" />
                            <div className="lb-avatar lb-skeleton-block" style={{ width: 40, height: 40 }} />
                            <div className="lb-row-main">
                                <div className="lb-skeleton-block" style={{ height: 14, width: '55%', borderRadius: 4 }} />
                                <div className="lb-skeleton-block" style={{ height: 10, width: '35%', borderRadius: 4, marginTop: 6 }} />
                            </div>
                            <div className="lb-skeleton-block" style={{ height: 16, width: 32, borderRadius: 4 }} />
                        </div>
                    ))}
                </div>
            ) : error ? (
                <div className="lb-empty">{t('common.noResults')}</div>
            ) : entries.length === 0 ? (
                <div className="lb-empty" data-testid="lb-empty">{t('points.leaderboard.empty')}</div>
            ) : (
                <div className="lb-list" data-testid="lb-list">
                    {entries.map((entry) => renderRow(entry))}
                    {showPinnedRow && (
                        <>
                            <div className="lb-pinned-label">{t('points.leaderboard.yourRank')}</div>
                            {renderRow(
                                {
                                    rank: me.rank,
                                    userId: me.userId,
                                    pubkey: me.pubkey,
                                    name: user?.profile?.name || user?.name || '',
                                    avatar: user?.profile?.avatar || '',
                                    level: me.level,
                                    titleKey: me.titleKey,
                                    points: me.points,
                                },
                                { pinned: true }
                            )}
                        </>
                    )}
                </div>
            )}

            {/* Badge legend */}
            {badgesByRarity.length > 0 && (
                <div className="lb-legend" data-testid="lb-legend">
                    <h2 className="lb-legend-title">{t('points.leaderboard.badgeLegend')}</h2>
                    {badgesByRarity.map(({ rarity, badges: group }) => (
                        <div key={rarity} className="lb-legend-group">
                            <span className="lb-rarity-label" style={{ color: RARITY_COLORS[rarity] }}>
                                {t(`points.rarity.${rarity}`)}
                            </span>
                            <div className="lb-legend-chips">
                                {group.map((b) => (
                                    <span
                                        key={b.id}
                                        className="lb-badge-chip"
                                        title={t(`points.badges.${b.id}.desc`)}
                                    >
                                        <img src={`/badges/${b.id}.png`} alt="" width="20" height="20" />
                                        {t(`points.badges.${b.id}.name`)}
                                    </span>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/*
              Rows/avatars/chips are produced by helper closures, which the
              styled-jsx babel plugin does not scope — so every descendant
              rule is written as `.lb-page :global(...)`. `.lb-page` itself
              sits directly in this component's JSX and gets the scope hash,
              keeping all of these rules page-local.
            */}
            <style jsx>{`
                .lb-page {
                    max-width: 640px;
                    margin: 0 auto;
                    padding: 1.5rem 1rem 3rem;
                    width: 100%;
                }

                .lb-page :global(.lb-header) {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    margin-bottom: 1.25rem;
                }

                .lb-page :global(.lb-title) {
                    font-family: var(--font-display);
                    font-size: 1.6rem;
                    font-weight: 700;
                    color: var(--color-gray-900);
                    margin: 0;
                }

                .lb-page :global(.lb-controls) {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 12px;
                    flex-wrap: wrap;
                    margin-bottom: 1rem;
                }

                .lb-page :global(.lb-scope-toggle) {
                    display: inline-flex;
                    background: var(--color-gray-100);
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-full);
                    padding: 3px;
                }

                .lb-page :global(.lb-scope-btn) {
                    border: none;
                    background: transparent;
                    color: var(--color-gray-500);
                    font-family: inherit;
                    font-size: 0.85rem;
                    font-weight: 600;
                    padding: 6px 16px;
                    border-radius: var(--radius-full);
                    cursor: pointer;
                    transition: all 0.15s;
                }

                .lb-page :global(.lb-scope-btn.active) {
                    background: var(--color-surface);
                    color: var(--color-gray-900);
                    box-shadow: var(--shadow-sm);
                }

                .lb-page :global(.lb-month-select) {
                    background: var(--color-surface);
                    color: var(--color-gray-900);
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-md);
                    padding: 7px 10px;
                    font-family: inherit;
                    font-size: 0.85rem;
                    max-width: 200px;
                }

                .lb-page :global(.lb-list) {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                }

                .lb-page :global(.lb-row) {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    background: var(--color-surface);
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-md);
                    padding: 10px 14px;
                    min-width: 0;
                }

                .lb-page :global(.lb-row-me) {
                    border-color: var(--color-secondary);
                    background: var(--color-orange-tint);
                }

                .lb-page :global(.lb-rank) {
                    width: 32px;
                    height: 32px;
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 0.85rem;
                    font-weight: 700;
                    color: var(--color-gray-500);
                    background: var(--color-gray-100);
                    flex-shrink: 0;
                }

                .lb-page :global(.lb-avatar) {
                    border-radius: 50%;
                    object-fit: cover;
                    flex-shrink: 0;
                }


                .lb-page :global(.lb-row-main) {
                    flex: 1;
                    min-width: 0;
                    display: flex;
                    flex-direction: column;
                    gap: 3px;
                }

                .lb-page :global(.lb-level-chip) {
                    display: inline-flex;
                    align-self: flex-start;
                    align-items: center;
                    background: var(--color-blue-tint);
                    color: var(--color-primary);
                    font-size: 0.7rem;
                    font-weight: 600;
                    padding: 1px 8px;
                    border-radius: var(--radius-full);
                    white-space: nowrap;
                }

                .lb-page :global(.lb-points) {
                    font-weight: 800;
                    font-size: 1rem;
                    color: var(--color-gray-900);
                    flex-shrink: 0;
                    font-variant-numeric: tabular-nums;
                }

                .lb-page :global(.lb-pinned-label) {
                    font-size: 0.75rem;
                    font-weight: 700;
                    text-transform: uppercase;
                    letter-spacing: 0.04em;
                    color: var(--color-gray-500);
                    margin-top: 8px;
                }

                .lb-page :global(.lb-empty) {
                    text-align: center;
                    padding: 3rem 1rem;
                    color: var(--color-gray-500);
                    background: var(--color-surface);
                    border: 1px dashed var(--color-gray-200);
                    border-radius: var(--radius-md);
                }

                .lb-page :global(.lb-legend) {
                    margin-top: 2.5rem;
                    border-top: 1px solid var(--color-gray-200);
                    padding-top: 1.5rem;
                }

                .lb-page :global(.lb-legend-title) {
                    font-family: var(--font-display);
                    font-size: 1.1rem;
                    font-weight: 700;
                    color: var(--color-gray-900);
                    margin: 0 0 1rem;
                }

                .lb-page :global(.lb-legend-group) {
                    margin-bottom: 1rem;
                }

                .lb-page :global(.lb-rarity-label) {
                    display: block;
                    font-size: 0.7rem;
                    font-weight: 700;
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                    margin-bottom: 6px;
                }

                .lb-page :global(.lb-legend-chips) {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 6px;
                }

                .lb-page :global(.lb-badge-chip) {
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                    background: var(--color-surface);
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-full);
                    padding: 4px 10px 4px 6px;
                    font-size: 0.78rem;
                    font-weight: 500;
                    color: var(--color-gray-700);
                    cursor: default;
                }

                .lb-page :global(.lb-badge-chip img) {
                    border-radius: 50%;
                    flex-shrink: 0;
                }

                /* Loading skeletons */
                .lb-page :global(.lb-skeleton-block) {
                    background: var(--color-gray-100);
                    animation: lb-pulse 1.4s ease-in-out infinite;
                }

                @keyframes lb-pulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.45; }
                }

                @media (max-width: 480px) {
                    .lb-page { padding: 1rem 0.75rem 3rem; }
                    .lb-page :global(.lb-row) { padding: 9px 10px; gap: 10px; }
                    .lb-page :global(.lb-month-select) { max-width: 160px; }
                }
            `}</style>
        </div>
    );
};

export default Leaderboard;
