import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { Plus, Edit, Trash2, ExternalLink, Loader2, MoreHorizontal, Copy, Check, ShieldCheck, Award, Globe, Lock, EyeOff, Users, UserCheck, Search, X, Mail, Ticket, Zap, QrCode } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { QRCodeSVG } from 'qrcode.react';
import { eventsApi } from '../services/api';
import { useApiQuery } from '../hooks/useApi';
import { getAssetUrl } from '../utils/assets';
import { publicUrl } from '../utils/publicUrl';

const VISIBILITY_CFG = {
    PUBLIC: { label: 'Public', color: 'var(--badge-success-text)', bg: 'var(--badge-success-bg)', icon: <Globe size={12} /> },
    LIMITED_SPACES: { label: 'Limited Spaces', color: 'var(--badge-warning-text)', bg: 'var(--badge-warning-bg)', icon: <Users size={12} /> },
    INVITE_ONLY: { label: 'Invite Only', color: '#7c3aed', bg: '#ede9fe', icon: <UserCheck size={12} /> },
    PRIVATE: { label: 'Private', color: 'var(--badge-error-text)', bg: 'var(--badge-error-bg)', icon: <Lock size={12} /> },
    DRAFT: { label: 'Draft', color: 'var(--badge-draft-text)', bg: 'var(--badge-draft-bg)', icon: <EyeOff size={12} /> },
};

const VISIBILITY_OPTIONS = ['PUBLIC', 'LIMITED_SPACES', 'INVITE_ONLY', 'PRIVATE', 'DRAFT'];

const VisibilityBadge = ({ visibility }) => {
    const cfg = VISIBILITY_CFG[visibility] || VISIBILITY_CFG.DRAFT;
    return (
        <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '2px 8px', borderRadius: 99,
            fontSize: '0.72rem', fontWeight: 700,
            color: cfg.color, background: cfg.bg,
        }}>
            {cfg.icon} {cfg.label}
        </span>
    );
};

const RSVP_OPTIONS = [
    { value: 'GOING', label: 'Going' },
    { value: 'INTERESTED', label: 'Interested' },
    { value: 'NOT_GOING', label: 'Not Going' },
];

const TICKET_STATUS_CFG = {
    PAID: { label: 'Paid', color: 'var(--badge-success-text)', bg: 'var(--badge-success-bg)' },
    PENDING: { label: 'Pending', color: 'var(--badge-warning-text)', bg: 'var(--badge-warning-bg)' },
    EXPIRED: { label: 'Expired', color: 'var(--badge-draft-text)', bg: 'var(--badge-draft-bg)' },
    CANCELLED: { label: 'Cancelled', color: 'var(--badge-error-text)', bg: 'var(--badge-error-bg)' },
};

const TicketStatusBadge = ({ status, checkedInAt }) => {
    const cfg = checkedInAt
        ? { label: 'Checked In', color: 'var(--badge-success-text)', bg: 'var(--badge-success-bg)' }
        : TICKET_STATUS_CFG[status] || TICKET_STATUS_CFG.PENDING;
    return (
        <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '2px 8px', borderRadius: 99,
            fontSize: '0.72rem', fontWeight: 700,
            color: cfg.color, background: cfg.bg,
        }}>
            {checkedInAt && <Check size={10} />} {cfg.label}
        </span>
    );
};

/** Host view: buyers for one event with door check-in (portal modal). */
const EventTicketsModal = ({ event, onClose }) => {
    const [tickets, setTickets] = useState([]);
    const [summary, setSummary] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [checkinLoading, setCheckinLoading] = useState(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const res = await eventsApi.eventTickets(event.id);
            setTickets(res?.data || []);
            setSummary(res?.summary || null);
        } catch (err) {
            setError(err?.message || 'Failed to load tickets.');
        } finally {
            setLoading(false);
        }
    }, [event.id]);

    useEffect(() => { load(); }, [load]);

    const handleCheckin = async (ticketId) => {
        setCheckinLoading(ticketId);
        try {
            const res = await eventsApi.checkinTicket(event.id, ticketId);
            const updated = res?.ticket || res;
            setTickets(prev => prev.map(t => (t.id === ticketId ? { ...t, ...updated } : t)));
            setSummary(prev => (prev ? { ...prev, checkedIn: (prev.checkedIn || 0) + 1 } : prev));
        } catch (err) {
            alert(err?.message || 'Failed to check in ticket.');
        } finally {
            setCheckinLoading(null);
        }
    };

    return ReactDOM.createPortal(
        <div className="tkm-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="tkm-card" role="dialog" aria-modal="true">
                <div className="tkm-header">
                    <h3 className="tkm-title"><Ticket size={16} style={{ color: '#f7931a' }} /> Tickets — {event.title}</h3>
                    <button className="tkm-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
                </div>
                {summary && (
                    <div className="tkm-summary">
                        <span><strong>{summary.sold}</strong> sold</span>
                        <span><Zap size={12} style={{ color: '#f7931a' }} /> <strong>{(summary.revenueSats || 0).toLocaleString()}</strong> sats</span>
                        <span><strong>{summary.checkedIn}</strong> checked in</span>
                        {summary.pending > 0 && <span><strong>{summary.pending}</strong> pending</span>}
                    </div>
                )}
                <div className="tkm-body">
                    {loading && (
                        <div className="tkm-empty"><Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} /></div>
                    )}
                    {!loading && error && <div className="tkm-empty" style={{ color: 'var(--color-error, #ef4444)' }}>{error}</div>}
                    {!loading && !error && tickets.length === 0 && (
                        <div className="tkm-empty">No tickets yet.</div>
                    )}
                    {!loading && !error && tickets.map(ticket => (
                        <div key={ticket.id} className="tkm-row">
                            <div className="tkm-avatar">
                                {ticket.buyer?.avatar ? (
                                    <img src={getAssetUrl(ticket.buyer.avatar)} alt="" />
                                ) : (
                                    <span>{(ticket.buyer?.name || '?').charAt(0).toUpperCase()}</span>
                                )}
                            </div>
                            <div className="tkm-row-info">
                                <div className="tkm-buyer-name">{ticket.buyer?.name || 'BIES member'}</div>
                                <div className="tkm-row-meta">
                                    {(ticket.amountSats || 0).toLocaleString()} sats
                                    {ticket.paidAt && ` · ${new Date(ticket.paidAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`}
                                </div>
                            </div>
                            <TicketStatusBadge status={ticket.status} checkedInAt={ticket.checkedInAt} />
                            {ticket.status === 'PAID' && !ticket.checkedInAt && (
                                <button
                                    className="tkm-checkin-btn"
                                    disabled={checkinLoading === ticket.id}
                                    onClick={() => handleCheckin(ticket.id)}
                                >
                                    {checkinLoading === ticket.id
                                        ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />
                                        : <UserCheck size={13} />}
                                    Check-in
                                </button>
                            )}
                        </div>
                    ))}
                </div>
            </div>
        </div>,
        document.body
    );
};

/** Buyer view: tap-to-show door QR for a purchased ticket (portal modal). */
const TicketQrModal = ({ ticket, onClose }) => ReactDOM.createPortal(
    <div className="tkm-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="tkm-card tkm-qr-card" role="dialog" aria-modal="true">
            <div className="tkm-header">
                <h3 className="tkm-title"><Ticket size={16} style={{ color: '#f7931a' }} /> My Ticket</h3>
                <button className="tkm-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
            </div>
            <div className="tkm-body tkm-qr-body">
                {ticket.event?.title && <p className="tkm-qr-event">{ticket.event.title}</p>}
                <div className="tkm-qr-wrap">
                    <QRCodeSVG value={ticket.id} size={200} level="M" marginSize={2} bgColor="#ffffff" fgColor="#000000" />
                </div>
                <p className="tkm-qr-id">Ticket #{ticket.id}</p>
                <TicketStatusBadge status={ticket.status} checkedInAt={ticket.checkedInAt} />
                <p className="tkm-qr-hint">
                    {ticket.checkedInAt ? 'This ticket has been checked in.' : 'Show this QR code at the door for check-in.'}
                </p>
            </div>
        </div>
    </div>,
    document.body
);

const AttendingActionMenu = ({ event, onChangeRsvp, onRemove }) => {
    const [open, setOpen] = useState(false);
    const [pos, setPos] = useState({ top: 0, left: 0 });
    const btnRef = useRef(null);
    const navigate = useNavigate();

    const handleToggle = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!open && btnRef.current) {
            const rect = btnRef.current.getBoundingClientRect();
            setPos({ top: rect.bottom + 4, left: rect.right });
        }
        setOpen(v => !v);
    };

    const close = () => setOpen(false);

    return (
        <>
            <button ref={btnRef} className="action-menu-trigger" onClick={handleToggle} title="Actions">
                <MoreHorizontal size={18} />
            </button>
            {open && ReactDOM.createPortal(
                <>
                    <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onClick={close} />
                    <div className="ctx-menu" style={{ position: 'fixed', top: pos.top, left: pos.left, transform: 'translateX(-100%)', zIndex: 9999 }}>
                        <button className="ctx-item" onClick={() => { close(); navigate(`/events/${event.id}`); }}>
                            <ExternalLink size={15} /> View Event
                        </button>
                        <div className="ctx-submenu-header">RSVP Status</div>
                        {RSVP_OPTIONS.map(opt => (
                            <button
                                key={opt.value}
                                className={`ctx-item ${event.rsvpStatus === opt.value ? 'ctx-active' : ''}`}
                                onClick={() => { close(); onChangeRsvp(event.id, opt.value); }}
                            >
                                {opt.label}
                                {event.rsvpStatus === opt.value && <Check size={12} style={{ marginLeft: 'auto' }} />}
                            </button>
                        ))}
                        <div className="ctx-divider" />
                        <button className="ctx-item ctx-delete" onClick={() => { close(); onRemove(event.id, event.title); }}>
                            <Trash2 size={15} /> Remove from My Events
                        </button>
                    </div>
                </>,
                document.body
            )}
        </>
    );
};

const ActionMenu = ({ event, onDelete, onVisibilityChange, onCopyLink, onViewTickets }) => {
    const [open, setOpen] = useState(false);
    const [showVisibility, setShowVisibility] = useState(false);
    const [pos, setPos] = useState({ top: 0, left: 0 });
    const btnRef = useRef(null);
    const navigate = useNavigate();

    const handleToggle = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!open && btnRef.current) {
            const rect = btnRef.current.getBoundingClientRect();
            setPos({ top: rect.bottom + 4, left: rect.right });
        }
        setOpen(v => !v);
        setShowVisibility(false);
    };

    const close = () => { setOpen(false); setShowVisibility(false); };

    return (
        <>
            <button ref={btnRef} className="action-menu-trigger" onClick={handleToggle} title="Actions">
                <MoreHorizontal size={18} />
            </button>

            {open && ReactDOM.createPortal(
                <>
                    <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onClick={close} />
                    <div className="ctx-menu" style={{ position: 'fixed', top: pos.top, left: pos.left, transform: 'translateX(-100%)', zIndex: 9999 }}>
                        {!showVisibility ? (
                            <>
                                <button className="ctx-item" onClick={() => { close(); navigate(`/events/edit/${event.id}`); }}>
                                    <Edit size={15} /> Edit Event
                                </button>
                                <button className="ctx-item" onClick={() => { close(); navigate(`/events/${event.id}`); }}>
                                    <ExternalLink size={15} /> View Event
                                </button>
                                {event.priceSats > 0 && (
                                    <button className="ctx-item" onClick={() => { close(); onViewTickets(event); }}>
                                        <Ticket size={15} /> Tickets
                                    </button>
                                )}
                                <button className="ctx-item" onClick={() => { setShowVisibility(true); }}>
                                    <Globe size={15} /> Change Visibility
                                </button>
                                {(event.visibility === 'PRIVATE' || event.visibility === 'INVITE_ONLY') && (
                                    <button className="ctx-item ctx-copy" onClick={() => { close(); onCopyLink(event.id); }}>
                                        <Copy size={15} /> Copy Event Link
                                    </button>
                                )}
                                <div className="ctx-divider" />
                                <button className="ctx-item ctx-delete" onClick={() => { close(); onDelete(event.id, event.title); }}>
                                    <Trash2 size={15} /> Delete
                                </button>
                            </>
                        ) : (
                            <>
                                <div className="ctx-submenu-header">Change Visibility</div>
                                {VISIBILITY_OPTIONS.map(v => {
                                    const cfg = VISIBILITY_CFG[v];
                                    return (
                                        <button
                                            key={v}
                                            className={`ctx-item ctx-visibility ${event.visibility === v ? 'ctx-active' : ''}`}
                                            onClick={() => { close(); onVisibilityChange(event.id, v); }}
                                        >
                                            <span style={{ color: cfg.color }}>{cfg.icon}</span> {cfg.label}
                                            {event.visibility === v && <Check size={12} style={{ marginLeft: 'auto', color: cfg.color }} />}
                                        </button>
                                    );
                                })}
                            </>
                        )}
                    </div>
                </>,
                document.body
            )}
        </>
    );
};

const MyEvents = () => {
    const navigate = useNavigate();
    const [filter, setFilter] = useState('all');
    const [search, setSearch] = useState('');
    const [showSearch, setShowSearch] = useState(false);
    const [copiedId, setCopiedId] = useState(null);
    const [actionLoading, setActionLoading] = useState(null);
    const [ticketsEvent, setTicketsEvent] = useState(null); // hosted event whose ticket list is open
    const [qrTicket, setQrTicket] = useState(null); // purchased ticket whose QR is shown

    const { data: eventsData, loading, refetch } = useApiQuery(eventsApi.listMine);
    const { data: attendingData, loading: attendingLoading, refetch: refetchAttending } = useApiQuery(eventsApi.listAttending);
    const { data: myTicketsData } = useApiQuery(eventsApi.myTickets);
    const eventList = Array.isArray(eventsData?.data) ? eventsData.data : Array.isArray(eventsData) ? eventsData : [];
    const attendingList = Array.isArray(attendingData?.data) ? attendingData.data : Array.isArray(attendingData) ? attendingData : [];
    const myTicketsList = (Array.isArray(myTicketsData?.data) ? myTicketsData.data : []).filter(t => t.status === 'PAID');
    // Exclude events I'm hosting from the attending list, then split invited vs attending
    const hostedIds = new Set(eventList.map(e => e.id));
    const nonHosted = attendingList.filter(e => !hostedIds.has(e.id));
    const invitedOnly = nonHosted.filter(e => e.rsvpStatus === 'INVITED');
    const attendingOnly = nonHosted.filter(e => e.rsvpStatus !== 'INVITED');

    const filteredEvents = eventList.filter(e => {
        const vis = (e.visibility || 'DRAFT').toLowerCase();
        if (filter === 'published' && (vis === 'draft' || vis === 'private')) return false;
        if (filter === 'draft' && vis !== 'draft') return false;
        if (filter === 'private' && vis !== 'private') return false;
        if (search && !(e.title || '').toLowerCase().includes(search.toLowerCase())) return false;
        return true;
    });

    const handleDelete = async (id, title) => {
        if (!window.confirm(`Delete "${title}"? This cannot be undone.`)) return;
        setActionLoading(id);
        try {
            await eventsApi.delete(id);
            refetch();
        } catch (err) {
            alert(err?.message || 'Failed to delete event.');
        } finally {
            setActionLoading(null);
        }
    };

    const handleVisibilityChange = useCallback(async (id, newVisibility) => {
        setActionLoading(id);
        try {
            await eventsApi.update(id, { visibility: newVisibility });
            refetch();
        } catch {
            alert('Failed to update visibility.');
        } finally {
            setActionLoading(null);
        }
    }, [refetch]);

    const handleChangeRsvp = useCallback(async (id, status) => {
        setActionLoading(id);
        try {
            await eventsApi.rsvp(id, status);
            refetchAttending();
        } catch {
            alert('Failed to update RSVP.');
        } finally {
            setActionLoading(null);
        }
    }, [refetchAttending]);

    const handleRemoveAttending = async (id, title) => {
        if (!window.confirm(`Remove "${title}" from your events?`)) return;
        setActionLoading(id);
        try {
            await eventsApi.cancelRsvp(id);
            refetchAttending();
        } catch {
            alert('Failed to remove event.');
        } finally {
            setActionLoading(null);
        }
    };

    const handleCopyLink = (id) => {
        // The web address, also from the phone app (not capacitor://localhost).
        navigator.clipboard.writeText(publicUrl(`/events/${id}`));
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 2000);
    };

    const formatDate = (d) => {
        if (!d) return '—';
        try { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
        catch { return d; }
    };

    const categoryLabel = (c) => {
        if (!c) return '—';
        return c.replace(/_/g, ' ').split(' ').map(w => w[0] + w.slice(1).toLowerCase()).join(' ');
    };

    if (loading && attendingLoading) {
        return (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
                <Loader2 size={32} style={{ animation: 'spin 1s linear infinite' }} />
            </div>
        );
    }

    return (
        <div className="page-content">
            <div className="header">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                    <div style={{ flex: 1 }}>
                        <h1 style={{ display: 'flex', alignItems: 'center', gap: '1rem', width: '100%' }}>
                            <span className="page-title-block">My Events</span>
                            <Link to="/events/create" className="hide-on-desktop" title="Create Event" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '36px', height: '36px', borderRadius: '50%', background: 'var(--color-secondary)', color: 'white', textDecoration: 'none', marginLeft: 'auto' }}>
                                <Plus size={18} strokeWidth={2.5} />
                            </Link>
                        </h1>
                        <p className="subtitle page-title-block">Manage and track all your events</p>
                    </div>
                    <Link to="/events/create" className="btn btn-primary hide-on-mobile" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none', width: 250 }}>
                        <Plus size={18} style={{ marginRight: 8 }} />{' '}Create Event
                    </Link>
                </div>
            </div>

            <div className="card-container">
                <div className="toolbar">
                    <div className="tabs">
                        <button className={`tab ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>
                            All Events
                        </button>
                        <button className={`tab ${filter === 'published' ? 'active' : ''}`} onClick={() => setFilter('published')}>
                            Published
                        </button>
                        <button className={`tab ${filter === 'draft' ? 'active' : ''}`} onClick={() => setFilter('draft')}>
                            Drafts
                        </button>
                        <button className={`tab ${filter === 'private' ? 'active' : ''}`} onClick={() => setFilter('private')}>
                            Private
                        </button>
                    </div>
                    <div className="search-wrapper">
                        <button 
                            className="search-toggle-btn hide-on-desktop" 
                            onClick={() => setShowSearch(!showSearch)}
                            aria-label="Toggle search"
                        >
                            {showSearch ? <X size={20} /> : <Search size={20} />}
                        </button>
                        <div className={`search-input-container ${showSearch ? 'mobile-visible' : ''}`}>
                            <Search className="search-icon hide-on-mobile" size={16} />
                            <input
                                type="text"
                                placeholder="Search events..."
                                className="search-input"
                                value={search}
                                onChange={e => setSearch(e.target.value)}
                            />
                        </div>
                    </div>
                </div>

                {filteredEvents.length === 0 ? (
                    <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--color-gray-500)' }}>
                        {eventList.length === 0 ? 'No events yet. Create your first one!' : 'No events match your filter.'}
                    </div>
                ) : (
                    <div className="table-wrapper">
                        <table className="events-table">
                            <thead>
                                <tr>
                                    <th style={{ minWidth: '160px' }}>Event Name</th>
                                    <th>Category</th>
                                    <th>Date</th>
                                    <th>Visibility</th>
                                    <th>Badges</th>
                                    <th>Attendees</th>
                                    <th>Sold</th>
                                    <th>Revenue</th>
                                    <th style={{ width: '60px', textAlign: 'center' }}>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filteredEvents.map(event => (
                                    <tr key={event.id} style={{ opacity: actionLoading === event.id ? 0.5 : 1 }}>
                                        <td>
                                            <Link to={`/events/${event.id}`} className="event-name-link">
                                                {event.title}
                                            </Link>
                                        </td>
                                        <td style={{ color: 'var(--color-gray-600)', fontSize: '0.88rem' }}>
                                            {categoryLabel(event.category)}
                                        </td>
                                        <td style={{ color: 'var(--color-gray-500)', fontSize: '0.88rem', whiteSpace: 'nowrap' }}>
                                            {formatDate(event.startDate)}
                                        </td>
                                        <td>
                                            <VisibilityBadge visibility={event.visibility || 'DRAFT'} />
                                        </td>
                                        <td>
                                            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                                                {event.isOfficial && (
                                                    <span className="badge-sm badge-official"><ShieldCheck size={10} /> Official</span>
                                                )}
                                                {event.isEndorsed && (
                                                    <span className="badge-sm badge-endorsed"><Award size={10} /> Endorsed</span>
                                                )}
                                                {event.endorsementRequested && !event.isEndorsed && (
                                                    <span className="badge-sm badge-pending">Pending Review</span>
                                                )}
                                                {copiedId === event.id && (
                                                    <span className="badge-sm badge-copied"><Check size={10} /> Copied!</span>
                                                )}
                                            </div>
                                        </td>
                                        <td style={{ color: 'var(--color-gray-500)', fontSize: '0.88rem' }}>
                                            {event.attendeeCount || 0}
                                            {event.maxAttendees ? ` / ${event.maxAttendees}` : ''}
                                        </td>
                                        <td style={{ color: 'var(--color-gray-500)', fontSize: '0.88rem' }}>
                                            {event.priceSats > 0
                                                ? `${event.ticketsSold || 0}${event.ticketCapacity ? ` / ${event.ticketCapacity}` : ''}`
                                                : '—'}
                                        </td>
                                        <td style={{ color: 'var(--color-gray-500)', fontSize: '0.88rem', whiteSpace: 'nowrap' }}>
                                            {event.priceSats > 0
                                                ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Zap size={12} style={{ color: '#f7931a' }} /> {(event.revenueSats || 0).toLocaleString()} sats</span>
                                                : '—'}
                                        </td>
                                        <td style={{ textAlign: 'center' }}>
                                            <ActionMenu
                                                event={event}
                                                onDelete={handleDelete}
                                                onVisibilityChange={handleVisibilityChange}
                                                onCopyLink={handleCopyLink}
                                                onViewTickets={setTicketsEvent}
                                            />
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Events Invited To */}
            {invitedOnly.length > 0 && (
                <div className="card-container" style={{ marginTop: '2rem' }}>
                    <div className="toolbar">
                        <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <Mail size={16} /> Events Invited To
                            <span style={{
                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                minWidth: 22, height: 22, borderRadius: 99,
                                fontSize: '0.72rem', fontWeight: 700,
                                background: 'var(--badge-info-bg, #dbeafe)', color: 'var(--badge-info-text, #1d4ed8)',
                                padding: '0 6px',
                            }}>
                                {invitedOnly.length}
                            </span>
                        </h3>
                    </div>
                    <div className="table-wrapper">
                        <table className="events-table">
                            <thead>
                                <tr>
                                    <th style={{ minWidth: '160px' }}>Event Name</th>
                                    <th>Host</th>
                                    <th>Date</th>
                                    <th>Status</th>
                                    <th>Attendees</th>
                                    <th style={{ width: '60px', textAlign: 'center' }}>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {invitedOnly.map(event => (
                                    <tr key={event.id} style={{ opacity: actionLoading === event.id ? 0.5 : 1 }}>
                                        <td>
                                            <Link to={`/events/${event.id}`} className="event-name-link">
                                                {event.title}
                                            </Link>
                                        </td>
                                        <td style={{ color: 'var(--color-gray-600)', fontSize: '0.88rem' }}>
                                            {event.host?.profile?.name || 'Unknown'}
                                        </td>
                                        <td style={{ color: 'var(--color-gray-500)', fontSize: '0.88rem', whiteSpace: 'nowrap' }}>
                                            {formatDate(event.startDate)}
                                        </td>
                                        <td>
                                            <span style={{
                                                display: 'inline-flex', alignItems: 'center', gap: 4,
                                                padding: '2px 8px', borderRadius: 99,
                                                fontSize: '0.72rem', fontWeight: 700,
                                                color: 'var(--badge-info-text, #1d4ed8)',
                                                background: 'var(--badge-info-bg, #dbeafe)',
                                            }}>
                                                RSVP Pending
                                            </span>
                                        </td>
                                        <td style={{ color: 'var(--color-gray-500)', fontSize: '0.88rem' }}>
                                            {event.attendeeCount || 0}
                                            {event.maxAttendees ? ` / ${event.maxAttendees}` : ''}
                                        </td>
                                        <td style={{ textAlign: 'center' }}>
                                            <AttendingActionMenu
                                                event={event}
                                                onChangeRsvp={handleChangeRsvp}
                                                onRemove={handleRemoveAttending}
                                            />
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* Events I'm Attending */}
            {attendingOnly.length > 0 && (
                <div className="card-container" style={{ marginTop: '2rem' }}>
                    <div className="toolbar">
                        <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 700 }}>Events I'm Attending</h3>
                    </div>
                    <div className="table-wrapper">
                        <table className="events-table">
                            <thead>
                                <tr>
                                    <th style={{ minWidth: '160px' }}>Event Name</th>
                                    <th>Host</th>
                                    <th>Date</th>
                                    <th>RSVP</th>
                                    <th>Attendees</th>
                                    <th style={{ width: '60px', textAlign: 'center' }}>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {attendingOnly.map(event => (
                                    <tr key={event.id} style={{ opacity: actionLoading === event.id ? 0.5 : 1 }}>
                                        <td>
                                            <Link to={`/events/${event.id}`} className="event-name-link">
                                                {event.title}
                                            </Link>
                                        </td>
                                        <td style={{ color: 'var(--color-gray-600)', fontSize: '0.88rem' }}>
                                            {event.host?.profile?.name || 'Unknown'}
                                        </td>
                                        <td style={{ color: 'var(--color-gray-500)', fontSize: '0.88rem', whiteSpace: 'nowrap' }}>
                                            {formatDate(event.startDate)}
                                        </td>
                                        <td>
                                            <span style={{
                                                display: 'inline-flex', alignItems: 'center', gap: 4,
                                                padding: '2px 8px', borderRadius: 99,
                                                fontSize: '0.72rem', fontWeight: 700,
                                                color: event.rsvpStatus === 'GOING' ? 'var(--badge-success-text)' : event.rsvpStatus === 'INVITED' ? 'var(--badge-info-text)' : 'var(--badge-warning-text)',
                                                background: event.rsvpStatus === 'GOING' ? 'var(--badge-success-bg)' : event.rsvpStatus === 'INVITED' ? 'var(--badge-info-bg)' : 'var(--badge-warning-bg)',
                                            }}>
                                                {event.rsvpStatus === 'GOING' ? 'Going' : event.rsvpStatus === 'INVITED' ? 'Invited' : 'Interested'}
                                            </span>
                                        </td>
                                        <td style={{ color: 'var(--color-gray-500)', fontSize: '0.88rem' }}>
                                            {event.attendeeCount || 0}
                                            {event.maxAttendees ? ` / ${event.maxAttendees}` : ''}
                                        </td>
                                        <td style={{ textAlign: 'center' }}>
                                            <AttendingActionMenu
                                                event={event}
                                                onChangeRsvp={handleChangeRsvp}
                                                onRemove={handleRemoveAttending}
                                            />
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* My Tickets — purchased across events */}
            {myTicketsList.length > 0 && (
                <div className="card-container" style={{ marginTop: '2rem' }}>
                    <div className="toolbar">
                        <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <Ticket size={16} style={{ color: '#f7931a' }} /> My Tickets
                        </h3>
                    </div>
                    <div className="table-wrapper">
                        <table className="events-table">
                            <thead>
                                <tr>
                                    <th style={{ minWidth: '160px' }}>Event Name</th>
                                    <th>Date</th>
                                    <th>Amount</th>
                                    <th>Status</th>
                                    <th style={{ width: '100px', textAlign: 'center' }}>Ticket</th>
                                </tr>
                            </thead>
                            <tbody>
                                {myTicketsList.map(ticket => (
                                    <tr key={ticket.id}>
                                        <td>
                                            <Link to={`/events/${ticket.eventId}`} className="event-name-link">
                                                {ticket.event?.title || 'Event'}
                                            </Link>
                                        </td>
                                        <td style={{ color: 'var(--color-gray-500)', fontSize: '0.88rem', whiteSpace: 'nowrap' }}>
                                            {formatDate(ticket.event?.startDate)}
                                        </td>
                                        <td style={{ color: 'var(--color-gray-500)', fontSize: '0.88rem', whiteSpace: 'nowrap' }}>
                                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Zap size={12} style={{ color: '#f7931a' }} /> {(ticket.amountSats || 0).toLocaleString()} sats</span>
                                        </td>
                                        <td>
                                            <TicketStatusBadge status={ticket.status} checkedInAt={ticket.checkedInAt} />
                                        </td>
                                        <td style={{ textAlign: 'center' }}>
                                            <button className="tkm-qr-btn" onClick={() => setQrTicket(ticket)} title="Show door check-in QR">
                                                <QrCode size={14} /> QR
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* Host ticket list / buyer QR modals */}
            {ticketsEvent && <EventTicketsModal event={ticketsEvent} onClose={() => setTicketsEvent(null)} />}
            {qrTicket && <TicketQrModal ticket={qrTicket} onClose={() => setQrTicket(null)} />}

            <style jsx>{`
                .event-name-link {
                    font-weight: 600;
                    color: var(--color-primary);
                    text-decoration: none;
                }
                :global([data-theme="dark"]) .event-name-link {
                    color: white !important;
                }
                .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; }
                .subtitle { color: var(--color-gray-500); }

                .card-container {
                    background: var(--color-surface);
                    border-radius: var(--radius-lg);
                    box-shadow: var(--shadow-sm);
                    border: 1px solid var(--color-gray-200);
                    overflow: hidden;
                }

                .toolbar {
                    padding: 1rem;
                    border-bottom: 1px solid var(--color-gray-200);
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }

                .tabs { display: flex; gap: 1rem; overflow-x: auto; -webkit-overflow-scrolling: touch; }
                .tab {
                    padding: 0.5rem 1rem;
                    border-radius: var(--radius-md);
                    font-size: 0.9rem;
                    font-weight: 500;
                    color: var(--color-gray-500);
                    cursor: pointer;
                    border: none;
                    background: none;
                    white-space: nowrap;
                    flex-shrink: 0;
                }
                .tab.active { background: var(--color-gray-100); color: #F97316; font-weight: 600; }
                
                .search-wrapper { display: flex; align-items: center; gap: 0.5rem; }
                .search-toggle-btn {
                    padding: 0.5rem;
                    border: none;
                    background: none;
                    color: var(--color-gray-500);
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    border-radius: var(--radius-md);
                }
                .search-toggle-btn:hover { background: var(--color-gray-100); }
                
                .search-input-container {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    background: var(--color-surface);
                    border: 1px solid var(--color-gray-300);
                    border-radius: var(--radius-md);
                    padding: 0 0.75rem;
                    transition: all 0.2s ease;
                }
                .search-input-container:focus-within {
                    border-color: var(--color-primary);
                    box-shadow: 0 0 0 2px rgba(249, 115, 22, 0.1);
                }
                .search-icon { color: var(--color-gray-400); }
                .search-input {
                    padding: 0.5rem 0;
                    border: none;
                    font-size: 0.9rem;
                    width: 180px;
                    outline: none;
                    background: transparent;
                }
                
                @media (max-width: 768px) {
                    .search-input-container {
                        position: absolute;
                        top: 100%;
                        left: 0;
                        right: 0;
                        z-index: 10;
                        background: var(--color-surface);
                        border-top: 1px solid var(--color-gray-100);
                        border-radius: 0;
                        padding: 0.75rem 1rem;
                        opacity: 0;
                        visibility: hidden;
                        transform: translateY(-10px);
                        box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
                    }
                    .search-input-container.mobile-visible {
                        opacity: 1;
                        visibility: visible;
                        transform: translateY(0);
                    }
                    .search-input { width: 100%; }
                    .toolbar { position: relative; }
                }

                .table-wrapper { overflow-x: auto; overflow-y: visible; -webkit-overflow-scrolling: touch; }
                .events-table { width: 100%; min-width: 700px; border-collapse: collapse; }

                .events-table th {
                    text-align: left;
                    padding: 1rem;
                    background: var(--color-gray-50);
                    font-size: 0.75rem;
                    text-transform: uppercase;
                    color: var(--color-gray-500);
                    font-weight: 600;
                    white-space: nowrap;
                }

                .events-table td { padding: 1rem; border-bottom: 1px solid var(--color-gray-100); font-size: 0.9rem; vertical-align: middle; white-space: nowrap; }
                .events-table tr:last-child td { border-bottom: none; }

                .badge-sm {
                    display: inline-flex;
                    align-items: center;
                    gap: 3px;
                    padding: 2px 7px;
                    border-radius: 99px;
                    font-size: 0.7rem;
                    font-weight: 700;
                    white-space: nowrap;
                }
                .badge-official { background: var(--color-secondary); color: white; }
                .badge-endorsed { background: var(--badge-warning-bg); color: var(--badge-warning-text); }
                .badge-pending { background: var(--badge-draft-bg); color: var(--badge-draft-text); }
                .badge-copied { background: var(--badge-success-bg); color: var(--badge-success-text); }
            `}</style>

            <style>{`
                .action-menu-trigger {
                    width: 32px;
                    height: 32px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    border-radius: 6px;
                    border: 1px solid transparent;
                    background: none;
                    color: var(--color-gray-500);
                    cursor: pointer;
                    transition: all 0.15s;
                }
                .action-menu-trigger:hover {
                    background: var(--color-gray-100);
                    border-color: var(--color-gray-200);
                    color: var(--color-gray-600);
                }
                .ctx-menu {
                    min-width: 190px;
                    background: var(--color-surface);
                    backdrop-filter: blur(12px);
                    border: 1px solid var(--color-gray-200);
                    border-radius: 10px;
                    box-shadow: 0 12px 32px rgba(0,0,0,0.12), 0 4px 12px rgba(0,0,0,0.06);
                    z-index: 9999;
                    padding: 4px 0;
                    animation: ctxIn 0.1s ease-out;
                }
                @keyframes ctxIn {
                    from { opacity: 0; transform: translateX(-100%) scale(0.95); }
                    to { opacity: 1; transform: translateX(-100%) scale(1); }
                }
                .ctx-submenu-header {
                    padding: 0.4rem 0.85rem;
                    font-size: 0.72rem;
                    font-weight: 700;
                    text-transform: uppercase;
                    color: var(--color-gray-400);
                    letter-spacing: 0.04em;
                }
                .ctx-item {
                    display: flex;
                    align-items: center;
                    gap: 0.6rem;
                    width: 100%;
                    padding: 0.5rem 0.85rem;
                    font-size: 0.84rem;
                    font-weight: 500;
                    color: var(--color-gray-600);
                    background: none;
                    border: none;
                    cursor: pointer;
                    text-align: left;
                    transition: background 0.08s;
                    white-space: nowrap;
                }
                .ctx-item:hover { background: var(--color-gray-100); }
                .ctx-copy { color: #1d4ed8; }
                .ctx-copy:hover { background: var(--color-blue-tint); }
                .ctx-active { font-weight: 700; }
                .ctx-delete { color: #ef4444; }
                .ctx-delete:hover { background: var(--color-red-tint); }
                .ctx-divider { height: 1px; background: var(--color-gray-200); margin: 3px 0; }

                /* Ticket modals (rendered via portal — plain global styles) */
                .tkm-overlay {
                    position: fixed;
                    inset: 0;
                    z-index: 10001;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background: rgba(0, 0, 0, 0.6);
                    backdrop-filter: blur(4px);
                }
                .tkm-card {
                    background: var(--color-surface);
                    border-radius: var(--radius-lg, 16px);
                    width: 92vw;
                    max-width: 480px;
                    max-height: 85vh;
                    display: flex;
                    flex-direction: column;
                    box-shadow: var(--shadow-lg);
                    overflow: hidden;
                }
                .tkm-qr-card { max-width: 340px; }
                .tkm-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 0.75rem;
                    padding: 1rem 1.25rem;
                    border-bottom: 1px solid var(--color-gray-200);
                    flex-shrink: 0;
                }
                .tkm-title {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    margin: 0;
                    font-size: 1rem;
                    font-weight: 700;
                    min-width: 0;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .tkm-close {
                    display: flex;
                    padding: 4px;
                    border: none;
                    background: none;
                    color: var(--color-gray-500);
                    cursor: pointer;
                    flex-shrink: 0;
                }
                .tkm-close:hover { color: var(--color-gray-900); }
                .tkm-summary {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 1rem;
                    padding: 0.75rem 1.25rem;
                    border-bottom: 1px solid var(--color-gray-100);
                    font-size: 0.8rem;
                    color: var(--color-gray-500);
                    flex-shrink: 0;
                }
                .tkm-summary span { display: inline-flex; align-items: center; gap: 4px; }
                .tkm-summary strong { color: var(--color-gray-900); }
                .tkm-body {
                    padding: 0.75rem 1rem 1rem;
                    overflow-y: auto;
                }
                .tkm-empty {
                    display: flex;
                    justify-content: center;
                    padding: 2rem;
                    color: var(--color-gray-500);
                    font-size: 0.85rem;
                }
                .tkm-row {
                    display: flex;
                    align-items: center;
                    gap: 0.75rem;
                    padding: 0.6rem 0.5rem;
                    border-radius: 8px;
                }
                .tkm-row:hover { background: var(--color-gray-50); }
                .tkm-avatar {
                    width: 36px;
                    height: 36px;
                    border-radius: 50%;
                    overflow: hidden;
                    background: var(--color-gray-200);
                    flex-shrink: 0;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-weight: 600;
                    font-size: 0.85rem;
                    color: var(--color-gray-500);
                }
                .tkm-avatar img { width: 100%; height: 100%; object-fit: cover; }
                .tkm-row-info { flex: 1; min-width: 0; }
                .tkm-buyer-name {
                    font-weight: 600;
                    font-size: 0.88rem;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .tkm-row-meta { font-size: 0.75rem; color: var(--color-gray-500); }
                .tkm-checkin-btn {
                    display: inline-flex;
                    align-items: center;
                    gap: 4px;
                    padding: 0.35rem 0.75rem;
                    border-radius: 8px;
                    border: 1px solid var(--color-gray-300);
                    background: var(--color-surface);
                    color: var(--color-primary);
                    font-size: 0.78rem;
                    font-weight: 600;
                    cursor: pointer;
                    white-space: nowrap;
                    transition: all 0.15s;
                    flex-shrink: 0;
                }
                .tkm-checkin-btn:hover:not(:disabled) { background: var(--color-blue-tint); border-color: var(--color-primary); }
                .tkm-checkin-btn:disabled { opacity: 0.6; cursor: wait; }
                .tkm-qr-btn {
                    display: inline-flex;
                    align-items: center;
                    gap: 4px;
                    padding: 0.35rem 0.75rem;
                    border-radius: 8px;
                    border: 1px solid var(--color-gray-300);
                    background: var(--color-surface);
                    color: var(--color-primary);
                    font-size: 0.78rem;
                    font-weight: 600;
                    cursor: pointer;
                    white-space: nowrap;
                    transition: all 0.15s;
                }
                .tkm-qr-btn:hover { background: var(--color-blue-tint); border-color: var(--color-primary); }
                .tkm-qr-body {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 0.6rem;
                    padding: 1.25rem;
                    text-align: center;
                }
                .tkm-qr-event {
                    margin: 0;
                    font-weight: 700;
                    font-size: 0.95rem;
                    color: var(--color-gray-900);
                }
                .tkm-qr-wrap {
                    display: inline-flex;
                    padding: 0.75rem;
                    background: white;
                    border-radius: 12px;
                    border: 1px solid var(--color-gray-200);
                }
                .tkm-qr-id {
                    margin: 0;
                    font-family: monospace;
                    font-size: 0.7rem;
                    color: var(--color-gray-400);
                    word-break: break-all;
                }
                .tkm-qr-hint {
                    margin: 0;
                    font-size: 0.8rem;
                    color: var(--color-gray-500);
                }
            `}</style>
        </div>
    );
};

export default MyEvents;
