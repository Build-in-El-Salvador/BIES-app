import React, { useState, useEffect } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Loader2, AlertCircle, Camera, X, Store, Globe } from 'lucide-react';
import { uploadApi, marketplaceApi } from '../../services/api';
import { nostrService } from '../../services/nostrService';
import { nostrSigner } from '../../services/nostrSigner';
import { MARKETPLACE_CATEGORIES } from '../../utils/nip99';
import { getAssetUrl } from '../../utils/assets';
import { marketCategoryLabel } from '../../components/marketplace/MarketListingCard';

const MAX_IMAGES = 5;
const CURRENCIES = ['SATS', 'USD'];

// MARKETPLACE_CATEGORIES is a list of lowercase slugs (see utils/nip99)
const CATEGORY_SLUGS = (MARKETPLACE_CATEGORIES || [])
    .map((c) => (typeof c === 'string' ? c : c?.id || c?.slug))
    .filter(Boolean);

// NIP-99 image tags must be absolute public URLs (Shopstr renders them as-is)
const toAbsoluteUrl = (url) => {
    if (!url) return '';
    const resolved = getAssetUrl(url);
    if (/^https?:\/\//i.test(resolved)) return resolved;
    try {
        return new URL(resolved, window.location.origin).toString();
    } catch {
        return resolved;
    }
};

/**
 * Marketplace listing create/edit form, modeled on directory/CreateListing.jsx
 * but trimmed to the NIP-99 fields. Publishing goes through the client signer
 * when one is connected (extension/nsec/bunker/amber), otherwise through the
 * custodial server signer (marketplaceApi.publish).
 *
 * @param {boolean} editMode - true when mounted at /discover/market/:naddr/edit
 */
const CreateMarketListing = ({ editMode = false }) => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { naddr } = useParams();

    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [amount, setAmount] = useState('');
    const [currency, setCurrency] = useState('SATS');
    const [categories, setCategories] = useState([]);
    const [location, setLocation] = useState('');
    const [images, setImages] = useState([]);

    // Edit mode: keep the addressable-event identity + original publish date
    const [dTag, setDTag] = useState('');
    const [publishedAt, setPublishedAt] = useState(null);
    const [status, setStatus] = useState('active');

    const [loading, setLoading] = useState(editMode);
    const [loadError, setLoadError] = useState(null);
    const [uploading, setUploading] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState('');

    const isBusy = submitting || uploading;

    useEffect(() => {
        if (!editMode) return;
        let cancelled = false;
        (async () => {
            try {
                const listing = await nostrService.fetchMarketplaceListing(naddr);
                if (cancelled) return;
                if (!listing) throw new Error(t('marketplace.loadError'));
                setTitle(listing.title || '');
                setDescription(listing.content || '');
                setAmount(listing.price?.amount != null ? String(listing.price.amount) : '');
                setCurrency(String(listing.price?.currency || 'SATS').toUpperCase());
                setCategories(Array.isArray(listing.categories) ? listing.categories : []);
                setLocation(listing.location || '');
                setImages(Array.isArray(listing.images) ? listing.images.filter(Boolean).slice(0, MAX_IMAGES) : []);
                setDTag(listing.dTag || '');
                setPublishedAt(listing.publishedAt || null);
                setStatus(listing.status === 'sold' ? 'sold' : 'active');
            } catch (err) {
                if (!cancelled) setLoadError(err.message || t('marketplace.loadError'));
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [editMode, naddr]);  

    const toggleCategory = (slug) =>
        setCategories((prev) =>
            prev.includes(slug) ? prev.filter((c) => c !== slug) : [...prev, slug]
        );

    // Same upload path as directory/CreateListing (uploadApi.media), minus the
    // crop modal — product photos keep their native aspect ratio.
    const handleImagesSelect = async (e) => {
        const files = Array.from(e.target.files || []);
        e.target.value = ''; // allow re-selecting the same file
        const room = MAX_IMAGES - images.length;
        const toUpload = files.slice(0, Math.max(room, 0));
        if (toUpload.length === 0) return;
        setUploading(true);
        setSubmitError('');
        try {
            for (const file of toUpload) {
                const result = await uploadApi.media(file);
                const url = toAbsoluteUrl(result?.url || result?.data?.url);
                if (url) {
                    setImages((prev) => (prev.length < MAX_IMAGES ? [...prev, url] : prev));
                }
            }
        } catch (err) {
            setSubmitError(err.message || 'Failed to upload image.');
        } finally {
            setUploading(false);
        }
    };

    const removeImage = (index) =>
        setImages((prev) => prev.filter((_, i) => i !== index));

    const handleSubmit = async () => {
        setSubmitError('');
        if (!title.trim()) {
            setSubmitError(t('marketplace.titleRequired'));
            window.scrollTo({ top: 0, behavior: 'smooth' });
            return;
        }
        const amountNum = Number(amount);
        if (!amount || !Number.isFinite(amountNum) || amountNum <= 0) {
            setSubmitError(t('marketplace.priceRequired'));
            window.scrollTo({ top: 0, behavior: 'smooth' });
            return;
        }
        setSubmitting(true);
        try {
            const desc = description.trim();
            const payload = {
                title: title.trim(),
                summary: desc.slice(0, 160),
                description: desc,
                price: { amount: amountNum, currency },
                images,
                location: location.trim(),
                categories,
                status,
                ...(editMode && dTag ? { dTag } : {}),
                ...(editMode && publishedAt ? { publishedAt } : {}),
            };
            // Nostr-native sessions sign client-side; custodial accounts let
            // the server sign with their managed key.
            const result = nostrSigner.mode
                ? await nostrService.publishMarketplaceListing(payload)
                : await marketplaceApi.publish(payload);
            const published = result?.data || result;
            navigate(`/discover/market/${published?.naddr || naddr}`);
        } catch (err) {
            setSubmitError(err.message || 'Failed to publish listing');
            window.scrollTo({ top: 0, behavior: 'smooth' });
        } finally {
            setSubmitting(false);
        }
    };

    if (loading) {
        return (
            <div className="container" style={{ textAlign: 'center', padding: '4rem 0' }}>
                <Loader2 size={32} style={{ animation: 'spin 1s linear infinite', margin: '0 auto', color: 'var(--color-gray-500)' }} />
            </div>
        );
    }

    if (loadError) {
        return (
            <div className="container">
                <div style={{ textAlign: 'center', padding: '4rem 0' }}>
                    <h2>{t('marketplace.loadError')}</h2>
                    <p style={{ color: 'var(--color-gray-500)', margin: '0.5rem 0' }}>{loadError}</p>
                    <Link
                        to="/discover/market"
                        style={{ marginTop: '1.5rem', display: 'inline-flex', alignItems: 'center', gap: 8, textDecoration: 'none', fontWeight: 500, color: 'var(--color-primary)' }}
                    >
                        <ArrowLeft size={16} /> {t('marketplace.title')}
                    </Link>
                </div>
            </div>
        );
    }

    return (
        <div className="market-form-page">
            <div className="container">
                <div className="mk-form-content">

                    {/* Header */}
                    <div className="mk-form-header">
                        <button onClick={() => navigate(-1)} className="mk-back-link" type="button">
                            <ArrowLeft size={18} /> {t('common.back')}
                        </button>
                        <h1 className="mk-form-title">
                            <Store size={24} style={{ color: 'var(--color-primary)', flexShrink: 0 }} />
                            {editMode ? t('marketplace.edit') : t('marketplace.create')}
                        </h1>
                    </div>

                    {submitError && (
                        <div className="mk-error-banner"><AlertCircle size={16} /> {submitError}</div>
                    )}

                    {/* Photos */}
                    <div className="mk-form-card">
                        <h3 className="mk-card-heading">{t('marketplace.formImages')}</h3>
                        <div className="mk-image-grid">
                            {images.map((img, idx) => (
                                <div key={`${img}-${idx}`} className="mk-image-tile">
                                    <img src={img} alt="" loading="lazy" />
                                    <button
                                        type="button"
                                        className="mk-image-remove"
                                        onClick={() => removeImage(idx)}
                                        disabled={isBusy}
                                        aria-label={t('common.cancel')}
                                    >
                                        <X size={14} />
                                    </button>
                                </div>
                            ))}
                            {images.length < MAX_IMAGES && (
                                <label className="mk-image-add" style={{ cursor: uploading ? 'not-allowed' : 'pointer' }}>
                                    {uploading ? (
                                        <Loader2 size={22} style={{ animation: 'spin 1s linear infinite', color: 'var(--color-gray-400)' }} />
                                    ) : (
                                        <Camera size={22} style={{ color: 'var(--color-gray-400)' }} />
                                    )}
                                    <input
                                        type="file"
                                        accept="image/*"
                                        multiple
                                        onChange={handleImagesSelect}
                                        style={{ display: 'none' }}
                                        disabled={uploading}
                                    />
                                </label>
                            )}
                        </div>
                    </div>

                    {/* Details */}
                    <div className="mk-form-card">
                        <div className="mk-form-group">
                            <label className="mk-label">{t('marketplace.formTitle')} *</label>
                            <input
                                type="text"
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                className="mk-input"
                                maxLength={120}
                                required
                            />
                        </div>

                        <div className="mk-form-group">
                            <label className="mk-label">{t('marketplace.formDescription')}</label>
                            <textarea
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                className="mk-input"
                                rows={5}
                                maxLength={5000}
                            />
                        </div>

                        <div className="mk-form-row">
                            <div className="mk-form-group">
                                <label className="mk-label">{t('marketplace.formPrice')} *</label>
                                <input
                                    type="number"
                                    inputMode="decimal"
                                    min="0"
                                    step="any"
                                    value={amount}
                                    onChange={(e) => setAmount(e.target.value)}
                                    className="mk-input"
                                    required
                                />
                            </div>
                            <div className="mk-form-group">
                                <label className="mk-label">{t('marketplace.formCurrency')}</label>
                                <select
                                    value={currency}
                                    onChange={(e) => setCurrency(e.target.value)}
                                    className="mk-input"
                                >
                                    {CURRENCIES.map((c) => (
                                        <option key={c} value={c}>{c}</option>
                                    ))}
                                </select>
                            </div>
                        </div>

                        <div className="mk-form-group">
                            <label className="mk-label">{t('marketplace.formCategory')}</label>
                            <div className="mk-category-select">
                                {CATEGORY_SLUGS.map((slug) => (
                                    <button
                                        key={slug}
                                        type="button"
                                        className={`mk-cat-chip ${categories.includes(slug) ? 'active' : ''}`}
                                        onClick={() => toggleCategory(slug)}
                                    >
                                        {marketCategoryLabel(t, slug)}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="mk-form-group" style={{ marginBottom: 0 }}>
                            <label className="mk-label">{t('marketplace.formLocation')}</label>
                            <input
                                type="text"
                                value={location}
                                onChange={(e) => setLocation(e.target.value)}
                                className="mk-input"
                                maxLength={200}
                                placeholder="El Zonte, La Libertad"
                            />
                        </div>
                    </div>

                    <p className="mk-publish-note">
                        <Globe size={15} />
                        {t('marketplace.publishedNote')}
                    </p>

                    {/* Actions */}
                    <div className="mk-form-actions">
                        <button type="button" onClick={() => navigate(-1)} className="btn btn-outline" disabled={submitting}>
                            {t('common.cancel')}
                        </button>
                        <button type="button" onClick={handleSubmit} disabled={isBusy} className="btn btn-primary">
                            {submitting && <Loader2 size={16} style={{ animation: 'spin 1s linear infinite', marginRight: 6, verticalAlign: '-3px' }} />}
                            {submitting ? t('marketplace.publishing') : t('marketplace.publish')}
                        </button>
                    </div>
                </div>
            </div>

            <style jsx>{`
                .market-form-page {
                    padding-top: 1.5rem;
                    padding-bottom: 4rem;
                }

                .mk-form-content {
                    max-width: 760px;
                    margin: 0 auto;
                }

                .mk-form-header {
                    margin-bottom: 1.25rem;
                }
                .mk-back-link {
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
                .mk-back-link:hover { color: var(--color-primary); }
                .mk-form-title {
                    display: flex;
                    align-items: center;
                    gap: 0.6rem;
                    font-size: 1.6rem;
                    font-weight: 700;
                    margin: 0;
                    color: var(--color-gray-900);
                }

                .mk-error-banner {
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

                .mk-form-card {
                    background: var(--color-surface);
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-lg);
                    box-shadow: var(--shadow-sm);
                    padding: 1.5rem;
                    margin-bottom: 1.25rem;
                }
                .mk-card-heading {
                    font-size: 1.05rem;
                    font-weight: 700;
                    margin: 0 0 1.25rem;
                    padding-bottom: 0.75rem;
                    border-bottom: 1px solid var(--color-gray-200);
                }

                .mk-image-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
                    gap: 0.75rem;
                }
                .mk-image-tile {
                    position: relative;
                    aspect-ratio: 1;
                    border-radius: var(--radius-md);
                    overflow: hidden;
                    background: var(--color-blue-tint);
                    border: 1px solid var(--color-gray-200);
                }
                .mk-image-tile img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    display: block;
                }
                .mk-image-remove {
                    position: absolute;
                    top: 4px;
                    right: 4px;
                    width: 24px;
                    height: 24px;
                    border-radius: 50%;
                    border: none;
                    background: rgba(0, 0, 0, 0.6);
                    color: white;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    cursor: pointer;
                }
                .mk-image-add {
                    aspect-ratio: 1;
                    border-radius: var(--radius-md);
                    border: 1px dashed var(--color-gray-300);
                    background: var(--color-surface);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: border-color 0.15s;
                }
                .mk-image-add:hover {
                    border-color: var(--color-primary);
                }

                .mk-form-group {
                    margin-bottom: 1.1rem;
                }
                .mk-form-row {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 0.75rem;
                }
                .mk-label {
                    display: block;
                    font-size: 0.85rem;
                    font-weight: 600;
                    color: var(--color-gray-700);
                    margin-bottom: 0.4rem;
                }
                .mk-input {
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
                .mk-input:focus {
                    border-color: var(--color-primary);
                    box-shadow: 0 0 0 3px rgba(0, 82, 204, 0.1);
                }
                textarea.mk-input { resize: vertical; }
                select.mk-input { appearance: auto; cursor: pointer; }

                .mk-category-select {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 0.5rem;
                }
                .mk-cat-chip {
                    border: 1px solid var(--color-gray-200);
                    background: var(--color-surface);
                    color: var(--color-gray-600);
                    padding: 0.35rem 0.85rem;
                    border-radius: var(--radius-full);
                    font-size: 0.82rem;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.15s;
                }
                .mk-cat-chip:hover {
                    border-color: var(--color-primary);
                    color: var(--color-primary);
                }
                .mk-cat-chip.active {
                    background: var(--color-blue-tint);
                    border-color: var(--color-primary);
                    color: var(--color-primary);
                }

                .mk-publish-note {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    margin: 0 0 1.25rem;
                    font-size: 0.85rem;
                    color: var(--color-gray-500);
                }

                .mk-form-actions {
                    display: flex;
                    justify-content: flex-end;
                    gap: 0.75rem;
                }

                @media (max-width: 600px) {
                    .mk-form-row {
                        grid-template-columns: 1fr;
                        gap: 0;
                    }
                    .mk-form-actions {
                        flex-direction: column-reverse;
                    }
                    .mk-form-actions button {
                        width: 100%;
                    }
                }
            `}</style>
        </div>
    );
};

export default CreateMarketListing;
