import React from 'react';
import { Link } from 'react-router-dom';
import { MapPin, Phone, Leaf, Building2, Bitcoin, ThumbsUp, ThumbsDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Avatar from '../Avatar';
import { focusOf, parseFrame } from '../../utils/coverFrame';
import CertifiedBadge from './CertifiedBadge';
import { prefetchDetail } from '../../utils/detailCache';
import { listingPage } from '../../utils/detailPages';

/**
 * Directory listing card (list row) per the mockup:
 * rounded photo left, bold name, produce/skills summary in primary blue,
 * MapPin + Phone rows in gray. The whole card is the link (no arrow).
 * Then the vouch and downvote counts (the Trust Score is their difference), the BIES Trusted pill,
 * BTC and pricing.
 *
 * @param {object} listing - parsed listing from directoryApi
 * @param {'FARM'|'PROVIDER'} type
 */
const DirectoryListingCard = ({ listing, type = 'FARM' }) => {
    const { t } = useTranslation();
    const isProvider = type === 'PROVIDER';
    const basePath = isProvider ? '/trusted' : '/farms';

    const category = isProvider && listing.category ? t(`directory.categories.${listing.category}`) : '';
    const details = isProvider
        ? (listing.skills || []).join(', ')
        : (listing.products || []).map((p) => p?.label).filter(Boolean).join(', ');
    const summary = [category, details].filter(Boolean).join(' · ');
    const photo = listing.photo || (listing.photos || [])[0] || '';
    const phone = listing.phone || listing.whatsapp || '';

    const vouches = listing.vouchCount ?? 0;
    const downvotes = listing.downvoteCount ?? 0;
    const votes = vouches + downvotes;
    const scoreTitle = [
        t('directory.trust.vouches', { count: listing.vouchCount ?? 0 }),
        t('directory.trust.downvotes', { count: listing.downvoteCount ?? 0 }),
    ].join(' · ');

    // Not the shield: that would read as BIES Trusted, which a listing earns.
    const FallbackIcon = isProvider ? Building2 : Leaf;

    return (
        /* styled-jsx only scopes DOM elements, so link resets are inline; the visual card is the div.
           The page draws this card's copy at once (state.preview), and its own
           fetch starts as soon as a finger touches the card. */
        <Link
            to={`${basePath}/${listing.id}`}
            state={{ preview: listing }}
            onPointerDown={() => prefetchDetail(...listingPage(listing.id))}
            className="dir-card-link"
            style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
        >
            <div className="dir-card">
                <div className="dir-card-photo">
                    <Avatar
                        src={photo}
                        alt={listing.name}
                        size={80}
                        position={listing.photo ? focusOf(parseFrame(listing.coverFrame)) : undefined}
                        fallback={
                            <div className="dir-card-photo-fallback">
                                <FallbackIcon size={28} />
                            </div>
                        }
                    />
                </div>

                <div className="dir-card-info">
                    <h3 className="dir-card-name">{listing.name}</h3>
                    {summary && <p className="dir-card-summary">{summary}</p>}
                    {listing.location && (
                        <div className="dir-card-meta">
                            <MapPin size={14} />
                            <span>{listing.location}</span>
                        </div>
                    )}
                    {phone && (
                        <div className="dir-card-meta">
                            <Phone size={14} />
                            <span>{phone}</span>
                        </div>
                    )}

                    {(votes > 0 || listing.isCertified || listing.btcAccepted || (isProvider && listing.pricing)) && (
                        <div className="dir-card-pills">
                            {votes > 0 && (
                                <span className="dir-score-pill" aria-label={scoreTitle}>
                                    <ThumbsUp size={12} aria-hidden="true" /> {vouches}
                                    {downvotes > 0 && (
                                        <>
                                            <span className="dir-score-sep" aria-hidden="true">·</span>
                                            <ThumbsDown size={12} aria-hidden="true" /> {downvotes}
                                        </>
                                    )}
                                </span>
                            )}
                            {listing.isCertified && <CertifiedBadge size="sm" />}
                            {listing.btcAccepted && (
                                <Bitcoin size={15} className="dir-btc-icon" aria-label={t('directory.btcAccepted')} />
                            )}
                            {isProvider && listing.pricing && <span className="dir-card-pricing">{listing.pricing}</span>}
                        </div>
                    )}
                </div>
            </div>

            <style jsx>{`
                .dir-card {
                    display: flex;
                    align-items: flex-start;
                    gap: 1rem;
                    padding: 1rem;
                    background: var(--color-surface);
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-lg);
                    box-shadow: var(--shadow-sm);
                    transition: transform 0.2s, box-shadow 0.2s, border-color 0.2s;
                }
                .dir-card:hover {
                    transform: translateY(-1px);
                    box-shadow: var(--shadow-md);
                    border-color: var(--color-primary);
                }
                .dir-card-photo {
                    width: 80px;
                    height: 80px;
                    border-radius: var(--radius-lg);
                    overflow: hidden;
                    flex-shrink: 0;
                    background: var(--color-blue-tint);
                }
                .dir-card-photo :global(img) {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    display: block;
                }
                .dir-card-photo-fallback {
                    width: 100%;
                    height: 100%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: var(--color-primary);
                }
                .dir-card-info {
                    flex: 1;
                    min-width: 0;
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                }
                .dir-card-name {
                    font-size: 1.05rem;
                    font-weight: 700;
                    margin: 0;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .dir-card-summary {
                    font-size: 0.85rem;
                    font-weight: 500;
                    color: var(--color-primary);
                    margin: 0;
                    display: -webkit-box;
                    -webkit-line-clamp: 2;
                    -webkit-box-orient: vertical;
                    overflow: hidden;
                }
                .dir-card-meta {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    font-size: 0.8rem;
                    color: var(--color-gray-500);
                    min-width: 0;
                }
                .dir-card-meta span {
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .dir-card-pills {
                    display: flex;
                    align-items: center;
                    flex-wrap: wrap;
                    gap: 6px;
                    margin-top: 2px;
                }
                .dir-score-pill {
                    display: inline-flex;
                    align-items: center;
                    gap: 4px;
                    background: var(--color-blue-tint);
                    color: var(--color-primary);
                    font-size: 0.75rem;
                    font-weight: 700;
                    padding: 2px 8px;
                    border-radius: var(--radius-full);
                }
                .dir-score-sep {
                    margin: 0 2px;
                    opacity: 0.6;
                }
                .dir-btc-icon {
                    color: #f7931a;
                    flex-shrink: 0;
                }
                .dir-card-pricing {
                    font-size: 0.75rem;
                    color: var(--color-gray-500);
                }
            `}</style>
        </Link>
    );
};

export default DirectoryListingCard;
