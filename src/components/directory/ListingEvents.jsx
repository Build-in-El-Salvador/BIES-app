import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { eventsApi } from '../../services/api';
import { useFeatureFlags } from '../../context/FeatureFlagsContext';
import EventRow from '../events/EventRow';

/**
 * A business or farm's coming events (the ones hosted as it), on its page,
 * while Events is on. Nothing when it has none.
 */
export default function ListingEvents({ listing, titleStyle }) {
    const { t, i18n } = useTranslation();
    const { flags } = useFeatureFlags();
    const [events, setEvents] = useState([]);
    const on = !!flags?.events;

    useEffect(() => {
        if (!on) return undefined;
        let cancelled = false;
        eventsApi.list({ upcoming: 'true', hostListingId: listing.id, limit: 10 })
            .then((res) => { if (!cancelled) setEvents(res?.data || []); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [on, listing.id]);

    if (!on || events.length === 0) return null;
    return (
        <section className="dir-events" aria-labelledby="dir-events-title">
            <h2 id="dir-events-title" style={titleStyle}>{t('directory.official.events')}</h2>
            <ul>
                {events.map((e) => <li key={e.id}><EventRow event={e} lang={i18n.language} /></li>)}
            </ul>
            <style jsx>{`
                .dir-events { margin-top: 1.75rem; }
                ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
            `}</style>
        </section>
    );
}
