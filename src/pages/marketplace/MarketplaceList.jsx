import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Search, Plus, Store } from 'lucide-react';
import { nostrService } from '../../services/nostrService';
import { marketplaceApi } from '../../services/api';
import { MARKETPLACE_CATEGORIES, isBlocked } from '../../utils/nip99';
import { useAuth } from '../../context/AuthContext';
import MarketListingCard, { marketCategoryLabel } from '../../components/marketplace/MarketListingCard';

// MARKETPLACE_CATEGORIES is a list of lowercase slugs (see utils/nip99)
const CATEGORY_SLUGS = (MARKETPLACE_CATEGORIES || [])
    .map((c) => (typeof c === 'string' ? c : c?.id || c?.slug))
    .filter(Boolean);

/**
 * Marketplace browse page (NIP-99 / Shopstr-compatible), modeled on
 * DirectoryList.jsx: search row with a circular "+" button, BIES/Global
 * scope tabs, category chips, and a grid of MarketListingCard.
 */
const MarketplaceList = () => {
    const { t } = useTranslation();
    const { user } = useAuth();
    const myPubkey = user?.nostrPubkey || '';

    const [scope, setScope] = useState('bies'); // private relay is spam-free
    const [myOnly, setMyOnly] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedCategories, setSelectedCategories] = useState([]);
    const [showSold, setShowSold] = useState(false);

    const [listings, setListings] = useState([]);
    // { pubkeys: [...], addresses: [...] } from GET /marketplace/blocklist
    const [blocklist, setBlocklist] = useState(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(false);

    // Search + category filters are client-side; only scope changes refetch.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            setLoadError(false);
            try {
                const params = myOnly
                    ? { scope: 'global', authors: [myPubkey], limit: 100 }
                    : { scope, limit: 100 };
                const [result, blRes] = await Promise.all([
                    nostrService.fetchMarketplaceListings(params),
                    marketplaceApi.blocklist().catch(() => null),
                ]);
                if (cancelled) return;
                const bl = blRes?.data || blRes;
                setBlocklist(bl && typeof bl === 'object' && !Array.isArray(bl) ? bl : null);
                setListings(Array.isArray(result) ? result : []);
            } catch {
                if (!cancelled) {
                    setListings([]);
                    setLoadError(true);
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [scope, myOnly, myPubkey]);

    const toggleCategory = (slug) =>
        setSelectedCategories((prev) =>
            prev.includes(slug) ? prev.filter((c) => c !== slug) : [...prev, slug]
        );

    const q = searchQuery.trim().toLowerCase();
    const filtered = listings.filter((l) => {
        if (isBlocked(l, blocklist)) return false;
        // Sellers always see their own sold items (so they can reactivate them)
        if (!showSold && !myOnly && l.status === 'sold') return false;
        if (selectedCategories.length > 0
            && !(l.categories || []).some((c) => selectedCategories.includes(c))) return false;
        if (q) {
            const hay = `${l.title || ''} ${l.summary || ''} ${(l.categories || []).join(' ')}`.toLowerCase();
            if (!hay.includes(q)) return false;
        }
        return true;
    });

    return (
        <div className="market-page container">
            {/* Desktop-only header — navbar shows the title on mobile */}
            <h1 className="page-header" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
                {t('marketplace.title')}
            </h1>

            <div className="mk-content">
                {/* Search row */}
                <div className="mk-search-row">
                    <div className="mk-search-bar">
                        <Search size={20} className="mk-search-icon" />
                        <input
                            type="text"
                            className="mk-search-input"
                            placeholder={t('marketplace.searchPlaceholder')}
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                        />
                    </div>
                    <Link
                        to="/market/new"
                        className="market-add-btn"
                        title={t('marketplace.post')}
                        style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            width: 44, height: 44, minWidth: 44, borderRadius: '50%',
                            background: 'var(--color-primary)', color: 'white', textDecoration: 'none', flexShrink: 0
                        }}
                    >
                        <Plus size={24} strokeWidth={2.5} />
                    </Link>
                </div>

                {/* BIES / Global scope tabs */}
                <div className="mk-scope-toggle" role="tablist">
                    <button
                        type="button"
                        role="tab"
                        aria-selected={!myOnly && scope === 'bies'}
                        className={`mk-scope-btn ${!myOnly && scope === 'bies' ? 'active' : ''}`}
                        onClick={() => { setMyOnly(false); setScope('bies'); }}
                    >
                        {t('marketplace.scopeBies')}
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={!myOnly && scope === 'global'}
                        className={`mk-scope-btn ${!myOnly && scope === 'global' ? 'active' : ''}`}
                        onClick={() => { setMyOnly(false); setScope('global'); }}
                    >
                        {t('marketplace.scopeGlobal')}
                    </button>
                    {myPubkey && (
                        <button
                            type="button"
                            role="tab"
                            aria-selected={myOnly}
                            className={`mk-scope-btn ${myOnly ? 'active' : ''}`}
                            onClick={() => setMyOnly((v) => !v)}
                        >
                            {t('marketplace.myListings')}
                        </button>
                    )}
                </div>

                {/* Category chips + sold toggle */}
                <div className="mk-chips-row">
                    <button
                        type="button"
                        className={`mk-chip ${selectedCategories.length === 0 ? 'active' : ''}`}
                        onClick={() => setSelectedCategories([])}
                    >
                        {t('marketplace.allCategories')}
                    </button>
                    {CATEGORY_SLUGS.map((slug) => (
                        <button
                            key={slug}
                            type="button"
                            className={`mk-chip ${selectedCategories.includes(slug) ? 'active' : ''}`}
                            onClick={() => toggleCategory(slug)}
                        >
                            {marketCategoryLabel(t, slug)}
                        </button>
                    ))}
                </div>
                <label className="mk-sold-toggle">
                    <input
                        type="checkbox"
                        checked={showSold}
                        onChange={() => setShowSold((v) => !v)}
                    />
                    {t('marketplace.showSold')}
                </label>

                {/* Section header */}
                <div className="mk-section-header">
                    <div className="mk-section-icon">
                        <Store size={20} />
                    </div>
                    <div className="mk-section-text">
                        <h2>{t('marketplace.title')}</h2>
                        <p>{t('marketplace.subtitle')}</p>
                    </div>
                </div>

                {/* Grid */}
                {loading ? (
                    <div className="mk-grid" aria-hidden="true">
                        {[...Array(6)].map((_, i) => (
                            <div key={i} className="mk-skeleton">
                                <div className="mk-skeleton-photo" />
                                <div className="mk-skeleton-line" style={{ width: '80%' }} />
                                <div className="mk-skeleton-line" style={{ width: '45%' }} />
                            </div>
                        ))}
                    </div>
                ) : filtered.length > 0 ? (
                    <div className="mk-grid">
                        {filtered.map((listing) => (
                            <MarketListingCard key={`${listing.pubkey}:${listing.dTag}`} listing={listing} />
                        ))}
                    </div>
                ) : (
                    <div className="mk-empty">
                        {loadError
                            ? t('marketplace.loadError')
                            : q
                                ? t('marketplace.noResults', { query: searchQuery.trim() })
                                : t('marketplace.noListings')}
                    </div>
                )}
            </div>

            <style jsx>{`
                .market-page {
                    padding-top: 2rem;
                    padding-bottom: 4rem;
                    box-sizing: border-box;
                }

                .mk-content {
                    max-width: 900px;
                    margin: 0 auto;
                }

                .mk-search-row {
                    display: flex;
                    align-items: center;
                    gap: 0.75rem;
                    margin-bottom: 1rem;
                }

                .mk-search-bar {
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
                .mk-search-bar:focus-within {
                    border-color: var(--color-primary);
                    box-shadow: 0 0 0 3px rgba(0, 71, 171, 0.1);
                }
                .mk-search-icon {
                    margin-left: 0.75rem;
                    color: var(--color-gray-400);
                    flex-shrink: 0;
                }
                .mk-search-input {
                    flex: 1;
                    min-width: 0;
                    border: none;
                    background: none;
                    padding: 0.5rem 0.75rem;
                    outline: none;
                    font-size: 1rem;
                    color: inherit;
                }

                .mk-scope-toggle {
                    display: inline-flex;
                    gap: 4px;
                    background: var(--color-surface-raised);
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-full);
                    padding: 4px;
                    margin-bottom: 0.9rem;
                }
                .mk-scope-btn {
                    border: none;
                    background: none;
                    padding: 0.4rem 1rem;
                    border-radius: var(--radius-full);
                    font-size: 0.85rem;
                    font-weight: 600;
                    color: var(--color-gray-600);
                    cursor: pointer;
                    transition: background 0.15s, color 0.15s;
                    white-space: nowrap;
                }
                .mk-scope-btn.active {
                    background: var(--color-primary);
                    color: white;
                }

                .mk-chips-row {
                    display: flex;
                    gap: 0.5rem;
                    overflow-x: auto;
                    padding-bottom: 0.4rem;
                    margin-bottom: 0.5rem;
                    -webkit-overflow-scrolling: touch;
                    scrollbar-width: none;
                }
                .mk-chips-row::-webkit-scrollbar {
                    display: none;
                }
                .mk-chip {
                    flex-shrink: 0;
                    border: 1px solid var(--color-gray-200);
                    background: var(--color-surface);
                    color: var(--color-gray-600);
                    padding: 0.35rem 0.85rem;
                    border-radius: var(--radius-full);
                    font-size: 0.82rem;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.15s;
                    white-space: nowrap;
                }
                .mk-chip:hover {
                    border-color: var(--color-primary);
                    color: var(--color-primary);
                }
                .mk-chip.active {
                    background: var(--color-blue-tint);
                    border-color: var(--color-primary);
                    color: var(--color-primary);
                }

                .mk-sold-toggle {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    font-size: 0.85rem;
                    font-weight: 500;
                    color: var(--color-gray-600);
                    cursor: pointer;
                    margin: 0 0 1.25rem;
                    width: fit-content;
                }
                .mk-sold-toggle input[type='checkbox'] {
                    width: 16px;
                    height: 16px;
                    margin: 0;
                    accent-color: var(--color-primary);
                    cursor: pointer;
                }

                .mk-section-header {
                    display: flex;
                    align-items: center;
                    gap: 0.85rem;
                    margin-bottom: 1.25rem;
                }
                .mk-section-icon {
                    width: 44px;
                    height: 44px;
                    border-radius: 50%;
                    background: var(--color-blue-tint);
                    color: var(--color-primary);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    flex-shrink: 0;
                }
                .mk-section-text {
                    min-width: 0;
                }
                .mk-section-text h2 {
                    font-size: 1.15rem;
                    font-weight: 700;
                    margin: 0;
                }
                .mk-section-text p {
                    font-size: 0.85rem;
                    color: var(--color-gray-500);
                    margin: 2px 0 0;
                }

                .mk-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
                    gap: 1rem;
                    align-items: stretch;
                }
                @media (max-width: 480px) {
                    .mk-grid {
                        grid-template-columns: repeat(2, 1fr);
                        gap: 0.75rem;
                    }
                }

                .mk-skeleton {
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-lg);
                    overflow: hidden;
                    background: var(--color-surface);
                    padding-bottom: 0.9rem;
                }
                .mk-skeleton-photo {
                    width: 100%;
                    aspect-ratio: 4 / 3;
                    background: var(--color-gray-200);
                    animation: mkPulse 1.4s ease-in-out infinite;
                    margin-bottom: 0.75rem;
                }
                .mk-skeleton-line {
                    height: 12px;
                    border-radius: 6px;
                    background: var(--color-gray-200);
                    animation: mkPulse 1.4s ease-in-out infinite;
                    margin: 0 0.85rem 0.5rem;
                }
                @keyframes mkPulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.45; }
                }

                .mk-empty {
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

export default MarketplaceList;
