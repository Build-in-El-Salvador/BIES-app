import React, { useState, useEffect } from 'react';
import { cachedList, rememberList } from '../../utils/listCache';
import useVisitState from '../../hooks/useVisitState';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Search, SlidersHorizontal, Plus, Loader2, UserRound } from 'lucide-react';
import { talentApi } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import TalentCard from '../../components/talent/TalentCard';
import { TALENT_CATEGORIES, WORK_TYPES } from '../../components/talent/talentOptions';

/**
 * BIES Talents: what members offer to do for others, laid out like the Farms
 * and Businesses pages: the search row with the filter toggle and the round
 * "+", chips for the kinds of talent (and the member's own), then the cards,
 * members taking on work first. Filters: available now, works remotely,
 * accepts bitcoin, and the kind of work (one-off, short-term, long-term).
 */
const TalentList = () => {
    const { t } = useTranslation();
    const { user } = useAuth();

    // What the page shows, as Back brings it back (hooks/useVisitState.js):
    // the same list, at the same place. A new visit starts afresh.
    const [searchQuery, setSearchQuery] = useVisitState('talents.search', '');
    const [filtersOpen, setFiltersOpen] = useVisitState('talents.filtersOpen', false);
    const [category, setCategory] = useVisitState('talents.category', '');
    const [mineOnly, setMineOnly] = useVisitState('talents.mine', false);
    const [availableOnly, setAvailableOnly] = useVisitState('talents.available', false);
    const [remoteOnly, setRemoteOnly] = useVisitState('talents.remote', false);
    const [btcOnly, setBtcOnly] = useVisitState('talents.btc', false);
    const [workType, setWorkType] = useVisitState('talents.workType', '');

    const params = { limit: 50 };
    if (searchQuery) params.search = searchQuery;
    if (category) params.category = category;
    if (mineOnly && user?.id) params.userId = user.id;
    if (availableOnly) params.available = 'true';
    if (remoteOnly) params.remote = 'true';
    if (btcOnly) params.btc = 'true';
    if (workType) params.workType = workType;
    const key = `talent:${JSON.stringify(params)}`;
    // A list shown before, from the first frame (utils/listCache.js).
    const [talents, setTalents] = useState(() => cachedList(key) || []);
    const [loading, setLoading] = useState(() => !cachedList(key));

    // Fetch talent (same 300ms debounce pattern as the directories). An answer
    // that arrives after the search or filters changed again is dropped.
    useEffect(() => {
        let current = true;
        // A list shown before appears at once (utils/listCache.js) and is then
        // refreshed; a new one shows the spinner.
        const seen = cachedList(key);
        if (seen) {
            setTalents(seen);
            setLoading(false);
        } else {
            setLoading(true);
        }
        const fetchTalent = async () => {
            try {
                const result = await talentApi.list(params);
                const found = Array.isArray(result?.data) ? result.data : [];
                rememberList(key, found);
                if (current) setTalents(found);
            } catch {
                if (current && !seen) setTalents([]);
            } finally {
                if (current) setLoading(false);
            }
        };
        const debounce = setTimeout(fetchTalent, seen ? 0 : 300);
        return () => {
            current = false;
            clearTimeout(debounce);
        };
    }, [key]);

    const activeFilterCount = [availableOnly, remoteOnly, btcOnly, !!workType].filter(Boolean).length;
    const filtering = !!(searchQuery || category || mineOnly || activeFilterCount);
    // "Yours" alone and nothing found: they haven't listed any talent yet.
    const noneOfYours = mineOnly && !searchQuery && !category && !activeFilterCount;

    return (
        <div className="talent-page container">
            {/* Desktop-only header — navbar shows the title on mobile */}
            <h1 className="page-header" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
                {t('pageTitles.talent')}
            </h1>

            <div className="tal-content">
                {/* Search row */}
                <div className="tal-search-row">
                    <div className="tal-search-bar">
                        <Search size={20} className="tal-search-icon" />
                        <input
                            type="text"
                            className="tal-search-input"
                            placeholder={t('talent.search')}
                            aria-label={t('talent.search')}
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                        />
                        <button
                            className="tal-filter-toggle"
                            onClick={() => setFiltersOpen(!filtersOpen)}
                            aria-label={t('common.filters')}
                            aria-expanded={filtersOpen}
                        >
                            <SlidersHorizontal size={20} />
                            {activeFilterCount > 0 && <span className="tal-filter-badge">{activeFilterCount}</span>}
                        </button>
                    </div>
                    <Link
                        to="/talents/new"
                        title={t('talent.add')}
                        aria-label={t('talent.add')}
                        style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            width: 44, height: 44, minWidth: 44, borderRadius: '50%',
                            background: 'var(--color-primary)', color: 'white', textDecoration: 'none', flexShrink: 0,
                        }}
                    >
                        <Plus size={24} strokeWidth={2.5} />
                    </Link>
                </div>

                {filtersOpen && (
                    <div className="tal-filters">
                        <div className="tal-checkbox-list">
                            <label>
                                <input type="checkbox" checked={availableOnly} onChange={() => setAvailableOnly((v) => !v)} />
                                {t('talent.filters.available')}
                            </label>
                            <label>
                                <input type="checkbox" checked={remoteOnly} onChange={() => setRemoteOnly((v) => !v)} />
                                {t('talent.filters.remote')}
                            </label>
                            <label>
                                <input type="checkbox" checked={btcOnly} onChange={() => setBtcOnly((v) => !v)} />
                                {t('talent.filters.btc')}
                            </label>
                        </div>
                        <div role="radiogroup" aria-labelledby="tal-worktype-label">
                            <span className="tal-filter-label" id="tal-worktype-label">{t('talent.filters.workType')}</span>
                            <div className="tal-chip-wrap">
                                {['', ...WORK_TYPES].map((w) => (
                                    <button
                                        key={w || 'any'}
                                        type="button"
                                        role="radio"
                                        aria-checked={workType === w}
                                        className={`tal-chip${workType === w ? ' active' : ''}`}
                                        onClick={() => setWorkType(w)}
                                    >
                                        {w ? t(`talent.workTypes.${w}`) : t('talent.filters.anyWork')}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                )}

                {/* Your own, then the kinds of talent */}
                <div className="tal-category-row" role="group" aria-label={t('talent.form.categoryLabel')}>
                    <button
                        type="button"
                        className={`tal-chip tal-chip-mine${mineOnly ? ' active' : ''}`}
                        aria-pressed={mineOnly}
                        onClick={() => setMineOnly((v) => !v)}
                    >
                        <UserRound size={14} aria-hidden="true" /> {t('talent.yours')}
                    </button>
                    {['', ...TALENT_CATEGORIES].map((c) => (
                        <button
                            key={c || 'all'}
                            type="button"
                            className={`tal-chip${category === c ? ' active' : ''}`}
                            aria-pressed={category === c}
                            onClick={() => setCategory(c)}
                        >
                            {c ? t(`talent.categories.${c}`) : t('talent.allCategories')}
                        </button>
                    ))}
                </div>

                {loading ? (
                    <div className="tal-loading">
                        <Loader2 size={32} style={{ animation: 'spin 1s linear infinite' }} />
                    </div>
                ) : talents.length > 0 ? (
                    <div className="tal-list">
                        {talents.map((talent) => (
                            <TalentCard key={talent.id} talent={talent} />
                        ))}
                    </div>
                ) : (
                    <div className="tal-empty">
                        <p className="tal-empty-text">
                            {searchQuery
                                ? t('talent.noResultsSearch', { query: searchQuery })
                                : noneOfYours ? t('talent.noneYours')
                                    : filtering ? t('talent.noMatches') : t('talent.empty')}
                        </p>
                        {(!filtering || noneOfYours) && (
                            <Link to="/talents/new" className="tal-empty-cta">
                                <Plus size={16} /> {t('talent.add')}
                            </Link>
                        )}
                    </div>
                )}
            </div>

            <style jsx>{`
                .talent-page {
                    padding-top: var(--page-top, 2rem);
                    padding-bottom: 4rem;
                    box-sizing: border-box;
                }
                .tal-content {
                    max-width: 760px;
                    margin: 0 auto;
                }
                .tal-search-row {
                    display: flex;
                    align-items: center;
                    gap: 0.75rem;
                    margin-bottom: 0.75rem;
                }
                .tal-search-bar {
                    display: flex;
                    align-items: center;
                    flex: 1;
                    min-width: 0;
                    background: var(--color-surface-raised);
                    padding: 0.5rem;
                    border-radius: var(--radius-full);
                    border: 1px solid var(--color-gray-200);
                    box-shadow: var(--shadow-sm);
                    transition: all 0.2s;
                }
                .tal-search-bar:focus-within {
                    border-color: var(--color-primary);
                    box-shadow: 0 0 0 3px rgba(0, 71, 171, 0.1);
                }
                .tal-search-bar :global(.tal-search-icon) {
                    margin-left: 0.75rem;
                    color: var(--color-gray-400);
                    flex-shrink: 0;
                }
                .tal-search-input {
                    flex: 1;
                    min-width: 0;
                    border: none;
                    background: none;
                    padding: 0.5rem 0.75rem;
                    outline: none;
                    font-size: 1rem;
                    color: inherit;
                }
                .tal-filter-toggle {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 44px;
                    height: 44px;
                    border-radius: 50%;
                    border: none;
                    background: none;
                    color: var(--color-gray-500);
                    cursor: pointer;
                    flex-shrink: 0;
                    position: relative;
                }
                .tal-filter-badge {
                    position: absolute;
                    top: 2px;
                    right: 2px;
                    width: 16px;
                    height: 16px;
                    border-radius: 50%;
                    background: var(--color-secondary);
                    color: white;
                    font-size: 0.65rem;
                    font-weight: 700;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }
                .tal-filters {
                    background: var(--color-surface);
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-lg);
                    padding: 1rem 1.25rem;
                    margin-bottom: 1rem;
                    display: flex;
                    flex-direction: column;
                    gap: 1rem;
                }
                .tal-filter-label {
                    display: block;
                    font-size: 0.9rem;
                    font-weight: 600;
                    margin-bottom: 0.5rem;
                }
                .tal-checkbox-list {
                    display: flex;
                    flex-direction: column;
                    gap: 0.5rem;
                    align-items: flex-start;
                }
                .tal-checkbox-list label {
                    font-weight: normal;
                    font-size: 0.9rem;
                    color: var(--color-gray-600);
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    cursor: pointer;
                    margin: 0;
                }
                .tal-checkbox-list input[type='checkbox'] {
                    width: 16px;
                    height: 16px;
                    margin: 0;
                    accent-color: var(--color-primary);
                    cursor: pointer;
                }
                .tal-chip-wrap {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 8px;
                }
                .tal-category-row {
                    display: flex;
                    gap: 8px;
                    overflow-x: auto;
                    margin: 0 0 1rem;
                    padding-bottom: 4px;
                    scrollbar-width: none;
                }
                .tal-category-row::-webkit-scrollbar { display: none; }
                .tal-chip {
                    flex-shrink: 0;
                    padding: 6px 14px;
                    border-radius: var(--radius-full);
                    border: 1px solid var(--color-gray-200);
                    background: var(--color-surface);
                    color: var(--color-gray-700);
                    font-size: 0.85rem;
                    font-weight: 500;
                    cursor: pointer;
                    white-space: nowrap;
                }
                .tal-chip-mine {
                    display: inline-flex;
                    align-items: center;
                    gap: 5px;
                }
                .tal-chip.active {
                    background: var(--color-primary);
                    border-color: var(--color-primary);
                    color: white;
                }
                .tal-list {
                    display: flex;
                    flex-direction: column;
                    gap: 1rem;
                }
                .tal-loading {
                    display: flex;
                    justify-content: center;
                    padding: 3rem;
                    color: var(--color-gray-500);
                }
                .tal-empty {
                    text-align: center;
                    padding: 3rem 1rem;
                    color: var(--color-gray-500);
                }
                .tal-empty-text {
                    margin: 0 auto;
                    max-width: 26rem;
                    line-height: 1.5;
                }
                .tal-empty :global(.tal-empty-cta) {
                    display: flex;
                    width: fit-content;
                    align-items: center;
                    gap: 6px;
                    margin: 1rem auto 0;
                    padding: 0.6rem 1.2rem;
                    border-radius: var(--radius-full);
                    background: var(--color-primary);
                    color: white;
                    font-weight: 600;
                    text-decoration: none;
                }
                @media (max-width: 768px) {
                    .page-header {
                        display: none !important;
                    }
                }
            `}</style>
        </div>
    );
};

export default TalentList;
