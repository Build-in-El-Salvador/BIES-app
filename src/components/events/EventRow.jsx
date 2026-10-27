import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Avatar from '../Avatar';
import { dayTile, hostOf, isFree, timeOf } from '../../utils/eventFormat';
import { focusOf, parseFrame } from '../../utils/coverFrame';

/** An event in a list: a square calendar tile (month and day), words (and where a proposed meetup stands), small photo, top-aligned like other lists. */
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
            </span>
            <span className="ev-row-text">
                <span className="ev-row-title">{event.title}</span>
                <span className="ev-row-line">{[tile.weekday, timeOf(event.startDate, lang), place].filter(Boolean).join(' · ')}</span>
                {(price || by) && <span className="ev-row-line">{[price, by && t('events.card.by', { names: by })].filter(Boolean).join(' · ')}</span>}
                {event.stage === 'proposed' && <span className="ev-row-line ev-row-proposed">{t('events.proposals.line', { going: event.goingCount || 0, min: event.minAttendees })}</span>}
            </span>
            {event.thumbnail && <span className="ev-row-photo"><Avatar src={event.thumbnail} size={56} fallback={null} position={focusOf(parseFrame(event.coverFrame))} /></span>}
            <style jsx>{`
                :global(.ev-row) {
                    display: flex; gap: 12px; align-items: flex-start; min-width: 0;
                    background: var(--color-surface); border: 1px solid var(--color-gray-200); border-radius: 16px; padding: 12px;
                    text-decoration: none; color: inherit;
                }
                .ev-cal {
                    width: 56px; height: 56px; flex: none; box-sizing: border-box; display: flex; flex-direction: column;
                    border-radius: 12px; border: 1px solid var(--color-gray-200); overflow: hidden; text-align: center; background: var(--color-surface);
                }
                .ev-cal span { display: block; font-size: 0.66rem; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; color: #FFFFFF; background: var(--color-secondary); padding: 2px 0; }
                .ev-cal b { flex: 1; display: flex; align-items: center; justify-content: center; font-family: var(--font-display); font-size: 1.6rem; line-height: 1; color: var(--color-gray-900); }
                .ev-row-text { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 3px; }
                .ev-row-title { font-family: var(--font-display); font-size: 1.2rem; line-height: 1.1; color: var(--color-gray-900); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
                .ev-row-line { font-size: 0.8rem; color: var(--color-gray-500); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .ev-row-proposed { font-weight: 600; color: var(--color-orange-text); }
                .ev-row-photo { width: 56px; height: 56px; border-radius: 12px; overflow: hidden; flex: none; background: var(--color-gray-100); }
                .ev-row-photo :global(img) { width: 100%; height: 100%; object-fit: cover; display: block; }
            `}</style>
        </Link>
    );
}

