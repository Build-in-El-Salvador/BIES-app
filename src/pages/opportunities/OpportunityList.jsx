import React, { useState, useEffect, useRef } from 'react';
import { cachedList, rememberList } from '../../utils/listCache';
import { opportunitiesKey, opportunitiesRequest } from '../../utils/listRequests';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Search, SlidersHorizontal, Plus, Loader2, UserRound, Bookmark } from 'lucide-react';
import { projectsApi } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import OpportunityCard from '../../components/opportunities/OpportunityCard';
import {
    OPPORTUNITY_KINDS, INDUSTRIES, STAGES, amountOf, hasField, shortDollars, typesShown, isTypeShown,
} from '../../components/opportunities/opportunityOptions';
import { isNativePlatform } from '../../utils/platform';

/** The amounts the price filter offers, in dollars. */
const AMOUNTS = [10000, 50000, 100000, 250000, 500000, 1000000, 5000000];

// The phone app leaves some types out (config/appScope.js).
const NATIVE = isNativePlatform();
const TYPES = typesShown(NATIVE);

const typeFrom = (value) => (TYPES.includes(value) ? value : '');

/** The search and filters, as the address keeps them; what doesn't fit the type is left out. */
function filtersFrom(params) {
    const type = typeFrom(params.get('type'));
    const mineOnly = params.get('mine') === '1';
    const kind = params.get('kind') || '';
    const stage = params.get('stage') || '';
    const industry = params.get('industry') || '';
    const amount = (key) => (type && amountOf({ type }) && AMOUNTS.map(String).includes(params.get(key)) ? params.get(key) : '');
    return {
        type,
        mineOnly,
        savedOnly: !mineOnly && params.get('saved') === '1',
        kind: type && type !== 'investment' && OPPORTUNITY_KINDS[type].includes(kind) ? kind : '',
        stage: type === 'investment' && STAGES.includes(stage) ? stage : '',
        category: INDUSTRIES.includes(industry) ? industry : '',
        minAmount: amount('min'),
        maxAmount: amount('max'),
        remoteOnly: params.get('remote') === '1' && (!type || hasField(type, 'remote')),
        btcOnly: params.get('btc') === '1' && (!type || hasField(type, 'btcAccepted')),
        query: (params.get('q') || '').slice(0, 100),
    };
}

/**
 * Opportunities: what members post for others to take up, laid out like
 * BIES Talents: the search row with the filter toggle and the round "+",
 * chips for your own, the ones you saved and each type, then the cards.
 * The filters follow the type: a job's hours, a raise's stage and size, a
 * business's price; then the industry, remote and bitcoin. All of it is in
 * the address (?type=job&kind=part-time&q=…, ?mine=1, ?saved=1), so Back, a
 * refresh, the Opportunities tab and a shared link show what they say.
 */
const OpportunityList = () => {
    const { t } = useTranslation();
    const { user } = useAuth();
    const [params, setParams] = useSearchParams();
    const { type, mineOnly, savedOnly, kind, stage, category, minAmount, maxAmount, remoteOnly, btcOnly, query } = filtersFrom(params);

    // What's typed in the search box; it goes into the address after a pause.
    const [searchQuery, setSearchQuery] = useState(query);
    const [filtersOpen, setFiltersOpen] = useState(() => [...params.keys()].some((key) => ['kind', 'stage', 'industry', 'min', 'max', 'remote', 'btc'].includes(key)));
    const [opportunities, setOpportunities] = useState([]);
    const [loading, setLoading] = useState(true);

    /** Changes the address (in place: no new step for Back): each key set, or taken out when empty. */
    const update = (changes) => setParams((prev) => {
        const next = new URLSearchParams(prev);
        for (const [key, value] of Object.entries(changes)) {
            if (value) next.set(key, String(value));
            else next.delete(key);
        }
        return next;
    }, { replace: true });
    // For the search box's pause: React Router gives an updater the address of
    // the render that made it, so a chip tapped during the pause would be undone.
    const latestUpdate = useRef(update);
    useEffect(() => { latestUpdate.current = update; });

    // The search box follows the address when something else changes it (the
    // Opportunities tab, Back); what was just typed isn't put back.
    const typed = useRef(query);
    useEffect(() => {
        if (query === typed.current) return;
        typed.current = query;
        setSearchQuery(query);
    }, [query]);
    useEffect(() => {
        if (searchQuery.slice(0, 100) === query) return undefined;
        const pause = setTimeout(() => {
            const value = searchQuery.slice(0, 100);
            typed.current = value.trim() ? value : '';
            latestUpdate.current({ q: typed.current });
        }, 300);
        return () => clearTimeout(pause);
    }, [searchQuery]);

    // What the chosen type can be filtered by (all of them, with no type). An
    // investment goes by its stage and size; its deal shows on its page.
    const kinds = type && type !== 'investment' ? OPPORTUNITY_KINDS[type] : [];
    const amount = type ? amountOf({ type }) : null;
    const canRemote = !type || hasField(type, 'remote');
    const canBtc = !type || hasField(type, 'btcAccepted');

    const chooseType = (next) => {
        if (next === type) return;
        // The filters of one type don't carry over to another.
        update({
            type: next,
            kind: '',
            stage: '',
            ...(!next || !amountOf({ type: next }) ? { min: '', max: '' } : {}),
            ...(next && !hasField(next, 'remote') ? { remote: '' } : {}),
            ...(next && !hasField(next, 'btcAccepted') ? { btc: '' } : {}),
        });
    };

    const clearFilters = () => update({ kind: '', stage: '', industry: '', min: '', max: '', remote: '', btc: '' });

    // Fetch on each change (the search is already paused for). An answer that
    // arrives after the search or filters changed again is dropped.
    useEffect(() => {
        let current = true;
        (async () => {
            const request = opportunitiesRequest(
                { query, type, kind, stage, category, minAmount, maxAmount, remoteOnly, btcOnly, mineOnly, savedOnly },
                { types: NATIVE ? TYPES : null, userId: user?.id },
            );
            // A list shown before appears at once (utils/listCache.js) and is
            // then refreshed; a new one shows the spinner.
            const key = opportunitiesKey(request);
            const seen = cachedList(key);
            if (seen) {
                setOpportunities(seen);
                setLoading(false);
            } else {
                setLoading(true);
            }
            try {
                const result = await projectsApi.list(request);
                const found = (Array.isArray(result?.data) ? result.data : []).filter((o) => isTypeShown(o.type, NATIVE));
                rememberList(key, found);
                if (current) setOpportunities(found);
            } catch {
                if (current && !seen) setOpportunities([]);
            } finally {
                if (current) setLoading(false);
            }
        })();
        return () => { current = false; };
    }, [query, type, kind, stage, category, minAmount, maxAmount, remoteOnly, btcOnly, mineOnly, savedOnly, user?.id]);

    const activeFilterCount = [kind, stage, category, minAmount || maxAmount, remoteOnly, btcOnly].filter(Boolean).length;
    const filtering = !!(query || type || mineOnly || savedOnly || activeFilterCount);
    const newLink = type ? `/opportunities/new?type=${type}` : '/opportunities/new';
    const btcLabel = t(`opportunities.filters.btc.${type || 'any'}`);

    const emptyText = query ? t('opportunities.noResultsSearch', { query })
        : mineOnly && !type && !activeFilterCount ? t('opportunities.noneYours')
            : savedOnly && !type && !activeFilterCount ? t('opportunities.noneSaved')
                : filtering ? t('opportunities.noMatches') : t('opportunities.empty');
    const offerToPost = !filtering || (mineOnly && !activeFilterCount && !query);

    const chip = (active, onClick, label, key, extra = {}) => (
        <button key={key} type="button" className={`opp-chip${active ? ' active' : ''}`} aria-pressed={active} onClick={onClick} {...extra}>
            {label}
        </button>
    );

    return (
        <div className="opportunities-page container">
            {/* Desktop-only header — navbar shows the title on mobile */}
            <h1 className="page-header" style={{ textAlign: 'center', marginBottom: '0.5rem' }}>
                {t('pageTitles.opportunities')}
            </h1>
            <p className="opp-intro">{t('opportunities.intro')}</p>

            <div className="opp-content">
                {/* Search row */}
                <div className="opp-search-row">
                    <div className="opp-search-bar">
                        <Search size={20} className="opp-search-icon" />
                        <input
                            type="text"
                            className="opp-search-input"
                            placeholder={t('opportunities.search')}
                            aria-label={t('opportunities.search')}
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                        />
                        <button
                            className="opp-filter-toggle"
                            onClick={() => setFiltersOpen(!filtersOpen)}
                            aria-label={t('common.filters')}
                            aria-expanded={filtersOpen}
                        >
                            <SlidersHorizontal size={20} />
                            {activeFilterCount > 0 && <span className="opp-filter-badge">{activeFilterCount}</span>}
                        </button>
                    </div>
                    <Link
                        to={newLink}
                        title={t('opportunities.add')}
                        aria-label={t('opportunities.add')}
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
                    <div className="opp-filters">
                        {kinds.length > 0 && (
                            <div role="group" aria-labelledby="opp-kind-label">
                                <span className="opp-filter-label" id="opp-kind-label">{t(`opportunities.filters.kind.${type}`)}</span>
                                <div className="opp-chip-wrap">
                                    {chip(!kind, () => update({ kind: '' }), t('opportunities.filters.any'), 'any')}
                                    {kinds.map((k) => chip(kind === k, () => update({ kind: kind === k ? '' : k }), t(`opportunities.kinds.${type}.${k}`), k))}
                                </div>
                            </div>
                        )}

                        {type === 'investment' && (
                            <div role="group" aria-labelledby="opp-stage-label">
                                <span className="opp-filter-label" id="opp-stage-label">{t('opportunities.stage')}</span>
                                <div className="opp-chip-wrap">
                                    {chip(!stage, () => update({ stage: '' }), t('opportunities.filters.any'), 'any')}
                                    {STAGES.map((s) => chip(stage === s, () => update({ stage: stage === s ? '' : s }), t(`opportunities.stages.${s}`), s))}
                                </div>
                            </div>
                        )}

                        {amount && (
                            <div>
                                <span className="opp-filter-label" id="opp-amount-label">{t(`opportunities.filters.amount.${type}`)}</span>
                                <div className="opp-amount-row">
                                    <select
                                        className="opp-select"
                                        value={minAmount}
                                        onChange={(e) => update({ min: e.target.value })}
                                        aria-label={t('opportunities.filters.min')}
                                    >
                                        <option value="">{t('opportunities.filters.min')}</option>
                                        {AMOUNTS.map((a) => <option key={a} value={a}>{shortDollars(a)}</option>)}
                                    </select>
                                    <span aria-hidden="true">–</span>
                                    <select
                                        className="opp-select"
                                        value={maxAmount}
                                        onChange={(e) => update({ max: e.target.value })}
                                        aria-label={t('opportunities.filters.max')}
                                    >
                                        <option value="">{t('opportunities.filters.max')}</option>
                                        {AMOUNTS.map((a) => <option key={a} value={a}>{shortDollars(a)}</option>)}
                                    </select>
                                </div>
                            </div>
                        )}

                        <div>
                            <label className="opp-filter-label" htmlFor="opp-industry">{t('opportunities.industry')}</label>
                            <select id="opp-industry" className="opp-select" value={category} onChange={(e) => update({ industry: e.target.value })}>
                                <option value="">{t('opportunities.filters.anyIndustry')}</option>
                                {INDUSTRIES.map((c) => <option key={c} value={c}>{t(`opportunities.industries.${c}`)}</option>)}
                            </select>
                        </div>

                        {(canRemote || canBtc) && (
                            <div className="opp-checkbox-list">
                                {canRemote && (
                                    <label>
                                        <input type="checkbox" checked={remoteOnly} onChange={() => update({ remote: remoteOnly ? '' : '1' })} />
                                        {t('opportunities.filters.remote')}
                                    </label>
                                )}
                                {canBtc && (
                                    <label>
                                        <input type="checkbox" checked={btcOnly} onChange={() => update({ btc: btcOnly ? '' : '1' })} />
                                        {btcLabel}
                                    </label>
                                )}
                            </div>
                        )}

                        {activeFilterCount > 0 && (
                            <button type="button" className="opp-clear" onClick={clearFilters}>{t('opportunities.filters.clear')}</button>
                        )}
                    </div>
                )}

                {/* Your own, the ones you saved, then the types */}
                <div className="opp-type-row" role="group" aria-label={t('opportunities.typeLabel')}>
                    <button
                        type="button"
                        className={`opp-chip opp-chip-icon${mineOnly ? ' active' : ''}`}
                        aria-pressed={mineOnly}
                        onClick={() => update({ mine: mineOnly ? '' : '1', saved: '' })}
                    >
                        <UserRound size={14} aria-hidden="true" /> {t('opportunities.yours')}
                    </button>
                    <button
                        type="button"
                        className={`opp-chip opp-chip-icon${savedOnly ? ' active' : ''}`}
                        aria-pressed={savedOnly}
                        onClick={() => update({ saved: savedOnly ? '' : '1', mine: '' })}
                    >
                        <Bookmark size={14} aria-hidden="true" /> {t('opportunities.saved')}
                    </button>
                    {chip(!type, () => chooseType(''), t('opportunities.allTypes'), 'all')}
                    {TYPES.map((ty) => chip(type === ty, () => chooseType(ty), t(`opportunities.typesPlural.${ty}`), ty))}
                </div>

                {loading ? (
                    <div className="opp-loading">
                        <Loader2 size={32} style={{ animation: 'spin 1s linear infinite' }} aria-label={t('common.loading', 'Loading')} />
                    </div>
                ) : opportunities.length > 0 ? (
                    <div className="opp-list">
                        {opportunities.map((o) => <OpportunityCard key={o.id} opportunity={o} />)}
                    </div>
                ) : (
                    <div className="opp-empty">
                        <p className="opp-empty-text">{emptyText}</p>
                        {offerToPost && (
                            <Link to={newLink} className="opp-empty-cta">
                                <Plus size={16} /> {t('opportunities.add')}
                            </Link>
                        )}
                    </div>
                )}
            </div>

            <style jsx>{`
                .opportunities-page {
                    padding-top: var(--page-top, 2rem);
                    padding-bottom: 4rem;
                    box-sizing: border-box;
                }
                .opp-intro {
                    text-align: center;
                    color: var(--color-gray-500);
                    margin: 0 auto 1.5rem;
                    max-width: 34rem;
                    line-height: 1.5;
                }
                .opp-content {
                    max-width: 760px;
                    margin: 0 auto;
                }
                .opp-search-row {
                    display: flex;
                    align-items: center;
                    gap: 0.75rem;
                    margin-bottom: 0.75rem;
                }
                .opp-search-bar {
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
                .opp-search-bar:focus-within {
                    border-color: var(--color-primary);
                    box-shadow: 0 0 0 3px rgba(0, 71, 171, 0.1);
                }
                .opp-search-bar :global(.opp-search-icon) {
                    margin-left: 0.75rem;
                    color: var(--color-gray-400);
                    flex-shrink: 0;
                }
                .opp-search-input {
                    flex: 1;
                    min-width: 0;
                    border: none;
                    background: none;
                    padding: 0.5rem 0.75rem;
                    outline: none;
                    font-size: 1rem;
                    color: inherit;
                }
                .opp-filter-toggle {
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
                .opp-filter-badge {
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
                .opp-filters {
                    background: var(--color-surface);
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-lg);
                    padding: 1rem 1.25rem;
                    margin-bottom: 1rem;
                    display: flex;
                    flex-direction: column;
                    gap: 1rem;
                }
                .opp-filter-label {
                    display: block;
                    font-size: 0.9rem;
                    font-weight: 600;
                    margin-bottom: 0.5rem;
                }
                .opp-select {
                    width: 100%;
                    padding: 0.55rem 0.75rem;
                    border-radius: var(--radius-md);
                    border: 1px solid var(--color-gray-300);
                    background: var(--color-surface);
                    color: inherit;
                    font-size: 0.9rem;
                    appearance: auto;
                    cursor: pointer;
                }
                .opp-amount-row {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    color: var(--color-gray-500);
                }
                .opp-checkbox-list {
                    display: flex;
                    flex-direction: column;
                    gap: 0.5rem;
                    align-items: flex-start;
                }
                .opp-checkbox-list label {
                    font-size: 0.9rem;
                    color: var(--color-gray-600);
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    cursor: pointer;
                    margin: 0;
                }
                .opp-checkbox-list input[type='checkbox'] {
                    width: 16px;
                    height: 16px;
                    margin: 0;
                    accent-color: var(--color-primary);
                    cursor: pointer;
                }
                .opp-clear {
                    align-self: flex-start;
                    background: none;
                    border: none;
                    padding: 0;
                    color: var(--color-primary);
                    font-weight: 600;
                    font-size: 0.9rem;
                    cursor: pointer;
                }
                .opp-chip-wrap {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 8px;
                }
                .opp-type-row {
                    display: flex;
                    gap: 8px;
                    overflow-x: auto;
                    margin: 0 0 1rem;
                    padding-bottom: 4px;
                    scrollbar-width: none;
                }
                .opp-type-row::-webkit-scrollbar { display: none; }
                .opportunities-page :global(.opp-chip) {
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
                .opportunities-page :global(.opp-chip-icon) {
                    display: inline-flex;
                    align-items: center;
                    gap: 5px;
                }
                .opportunities-page :global(.opp-chip.active) {
                    background: var(--color-primary);
                    border-color: var(--color-primary);
                    color: white;
                }
                .opp-list {
                    display: flex;
                    flex-direction: column;
                    gap: 1rem;
                }
                .opp-loading {
                    display: flex;
                    justify-content: center;
                    padding: 3rem;
                    color: var(--color-gray-500);
                }
                .opp-empty {
                    text-align: center;
                    padding: 3rem 1rem;
                    color: var(--color-gray-500);
                }
                .opp-empty-text {
                    margin: 0 auto;
                    max-width: 26rem;
                    line-height: 1.5;
                }
                .opp-empty :global(.opp-empty-cta) {
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
                    .page-header,
                    .opp-intro {
                        display: none !important;
                    }
                }
            `}</style>
        </div>
    );
};

export default OpportunityList;
