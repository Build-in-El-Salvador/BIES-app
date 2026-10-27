import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CalendarPlus } from 'lucide-react';
import { eventsApi } from '../../services/api';
import { useFeatureFlags } from '../../context/FeatureFlagsContext';
import EventRow from '../events/EventRow';

/**
 * A business or farm's coming events, on its page, while Events is on: the
 * ones hosted as it, and members' meetups tagged as being there (it isn't
 * their host). "Plan a meetup here" opens a proposal with the place filled in.
 */
export default function ListingEvents({ listing, titleStyle }) {
    const { t, i18n } = useTranslation();
    const { flags } = useFeatureFlags();
    const [events, setEvents] = useState([]);
    const on = !!flags?.events;

    useEffect(() => {
        if (!on) return undefined;
        let cancelled = false;
        eventsApi.list({ upcoming: 'true', atListingId: listing.id, limit: 10 })
            .then((res) => { if (!cancelled) setEvents(res?.data || []); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [on, listing.id]);

    if (!on) return null;
    const tagged = events.some((e) => e.hostListing?.id !== listing.id);
    return (
        <section className="dir-events" aria-labelledby="dir-events-title">
            <h2 id="dir-events-title" style={titleStyle}>{t('events.proposals.eventsHere')}</h2>
            {events.length > 0 && (
                <ul>
                    {events.map((e) => <li key={e.id}><EventRow event={e} lang={i18n.language} /></li>)}
                </ul>
            )}
            {tagged && <p className="dir-events-note">{t('events.proposals.notHost')}</p>}
            <Link to={`/events/propose?venue=${encodeURIComponent(listing.id)}`} className="dir-events-plan">
                <CalendarPlus size={18} aria-hidden="true" /> {t('events.proposals.planHere')}
            </Link>
            <style jsx>{`
                .dir-events { margin-top: 1.75rem; display: flex; flex-direction: column; gap: 10px; }
                .dir-events :global(h2) { margin-bottom: 0; }
                ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
                .dir-events-note { margin: 0; font-size: 0.82rem; color: var(--color-gray-500); }
                .dir-events :global(.dir-events-plan) {
                    align-self: flex-start; display: inline-flex; align-items: center; gap: 8px; height: 44px; padding: 0 18px;
                    border-radius: var(--radius-full); border: 1.5px solid var(--color-primary); color: var(--color-primary);
                    font-weight: 700; font-size: 0.9rem; text-decoration: none; background: var(--color-surface);
                }
            `}</style>
        </section>
    );
}
