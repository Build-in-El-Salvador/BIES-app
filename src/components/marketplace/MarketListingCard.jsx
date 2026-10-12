import React from 'react';
import { Link } from 'react-router-dom';
import { MapPin, Package, User } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * Listings whose images are blurred until revealed on the detail page:
 * a NIP-36 content-warning tag (parsed into listing.contentWarning) or an
 * nsfw / content-warning topic tag.
 */
export const isSensitiveListing = (listing) =>
    !!listing?.contentWarning
    || (listing?.categories || []).some((c) => c === 'nsfw' || c === 'content-warning');

/** Display label for a MARKETPLACE_CATEGORIES slug, falling back to a prettified slug. */
export const marketCategoryLabel = (t, slug) =>
    t(`marketplace.categories.${slug}`, String(slug).replace(/-/g, ' ').replace(/(^|\s)\S/g, (m) => m.toUpperCase()));

/** "21,000 sats" / "150 USD" price label shared by the marketplace pages. */
export const formatListingPrice = (price) => {
    if (!price || price.amount == null || price.amount === '') return '';
    const amt = Number(price.amount);
    const formatted = Number.isFinite(amt) ? amt.toLocaleString('en-US') : String(price.amount);
    const cur = String(price.currency || '').toUpperCase();
    if (!cur) return formatted;
    return cur === 'SATS' ? `${formatted} sats` : `${formatted} ${cur}`;
};

/**
 * Marketplace listing card (grid tile), modeled on DirectoryListingCard:
 * product photo on top, title, price badge, location, sold badge, seller name.
 * Links to /market/<naddr>.
 *
 * @param {object} listing - parsed NIP-99 listing (see utils/nip99 parseListingEvent)
 */
const MarketListingCard = ({ listing }) => {
    const { t } = useTranslation();
    const image = (listing.images || [])[0] || '';
    const isSold = listing.status === 'sold';
    const priceLabel = formatListingPrice(listing.price);
    const sensitive = isSensitiveListing(listing);

    return (
        /* styled-jsx only scopes DOM elements, so link resets are inline; the visual card is the div */
        <Link
            to={`/market/${listing.naddr}`}
            className="mk-card-link"
            style={{ textDecoration: 'none', color: 'inherit', display: 'block', height: '100%' }}
        >
            <div className="mk-card">
                <div className="mk-card-photo">
                    {image ? (
                        <img
                            src={image}
                            alt={listing.title || ''}
                            loading="lazy"
                            style={sensitive ? { filter: 'blur(14px)' } : undefined}
                        />
                    ) : (
                        <div className="mk-card-photo-fallback">
                            <Package size={28} />
                        </div>
                    )}
                    {isSold && <span className="mk-sold-badge">{t('marketplace.sold')}</span>}
                </div>

                <div className="mk-card-info">
                    <h3 className="mk-card-title">{listing.title}</h3>
                    {priceLabel && <span className="mk-price-badge">{priceLabel}</span>}
                    {listing.location && (
                        <div className="mk-card-meta">
                            <MapPin size={13} />
                            <span>{listing.location}</span>
                        </div>
                    )}
                    {listing.sellerName && (
                        <div className="mk-card-meta">
                            {listing.sellerAvatar ? (
                                <img className="mk-seller-avatar" src={listing.sellerAvatar} alt="" loading="lazy" />
                            ) : (
                                <User size={13} />
                            )}
                            <span>{listing.sellerName}</span>
                        </div>
                    )}
                </div>
            </div>

            <style jsx>{`
                .mk-card {
                    display: flex;
                    flex-direction: column;
                    height: 100%;
                    background: var(--color-surface);
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-lg);
                    box-shadow: var(--shadow-sm);
                    overflow: hidden;
                    transition: transform 0.2s, box-shadow 0.2s, border-color 0.2s;
                }
                .mk-card:hover {
                    transform: translateY(-2px);
                    box-shadow: var(--shadow-md);
                    border-color: var(--color-primary);
                }
                .mk-card-photo {
                    position: relative;
                    width: 100%;
                    aspect-ratio: 4 / 3;
                    background: var(--color-blue-tint);
                    overflow: hidden;
                }
                .mk-card-photo img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    display: block;
                }
                .mk-card-photo-fallback {
                    width: 100%;
                    height: 100%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: var(--color-primary);
                    opacity: 0.6;
                }
                .mk-sold-badge {
                    position: absolute;
                    top: 8px;
                    left: 8px;
                    background: rgba(0, 0, 0, 0.65);
                    color: white;
                    font-size: 0.72rem;
                    font-weight: 700;
                    text-transform: uppercase;
                    letter-spacing: 0.03em;
                    padding: 3px 10px;
                    border-radius: var(--radius-full);
                }
                .mk-card-info {
                    display: flex;
                    flex-direction: column;
                    gap: 5px;
                    padding: 0.75rem 0.85rem 0.9rem;
                    min-width: 0;
                }
                .mk-card-title {
                    font-size: 0.95rem;
                    font-weight: 700;
                    margin: 0;
                    line-height: 1.3;
                    display: -webkit-box;
                    -webkit-line-clamp: 2;
                    -webkit-box-orient: vertical;
                    overflow: hidden;
                }
                .mk-price-badge {
                    align-self: flex-start;
                    background: var(--color-blue-tint);
                    color: var(--color-primary);
                    font-size: 0.8rem;
                    font-weight: 700;
                    padding: 2px 10px;
                    border-radius: var(--radius-full);
                    white-space: nowrap;
                }
                .mk-card-meta {
                    display: flex;
                    align-items: center;
                    gap: 5px;
                    font-size: 0.78rem;
                    color: var(--color-gray-500);
                    min-width: 0;
                }
                .mk-card-meta span {
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .mk-seller-avatar {
                    width: 16px;
                    height: 16px;
                    border-radius: 50%;
                    object-fit: cover;
                    flex-shrink: 0;
                }
            `}</style>
        </Link>
    );
};

export default MarketListingCard;
