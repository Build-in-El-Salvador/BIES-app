import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Check, MapPin } from 'lucide-react';
import Avatar from '../Avatar';
import { dayTile, hostOf, proposalNeeds, timeOf } from '../../utils/eventFormat';
import { focusOf, parseFrame } from '../../utils/coverFrame';

/**
 * A meetup a member proposed, in the Events list: when and where, how many
 * are in of how many it needs, and "I'm in". The whole card opens it.
 */
export default function ProposalCard({ event, lang, going, onGoing, busy = false }) {
    const { t } = useTranslation();
    const tile = dayTile(event.startDate, lang);
    const host = hostOf(event);
    const min = event.minAttendees || 0;
    const count = event.goingCount || 0;
    const needs = proposalNeeds(event);
    const place = event.venueListing?.name || event.locationName || event.location;
    const toggle = (e) => {
        e.preventDefault();
        e.stopPropagation();
        onGoing(!going);
    };
    return (
        <article className="pc">
            <Link to={`/events/${event.id}`} state={{ preview: event }} className="pc-link" aria-label={event.title} />
            <div className="pc-top">
                <span className="pc-cal" aria-hidden="true"><span>{tile.month}</span><b>{tile.day}</b></span>
                <span className="pc-text">
                    <span className="pc-title">{event.title}</span>
                    <span className="pc-line">{[tile.weekday, timeOf(event.startDate, lang)].join(' · ')}</span>
                    {place && <span className="pc-line pc-place"><MapPin size={13} aria-hidden="true" /> {place}</span>}
                </span>
                {event.thumbnail && (
                    <span className="pc-photo"><Avatar src={event.thumbnail} size={56} fallback={null} position={focusOf(parseFrame(event.coverFrame))} /></span>
                )}
            </div>
            <div className="pc-track" aria-hidden="true"><span style={{ width: `${min ? Math.min(100, (count / min) * 100) : 0}%` }} /></div>
            <div className="pc-foot">
                <span className="pc-who">
                    <span className="pc-face"><Avatar src={host.image} size={26} fallback={<span className="pc-initial">{(host.name || '?')[0].toUpperCase()}</span>} /></span>
                    <span className="pc-count">
                        <b>{t('events.proposals.progress', { going: count, min })}</b>
                        {needs > 0 && <> · {t('events.proposals.needs', { count: needs })}</>}
                    </span>
                </span>
                <button type="button" className={`pc-in${going ? ' on' : ''}`} aria-pressed={!!going} disabled={busy} onClick={toggle}>
                    {going && <Check size={15} aria-hidden="true" />} {going ? t('events.proposals.in') : t('events.proposals.imIn')}
                </button>
            </div>
            <style jsx>{`
                .pc {
                    position: relative; display: flex; flex-direction: column; gap: 10px; padding: 12px;
                    background: var(--color-surface); border: 1px solid var(--color-gray-200); border-radius: 16px;
                }
                .pc :global(.pc-link) { position: absolute; inset: 0; z-index: 1; border-radius: 16px; }
                .pc-top { display: flex; gap: 12px; align-items: flex-start; min-width: 0; }
                .pc-cal {
                    width: 56px; height: 56px; flex: none; box-sizing: border-box; display: flex; flex-direction: column;
                    border-radius: 12px; border: 1.5px dashed var(--color-secondary); overflow: hidden; text-align: center; background: var(--color-orange-tint);
                }
                .pc-cal span { display: block; font-size: 0.66rem; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; color: var(--color-orange-text); padding: 3px 0 0; }
                .pc-cal b { flex: 1; display: flex; align-items: center; justify-content: center; font-family: var(--font-display); font-size: 1.5rem; line-height: 1; color: var(--color-gray-900); }
                .pc-text { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 3px; }
                .pc-title { font-family: var(--font-display); font-size: 1.2rem; line-height: 1.1; color: var(--color-gray-900); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
                .pc-line { font-size: 0.8rem; color: var(--color-gray-500); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .pc-place { display: flex; align-items: center; gap: 4px; }
                .pc-photo { width: 56px; height: 56px; border-radius: 12px; overflow: hidden; flex: none; background: var(--color-gray-100); }
                .pc-photo :global(img) { width: 100%; height: 100%; object-fit: cover; display: block; }
                .pc-track { height: 6px; border-radius: 999px; background: var(--color-gray-100); overflow: hidden; }
                .pc-track span { display: block; height: 100%; border-radius: 999px; background: var(--color-secondary); }
                .pc-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
                .pc-who { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 0.82rem; color: var(--color-gray-500); }
                .pc-who b { color: var(--color-gray-900); }
                .pc-count { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .pc-face { width: 26px; height: 26px; border-radius: 50%; overflow: hidden; flex: none; background: var(--color-gray-100); display: inline-flex; align-items: center; justify-content: center; }
                .pc-face :global(img) { width: 100%; height: 100%; object-fit: cover; display: block; }
                .pc-initial { font-size: 0.7rem; font-weight: 700; color: var(--color-primary); }
                .pc-in {
                    position: relative; z-index: 2; flex: none; display: inline-flex; align-items: center; gap: 6px;
                    height: 38px; padding: 0 18px; border-radius: var(--radius-full); border: 1.5px solid var(--color-primary); cursor: pointer;
                    background: var(--color-primary); color: #FFFFFF; font-size: 0.875rem; font-weight: 700;
                }
                .pc-in.on { background: var(--color-surface); color: var(--color-primary); }
                .pc-in:disabled { opacity: 0.7; cursor: default; }
            `}</style>
        </article>
    );
}
