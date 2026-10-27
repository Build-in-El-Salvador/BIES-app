import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Search, Plus, ChevronRight, ChevronLeft, MapPin, Video, Users, CalendarDays, Loader2, Hand } from 'lucide-react';
import { eventsApi } from '../services/api';
import { useAuth } from '../context/AuthContext';
import CoverPhoto from '../components/CoverPhoto';
import { BiesTag, PriceLine, TicketButton, WhoLine } from '../components/events/EventBits';
import EventRow from '../components/events/EventRow';
import ProposalCard from '../components/events/ProposalCard';
import { bothTicketLinks, isFree, monthHeading, monthKey, whenShort } from '../utils/eventFormat';
import { CARD_SHADE, focusOf, parseFrame } from '../utils/coverFrame';
import biesLogo from '../assets/logo-icon.svg';

/**
 * Events: BIES events first, as large photo cards you swipe through, then
 * community events as a list by date (a calendar tile, then a small photo),
 * as Luma lists events, then meetups members proposed, which aren't on yet
 * (one joins Community events when enough people are in). Chips filter them;
 * "Past events" lists what's over. Tickets are the host's own page (Luma,
 * pretix…): the app doesn't sell them.
 */

const FILTERS = ['all', 'bies', 'community', 'proposed', 'free', 'online'];
const isProposal = (e) => e.stage === 'proposed';
const keep = (filter) => (e) => filter === 'all'
    || (filter === 'bies' && e.isOfficial)
    || (filter === 'community' && !e.isOfficial && !isProposal(e))
    || (filter === 'proposed' && isProposal(e))
    || (filter === 'free' && isFree(e) && !isProposal(e))
    || (filter === 'online' && e.isOnline);

const Events = () => {
    const { t, i18n } = useTranslation();
    const { user } = useAuth();
    const lang = i18n.language;
    const [params, setParams] = useSearchParams();
    const past = params.get('past') === '1';
    const [search, setSearch] = useState('');
    const [filter, setFilter] = useState('all');
    const [events, setEvents] = useState(null); // null while loading
    const [error, setError] = useState(false);
    const [going, setGoing] = useState({}); // eventId → true/false after a tap
    const [busy, setBusy] = useState({}); // proposal id → true while a tap is on its way
    const [notice, setNotice] = useState(''); // why a tap on a proposal didn't take
    const [addMenu, setAddMenu] = useState(false); // + : add an event, or propose a meetup

    // The + menu closes with Escape too.
    useEffect(() => {
        if (!addMenu) return undefined;
        const onKey = (e) => { if (e.key === 'Escape') setAddMenu(false); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [addMenu]);

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

    // Past events have no Proposed chip: all of them, then.
    const chip = past && filter === 'proposed' ? 'all' : filter;
    const shown = useMemo(() => (events || []).filter(keep(chip)), [events, chip]);
    const bies = past ? [] : shown.filter((e) => e.isOfficial);
    const community = past ? shown : shown.filter((e) => !e.isOfficial && !isProposal(e));
    const proposals = past ? [] : shown.filter(isProposal);
    const showProposals = !past && (chip === 'all' || chip === 'proposed');
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

    // As many as the list said, with my own tap counted.
    const withMyTap = (e) => ({ ...e, goingCount: (e.goingCount || 0) - (e.rsvpStatus === 'GOING' ? 1 : 0) + (isGoing(e) ? 1 : 0) });

    // I'm in on a proposal: when that makes its number it's on, and moves up
    // into Community events.
    const join = async (event, next) => {
        if (busy[event.id]) return;
        const before = isGoing(event);
        setNotice('');
        setGoing((g) => ({ ...g, [event.id]: next }));
        setBusy((b) => ({ ...b, [event.id]: true }));
        try {
            const res = next ? await eventsApi.rsvp(event.id, 'GOING') : await eventsApi.cancelRsvp(event.id);
            if (res?.confirmed) load(search.trim());
        } catch (err) {
            setGoing((g) => ({ ...g, [event.id]: before }));
            const reason = err?.data?.reason;
            setNotice(t(`events.proposals.errors.${reason}`, { defaultValue: t('events.proposals.errors.generic') }));
            if (reason === 'called_off') load(search.trim());
        } finally {
            setBusy((b) => ({ ...b, [event.id]: false }));
        }
    };
    const closed = (e) => !!e.decideBy && new Date(e.decideBy).getTime() < Date.now();

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
                    <div className="ev-add-wrap">
                        <button type="button" className="ev-add" aria-label={t('events.page.add')} aria-haspopup="menu" aria-expanded={addMenu} onClick={() => setAddMenu((v) => !v)}>
                            <Plus size={22} />
                        </button>
                        {addMenu && (
                            <>
                                <div className="ev-add-backdrop" onClick={() => setAddMenu(false)} />
                                <div className="ev-add-menu" role="menu">
                                    <Link to="/events/create" role="menuitem"><CalendarDays size={18} aria-hidden="true" /> {t('events.proposals.addEvent')}</Link>
                                    <Link to="/events/propose" role="menuitem"><Hand size={18} aria-hidden="true" /> {t('events.proposals.propose')}</Link>
                                </div>
                            </>
                        )}
                    </div>
                </div>

                <div className="ev-chips" role="group" aria-label={t('events.page.title')}>
                    {past && (
                        <button type="button" className="ev-chip back" onClick={() => setParams({})}>
                            <ChevronLeft size={15} aria-hidden="true" /> {t('events.page.upcoming')}
                        </button>
                    )}
                    {FILTERS.filter((f) => !(past && f === 'proposed')).map((f) => (
                        <button key={f} type="button" className={`ev-chip${chip === f ? ' on' : ''}`} aria-pressed={chip === f} onClick={() => setFilter(f)}>
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
                ) : shown.length === 0 && chip !== 'proposed' ? (
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

                {events !== null && !error && showProposals && (
                    // Not on yet, so under the confirmed ones.
                    <section aria-labelledby="ev-prop-title">
                        <h2 id="ev-prop-title" className="ev-sec-h">
                            <Hand size={20} aria-hidden="true" /> {t('events.proposals.section')} {proposals.length > 0 && <span>{proposals.length}</span>}
                        </h2>
                        <p className="ev-sec-hint">{t('events.proposals.sectionHint')}</p>
                        {notice && <p className="ev-notice" role="alert">{notice}</p>}
                        <ul className="ev-list">
                            {proposals.map((e) => (
                                <li key={e.id}>
                                    <ProposalCard
                                        event={withMyTap(e)}
                                        lang={lang}
                                        going={isGoing(e)}
                                        onGoing={(next) => join(e, next)}
                                        busy={!!busy[e.id]}
                                        mine={!!user && e.hostId === user.id}
                                        closed={closed(e)}
                                    />
                                </li>
                            ))}
                            <li>
                                <Link to="/events/propose" className="ev-propose">
                                    <span className="ev-propose-icon"><Plus size={20} aria-hidden="true" /></span>
                                    <span className="ev-propose-text">
                                        <b>{t('events.proposals.propose')}</b>
                                        <small>{t('events.proposals.proposeHint')}</small>
                                    </span>
                                </Link>
                            </li>
                        </ul>
                    </section>
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
                .ev-add-wrap { position: relative; flex-shrink: 0; }
                .ev-add {
                    display: flex; align-items: center; justify-content: center; width: 44px; height: 44px; min-width: 44px;
                    border-radius: 50%; border: 0; cursor: pointer; background: var(--color-primary); color: white;
                }
                .ev-add-backdrop { position: fixed; inset: 0; z-index: 40; }
                .ev-add-menu {
                    position: absolute; right: 0; top: 52px; z-index: 41; min-width: 230px; padding: 6px;
                    background: var(--color-surface); border: 1px solid var(--color-gray-200); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg);
                    display: flex; flex-direction: column;
                }
                .ev-add-menu :global(a) {
                    display: flex; align-items: center; gap: 10px; padding: 12px; border-radius: var(--radius-md);
                    font-size: 0.95rem; font-weight: 600; color: var(--color-gray-900); text-decoration: none;
                }
                .ev-add-menu :global(a:hover) { background: var(--color-gray-100); }
                .ev-add-menu :global(svg) { color: var(--color-primary); }
                .ev-sec-hint { margin: -4px 0 10px; font-size: 0.85rem; color: var(--color-gray-500); }
                .ev-notice { margin: 0 0 10px; padding: 10px 12px; border-radius: var(--radius-md); background: var(--color-orange-tint); color: var(--color-orange-text); font-size: 0.875rem; }
                .ev-content :global(.ev-propose) {
                    display: flex; align-items: center; gap: 12px; padding: 14px; border-radius: 16px; height: 100%; box-sizing: border-box;
                    border: 1.5px dashed var(--color-gray-300); text-decoration: none; color: inherit;
                }
                .ev-propose-icon { width: 44px; height: 44px; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center; background: rgba(0, 71, 171, 0.08); color: var(--color-primary); }
                .ev-propose-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
                .ev-propose-text b { font-family: var(--font-display); font-size: 1.2rem; line-height: 1.1; color: var(--color-gray-900); }
                .ev-propose-text small { font-size: 0.82rem; color: var(--color-gray-500); }
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

/**
 * A BIES event: the photo fills the card, the words sit on its dark foot. Its
 * team can give the card its own photo and position it for the card's shape
 * (cardImage, cardFrame); otherwise the cover, kept on the part chosen for it.
 */
function SpotlightCard({ event, lang, going, onGoing }) {
    const { t } = useTranslation();
    const photo = event.cardImage || event.thumbnail;
    return (
        <article className="ev-spot">
            {photo && (
                <span className="ev-spot-photo">
                    <CoverPhoto src={photo} frame={event.cardFrame} focus={event.cardImage ? undefined : focusOf(parseFrame(event.coverFrame))} />
                </span>
            )}
            <span className="ev-spot-shade" style={{ background: CARD_SHADE }} aria-hidden="true" />
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
                .ev-spot-shade { position: absolute; inset: 0; }
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
