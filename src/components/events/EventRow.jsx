import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Avatar from '../Avatar';
import { dayTile, hostOf, isFree, timeOf } from '../../utils/eventFormat';

/** A community event in the dated list: calendar tile, words, small photo. */
export default function EventRow({ event, lang }) {
    const { t } = useTranslation();
    const tile = dayTile(event.startDate, lang);
    const host = hostOf(event);
    const cohost = (event.partners || []).find((p) => p.role === 'COHOST');
    const by = [host.isOfficial ? 'BIES' : host.name, cohost?.name].filter(Boolean).join(' & ');
    const price = (event.priceLabel || '').trim() || (isFree(event) ? t('events.card.free') : '');
    const place = event.isOnline ? t('events.card.online') : (event.locationName || event.location);
    return (
        <Link to={`/events/${event.id}`} state={{ preview: event }} className="ev-row">
            <span className="ev-cal" aria-hidden="true">
                <span>{tile.month}</span>
                <b>{tile.day}</b>
                <small>{tile.weekday}</small>
            </span>
            <span className="ev-row-text">
                <span className="ev-row-title">{event.title}</span>
                <span className="ev-row-line">{[timeOf(event.startDate, lang), place, price].filter(Boolean).join(' · ')}</span>
                {by && <span className="ev-row-line">{t('events.card.by', { names: by })}</span>}
            </span>
            {event.thumbnail && <span className="ev-row-photo"><Avatar src={event.thumbnail} size={60} fallback={null} /></span>}
            <style jsx>{`
                :global(.ev-row) {
                    display: flex; gap: 12px; align-items: center; min-width: 0;
                    background: var(--color-surface); border: 1px solid var(--color-gray-200); border-radius: 16px; padding: 12px;
                    text-decoration: none; color: inherit;
                }
                .ev-cal { width: 52px; flex: none; border-radius: 12px; border: 1px solid var(--color-gray-200); overflow: hidden; text-align: center; background: var(--color-surface); }
                .ev-cal span { display: block; font-size: 0.66rem; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; color: #FFFFFF; background: var(--color-secondary); padding: 2px 0; }
                .ev-cal b { display: block; font-family: var(--font-display); font-size: 1.55rem; line-height: 1.05; color: var(--color-gray-900); padding-top: 3px; }
                .ev-cal small { display: block; font-size: 0.66rem; font-weight: 600; color: var(--color-gray-500); padding-bottom: 4px; text-transform: uppercase; letter-spacing: 0.05em; }
                .ev-row-text { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 3px; }
                .ev-row-title { font-family: var(--font-display); font-size: 1.2rem; line-height: 1.1; color: var(--color-gray-900); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
                .ev-row-line { font-size: 0.8rem; color: var(--color-gray-500); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .ev-row-photo { width: 60px; height: 60px; border-radius: 12px; overflow: hidden; flex: none; background: var(--color-gray-100); }
                .ev-row-photo :global(img) { width: 100%; height: 100%; object-fit: cover; display: block; }
            `}</style>
        </Link>
    );
}

