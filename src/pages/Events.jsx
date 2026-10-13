import React, { useState, useEffect, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Search, Filter, SlidersHorizontal, MapPin, Calendar as CalendarIcon, Clock, Users, Globe, Plus, ShieldCheck, Award, ChevronLeft, ChevronRight, X, Loader2, Ticket, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getAssetUrl } from '../utils/assets';
import { stripHtml } from '../utils/text';
import { eventsApi } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useViewPreference } from '../context/ViewContext';

const EVENT_CATEGORY_COLORS = {
    CONFERENCE: 'var(--color-blue-tint)',
    HACKATHON: 'var(--color-amber-tint)',
    WORKSHOP: 'var(--color-blue-tint)',
    MEETUP: 'var(--color-green-tint)',
    NETWORKING: 'var(--color-red-tint)',
    DEMO_DAY: 'var(--color-orange-tint)',
};

/**
 * Local-timezone YYYY-MM-DD. Calendar cells, event dots and the date filter
 * must all agree on the viewer's LOCAL day — comparing the UTC prefix of an
 * ISO string shifts events near midnight into the wrong day for UTC± viewers.
 */
const toLocalDateStr = (value) => {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value);
    if (isNaN(date.getTime())) return '';
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

const EventCard = ({ event, isOfficial, viewType = 'standard' }) => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const bgColor = EVENT_CATEGORY_COLORS[event.category] || 'var(--color-gray-100)';
    const hasImage = event.coverImage || event.image || event.thumbnail;
    const categoryLabel = (event.category || '').replace(/_/g, ' ');
    const dateStrList = (() => {
        const d = event.startDate || event.date;
        if (!d) return '';
        try {
            const date = new Date(d);
            const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase().replace(' ', '');
            return `${dateStr}, ${timeStr}`;
        }
        catch { return d; }
    })();

    const dateStrFull = (() => {
        const d = event.startDate || event.date;
        if (!d) return '';
        try {
            const date = new Date(d);
            const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
            return `${dateStr} at ${timeStr}`;
        }
        catch { return d; }
    })();

    const displayLocation = useMemo(() => {
        if (!event.location) return 'El Salvador';
        const parts = event.location.split(',');
        if (parts.length > 1) return parts[0].trim();
        return event.location;
    }, [event.location]);

    if (viewType === 'list') {
        const tags = [
            categoryLabel,
            isOfficial ? t('common.official') : null,
            event.isOnline ? t('common.online') : null,
            event.isEndorsed ? t('common.endorsed') : null
        ].filter(Boolean);

        return (
            <Link to={`/events/${event.id}`} className="event-card-link-list">
                <div className="event-list-card" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '1.25rem', padding: '1rem', background: 'var(--color-surface)', borderRadius: 'var(--radius-xl)', border: `1px solid ${isOfficial ? '#fed7aa' : 'var(--color-gray-200)'}`, position: 'relative', overflow: 'hidden', boxSizing: 'border-box', width: '100%', minWidth: 0 }}>
                    <div className="event-list-avatar relative" style={{ width: '64px', height: '64px', borderRadius: '50%', overflow: 'hidden', background: 'var(--color-gray-100)', flexShrink: 0 }}>
                        {hasImage ? (
                            <img 
                                src={getAssetUrl(event.coverImage || event.image || event.thumbnail)} 
                                alt={event.title} 
                                className="w-full h-full object-cover" 
                                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                            />
                        ) : (
                            <div className="w-full h-full" style={{ width: '100%', height: '100%', backgroundColor: bgColor, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <CalendarIcon size={24} style={{ color: 'var(--color-gray-400)' }} />
                            </div>
                        )}
                    </div>
                    <div className="event-list-info" style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                        <h3 className="font-semibold text-lg" style={{ fontSize: '1.1rem', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginBottom: 2, margin: 0 }}>{event.title}</h3>
                        <div className="event-list-meta" style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '4px', fontSize: '0.8rem', color: 'var(--color-gray-500)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap' }}>
                                <CalendarIcon size={13} style={{ flexShrink: 0 }} />
                                <span>{dateStrList}</span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', overflow: 'hidden', minWidth: 0 }}>
                                <MapPin size={13} style={{ flexShrink: 0 }} />
                                <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{displayLocation}</span>
                            </div>
                        </div>

                        {(tags.length > 0 || event.priceSats > 0) && (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '6px' }}>
                                {event.priceSats > 0 && (
                                    <span className="event-list-tag" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '2px 8px', fontSize: '0.7rem', background: 'var(--color-orange-tint)', borderRadius: '99px', color: '#b45309', fontWeight: 700 }}>
                                        <Zap size={10} /> {Number(event.priceSats).toLocaleString()} sats
                                    </span>
                                )}
                                {tags.map((tag, i) => (
                                    <span key={i} className="event-list-tag" style={{ padding: '2px 8px', fontSize: '0.7rem', background: 'var(--color-surface-raised)', borderRadius: '99px', color: 'var(--color-gray-600)', fontWeight: 500 }}>{tag}</span>
                                ))}
                            </div>
                        )}
                    </div>
                    <div className="event-list-actions" style={{ flexShrink: 0 }}>
                        {/* Desktop: text pill button */}
                        {event.priceSats > 0 ? (
                            <>
                                <button
                                    className="btn btn-primary btn-xs ticket-btn-text"
                                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); navigate(`/events/${event.id}`); }}
                                >
                                    {t('common.buyTicket', 'Buy Ticket')}
                                </button>
                                <button
                                    className="ticket-btn-icon"
                                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); navigate(`/events/${event.id}`); }}
                                >
                                    <Zap size={18} />
                                </button>
                            </>
                        ) : (event.ticketUrl || event.externalUrl) ? (
                            <>
                                <a
                                    href={event.ticketUrl || event.externalUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="btn btn-primary btn-xs ticket-btn-text"
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    {t('common.getTickets')}
                                </a>
                                <a
                                    href={event.ticketUrl || event.externalUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="ticket-btn-icon"
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    <Ticket size={18} />
                                </a>
                            </>
                        ) : (
                            <>
                                <button
                                    className="btn btn-primary btn-xs ticket-btn-text"
                                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); navigate(`/events/${event.id}`); }}
                                >
                                    {t('common.rsvp', 'RSVP')}
                                </button>
                                <button
                                    className="ticket-btn-icon"
                                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); navigate(`/events/${event.id}`); }}
                                >
                                    <Ticket size={18} />
                                </button>
                            </>
                        )}
                    </div>
                </div>
                <style jsx>{`
                    .event-card-link-list { text-decoration: none; color: inherit; display: flex; width: 100%; }
                    .event-list-card {
                        transition: transform 0.2s, box-shadow 0.2s, border-color 0.2s;
                    }
                    .event-list-card:hover {
                        border-color: var(--color-primary-light);
                        box-shadow: var(--shadow-sm);
                    }
                    .event-list-tag {
                        font-size: 0.75rem;
                        padding: 2px 10px;
                        background: var(--color-surface-raised);
                        border-radius: 99px;
                        color: var(--color-gray-600);
                        font-weight: 500;
                    }
                    .ticket-btn-text {
                        display: inline-flex;
                        align-items: center;
                        height: 32px;
                        font-size: 0.8rem;
                        border-radius: var(--radius-full);
                        white-space: nowrap;
                        text-decoration: none;
                    }
                    .ticket-btn-icon {
                        display: none;
                        align-items: center;
                        justify-content: center;
                        width: 36px;
                        height: 36px;
                        min-width: 36px;
                        border-radius: 8px;
                        border: 1.5px solid var(--color-gray-200);
                        background: transparent;
                        color: var(--color-gray-500);
                        text-decoration: none;
                        transition: all 0.2s ease;
                        cursor: pointer;
                    }
                    .ticket-btn-icon:hover {
                        color: var(--color-primary);
                        border-color: var(--color-primary);
                        background: rgba(99, 102, 241, 0.06);
                    }
                    @media (max-width: 768px) {
                        .ticket-btn-text { display: none !important; }
                        .ticket-btn-icon { display: inline-flex !important; }
                    }
                `}</style>
            </Link>
        );
    }

    return (
        <div className="event-card">
            <Link to={`/events/${event.id}`} className="card-image-link">
                <div
                    className="card-image"
                    style={{
                        backgroundColor: hasImage ? undefined : bgColor,
                        backgroundImage: hasImage ? `url(${getAssetUrl(event.coverImage || event.image || event.thumbnail)})` : 'none',
                    }}
                >
                    <span className="cat-badge">{categoryLabel}</span>
                    <span className="date-badge"><CalendarIcon size={11} /> {dateStrFull}</span>
                    {event.priceSats > 0 && (
                        <span className="price-badge"><Zap size={11} /> {Number(event.priceSats).toLocaleString()} sats</span>
                    )}
                    {isOfficial && (
                        <span className="official-badge"><ShieldCheck size={11} /> {t('common.official')}</span>
                    )}
                    {event.isOnline && (
                        <span className="online-badge"><Globe size={11} /> {t('common.online')}</span>
                    )}
                    {event.isEndorsed && (
                        <span className="endorsed-badge"><Award size={11} /> {t('common.endorsed')}</span>
                    )}
                </div>
            </Link>
            <div className="card-body">
                <Link to={`/events/${event.id}`} className="card-title-link">
                    <h3>{event.title}</h3>
                </Link>
                <p className="description">{stripHtml(event.description)}</p>
                <div className="meta-rows">
                    <div className="meta-item"><CalendarIcon size={13} /><span>{dateStrFull}</span></div>
                    <div className="meta-item"><MapPin size={13} /><span>{event.location}</span></div>
                </div>
                <div className="actions">
                    {event.priceSats > 0 ? (
                        <Link to={`/events/${event.id}`} className="btn btn-primary btn-xs reserve-btn"><Zap size={13} style={{ marginRight: 4 }} /> {t('common.buyTicket', 'Buy Ticket')}</Link>
                    ) : (event.ticketUrl || event.externalUrl) ? (
                        <a href={event.ticketUrl || event.externalUrl} target="_blank" rel="noopener noreferrer" className="btn btn-primary btn-xs reserve-btn">{t('common.getTickets')}</a>
                    ) : (
                        <Link to={`/events/${event.id}`} className="btn btn-primary btn-xs reserve-btn">{t('common.rsvp', 'RSVP')}</Link>
                    )}
                </div>
            </div>
            <style jsx>{`
                .event-card {
                    background: var(--color-surface);
                    border-radius: var(--radius-lg);
                    overflow: hidden;
                    border: 1px solid ${isOfficial ? '#fed7aa' : 'var(--color-gray-200)'};
                    transition: transform 0.2s, box-shadow 0.2s;
                    display: flex;
                    flex-direction: column;
                }
                .event-card:hover { transform: translateY(-4px); box-shadow: var(--shadow-md); }
                .card-image-link { text-decoration: none; display: block; }
                .card-image {
                    height: 160px;
                    position: relative;
                    padding: 1rem;
                    background-size: cover;
                    background-position: center;
                }
                .cat-badge {
                    position: absolute;
                    top: 1rem;
                    left: 1rem;
                    background: rgba(75, 85, 99, 0.85);
                    padding: 4px 8px;
                    border-radius: 4px;
                    font-size: 0.72rem;
                    font-weight: 600;
                    color: white;
                    text-transform: uppercase;
                    letter-spacing: 0.03em;
                }
                .official-badge {
                    position: absolute;
                    bottom: 1rem;
                    right: 1rem;
                    background: var(--color-secondary);
                    color: white;
                    padding: 3px 8px;
                    border-radius: 4px;
                    font-size: 0.7rem;
                    font-weight: 700;
                    display: flex;
                    align-items: center;
                    gap: 3px;
                }
                .date-badge {
                    position: absolute;
                    top: 1rem;
                    right: 1rem;
                    background: rgba(0,0,0,0.7);
                    color: white;
                    padding: 3px 8px;
                    border-radius: 4px;
                    font-size: 0.7rem;
                    font-weight: 600;
                    display: flex;
                    align-items: center;
                    gap: 3px;
                }
                .price-badge {
                    position: absolute;
                    top: 3.2rem;
                    left: 1rem;
                    background: rgba(0,0,0,0.75);
                    color: #fbbf24;
                    padding: 3px 8px;
                    border-radius: 99px;
                    font-size: 0.7rem;
                    font-weight: 700;
                    display: flex;
                    align-items: center;
                    gap: 3px;
                }
                .online-badge {
                    position: absolute;
                    bottom: 1rem;
                    left: 1rem;
                    background: rgba(0,0,0,0.6);
                    color: white;
                    padding: 2px 8px;
                    border-radius: 99px;
                    font-size: 0.72rem;
                    display: flex;
                    align-items: center;
                    gap: 3px;
                }
                .endorsed-badge {
                    position: absolute;
                    bottom: 1rem;
                    right: 1rem;
                    background: var(--badge-warning-bg);
                    color: var(--badge-warning-text);
                    padding: 2px 8px;
                    border-radius: 99px;
                    font-size: 0.7rem;
                    font-weight: 700;
                    display: flex;
                    align-items: center;
                    gap: 3px;
                }
                .card-body { padding: 1.5rem; flex: 1; display: flex; flex-direction: column; }
                .card-title-link { text-decoration: none; color: inherit; }
                .card-title-link:hover h3 { color: var(--color-primary); }
                h3 { font-size: 1.05rem; margin-bottom: 0.5rem; line-height: 1.3; }
                .description {
                    font-size: 0.875rem;
                    color: var(--color-gray-500);
                    margin-bottom: 1rem;
                    line-height: 1.45;
                    display: -webkit-box;
                    -webkit-line-clamp: 2;
                    -webkit-box-orient: vertical;
                    overflow: hidden;
                }
                .meta-rows { display: flex; flex-direction: column; gap: 0.4rem; margin-bottom: 1rem; }
                .meta-item { display: flex; align-items: center; gap: 5px; font-size: 0.82rem; color: var(--color-gray-500); }
                .meta-item span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .actions { margin-top: auto; }
                .reserve-btn {
                    width: 100%;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 0.85rem;
                    height: 36px;
                    white-space: nowrap;
                    text-decoration: none;
                }

            `}</style>
        </div>
    );
};

const Events = () => {
    const { t } = useTranslation();
    const { user } = useAuth();
    const { defaultView } = useViewPreference();
    const [rawOfficialEvents, setRawOfficialEvents] = useState([]);
    const [rawCommunityEvents, setRawCommunityEvents] = useState([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [category, setCategory] = useState('');
    const [selectedDate, setSelectedDate] = useState(null);
    const [showOfficial, setShowOfficial] = useState(true);
    const [showCommunity, setShowCommunity] = useState(true);
    const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
    const [eventViewType, setEventViewType] = useState(() => localStorage.getItem('bies_events_view') || defaultView);
    const [viewMenuOpen, setViewMenuOpen] = useState(false);
    const isPWA = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

    const categories = [
        { id: 'NETWORKING', label: 'Networking' },
        { id: 'CONFERENCE', label: 'Conference' },
        { id: 'WORKSHOP', label: 'Workshop' },
        { id: 'HACKATHON', label: 'Hackathon' },
        { id: 'MEETUP', label: 'Meetup' },
        { id: 'DEMO_DAY', label: 'Demo Day' },
    ];

    useEffect(() => {
        const fetchEvents = async () => {
            setLoading(true);
            try {
                const officialParams = { upcoming: true, isOfficial: 'true' };
                if (search) officialParams.search = search;
                if (category) officialParams.category = category;

                const communityParams = { upcoming: true, isOfficial: 'false' };
                if (search) communityParams.search = search;
                if (category) communityParams.category = category;

                const [offResult, commResult] = await Promise.all([
                    eventsApi.list(officialParams),
                    eventsApi.list(communityParams)
                ]);

                const offList = offResult?.data || offResult || [];
                const commList = commResult?.data || commResult || [];

                setRawOfficialEvents(Array.isArray(offList) ? offList : []);
                setRawCommunityEvents(Array.isArray(commList) ? commList : []);
            } catch (err) {
                console.error('Fetch events error:', err);
                setRawOfficialEvents([]);
                setRawCommunityEvents([]);
            } finally {
                setLoading(false);
            }
        };
        const debounce = setTimeout(fetchEvents, 300);
        return () => clearTimeout(debounce);
    }, [search, category]);

    // Derive displayed lists — apply selectedDate filter client-side.
    // Compare LOCAL date strings on both sides: toISOString() of local midnight
    // is the previous day for UTC+ viewers and shifts events near midnight.
    const officialEvents = useMemo(() => {
        if (!selectedDate) return rawOfficialEvents;
        const dateStr = toLocalDateStr(selectedDate);
        return rawOfficialEvents.filter(e => toLocalDateStr(e.startDate || e.date) === dateStr);
    }, [rawOfficialEvents, selectedDate]);

    const communityEvents = useMemo(() => {
        if (!selectedDate) return rawCommunityEvents;
        const dateStr = toLocalDateStr(selectedDate);
        return rawCommunityEvents.filter(e => toLocalDateStr(e.startDate || e.date) === dateStr);
    }, [rawCommunityEvents, selectedDate]);

    // Build a Set of local date strings that have events, for calendar dot
    // indicators — the calendar cells are built from local date parts too
    const eventDates = useMemo(() => {
        const dates = new Set();
        [...rawOfficialEvents, ...rawCommunityEvents].forEach(e => {
            const d = toLocalDateStr(e.startDate || e.date);
            if (d) dates.add(d);
        });
        return dates;
    }, [rawOfficialEvents, rawCommunityEvents]);

    // Calendar Helper
    const [currentMonth, setCurrentMonth] = useState(new Date());
    const daysInMonth = (date) => new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    const firstDayOfMonth = (date) => new Date(date.getFullYear(), date.getMonth(), 1).getDay();

    const renderCalendar = () => {
        const totalDays = daysInMonth(currentMonth);
        const firstDay = firstDayOfMonth(currentMonth);
        const days = [];

        // Header
        const monthYear = currentMonth.toLocaleString('default', { month: 'long', year: 'numeric' });

        const dayStyle = {
            aspectRatio: '1',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '0.8rem',
            cursor: 'pointer',
            borderRadius: '4px',
        };

        for (let i = 0; i < firstDay; i++) {
            days.push(<div key={`empty-${i}`} style={{ aspectRatio: '1' }}></div>);
        }

        for (let d = 1; d <= totalDays; d++) {
            const date = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), d);
            const isSelected = selectedDate && date.toDateString() === selectedDate.toDateString();
            const isToday = date.toDateString() === new Date().toDateString();
            const dateStr = `${currentMonth.getFullYear()}-${String(currentMonth.getMonth() + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            const hasEvents = eventDates.has(dateStr);

            days.push(
                <div
                    key={d}
                    title={hasEvents ? 'Events on this date' : undefined}
                    style={{
                        ...dayStyle,
                        background: isSelected ? 'var(--color-secondary)' : hasEvents && !isSelected ? 'var(--color-blue-tint)' : undefined,
                        color: isSelected ? 'white' : isToday ? 'var(--color-secondary)' : hasEvents ? '#1d4ed8' : undefined,
                        fontWeight: isSelected || isToday || hasEvents ? 700 : undefined,
                        border: isSelected ? 'none' : isToday ? '1px solid var(--color-secondary)' : hasEvents ? '1.5px solid #3b82f6' : undefined,
                        cursor: hasEvents ? 'pointer' : 'default',
                        position: 'relative',
                    }}
                    onClick={() => hasEvents || isSelected ? setSelectedDate(isSelected ? null : date) : undefined}
                >
                    {d}
                </div>
            );
        }

        return (
            <div className="calendar-widget">
                <div style={{ display: 'flex', alignItems: 'center', width: '100%', marginBottom: '1rem' }}>
                    <button style={{ padding: '0.25rem', borderRadius: '4px', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-gray-400)', display: 'flex', alignItems: 'center' }} onClick={() => setCurrentMonth(prev => new Date(prev.getFullYear(), prev.getMonth() - 1, 1))}>
                        <ChevronLeft size={16} />
                    </button>
                    <span style={{ flex: 1, textAlign: 'center', fontWeight: 600, fontSize: '0.9rem' }}>{monthYear}</span>
                    <button style={{ padding: '0.25rem', borderRadius: '4px', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-gray-400)', display: 'flex', alignItems: 'center' }} onClick={() => setCurrentMonth(prev => new Date(prev.getFullYear(), prev.getMonth() + 1, 1))}>
                        <ChevronRight size={16} />
                    </button>
                </div>
                <div className="calendar-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '4px', textAlign: 'center', width: '100%' }}>
                    {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <div key={i} className="weekday" style={{ fontSize: '0.7rem', color: 'var(--color-gray-400)', fontWeight: 700, paddingBottom: '0.5rem' }}>{d}</div>)}
                    {days}
                </div>
                {selectedDate && (
                    <button className="clear-date" onClick={() => setSelectedDate(null)}>{t('common.clearDate')}</button>
                )}
            </div>
        );
    };

    return (
        <div className="events-page container">
            <div className="discover-header">
                <h1>{t('events.title')}</h1>
            </div>

            <div className="search-row">
                <div className="search-left-column">
                    {(user?.role === 'BUILDER' || user?.isAdmin || user?.role === 'MOD' || user?.role === 'INVESTOR') && (
                        <Link to="/events/create" className="btn btn-primary create-project-btn" style={{ display: 'flex', width: '100%', boxSizing: 'border-box', gap: '0.5rem', justifyContent: 'center' }}>
                            <Plus size={18} /><span>{t('events.createEvent')}</span>
                        </Link>
                    )}
                </div>
                <div style={{ display: 'flex', flex: 1, gap: '0.75rem', alignItems: 'center', minWidth: 0, maxWidth: '100%' }}>
                    <div className="search-bar">
                        <Search size={20} className="search-icon" />
                        <input
                            type="text"
                            placeholder={t('events.searchPlaceholder')}
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                        />
                        <div className="view-toggle-container" style={{ position: 'relative' }}>
                            <button className="mobile-filter-toggle" style={{ display: 'flex', marginRight: '0.25rem' }} onClick={() => setViewMenuOpen(!viewMenuOpen)} aria-label="Toggle View">
                                {eventViewType === 'list' && <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>}
                                {eventViewType === 'standard' && <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>}
                            </button>
                            {viewMenuOpen && (
                            <div className="view-menu-dropdown" style={{
                                position: 'absolute', top: '100%', right: 0, marginTop: '0.5rem',
                                background: 'var(--color-surface)', border: '1px solid var(--color-gray-200)',
                                borderRadius: 'var(--radius-md)', padding: '0.5rem', zIndex: 50,
                                boxShadow: 'var(--shadow-md)', minWidth: '160px',
                                display: 'flex', flexDirection: 'column', gap: '4px'
                            }}>
                                <button onClick={() => { setEventViewType('list'); setViewMenuOpen(false); }} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', border: 'none', background: eventViewType==='list'?'var(--color-primary)':'transparent', color: eventViewType==='list'?'white':'inherit', borderRadius: '4px', cursor:'pointer', fontWeight: 500 }}>
                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg> List
                                </button>
                                <button onClick={() => { setEventViewType('standard'); setViewMenuOpen(false); }} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', border: 'none', background: eventViewType==='standard'?'var(--color-primary)':'transparent', color: eventViewType==='standard'?'white':'inherit', borderRadius: '4px', cursor:'pointer', fontWeight: 500 }}>
                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg> Grid
                                </button>
                            </div>
                            )}
                        </div>
                        <button className="mobile-filter-toggle" style={{ display: 'flex' }} onClick={() => setMobileFiltersOpen(!mobileFiltersOpen)}>
                            <SlidersHorizontal size={20} />
                        </button>
                        <button className="btn btn-primary search-btn-desktop">{t('common.search')}</button>
                    </div>
                    {isPWA && (user?.role === 'BUILDER' || user?.isAdmin || user?.role === 'MOD' || user?.role === 'INVESTOR') && (
                        <Link to="/events/create" className="pwa-create-btn" title="Create Event" style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            width: 44, height: 44, minWidth: 44, borderRadius: '50%',
                            background: '#FF5B00', color: 'white', textDecoration: 'none', flexShrink: 0
                        }}>
                            <Plus size={24} strokeWidth={2.5} />
                        </Link>
                    )}
                </div>
            </div>

            <div className="content-layout">
                {/* Filters Sidebar */}
                <div className={`filters-column ${mobileFiltersOpen ? 'mobile-open' : ''}`}>
                    <div className="sidebar-section calendar-section">
                        <div className="filter-header">
                            <CalendarIcon size={18} />
                            <span>{t('events.calendar')}</span>
                        </div>
                        {renderCalendar()}
                    </div>

                    <aside className="filters">
                        <div className="filter-group">
                            <label>{t('events.eventTypes')}</label>
                            <div className="checkbox-list">
                                <label>
                                    <input type="checkbox" checked={showOfficial} onChange={e => setShowOfficial(e.target.checked)} />
                                    {t('events.officialEvents')}
                                </label>
                                <label>
                                    <input type="checkbox" checked={showCommunity} onChange={e => setShowCommunity(e.target.checked)} />
                                    {t('events.communityEvents')}
                                </label>
                            </div>
                        </div>

                        <div className="filter-group" style={{ marginBottom: 0 }}>
                            <label>{t('events.categories')}</label>
                            <div className="checkbox-list">
                                <button
                                    className={`cat-item ${!category ? 'active' : ''}`}
                                    onClick={() => setCategory('')}
                                >
                                    {t('events.allCategories')}
                                </button>
                                {categories.map(cat => (
                                    <button
                                        key={cat.id}
                                        className={`cat-item ${category === cat.id ? 'active' : ''}`}
                                        onClick={() => setCategory(cat.id)}
                                    >
                                        {cat.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </aside>
                </div>

                {/* Main Content */}
                <main className="main-content">
                    {loading ? (
                        <div className="loading-state">
                            <Loader2 size={40} className="spin text-primary" />
                        </div>
                    ) : (
                        <>
                            {/* Official Events Section */}
                            {showOfficial && officialEvents.length > 0 && (
                                <section className="events-section official-section">
                                    <div className="section-header">
                                        <ShieldCheck size={24} className="text-secondary" />
                                        <h2>{t('events.officialBIES')}</h2>
                                    </div>
                                    <div className={eventViewType === 'list' ? 'events-list-layout' : 'events-grid'}>
                                        {officialEvents.map(event => (
                                            <EventCard key={event.id} event={event} isOfficial={true} viewType={eventViewType} />
                                        ))}
                                    </div>
                                </section>
                            )}

                            {/* Community Events Section */}
                            {showCommunity && (
                                <section className="events-section community-section">
                                    <div className="section-header">
                                        <Users size={24} className="text-primary" />
                                        <h2>{t('events.communityBIES')}</h2>
                                    </div>
                                    {communityEvents.length === 0 ? (
                                        <div className="empty-state">{t('events.noCommunityEvents')}</div>
                                    ) : (
                                        <div className={eventViewType === 'list' ? 'events-list-layout' : 'events-grid'}>
                                            {communityEvents.map(event => (
                                                <EventCard key={event.id} event={event} isOfficial={false} viewType={eventViewType} />
                                            ))}
                                        </div>
                                    )}
                                </section>
                            )}

                            {!showOfficial && !showCommunity && (
                                <div className="empty-state">{t('events.selectEventTypes')}</div>
                            )}
                        </>
                    )}
                </main>
            </div>

            <style jsx>{`
                .events-page {
                    padding-top: var(--page-top, 2rem);
                    padding-bottom: 4rem;
                }

                .discover-header {
                    margin-bottom: 1.5rem;
                    text-align: center;
                }
                .discover-header h1 { font-size: 2.5rem; font-weight: 800; margin-bottom: 0.5rem; }

                .search-row {
                    display: flex;
                    align-items: center;
                    gap: 2rem;
                    margin-bottom: 2rem;
                    max-width: 100%;
                    box-sizing: border-box;
                }

                .search-left-column {
                    width: 250px;
                    flex-shrink: 0;
                    display: flex;
                }

                .create-project-btn {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 0.5rem;
                    font-weight: 600;
                    border-radius: var(--radius-full);
                    padding: 0.6rem 1.5rem;
                    white-space: nowrap;
                    width: 100%;
                    box-sizing: border-box;
                    flex-shrink: 0;
                    text-decoration: none;
                }

                .search-bar {
                    display: flex;
                    align-items: center;
                    flex: 1;
                    min-width: 0;
                    background: var(--color-gray-100);
                    padding: 0.5rem;
                    border-radius: var(--radius-full);
                    border: 1px solid var(--color-gray-300);
                    box-shadow: var(--shadow-sm);
                }

                .search-icon {
                    margin-left: 1rem;
                    color: var(--color-gray-400);
                }

                .search-bar input {
                    flex: 1;
                    border: none;
                    padding: 0.5rem 1rem;
                    outline: none;
                    font-size: 1rem;
                    background: transparent;
                }

                .search-btn-desktop {
                    white-space: nowrap;
                    flex-shrink: 0;
                }

                /* Layout */
                .content-layout {
                    display: flex;
                    gap: 2rem;
                    align-items: flex-start;
                }

                .filters-column {
                    width: 250px;
                    display: flex;
                    flex-direction: column;
                    flex-shrink: 0;
                }

                .filters {
                    width: 250px;
                    background: var(--color-gray-100);
                    padding: 1.5rem;
                    border-radius: var(--radius-lg);
                    height: fit-content;
                    border: 1px solid var(--color-gray-200);
                    display: flex;
                    flex-direction: column;
                }

                .filter-header {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    font-weight: 600;
                    margin-bottom: 1.5rem;
                    padding-bottom: 1rem;
                    border-bottom: 1px solid var(--color-gray-200);
                }

                .filter-group { margin-bottom: 1.5rem; }
                .filter-group label {
                    display: block;
                    font-size: 0.9rem;
                    font-weight: 600;
                    margin-bottom: 0.75rem;
                }

                .checkbox-list {
                    display: flex;
                    flex-direction: column;
                    gap: 0.5rem;
                    align-items: flex-start;
                }

                .checkbox-list label {
                    font-weight: normal;
                    font-size: 0.9rem;
                    color: var(--color-gray-600);
                    display: flex;
                    align-items: center;
                    justify-content: flex-start;
                    cursor: pointer;
                    width: auto;
                    padding: 2px 0;
                    margin: 0;
                    gap: 8px;
                }
                
                .checkbox-list input[type="checkbox"] {
                    margin: 0;
                    width: 16px;
                    height: 16px;
                    accent-color: var(--color-primary);
                    flex-shrink: 0;
                    cursor: pointer;
                }

                .cat-item {
                    width: 100%;
                    text-align: left;
                    padding: 0.5rem 0.75rem;
                    border-radius: var(--radius-md);
                    font-size: 0.9rem;
                    color: var(--color-gray-600);
                    background: none;
                    border: none;
                    cursor: pointer;
                    transition: all 0.2s;
                    font-weight: 500;
                }
                .cat-item:hover { background: var(--color-primary); color: white; }
                .cat-item.active { background: var(--color-primary); color: white; font-weight: 600; }

                /* Calendar Widget */
                .calendar-widget {
                    width: 100%;
                }
                .calendar-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 1rem;
                    width: 100%;
                }
                .calendar-header span { font-weight: 600; font-size: 0.9rem; flex: 1; text-align: center; }
                .calendar-header button {
                    padding: 0.25rem;
                    border-radius: 4px;
                    background: none;
                    border: none;
                    cursor: pointer;
                    color: var(--color-gray-400);
                }
                .calendar-header button:hover { color: var(--color-gray-900); background: var(--color-gray-100); }
                
                .sidebar-section {
                    background: var(--color-gray-100);
                    padding: 1.5rem;
                    border-radius: var(--radius-lg);
                    border: 1px solid var(--color-gray-200);
                    margin-bottom: 2rem;
                }

                .calendar-grid {
                    display: grid !important;
                    grid-template-columns: repeat(7, 1fr) !important;
                    gap: 4px !important;
                    text-align: center;
                    width: 100%;
                    min-width: 210px;
                }
                .weekday { font-size: 0.7rem; color: var(--color-gray-400); font-weight: 700; padding-bottom: 0.5rem; }
                .calendar-day {
                    aspect-ratio: 1;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 0.8rem;
                    cursor: pointer;
                    border-radius: 4px;
                    transition: all 0.2s;
                }
                .calendar-day:hover { background: var(--color-amber-tint); }
                .calendar-day.selected { background: var(--color-secondary); color: white; font-weight: 700; }
                .calendar-day.today { border: 1px solid var(--color-secondary); color: var(--color-secondary); font-weight: 700; }
                .calendar-day.empty { cursor: default; }
                .clear-date {
                    width: 100%;
                    margin-top: 1rem;
                    font-size: 0.75rem;
                    color: var(--color-gray-400);
                    background: none;
                    border: 1px solid var(--color-gray-200);
                    padding: 0.4rem;
                    border-radius: 4px;
                    cursor: pointer;
                }

                /* Main Content */
                .main-content { 
                    flex: 1;
                    min-width: 0;
                }
                .loading-state { display: flex; justify-content: center; padding: 4rem 0; }
                .spin { animation: spin 1s linear infinite; }
                @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

                .events-section { margin-bottom: 4rem; }
                .section-header {
                    display: flex;
                    align-items: center;
                    gap: 0.75rem;
                    margin-bottom: 1.5rem;
                }
                .section-header h2 { font-size: 1.5rem; font-weight: 800; color: var(--color-gray-900); }

                .events-grid {
                    display: grid;
                    grid-template-columns: repeat(3, 1fr);
                    gap: 1.5rem;
                }

                .events-list-layout {
                    display: flex;
                    flex-direction: column;
                    gap: 1rem;
                }
                
                @media (max-width: 768px) {
                    .events-list-layout {
                        padding: 0;
                        overflow: hidden;
                        max-width: 100%;
                        width: 100%;
                        box-sizing: border-box;
                    }
                }

                @media (max-width: 1150px) {
                    .events-grid { grid-template-columns: repeat(2, 1fr); }
                }

                .empty-state { padding: 3rem; text-align: center; color: var(--color-gray-400); background: var(--color-gray-100); border-radius: var(--radius-lg); border: 1px dashed var(--color-gray-200); }

                .mobile-filter-toggle {
                    display: none;
                    align-items: center;
                    justify-content: center;
                    width: 40px;
                    height: 40px;
                    border-radius: 50%;
                    border: none;
                    background: none;
                    color: var(--color-gray-500);
                    cursor: pointer;
                    flex-shrink: 0;
                }

                @media (max-width: 768px) {
                    .search-left-column { display: none !important; }
                    .discover-header { display: none !important; }
                    .page-header { display: none !important; }
                }

                @media (max-width: 768px) {
                    .search-row { flex-direction: column; align-items: stretch; gap: 1rem; }
                    .search-left-column { display: none !important; }
                    .content-layout { flex-direction: column; }
                    .filters-column {
                        width: 100%;
                        display: none;
                    }
                    .filters-column.mobile-open {
                        display: flex;
                    }
                    .filters { width: 100%; }
                    .events-grid { grid-template-columns: 1fr; }
                    .mobile-filter-toggle { display: flex; }
                    .search-btn-desktop { display: none; }
                }

                @media (max-width: 768px) {
                    :global(.ticket-btn-text) { display: none !important; }
                    :global(.ticket-btn-icon) { display: inline-flex !important; }
                    :global(.event-list-card) { gap: 0.75rem !important; padding: 0.75rem !important; }
                    :global(.event-list-avatar) { width: 52px !important; height: 52px !important; }
                    .content-layout { gap: 0 !important; }
                    .main-content { width: 100% !important; }
                }
            `}</style>
        </div>
    );
};

export default Events;
