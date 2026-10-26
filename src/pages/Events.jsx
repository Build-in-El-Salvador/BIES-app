import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Search, Plus, ChevronRight, ChevronLeft, MapPin, Video, Users, CalendarDays, Loader2 } from 'lucide-react';
import { eventsApi } from '../services/api';
import Avatar from '../components/Avatar';
import { BiesTag, PriceLine, TicketButton, WhoLine } from '../components/events/EventBits';
import EventRow from '../components/events/EventRow';
import { bothTicketLinks, isFree, monthHeading, monthKey, whenShort } from '../utils/eventFormat';
import biesLogo from '../assets/logo-icon.svg';

/**
 * Events: BIES events first, as large photo cards you swipe through, then
 * community events as a list by date (a calendar tile, then a small photo),
 * as Luma lists events. Chips filter both; "Past events" lists what's over.
 * Tickets are the host's own page (Luma, pretix…): the app doesn't sell them.
 */

const FILTERS = ['all', 'bies', 'community', 'free', 'online'];
const keep = (filter) => (e) => filter === 'all'
    || (filter === 'bies' && e.isOfficial)
    || (filter === 'community' && !e.isOfficial)
    || (filter === 'free' && isFree(e))
    || (filter === 'online' && e.isOnline);

const Events = () => {
    const { t, i18n } = useTranslation();
    const lang = i18n.language;
    const [params, setParams] = useSearchParams();
    const past = params.get('past') === '1';
    const [search, setSearch] = useState('');
    const [filter, setFilter] = useState('all');
    const [events, setEvents] = useState(null); // null while loading
    const [error, setError] = useState(false);
    const [going, setGoing] = useState({}); // eventId → true/false after a tap

    const latest = useRef(0); // only the newest answer is shown
    const load = useCallback(async (q) => {
        const ask = ++latest.current;
        setError(false);
        try {
            const res = await eventsApi.list({ ...(past ? { past: 'true' } : { upcoming: 'true' }), ...(q ? { search: q } : {}), limit: 50 });
            if (ask === latest.current) setEvents(res?.data || []);
        } catch {
            if (ask !== latest.current) return;
            setError(true);
            setEvents([]);
        }
    }, [past]);

    useEffect(() => {
        setEvents(null);
        const timer = setTimeout(() => load(search.trim()), search ? 300 : 0);
        return () => clearTimeout(timer);
    }, [load, search]);

    const shown = useMemo(() => (events || []).filter(keep(filter)), [events, filter]);
    const bies = past ? [] : shown.filter((e) => e.isOfficial);
    const community = past ? shown : shown.filter((e) => !e.isOfficial);
    const byMonth = useMemo(() => {
        const groups = [];
        for (const e of community) {
            const key = monthKey(e.startDate);
            if (groups[groups.length - 1]?.key !== key) groups.push({ key, date: e.startDate, items: [] });
            groups[groups.length - 1].items.push(e);
        }
        return groups;
    }, [community]);

    const rsvp = async (event, next) => {
        setGoing((g) => ({ ...g, [event.id]: next }));
        try {
            if (next) await eventsApi.rsvp(event.id, 'GOING');
            else await eventsApi.cancelRsvp(event.id);
        } catch {
            setGoing((g) => ({ ...g, [event.id]: !next }));
        }
    };
    const isGoing = (e) => (e.id in going ? going[e.id] : e.rsvpStatus === 'GOING');

    return (
        <div className="events-page container">
            <h1 className="page-header events-header">{past ? t('events.page.past') : t('events.page.title')}</h1>
            <div className="ev-content">
                <div className="ev-search-row">
                    <label className="ev-search-bar">
                        <Search size={20} className="ev-search-icon" aria-hidden="true" />
                        <input
                            type="search"
                            className="ev-search-input"
                            placeholder={t('events.page.search')}
                            aria-label={t('events.page.search')}
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                        />
                    </label>
                    <Link to="/events/create" className="ev-add" aria-label={t('events.page.add')} title={t('events.page.add')}>
                        <Plus size={22} />
                    </Link>
                </div>

                <div className="ev-chips" role="group" aria-label={t('events.page.title')}>
                    {past && (
                        <button type="button" className="ev-chip back" onClick={() => setParams({})}>
                            <ChevronLeft size={15} aria-hidden="true" /> {t('events.page.upcoming')}
                        </button>
                    )}
                    {FILTERS.map((f) => (
                        <button key={f} type="button" className={`ev-chip${filter === f ? ' on' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                            {t(`events.page.filters.${f}`)}
                        </button>
                    ))}
                </div>

                {events === null ? (
                    <div className="ev-state"><Loader2 size={28} className="ev-spin" /></div>
                ) : error ? (
                    <div className="ev-state">
                        <p>{t('events.page.loadError')}</p>
                        <button type="button" className="ev-retry" onClick={() => { setEvents(null); load(search.trim()); }}>{t('events.page.retry')}</button>
                    </div>
                ) : shown.length === 0 ? (
                    <div className="ev-empty">
                        <CalendarDays size={28} aria-hidden="true" />
                        <p>{past ? t('events.page.noPast') : events.length ? t('events.page.noneFiltered') : t('events.page.none')}</p>
                        {!past && !events.length && (
                            <Link to="/events/create" className="ev-empty-cta"><Plus size={16} /> {t('events.page.add')}</Link>
                        )}
                    </div>
                ) : (
                    <>
                        {bies.length > 0 && (
                            <section aria-labelledby="ev-bies-title">
                                <h2 id="ev-bies-title" className="ev-sec-h">
                                    <img src={biesLogo} alt="" /> {t('events.page.biesEvents')} <span>{bies.length}</span>
                                </h2>
                                <div className={`ev-spot-row${bies.length === 1 ? ' one' : ''}`}>
                                    {bies.map((e) => (
                                        <SpotlightCard key={e.id} event={e} lang={lang} going={isGoing(e)} onGoing={(next) => rsvp(e, next)} />
                                    ))}
                                </div>
                            </section>
                        )}
                        {community.length > 0 && (
                            <section aria-labelledby="ev-com-title">
                                {!past && (
                                    <h2 id="ev-com-title" className="ev-sec-h">
                                        <Users size={20} aria-hidden="true" /> {t('events.page.communityEvents')} <span>{community.length}</span>
                                    </h2>
                                )}
                                {byMonth.map((g) => (
                                    <div key={g.key} className="ev-month">
                                        <p className="ev-month-h">{monthHeading(g.date, lang)}</p>
                                        <ul className="ev-list">
                                            {g.items.map((e) => <li key={e.id}><EventRow event={e} lang={lang} /></li>)}
                                        </ul>
                                    </div>
                                ))}
                            </section>
                        )}
                    </>
                )}

                {!past && (
                    <button type="button" className="ev-past" onClick={() => setParams({ past: '1' })}>
                        {t('events.page.past')} <ChevronRight size={16} aria-hidden="true" />
                    </button>
                )}
            </div>

            <style jsx>{`
                .events-page { padding-top: var(--page-top, 2rem); padding-bottom: 4rem; box-sizing: border-box; }
                .events-header { text-align: center; margin-bottom: 1.5rem; }
                /* The top bar shows the title on a phone. */
                @media (max-width: 768px) { .events-header { display: none; } }
                .ev-content { max-width: 760px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
                .ev-search-row { display: flex; align-items: center; gap: 0.75rem; }
                .ev-search-bar {
                    display: flex; align-items: center; flex: 1; min-width: 0;
                    background: var(--color-surface-raised); padding: 0.5rem; border-radius: var(--radius-full);
                    border: 1px solid var(--color-gray-200); box-shadow: var(--shadow-sm); transition: all 0.2s;
                }
                .ev-search-bar:focus-within { border-color: var(--color-primary); box-shadow: 0 0 0 3px rgba(0, 71, 171, 0.1); }
                .ev-search-bar :global(.ev-search-icon) { margin-left: 0.75rem; color: var(--color-gray-400); flex-shrink: 0; }
                .ev-search-input { flex: 1; min-width: 0; border: none; background: none; padding: 0.5rem 0.75rem; outline: none; font-size: 1rem; color: inherit; }
                .ev-content :global(.ev-add) {
                    display: flex; align-items: center; justify-content: center; width: 44px; height: 44px; min-width: 44px;
                    border-radius: 50%; background: var(--color-primary); color: white; text-decoration: none; flex-shrink: 0;
                }
                .ev-chips { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; scrollbar-width: none; }
                .ev-chips::-webkit-scrollbar { display: none; }
                .ev-chip {
                    flex-shrink: 0; display: inline-flex; align-items: center; gap: 4px;
                    padding: 6px 14px; border-radius: var(--radius-full); border: 1px solid var(--color-gray-200);
                    background: var(--color-surface); color: var(--color-gray-700); font-size: 0.85rem; font-weight: 500; cursor: pointer; white-space: nowrap;
                }
                .ev-chip.on { background: var(--color-primary); border-color: var(--color-primary); color: white; }
                .ev-chip.back { color: var(--color-primary); font-weight: 600; }
                .ev-sec-h {
                    display: flex; align-items: center; gap: 8px; margin: 6px 0 10px;
                    font-family: var(--font-display); font-size: 1.5rem; line-height: 1; color: var(--color-gray-900);
                }
                .ev-sec-h img { width: 22px; height: 22px; }
                .ev-sec-h :global(svg) { color: var(--color-primary); }
                .ev-sec-h span { font-family: var(--font-sans); font-size: 0.85rem; font-weight: 500; color: var(--color-gray-500); }
                .ev-spot-row {
                    display: flex; gap: 12px; overflow-x: auto; scroll-snap-type: x mandatory; scrollbar-width: none;
                    margin: 0 calc(-1 * var(--spacing-md)); padding: 0 var(--spacing-md) 4px;
                }
                .ev-spot-row::-webkit-scrollbar { display: none; }
                .ev-month { margin-bottom: 10px; }
                .ev-month-h { margin: 4px 0 8px; font-size: 0.75rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--color-gray-500); }
                .ev-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; grid-template-columns: minmax(0, 1fr); }
                .ev-state, .ev-empty { text-align: center; padding: 3rem 1rem; color: var(--color-gray-500); }
                .ev-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; border: 1px dashed var(--color-gray-300); border-radius: var(--radius-lg); background: var(--color-surface); }
                .ev-empty p { margin: 0; max-width: 36ch; }
                .ev-empty :global(.ev-empty-cta) {
                    display: inline-flex; align-items: center; gap: 6px; margin-top: 6px; padding: 0.6rem 1.2rem;
                    border-radius: var(--radius-full); background: var(--color-primary); color: white; font-weight: 600; text-decoration: none;
                }
                .ev-retry { border: 1px solid var(--color-gray-300); background: var(--color-surface); border-radius: var(--radius-full); padding: 0.5rem 1rem; font-weight: 600; cursor: pointer; }
                .ev-state :global(.ev-spin) { animation: spin 1s linear infinite; }
                .ev-past {
                    align-self: center; display: inline-flex; align-items: center; gap: 4px; margin-top: 4px;
                    border: 0; background: none; color: var(--color-primary); font-size: 0.9rem; font-weight: 600; cursor: pointer; padding: 8px;
                }
                @media (min-width: 768px) {
                    .ev-spot-row { overflow: visible; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); margin: 0; padding: 0; }
                    .ev-spot-row.one { grid-template-columns: minmax(0, 1fr); }
                    .ev-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
                }
            `}</style>
        </div>
    );
};

/** A BIES event: the photo fills the card, the words sit on its dark foot. */
function SpotlightCard({ event, lang, going, onGoing }) {
    const { t } = useTranslation();
    return (
        <article className="ev-spot">
            <span className="ev-spot-photo"><Avatar src={event.thumbnail} fallback={null} /></span>
            <span className="ev-spot-shade" aria-hidden="true" />
            <Link to={`/events/${event.id}`} state={{ preview: event }} className="ev-spot-link" aria-label={event.title} />
            <span className="ev-spot-tag"><BiesTag /></span>
            <div className="ev-spot-body">
                <span className="ev-spot-when">{whenShort(event.startDate, lang)}</span>
                <h3 className="ev-spot-title">{event.title}</h3>
                <span className="ev-spot-where">
                    {event.isOnline ? <Video size={14} aria-hidden="true" /> : <MapPin size={14} aria-hidden="true" />}
                    <span>{event.isOnline ? t('events.card.online') : (event.locationName || event.location)}</span>
                </span>
                <WhoLine event={event} className="ev-spot-who" />
                <div className={`ev-spot-foot${bothTicketLinks(event) ? ' two' : ''}`}>
                    <PriceLine event={event} className="ev-spot-price" />
                    <TicketButton event={event} going={going} onGoing={onGoing} />
                </div>
            </div>
            <style jsx>{`
                .ev-spot {
                    position: relative; flex: none; width: 86%; max-width: 420px; aspect-ratio: 4 / 5;
                    border-radius: 20px; overflow: hidden; scroll-snap-align: start;
                    background: linear-gradient(135deg, var(--color-primary), #0A192F); color: #FFFFFF;
                    display: flex; flex-direction: column; justify-content: flex-end;
                    --ev-face-ring: rgba(8, 15, 45, 0.9); --ev-who-color: rgba(255, 255, 255, 0.85);
                    --ev-price-color: #FFFFFF; --ev-price-sub: rgba(255, 255, 255, 0.75);
                }
                .ev-spot-photo { position: absolute; inset: 0; }
                .ev-spot-photo :global(img) { width: 100%; height: 100%; object-fit: cover; display: block; }
                .ev-spot-shade { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(10, 20, 60, 0) 30%, rgba(10, 20, 60, 0.55) 58%, rgba(8, 15, 45, 0.92) 100%); }
                .ev-spot :global(.ev-spot-link) { position: absolute; inset: 0; z-index: 1; }
                .ev-spot-tag { position: absolute; left: 14px; top: 14px; z-index: 1; }
                .ev-spot-body { position: relative; padding: 16px; display: flex; flex-direction: column; gap: 8px; pointer-events: none; }
                .ev-spot-body :global(button) { pointer-events: auto; }
                .ev-spot-when { font-size: 0.78rem; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; color: #FFD3BA; }
                .ev-spot-title { margin: 0; font-family: var(--font-display); font-size: 1.9rem; line-height: 1.05; color: #FFFFFF; text-wrap: balance; overflow-wrap: anywhere; }
                .ev-spot-where { display: flex; align-items: center; gap: 6px; font-size: 0.85rem; color: rgba(255, 255, 255, 0.85); min-width: 0; }
                .ev-spot-where span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .ev-spot-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 4px; }
                .ev-spot-foot.two { flex-direction: column; align-items: stretch; }
                @media (min-width: 768px) { .ev-spot { width: auto; max-width: none; aspect-ratio: 4 / 3; } }
            `}</style>
        </article>
    );
}

export default Events;
