import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
    ArrowLeft, MapPin, Loader2, Package, ExternalLink, MessageCircle,
    Edit3, Trash2, Tag, CheckCircle, RefreshCw, EyeOff, Ban, ShieldOff, User,
} from 'lucide-react';
import { nostrService } from '../../services/nostrService';
import { marketplaceApi } from '../../services/api';
import { shopstrUrl, isBlocked } from '../../utils/nip99';
import { nostrSigner } from '../../services/nostrSigner';
import { useAuth } from '../../context/AuthContext';
import ZapButton from '../../components/ZapButton';
import {
    marketCategoryLabel,
    formatListingPrice,
    isSensitiveListing,
} from '../../components/marketplace/MarketListingCard';

/**
 * Marketplace listing detail page, modeled on directory/ListingDetail.jsx:
 * hero photo (with content-warning blur), title + price, seller row, plain-text
 * description, buyer actions (Shopstr / DM / zap) and seller/admin controls.
 */
const MarketListingDetail = () => {
    const { naddr } = useParams();
    const navigate = useNavigate();
    const { t } = useTranslation();
    const { user, isStaff } = useAuth();

    const [listing, setListing] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [activeImage, setActiveImage] = useState(0);
    const [revealed, setRevealed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [actionError, setActionError] = useState('');

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            setError(null);
            setActiveImage(0);
            setRevealed(false);
            try {
                const [result, blRes] = await Promise.all([
                    nostrService.fetchMarketplaceListing(naddr),
                    // Moderation blocklist applies on the detail page too, not
                    // just the browse grid (deep links via naddr).
                    marketplaceApi.blocklist().catch(() => null),
                ]);
                const bl = blRes?.data || blRes;
                if (result && bl && isBlocked(result, bl)) {
                    if (!cancelled) setListing(null);
                    return;
                }
                // Single-listing fetch doesn't attach seller info — enrich from kind:0
                if (result && !result.sellerName) {
                    try {
                        const profiles = await nostrService.getProfiles([result.pubkey]);
                        const profile = profiles?.get?.(result.pubkey);
                        result.sellerName = profile?.display_name || profile?.name || '';
                        result.sellerAvatar = profile?.picture || '';
                    } catch { /* non-blocking */ }
                }
                if (!cancelled) setListing(result || null);
            } catch (err) {
                if (!cancelled) setError(err.message || 'Failed to load listing');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [naddr]);

    if (loading) {
        return (
            <div className="market-detail-page">
                <div className="container" style={{ textAlign: 'center', padding: '4rem 0' }}>
                    <Loader2 size={32} style={{ animation: 'spin 1s linear infinite', margin: '0 auto', color: 'var(--color-gray-500)' }} />
                </div>
            </div>
        );
    }

    if (error || !listing) {
        return (
            <div className="market-detail-page">
                <div className="container">
                    <div style={{ textAlign: 'center', padding: '4rem 0' }}>
                        <h2>{t('marketplace.loadError')}</h2>
                        <Link
                            to="/discover/market"
                            style={{
                                marginTop: '1.5rem', display: 'inline-flex', alignItems: 'center', gap: 8,
                                textDecoration: 'none', fontWeight: 500, color: 'var(--color-primary)',
                            }}
                        >
                            <ArrowLeft size={16} /> {t('marketplace.title')}
                        </Link>
                    </div>
                </div>
            </div>
        );
    }

    const myPubkey = user?.nostrPubkey || '';
    const isSeller = !!myPubkey && myPubkey === listing.pubkey;
    const isSold = listing.status === 'sold';
    const sensitive = isSensitiveListing(listing);
    const blurImages = sensitive && !revealed;
    const images = Array.isArray(listing.images) ? listing.images.filter(Boolean) : [];
    const priceLabel = formatListingPrice(listing.price);
    const publishedTs = Number(listing.publishedAt || listing.createdAt) || 0;
    const publishedDate = publishedTs ? new Date(publishedTs * 1000).toLocaleDateString() : '';

    // Republish with the status flipped — reuses dTag + publishedAt so the
    // addressable event (30402:<pubkey>:<d>) replaces the old version.
    const handleToggleSold = async () => {
        setBusy(true);
        setActionError('');
        try {
            const payload = {
                dTag: listing.dTag,
                title: listing.title,
                summary: listing.summary,
                description: listing.content,
                price: listing.price,
                images,
                location: listing.location,
                categories: listing.categories,
                publishedAt: listing.publishedAt,
                status: isSold ? 'active' : 'sold',
            };
            if (nostrSigner.signsOnDevice) {
                await nostrService.publishMarketplaceListing(payload);
            } else {
                await marketplaceApi.publish(payload);
            }
            setListing((prev) => ({ ...prev, status: payload.status }));
        } catch (err) {
            setActionError(err.message || 'Failed to update listing');
        } finally {
            setBusy(false);
        }
    };

    const handleDelete = async () => {
        if (!window.confirm(t('marketplace.deleteConfirm'))) return;
        setBusy(true);
        setActionError('');
        try {
            if (nostrSigner.signsOnDevice) {
                await nostrService.deleteMarketplaceListing(listing.id, listing.dTag);
            } else {
                await marketplaceApi.remove({ eventId: listing.id, dTag: listing.dTag });
            }
            navigate('/discover/market');
        } catch (err) {
            setActionError(err.message || 'Failed to delete listing');
            setBusy(false);
        }
    };

    const handleAdminBlock = async (type, value) => {
        setBusy(true);
        setActionError('');
        try {
            await marketplaceApi.block({ type, value });
            navigate('/discover/market');
        } catch (err) {
            setActionError(err.message || 'Failed to block');
            setBusy(false);
        }
    };

    return (
        <div className="market-detail-page">
            {/* Hero image — full-bleed on mobile, rounded column on desktop */}
            <div className="mk-hero-wrap">
                <div className="mk-hero">
                    {images[activeImage] ? (
                        <img
                            src={images[activeImage]}
                            alt={listing.title || ''}
                            loading="lazy"
                            className="mk-hero-img"
                            style={blurImages ? { filter: 'blur(24px)' } : undefined}
                        />
                    ) : (
                        <div className="mk-hero-fallback">
                            <Package size={56} />
                        </div>
                    )}
                    {blurImages && images.length > 0 && (
                        <div className="mk-cw-overlay">
                            <EyeOff size={28} />
                            <span>{t('marketplace.contentWarning')}</span>
                            <button type="button" className="mk-cw-reveal" onClick={() => setRevealed(true)}>
                                {t('marketplace.revealImage')}
                            </button>
                        </div>
                    )}
                    {isSold && <span className="mk-detail-sold">{t('marketplace.sold')}</span>}
                    <Link
                        to="/discover/market"
                        aria-label={t('marketplace.title')}
                        style={{
                            position: 'absolute', top: 16, left: 16,
                            width: 42, height: 42, borderRadius: '50%',
                            background: 'var(--color-surface)', border: '1px solid var(--color-gray-200)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            textDecoration: 'none', color: 'var(--color-gray-700)',
                            boxShadow: '0 1px 3px rgba(0,0,0,0.15)', zIndex: 5,
                        }}
                    >
                        <ArrowLeft size={20} />
                    </Link>
                </div>
                {images.length > 1 && (
                    <div className="mk-thumbs">
                        {images.map((img, i) => (
                            <button
                                key={`${img}-${i}`}
                                type="button"
                                className={`mk-thumb ${i === activeImage ? 'active' : ''}`}
                                onClick={() => setActiveImage(i)}
                            >
                                <img
                                    src={img}
                                    alt=""
                                    loading="lazy"
                                    style={blurImages ? { filter: 'blur(8px)' } : undefined}
                                />
                            </button>
                        ))}
                    </div>
                )}
            </div>

            <div className="container">
                <div className="mk-detail-content">
                    <div className="mk-head-row">
                        <h1 className="mk-detail-title">{listing.title}</h1>
                        {priceLabel && <span className="mk-detail-price">{priceLabel}</span>}
                    </div>

                    {/* Seller */}
                    <div className="mk-seller-row">
                        <div className="mk-seller-avatar">
                            {listing.sellerAvatar ? (
                                <img src={listing.sellerAvatar} alt="" loading="lazy" />
                            ) : (
                                <User size={18} />
                            )}
                        </div>
                        <span className="mk-seller-name">
                            {listing.sellerName || `${(listing.pubkey || '').slice(0, 12)}…`}
                        </span>
                        {publishedDate && <span className="mk-published">{publishedDate}</span>}
                    </div>

                    {listing.location && (
                        <div className="mk-detail-meta">
                            <MapPin size={16} />
                            <span>{listing.location}</span>
                        </div>
                    )}

                    {actionError && <p className="mk-action-error">{actionError}</p>}

                    {/* Actions */}
                    <div className="mk-actions">
                        <a
                            className="mk-action-btn"
                            href={shopstrUrl(listing.naddr)}
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            <ExternalLink size={15} /> {t('marketplace.viewOnShopstr')}
                        </a>
                        {!isSeller && (
                            <>
                                <button
                                    type="button"
                                    className="mk-action-btn"
                                    onClick={() => navigate('/messages', { state: { pubkey: listing.pubkey } })}
                                >
                                    <MessageCircle size={15} /> {t('marketplace.messageSeller')}
                                </button>
                                <ZapButton
                                    recipients={[{
                                        pubkey: listing.pubkey,
                                        name: listing.sellerName || 'Seller',
                                        avatar: listing.sellerAvatar || '',
                                    }]}
                                    eventId={listing.id}
                                    label={t('marketplace.zapSeller')}
                                />
                            </>
                        )}
                        {isSeller && (
                            <>
                                <Link
                                    to={`/discover/market/${listing.naddr}/edit`}
                                    className="mk-action-btn"
                                    style={{ textDecoration: 'none' }}
                                >
                                    <Edit3 size={15} /> {t('marketplace.edit')}
                                </Link>
                                <button
                                    type="button"
                                    className="mk-action-btn"
                                    onClick={handleToggleSold}
                                    disabled={busy}
                                >
                                    {isSold ? <RefreshCw size={15} /> : <CheckCircle size={15} />}
                                    {isSold ? t('marketplace.reactivate') : t('marketplace.markSold')}
                                </button>
                                <button
                                    type="button"
                                    className="mk-action-btn danger"
                                    onClick={handleDelete}
                                    disabled={busy}
                                >
                                    <Trash2 size={15} /> {t('marketplace.delete')}
                                </button>
                            </>
                        )}
                    </div>

                    {/* Admin moderation */}
                    {isStaff && !isSeller && (
                        <div className="mk-admin-row">
                            <button
                                type="button"
                                className="mk-admin-btn"
                                disabled={busy}
                                onClick={() => handleAdminBlock('address', `30402:${listing.pubkey}:${listing.dTag}`)}
                            >
                                <ShieldOff size={14} /> {t('marketplace.adminHide')}
                            </button>
                            <button
                                type="button"
                                className="mk-admin-btn"
                                disabled={busy}
                                onClick={() => handleAdminBlock('pubkey', listing.pubkey)}
                            >
                                <Ban size={14} /> {t('marketplace.adminBlockSeller')}
                            </button>
                        </div>
                    )}

                    {/* Description — plain text only, never rendered as HTML */}
                    {listing.content && (
                        <section className="mk-detail-section">
                            <p className="mk-description">{listing.content}</p>
                        </section>
                    )}

                    {/* Categories */}
                    {(listing.categories || []).length > 0 && (
                        <section className="mk-detail-section">
                            <div className="mk-category-chips">
                                {listing.categories.map((slug) => (
                                    <span key={slug} className="mk-category-chip">
                                        <Tag size={14} />
                                        {marketCategoryLabel(t, slug)}
                                    </span>
                                ))}
                            </div>
                        </section>
                    )}
                </div>
            </div>

            <style jsx>{`
                .market-detail-page {
                    padding-bottom: 4rem;
                }

                .mk-hero-wrap {
                    max-width: 760px;
                    margin: 0 auto;
                }
                .mk-hero {
                    position: relative;
                    width: 100%;
                    aspect-ratio: 16 / 9;
                    overflow: hidden;
                    background: var(--color-blue-tint);
                }
                .mk-hero-img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    display: block;
                }
                .mk-hero-fallback {
                    width: 100%;
                    height: 100%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: var(--color-primary);
                    opacity: 0.55;
                    background: linear-gradient(135deg, var(--color-blue-tint), var(--color-green-tint));
                }

                .mk-cw-overlay {
                    position: absolute;
                    inset: 0;
                    z-index: 4;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    gap: 0.6rem;
                    background: rgba(0, 0, 0, 0.35);
                    color: white;
                    font-size: 0.9rem;
                    font-weight: 600;
                    text-align: center;
                    padding: 1rem;
                }
                .mk-cw-reveal {
                    border: none;
                    background: var(--color-surface);
                    color: var(--color-gray-900);
                    font-size: 0.82rem;
                    font-weight: 600;
                    padding: 0.45rem 1.1rem;
                    border-radius: var(--radius-full);
                    cursor: pointer;
                    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
                }

                .mk-detail-sold {
                    position: absolute;
                    top: 16px;
                    right: 16px;
                    z-index: 5;
                    background: rgba(0, 0, 0, 0.65);
                    color: white;
                    font-size: 0.78rem;
                    font-weight: 700;
                    text-transform: uppercase;
                    letter-spacing: 0.03em;
                    padding: 4px 12px;
                    border-radius: var(--radius-full);
                }

                .mk-thumbs {
                    display: flex;
                    gap: 0.5rem;
                    padding: 0.6rem 1rem 0;
                    overflow-x: auto;
                }
                .mk-thumb {
                    width: 64px;
                    height: 48px;
                    padding: 0;
                    border-radius: var(--radius-md);
                    border: 2px solid transparent;
                    overflow: hidden;
                    background: var(--color-blue-tint);
                    cursor: pointer;
                    flex-shrink: 0;
                }
                .mk-thumb.active {
                    border-color: var(--color-primary);
                }
                .mk-thumb img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    display: block;
                }

                .mk-detail-content {
                    max-width: 760px;
                    margin: 0 auto;
                    padding-top: 1rem;
                }

                .mk-head-row {
                    display: flex;
                    align-items: flex-start;
                    justify-content: space-between;
                    gap: 0.75rem;
                    margin-bottom: 0.75rem;
                }
                .mk-detail-title {
                    font-size: 1.6rem;
                    font-weight: 800;
                    margin: 0;
                    line-height: 1.25;
                    min-width: 0;
                    overflow-wrap: break-word;
                }
                .mk-detail-price {
                    flex-shrink: 0;
                    background: var(--color-blue-tint);
                    color: var(--color-primary);
                    font-size: 1rem;
                    font-weight: 800;
                    padding: 0.35rem 0.9rem;
                    border-radius: var(--radius-full);
                    white-space: nowrap;
                }

                .mk-seller-row {
                    display: flex;
                    align-items: center;
                    gap: 0.6rem;
                    margin-bottom: 0.6rem;
                    min-width: 0;
                }
                .mk-seller-avatar {
                    width: 34px;
                    height: 34px;
                    border-radius: 50%;
                    overflow: hidden;
                    flex-shrink: 0;
                    background: var(--color-blue-tint);
                    color: var(--color-primary);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }
                .mk-seller-avatar img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    display: block;
                }
                .mk-seller-name {
                    font-size: 0.92rem;
                    font-weight: 600;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .mk-published {
                    font-size: 0.8rem;
                    color: var(--color-gray-500);
                    flex-shrink: 0;
                }

                .mk-detail-meta {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    color: var(--color-gray-600);
                    font-size: 0.92rem;
                    margin-bottom: 0.75rem;
                    min-width: 0;
                }
                .mk-detail-meta span {
                    overflow: hidden;
                    text-overflow: ellipsis;
                }

                .mk-action-error {
                    margin: 0 0 0.75rem;
                    font-size: 0.85rem;
                    color: var(--color-error, #b91c1c);
                }

                .mk-actions {
                    display: flex;
                    flex-wrap: wrap;
                    align-items: center;
                    gap: 0.5rem;
                    margin: 0.75rem 0 0.5rem;
                }
                .mk-action-btn {
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                    padding: 0.45rem 0.95rem;
                    border-radius: var(--radius-full);
                    border: 1px solid var(--color-gray-300);
                    background: var(--color-surface);
                    color: var(--color-gray-700);
                    font-size: 0.85rem;
                    font-weight: 600;
                    cursor: pointer;
                    text-decoration: none;
                    white-space: nowrap;
                    transition: border-color 0.15s, color 0.15s, background 0.15s;
                }
                .mk-action-btn:hover:not(:disabled) {
                    border-color: var(--color-primary);
                    color: var(--color-primary);
                }
                .mk-action-btn.danger {
                    color: var(--color-error, #b91c1c);
                }
                .mk-action-btn.danger:hover:not(:disabled) {
                    border-color: var(--color-error, #b91c1c);
                    color: var(--color-error, #b91c1c);
                    background: var(--color-red-tint);
                }
                .mk-action-btn:disabled {
                    opacity: 0.6;
                    cursor: default;
                }

                .mk-admin-row {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 0.5rem;
                    margin-bottom: 0.5rem;
                }
                .mk-admin-btn {
                    display: inline-flex;
                    align-items: center;
                    gap: 5px;
                    padding: 0.35rem 0.8rem;
                    border-radius: var(--radius-full);
                    border: 1px dashed var(--color-gray-300);
                    background: none;
                    color: var(--color-gray-500);
                    font-size: 0.78rem;
                    font-weight: 600;
                    cursor: pointer;
                }
                .mk-admin-btn:hover:not(:disabled) {
                    border-color: var(--color-error, #b91c1c);
                    color: var(--color-error, #b91c1c);
                }
                .mk-admin-btn:disabled {
                    opacity: 0.6;
                    cursor: default;
                }

                .mk-detail-section {
                    margin-top: 1.5rem;
                }

                .mk-description {
                    margin: 0;
                    font-size: 0.95rem;
                    line-height: 1.7;
                    color: var(--color-gray-700);
                    white-space: pre-wrap;
                    overflow-wrap: break-word;
                }

                .mk-category-chips {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 0.6rem;
                }
                .mk-category-chip {
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                    padding: 0.4rem 0.9rem;
                    border-radius: var(--radius-full);
                    background: var(--color-blue-tint);
                    color: var(--color-primary);
                    font-size: 0.83rem;
                    font-weight: 600;
                }

                @media (min-width: 769px) {
                    .mk-hero-wrap {
                        padding-top: 1.5rem;
                    }
                    .mk-hero {
                        border-radius: var(--radius-lg);
                    }
                }
            `}</style>
        </div>
    );
};

export default MarketListingDetail;
