import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Search, SlidersHorizontal, Plus, Loader2, Bookmark } from 'lucide-react';
import { directoryApi } from '../../services/api';
import DirectoryListingCard from '../../components/directory/DirectoryListingCard';
import { DIRECTORY_CATEGORIES } from '../../components/directory/categories';
import { PRODUCE_KINDS, produceKind } from './produceIcons';

const FARM_PRACTICES = [
    { id: 'regenerative', tKey: 'directory.practices.regenerative' },
    { id: 'rotational-grazing', tKey: 'directory.practices.rotationalGrazing' },
    { id: 'no-gmo-feed', tKey: 'directory.practices.noGmoFeed' },
    { id: 'animal-welfare', tKey: 'directory.practices.animalWelfare' },
];

/**
 * Directory list page per the mockup: search row with filter toggle and
 * circular "+" button, tinted section header, listing cards, highest Trust
 * Score first. Farms and BIES Trusted (PROVIDER) are separate pages: farms
 * filter by what they sell, businesses by category.
 *
 * @param {'FARM'|'PROVIDER'} type
 */
const DirectoryList = ({ type = 'FARM' }) => {
    const { t } = useTranslation();
    const isFarm = type === 'FARM';

    const [searchQuery, setSearchQuery] = useState('');
    const [listings, setListings] = useState([]);
    const [loading, setLoading] = useState(true);
    const [filtersOpen, setFiltersOpen] = useState(false);

    // Farm filters
    const [selectedPractices, setSelectedPractices] = useState([]);
    // Shared / provider filters
    const [certifiedOnly, setCertifiedOnly] = useState(false);
    const [btcOnly, setBtcOnly] = useState(false);
    const [category, setCategory] = useState('');
    const [produce, setProduce] = useState(''); // FARM: a PRODUCE_KINDS key
    const [savedOnly, setSavedOnly] = useState(false); // the member's saved listings

    // Reset state when switching between /farms and /trusted
    useEffect(() => {
        setSearchQuery('');
        setSelectedPractices([]);
        setCertifiedOnly(false);
        setBtcOnly(false);
        setCategory('');
        setProduce('');
        setSavedOnly(false);
        setFiltersOpen(false);
    }, [type]);

    // Fetch listings (same 300ms debounce pattern as Discover)
    useEffect(() => {
        const fetchListings = async () => {
            setLoading(true);
            try {
                const params = { type, limit: 50, sort: 'score' };
                if (searchQuery) params.search = searchQuery;
                if (category) params.category = category;
                if (savedOnly) params.saved = 'true';
                const result = await directoryApi.list(params);
                const list = result?.data || result || [];
                setListings(Array.isArray(list) ? list : []);
            } catch {
                setListings([]);
            } finally {
                setLoading(false);
            }
        };
        const debounce = setTimeout(fetchListings, 300);
        return () => clearTimeout(debounce);
    }, [searchQuery, type, category, savedOnly]);

    // Client-side filtering (minimal drawer for now)
    const filtered = listings.filter((l) => {
        if (certifiedOnly && !l.isCertified) return false;
        if (isFarm) {
            if (produce && !(l.products || []).some((p) => produceKind(p) === produce)) return false;
            if (selectedPractices.length > 0) {
                const practices = l.practices || [];
                if (!selectedPractices.some((p) => practices.includes(p))) return false;
            }
        } else {
            if (btcOnly && !l.btcAccepted) return false;
        }
        return true;
    });

    const activeFilterCount = (isFarm ? selectedPractices.length : (btcOnly ? 1 : 0)) + (certifiedOnly ? 1 : 0);

    const togglePractice = (id) => {
        setSelectedPractices((prev) =>
            prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
        );
    };

    return (
        <div className="directory-page container">
            {/* Desktop-only header — navbar shows the title on mobile */}
            <h1 className="page-header" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
                {isFarm ? t('pageTitles.farmDirectory') : t('pageTitles.certifiedDirectory')}
            </h1>

            <div className="dir-content">
                {/* Search row */}
                <div className="dir-search-row">
                    <div className="dir-search-bar">
                        <Search size={20} className="dir-search-icon" />
                        <input
                            type="text"
                            className="dir-search-input"
                            placeholder={isFarm ? t('directory.searchFarms') : t('directory.searchProviders')}
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                        />
                        <button
                            className="dir-filter-toggle"
                            onClick={() => setFiltersOpen(!filtersOpen)}
                            aria-label={t('common.filters')}
                        >
                            <SlidersHorizontal size={20} />
                            {activeFilterCount > 0 && <span className="dir-filter-badge">{activeFilterCount}</span>}
                        </button>
                    </div>
                    <Link
                        to={isFarm ? '/farms/new' : '/trusted/new'}
                        className="directory-add-btn"
                        title={isFarm ? t('directory.createTitleFarm') : t('directory.createTitleProvider')}
                        aria-label={isFarm ? t('directory.createTitleFarm') : t('directory.createTitleProvider')}
                        style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            width: 44, height: 44, minWidth: 44, borderRadius: '50%',
                            background: 'var(--color-primary)', color: 'white', textDecoration: 'none', flexShrink: 0
                        }}
                    >
                        <Plus size={24} strokeWidth={2.5} />
                    </Link>
                </div>

                {/* Filter drawer (minimal for now) */}
                {filtersOpen && (
                    <div className="dir-filters">
                        {isFarm ? (
                            <>
                                <div className="dir-filter-group">
                                    <span className="dir-filter-label">{t('directory.practicesLabel')}</span>
                                    <div className="dir-checkbox-list">
                                        {FARM_PRACTICES.map((p) => (
                                            <label key={p.id}>
                                                <input
                                                    type="checkbox"
                                                    checked={selectedPractices.includes(p.id)}
                                                    onChange={() => togglePractice(p.id)}
                                                />
                                                {t(p.tKey)}
                                            </label>
                                        ))}
                                    </div>
                                </div>
                                <div className="dir-checkbox-list">
                                    <label>
                                        <input
                                            type="checkbox"
                                            checked={certifiedOnly}
                                            onChange={() => setCertifiedOnly(!certifiedOnly)}
                                        />
                                        {t('directory.certifiedOnly')}
                                    </label>
                                </div>
                            </>
                        ) : (
                            <>
                                <div className="dir-checkbox-list">
                                    <label>
                                        <input
                                            type="checkbox"
                                            checked={btcOnly}
                                            onChange={() => setBtcOnly(!btcOnly)}
                                        />
                                        {t('directory.acceptsBitcoin')}
                                    </label>
                                    <label>
                                        <input
                                            type="checkbox"
                                            checked={certifiedOnly}
                                            onChange={() => setCertifiedOnly(!certifiedOnly)}
                                        />
                                        {t('directory.certifiedOnly')}
                                    </label>
                                </div>
                            </>
                        )}
                    </div>
                )}

                {/* Farms by what they sell; BIES Trusted by category */}
                <div className="dir-category-row" role="group" aria-label={isFarm ? t('directory.whatTheyProduce') : t('directory.category')}>
                    <button
                        type="button"
                        className={`dir-chip dir-chip-saved${savedOnly ? ' active' : ''}`}
                        aria-pressed={savedOnly}
                        onClick={() => setSavedOnly((v) => !v)}
                    >
                        <Bookmark size={14} aria-hidden="true" /> {t('directory.actions.saved')}
                    </button>
                    {isFarm
                        ? ['', ...PRODUCE_KINDS].map((k) => (
                            <button
                                key={k || 'all'}
                                type="button"
                                className={`dir-chip${produce === k ? ' active' : ''}`}
                                aria-pressed={produce === k}
                                onClick={() => setProduce(k)}
                            >
                                {k ? t(`directory.produce.${k}`) : t('directory.allProduce')}
                            </button>
                        ))
                        : ['', ...DIRECTORY_CATEGORIES].map((c) => (
                            <button
                                key={c || 'all'}
                                type="button"
                                className={`dir-chip${category === c ? ' active' : ''}`}
                                aria-pressed={category === c}
                                onClick={() => setCategory(c)}
                            >
                                {c ? t(`directory.categories.${c}`) : t('directory.allCategories')}
                            </button>
                        ))}
                </div>

                {/* Listing cards */}
                {loading ? (
                    <div className="dir-loading">
                        <Loader2 size={32} style={{ animation: 'spin 1s linear infinite' }} />
                    </div>
                ) : filtered.length > 0 ? (
                    <div className="dir-list">
                        {filtered.map((listing) => (
                            <DirectoryListingCard key={listing.id} listing={listing} type={type} />
                        ))}
                    </div>
                ) : (
                    <div className="dir-empty">
                        {searchQuery
                            ? t('directory.noResultsSearch', { query: searchQuery })
                            : savedOnly ? t('directory.noSaved')
                                : isFarm ? t('directory.noFarms') : t('directory.noProviders')}
                        {!searchQuery && !savedOnly && (
                            <Link to={isFarm ? '/farms/new' : '/trusted/new'} className="dir-empty-cta">
                                <Plus size={16} /> {isFarm ? t('directory.createTitleFarm') : t('directory.createTitleProvider')}
                            </Link>
                        )}
                    </div>
                )}
            </div>

            <style jsx>{`
                .directory-page {
                    padding-top: var(--page-top, 2rem);
                    padding-bottom: 4rem;
                    box-sizing: border-box;
                }

                .dir-content {
                    max-width: 760px;
                    margin: 0 auto;
                }

                .dir-search-row {
                    display: flex;
                    align-items: center;
                    gap: 0.75rem;
                    margin-bottom: 1.5rem;
                }

                .dir-search-bar {
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
                .dir-search-bar:focus-within {
                    border-color: var(--color-primary);
                    box-shadow: 0 0 0 3px rgba(0, 71, 171, 0.1);
                }

                .dir-search-icon {
                    margin-left: 0.75rem;
                    color: var(--color-gray-400);
                    flex-shrink: 0;
                }

                .dir-search-input {
                    flex: 1;
                    min-width: 0;
                    border: none;
                    background: none;
                    padding: 0.5rem 0.75rem;
                    outline: none;
                    font-size: 1rem;
                    color: inherit;
                }

                .dir-filter-toggle {
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
                .dir-filter-badge {
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

                .dir-category-row {
                    display: flex;
                    gap: 8px;
                    overflow-x: auto;
                    margin: 0 0 1rem;
                    padding-bottom: 4px;
                    scrollbar-width: none;
                }
                .dir-category-row::-webkit-scrollbar { display: none; }
                .dir-chip {
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
                .dir-chip-saved {
                    display: inline-flex;
                    align-items: center;
                    gap: 5px;
                }
                .dir-chip.active {
                    background: var(--color-primary);
                    border-color: var(--color-primary);
                    color: white;
                }
                .dir-empty :global(.dir-empty-cta) {
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
                .dir-filters {
                    background: var(--color-surface);
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-lg);
                    padding: 1rem 1.25rem;
                    margin-bottom: 1.5rem;
                    display: flex;
                    flex-direction: column;
                    gap: 1rem;
                }

                .dir-filter-label {
                    display: block;
                    font-size: 0.9rem;
                    font-weight: 600;
                    margin-bottom: 0.5rem;
                }

                .dir-checkbox-list {
                    display: flex;
                    flex-direction: column;
                    gap: 0.5rem;
                    align-items: flex-start;
                }
                .dir-checkbox-list label {
                    font-weight: normal;
                    font-size: 0.9rem;
                    color: var(--color-gray-600);
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    cursor: pointer;
                    margin: 0;
                }
                .dir-checkbox-list input[type='checkbox'] {
                    width: 16px;
                    height: 16px;
                    margin: 0;
                    accent-color: var(--color-primary);
                    cursor: pointer;
                }

                .dir-list {
                    display: flex;
                    flex-direction: column;
                    gap: 1rem;
                }

                .dir-loading {
                    display: flex;
                    justify-content: center;
                    padding: 3rem;
                    color: var(--color-gray-500);
                }

                .dir-empty {
                    text-align: center;
                    padding: 3rem 1rem;
                    color: var(--color-gray-500);
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

export default DirectoryList;
