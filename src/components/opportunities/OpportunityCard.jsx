import React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MapPin, Clock } from 'lucide-react';
import Avatar from '../Avatar';
import { focusOf, parseFrame } from '../../utils/coverFrame';
import { isPlaceholderName } from '../../utils/profileComplete';
import { daysLeft, isOpen, summaryOf } from './opportunityOptions';
import TypeBadge, { styleOf } from './TypeBadge';
import { prefetchDetail } from '../../utils/detailCache';
import { opportunityPage } from '../../utils/detailPages';

/**
 * An opportunity in the list, as a row (LinkedIn Jobs, Facebook Marketplace):
 * its cover photo (or its type's icon), its type and kind, what it is, who
 * posted it, the money and facts that matter for its type, where, and when
 * it closes.
 *
 * @param {object} opportunity - from projectsApi.list
 */
const OpportunityCard = ({ opportunity }) => {
    const { t } = useTranslation();
    const o = opportunity;
    const profile = o.owner?.profile || {};
    const name = isPlaceholderName(profile.name) ? t('profileView.newMember') : profile.name;
    const summary = summaryOf(o, t);
    const place = [o.location, o.remote && t('opportunities.remote')].filter(Boolean).join(' · ');
    const open = isOpen(o);
    const days = daysLeft(o);
    const closing = !open ? t('opportunities.closed')
        : days === 0 ? t('opportunities.closesToday')
            : days !== null && days <= 14 ? t('opportunities.closesIn', { count: days }) : '';
    const { Icon, color, tint } = styleOf(o.type);

    return (
        /* styled-jsx only scopes DOM elements, so link resets are inline; the visual card is the div.
           The page draws this card's copy at once (state.preview), and its own
           fetch starts as soon as a finger touches the card. */
        <Link
            to={`/opportunities/${o.id}`}
            state={{ preview: o }}
            onPointerDown={() => prefetchDetail(...opportunityPage(o.id))}
            className="opp-card-link"
            style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
        >
            <div className={`opp-card${open ? '' : ' closed'}`}>
                <div className="opp-card-photo" style={{ background: tint, color }}>
                    <Avatar src={o.thumbnail} size={80} fallback={<Icon size={28} aria-hidden="true" />} position={focusOf(parseFrame(o.coverFrame))} />
                </div>

                <div className="opp-card-info">
                    <TypeBadge opportunity={o} />
                    <h3 className="opp-card-title">{o.title}</h3>
                    {name && <p className="opp-card-name">{name}</p>}
                    {summary && <p className="opp-card-summary">{summary}</p>}
                    {place && (
                        <div className="opp-card-meta">
                            <MapPin size={14} aria-hidden="true" />
                            <span>{place}</span>
                        </div>
                    )}
                    {closing && (
                        <div className={`opp-card-meta${open ? ' soon' : ' over'}`}>
                            <Clock size={14} aria-hidden="true" />
                            <span>{closing}</span>
                        </div>
                    )}
                </div>
            </div>

            <style jsx>{`
                .opp-card {
                    display: flex;
                    align-items: flex-start;
                    gap: 0.9rem;
                    padding: 1rem;
                    background: var(--color-surface);
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-lg);
                    box-shadow: var(--shadow-sm);
                    transition: transform 0.2s, box-shadow 0.2s, border-color 0.2s;
                }
                .opp-card:hover {
                    transform: translateY(-1px);
                    box-shadow: var(--shadow-md);
                    border-color: var(--color-primary);
                }
                .opp-card.closed .opp-card-photo,
                .opp-card.closed .opp-card-title {
                    opacity: 0.6;
                }
                .opp-card-photo {
                    width: 72px;
                    height: 72px;
                    border-radius: 12px;
                    overflow: hidden;
                    flex-shrink: 0;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }
                .opp-card-photo :global(img) {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    display: block;
                }
                .opp-card-info {
                    flex: 1;
                    min-width: 0;
                    display: flex;
                    flex-direction: column;
                    gap: 3px;
                }
                .opp-card-title {
                    font-size: 1.05rem;
                    font-weight: 700;
                    margin: 2px 0 0;
                    line-height: 1.3;
                    overflow-wrap: anywhere;
                }
                .opp-card-name {
                    margin: 0;
                    font-size: 0.85rem;
                    color: var(--color-gray-600);
                }
                .opp-card-summary {
                    font-size: 0.85rem;
                    font-weight: 600;
                    color: var(--color-primary);
                    margin: 0;
                    display: -webkit-box;
                    -webkit-line-clamp: 2;
                    -webkit-box-orient: vertical;
                    overflow: hidden;
                }
                .opp-card-meta {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    font-size: 0.8rem;
                    color: var(--color-gray-500);
                    min-width: 0;
                }
                .opp-card-meta span {
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .opp-card-meta.soon {
                    color: var(--color-orange-text, #b45309);
                    font-weight: 600;
                }
                .opp-card-meta.over {
                    color: var(--color-gray-600);
                    font-weight: 600;
                }
            `}</style>
        </Link>
    );
};

export default OpportunityCard;
