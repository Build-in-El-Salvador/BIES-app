import React, { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Calendar, MapPin, Clock, Users, Globe, Link as LinkIcon, ShieldCheck, Award, Zap, AlertCircle, Send, Facebook, Twitter, Mail, Check, MessageSquare, Loader2, Tag, ExternalLink, CheckCircle, ChevronLeft, ChevronRight, MoreHorizontal, Copy, UserPlus, X, Search, Flag, CalendarPlus, Navigation, Edit3, Radio, Ticket } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { getAssetUrl } from '../utils/assets';
import { openExternal } from '../utils/openExternal';
import { eventsApi, profilesApi } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useWallet } from '../hooks/useWallet';
import ZapButton from '../components/ZapButton';
import TicketPurchaseModal from '../components/TicketPurchaseModal';
import DOMPurify from 'dompurify';
import TranslatableText from '../components/TranslatableText';
import { BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Label } from 'recharts';
import { useLightbox } from '../context/LightboxContext';
import { nostrService } from '../services/nostrService';
import { nostrSigner } from '../services/nostrSigner';
import { useModerationDialogs } from '../components/moderation/useModerationDialogs';
import BackButton from '../components/BackButton';
import { safeHref } from '../utils/safeUrl';

const EventDetail = () => {
    const { id } = useParams();
    const { t } = useTranslation();
    const { isAuthenticated, user } = useAuth();
    const { connected: walletConnected, balance: walletBalance } = useWallet();
    const lightbox = useLightbox();
    const [event, setEvent] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [rsvpStatus, setRsvpStatus] = useState(null); // null | 'GOING' | 'INTERESTED' | 'NOT_GOING'
    const [rsvpLoading, setRsvpLoading] = useState(false);
    const [showRsvpDropdown, setShowRsvpDropdown] = useState(false);
    const [showActionMenu, setShowActionMenu] = useState(false);
    const [showShareMenu, setShowShareMenu] = useState(false);
    const [showInviteModal, setShowInviteModal] = useState(false);
    const [linkCopied, setLinkCopied] = useState(false);
    const { openReport, dialogs: moderationDialogs } = useModerationDialogs();
    const [inviteSearch, setInviteSearch] = useState('');
    const [inviteResults, setInviteResults] = useState([]);
    const [inviteSearching, setInviteSearching] = useState(false);
    const [inviteSending, setInviteSending] = useState(null);
    const [invitedIds, setInvitedIds] = useState(new Set());
    const [showCoverRsvp, setShowCoverRsvp] = useState(false);
    const [relayPosting, setRelayPosting] = useState(false); // null | 'posting' | 'done' | 'error'
    const [relayPostStatus, setRelayPostStatus] = useState(null);
    const [myTicket, setMyTicket] = useState(null); // the user's PAID ticket, if any
    const [showTicketModal, setShowTicketModal] = useState(false);

    const parseEvent = (data) => {
        if (!data) return data;
        const parsed = { ...data };
        try {
            if (typeof parsed.tags === 'string') parsed.tags = JSON.parse(parsed.tags || '[]');
            if (typeof parsed.customSections === 'string') parsed.customSections = JSON.parse(parsed.customSections || '[]');
            if (typeof parsed.guestList === 'string') parsed.guestList = JSON.parse(parsed.guestList || '[]');
        } catch (e) {
            console.error('Error parsing event JSON fields:', e);
        }
        return parsed;
    };

    const fetchEvent = async () => {
        setLoading(true);
        try {
            const result = await eventsApi.get(id);
            const parsed = parseEvent(result);
            setEvent(parsed);
            setRsvpStatus(parsed?.rsvpStatus || null);
        } catch (err) {
            console.error('Error fetching event:', err);
            setError(err.message || 'Failed to load event');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchEvent();
    }, [id]);

    // For paid events, check whether the user already holds a PAID ticket
    useEffect(() => {
        if (!isAuthenticated || !event?.id || !(event.priceSats > 0)) return undefined;
        let cancelled = false;
        eventsApi.myEventTickets(event.id)
            .then(res => {
                if (cancelled) return;
                const paid = (res?.data || []).find(t => t.status === 'PAID');
                if (paid) setMyTicket(paid);
            })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [isAuthenticated, event?.id, event?.priceSats]);

    // Called by TicketPurchaseModal once the ticket is PAID — the server has
    // already upserted the RSVP to GOING, so refresh silently (no spinner)
    const handleTicketPurchased = (ticket) => {
        setMyTicket(ticket);
        setRsvpStatus('GOING');
        eventsApi.get(id).then(result => {
            const parsed = parseEvent(result);
            setEvent(parsed);
            setRsvpStatus(parsed?.rsvpStatus || 'GOING');
        }).catch(() => {});
    };

    const handleRsvp = async (status) => {
        if (!isAuthenticated) return;
        setRsvpLoading(true);
        try {
            if (status === 'NOT_GOING' || status === null) {
                await eventsApi.cancelRsvp(id);
                setRsvpStatus(null);
            } else {
                await eventsApi.rsvp(id, status);
                setRsvpStatus(status);
            }
            // Refresh event data to update attendee list
            const result = await eventsApi.get(id);
            setEvent(parseEvent(result));
        } catch (err) {
            console.error('RSVP error:', err);
        } finally {
            setRsvpLoading(false);
            setShowRsvpDropdown(false);
        }
    };

    const getRsvpLabel = (status) => {
        switch (status) {
            case 'GOING': return t('eventDetail.attending', 'Attending');
            case 'INTERESTED': return t('eventDetail.thinkingAboutIt', 'Thinking About It');
            case 'NOT_GOING': return t('eventDetail.notAttending', 'Not Attending');
            default: return t('eventDetail.rsvp', 'RSVP');
        }
    };

    // ─── Share: Copy Link ────────────────────────────────────────────────
    const handleCopyLink = async () => {
        const url = `${window.location.origin}/events/${id}`;
        try {
            await navigator.clipboard.writeText(url);
            setLinkCopied(true);
            setTimeout(() => setLinkCopied(false), 2000);
        } catch {
            // Fallback for older browsers
            const ta = document.createElement('textarea');
            ta.value = url;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            setLinkCopied(true);
            setTimeout(() => setLinkCopied(false), 2000);
        }
        setShowShareMenu(false);
    };

    // ─── Share: Post to BIES Relay (NIP-52) ───────────────────────────────
    const handlePostToRelay = async () => {
        if (!event || relayPosting) return;
        if (!nostrSigner.canSignSilently) {
            alert('Connect a Nostr signer to post to the relay.');
            return;
        }
        setRelayPosting(true);
        setRelayPostStatus(null);
        try {
            const safeTags = (Array.isArray(event.tags) ? event.tags : []).filter(t => typeof t === 'string');
            await nostrService.publishCalendarEvent({
                id: event.id,
                title: event.title,
                description: event.description,
                startDate: event.startDate || event.date,
                endDate: event.endDate,
                location: event.locationName || event.location,
                locationAddress: event.locationAddress,
                isOnline: event.isOnline,
                onlineUrl: event.onlineUrl,
                thumbnail: event.thumbnail,
                ticketUrl: event.ticketUrl,
                category: event.category,
                tags: safeTags,
            }, 'bies');
            setRelayPostStatus('done');
        } catch (err) {
            console.error('Failed to post event to BIES relay:', err);
            setRelayPostStatus('error');
        } finally {
            setRelayPosting(false);
            setTimeout(() => { setRelayPostStatus(null); setShowShareMenu(false); }, 2000);
        }
    };

    // ─── Add to Calendar (.ics download) ──────────────────────────────────
    const handleAddToCalendar = () => {
        if (!event) return;
        const start = new Date(event.startDate || event.date);
        const end = event.endDate ? new Date(event.endDate) : new Date(start.getTime() + 2 * 60 * 60 * 1000);
        const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
        const esc = (s) => (s || '').replace(/[\\;,]/g, c => '\\' + c).replace(/\n/g, '\\n');
        const loc = [event.locationName, event.locationAddress, event.location].filter(Boolean).join(', ');
        const url = `${window.location.origin}/events/${id}`;
        const ics = [
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//BIES//Event//EN',
            'BEGIN:VEVENT',
            `DTSTART:${fmt(start)}`, `DTEND:${fmt(end)}`,
            `SUMMARY:${esc(event.title)}`, `LOCATION:${esc(loc)}`,
            `URL:${url}`,
            `DESCRIPTION:${esc(url)}`,
            'END:VEVENT', 'END:VCALENDAR',
        ].join('\r\n');
        const blob = new Blob([ics], { type: 'text/calendar' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${event.title.replace(/[^a-z0-9]/gi, '-').substring(0, 40)}.ics`;
        a.click();
        URL.revokeObjectURL(a.href);
        setShowActionMenu(false);
    };

    // ─── Open in Maps ─────────────────────────────────────────────────────
    const handleOpenInMaps = () => {
        const loc = event?.locationMapUrl || event?.locationAddress || event?.location;
        if (!loc) return;
        if (event.locationMapUrl) {
            openExternal(event.locationMapUrl);
        } else {
            openExternal(`https://maps.google.com/?q=${encodeURIComponent(loc)}`);
        }
        setShowActionMenu(false);
    };

    // ─── Report event ─────────────────────────────────────────────────────
    // To BIES's moderators (terms of use §6). Official BIES events don't offer
    // to block their host, who is BIES staff.
    const handleReport = () => {
        setShowActionMenu(false);
        const hostName = event.host?.profile?.name;
        openReport(
            { type: 'event', id: event.id },
            event.isOfficial || !event.hostId ? {} : { name: hostName, blockTarget: { userId: event.hostId } },
        );
    };

    // ─── Invite: Search members ───────────────────────────────────────────
    const searchMembers = useCallback(async (q) => {
        if (!q || q.length < 2) { setInviteResults([]); return; }
        setInviteSearching(true);
        try {
            const res = await profilesApi.list({ search: q, limit: 10 });
            const list = res?.data || res || [];
            // Filter out the event host and current user
            setInviteResults(list.filter(p => p.userId !== event?.hostId && p.userId !== user?.id));
        } catch { setInviteResults([]); }
        finally { setInviteSearching(false); }
    }, [event?.hostId, user?.id]);

    useEffect(() => {
        const timer = setTimeout(() => searchMembers(inviteSearch), 300);
        return () => clearTimeout(timer);
    }, [inviteSearch, searchMembers]);

    // ─── Invite: Send invitation ──────────────────────────────────────────
    const handleInvite = async (profile) => {
        if (!event || inviteSending) return;
        const targetUserId = profile.userId;
        setInviteSending(targetUserId);
        try {
            // 1. Backend: create notification + INVITED attendee record
            await eventsApi.invite(id, targetUserId);

            // 2. Send NIP-17 DM with event link (best-effort, don't block on failure)
            if (nostrSigner.canSignSilently && profile.user?.nostrPubkey) {
                const eventUrl = `${window.location.origin}/events/${id}`;
                const dmContent = `You're invited to "${event.title}"!\n\n${eventUrl}`;
                nostrService.sendNip17DM(profile.user.nostrPubkey, dmContent).catch(() => {});
            }

            setInvitedIds(prev => new Set([...prev, targetUserId]));
        } catch (err) {
            // Show a user-friendly error if already invited (409) vs generic failure
            const msg = err?.status === 409 ? 'Already invited' : 'Failed to send invite';
            // On 409 keep the button disabled (user IS already invited); only revert on real failures
            if (err?.status !== 409) {
                setInvitedIds(prev => { const n = new Set(prev); n.delete(targetUserId); return n; });
            }
            alert(msg);
        } finally {
            setInviteSending(null);
        }
    };

    // Close all dropdowns helper
    const closeAllDropdowns = () => {
        setShowCoverRsvp(false);
        setShowShareMenu(false);
        setShowActionMenu(false);
    };

    // ─── RSVP icon for cover ──────────────────────────────────────────────
    const getRsvpIcon = () => {
        if (rsvpStatus === 'GOING') return <CheckCircle size={18} />;
        if (rsvpStatus === 'INTERESTED') return <Clock size={18} />;
        return <Calendar size={18} />;
    };

    const formatDate = (dateStr) => {
        if (!dateStr) return '';
        try {
            return new Date(dateStr).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
        } catch { return dateStr; }
    };

    if (loading) {
        return (
            <div className="event-detail-page">
                <div className="container" style={{ textAlign: 'center', padding: '4rem 0' }}>
                    <Loader2 size={32} style={{ animation: 'spin 1s linear infinite', margin: '0 auto' }} />
                </div>
            </div>
        );
    }

    if (error || !event) {
        return (
            <div className="event-detail-page">
                <div className="container">
                    <div style={{ textAlign: 'center', padding: '4rem 0' }}>
                        <h2>{t('eventDetail.eventNotFound', 'Event not found')}</h2>
                        <p style={{ color: '#64748b', margin: '0.5rem 0' }}>{error || t('eventDetail.eventNotFoundDesc', "This event doesn't exist or has been removed.")}</p>
                        <Link to="/events" className="back-link" style={{ marginTop: '1.5rem', display: 'inline-flex', alignItems: 'center', gap: '8px', textDecoration: 'none', fontWeight: 500, color: 'var(--color-primary)' }}>
                            {t('eventDetail.backToEvents', 'Back to Events')}
                        </Link>
                    </div>
                </div>
            </div>
        );
    }

    const description = event.fullDescription || event.description || '';

    return (
        <div className="event-detail-page">
            <div className="container">
                <div className="hero-image">
                    {(event.coverImage || event.thumbnail || event.image) && (
                        <img
                            src={getAssetUrl(event.coverImage || event.thumbnail || event.image)}
                            alt={event.title}
                            onClick={() => lightbox.open(getAssetUrl(event.coverImage || event.thumbnail || event.image))}
                            style={{ cursor: 'pointer' }}
                        />
                    )}
                    <BackButton to="/events" overlay label={t('eventDetail.backToEvents', 'Back to Events')} />
                    <span className={`category-badge ${(event.category || '').toLowerCase()}`}>
                        {event.category?.replace(/_/g, ' ')}
                    </span>

                    {/* Cover photo action buttons */}
                    {isAuthenticated && (
                        <div className="cover-actions">
                            {/* RSVP icon button */}
                            <div style={{ position: 'relative' }}>
                                <button
                                    className={`cover-btn ${rsvpStatus === 'GOING' ? 'going' : rsvpStatus === 'INTERESTED' ? 'interested' : ''}`}
                                    onClick={() => { const next = !showCoverRsvp; closeAllDropdowns(); setShowCoverRsvp(next); }}
                                    disabled={rsvpLoading}
                                    title={getRsvpLabel(rsvpStatus)}
                                >
                                    {getRsvpIcon()}
                                </button>
                                {showCoverRsvp && (
                                    <>
                                        <div className="click-overlay" onClick={() => setShowCoverRsvp(false)} />
                                        <div className="cover-dropdown">
                                            <button className="cover-dropdown-item" onClick={() => { handleRsvp('GOING'); setShowCoverRsvp(false); }}>
                                                <CheckCircle size={14} /> Attending
                                            </button>
                                            <button className="cover-dropdown-item" onClick={() => { handleRsvp('INTERESTED'); setShowCoverRsvp(false); }}>
                                                <Clock size={14} /> Interested
                                            </button>
                                            <button className="cover-dropdown-item" style={{ color: 'var(--color-error)' }} onClick={() => { handleRsvp(null); setShowCoverRsvp(false); }}>
                                                <X size={14} /> Not Going
                                            </button>
                                        </div>
                                    </>
                                )}
                            </div>

                            {/* Share button */}
                            <div style={{ position: 'relative' }}>
                                <button className="cover-btn" onClick={() => { const next = !showShareMenu; closeAllDropdowns(); setShowShareMenu(next); }} title="Share">
                                    <Send size={18} />
                                </button>
                                {showShareMenu && (
                                    <>
                                        <div className="click-overlay" onClick={() => setShowShareMenu(false)} />
                                        <div className="cover-dropdown" style={{ right: 0, left: 'auto', minWidth: '180px' }}>
                                            <button className="cover-dropdown-item" onClick={handleCopyLink}>
                                                <Copy size={14} /> {linkCopied ? 'Copied!' : 'Copy Link'}
                                            </button>
                                            <button className="cover-dropdown-item" onClick={() => { setShowInviteModal(true); setShowShareMenu(false); }}>
                                                <UserPlus size={14} /> Invite Members
                                            </button>
                                            <button className="cover-dropdown-item" onClick={handlePostToRelay} disabled={relayPosting}>
                                                {relayPosting ? <Loader2 size={14} className="spin" /> : relayPostStatus === 'done' ? <CheckCircle size={14} style={{ color: 'var(--color-success, #22c55e)' }} /> : relayPostStatus === 'error' ? <AlertCircle size={14} style={{ color: 'var(--color-error)' }} /> : <Radio size={14} />}
                                                {relayPosting ? 'Posting…' : relayPostStatus === 'done' ? 'Posted!' : relayPostStatus === 'error' ? 'Failed' : 'Post to BIES Relay'}
                                            </button>
                                        </div>
                                    </>
                                )}
                            </div>

                            {/* Action menu (...) */}
                            {moderationDialogs}
                            <div style={{ position: 'relative' }}>
                                <button className="cover-btn" onClick={() => { const next = !showActionMenu; closeAllDropdowns(); setShowActionMenu(next); }} title="More options">
                                    <MoreHorizontal size={18} />
                                </button>
                                {showActionMenu && (
                                    <>
                                        <div className="click-overlay" onClick={() => setShowActionMenu(false)} />
                                        <div className="cover-dropdown" style={{ right: 0, left: 'auto', minWidth: '200px' }}>
                                            <button className="cover-dropdown-item" onClick={handleAddToCalendar}>
                                                <CalendarPlus size={14} /> Add to Calendar
                                            </button>
                                            {(event.locationMapUrl || event.locationAddress || event.location) && (
                                                <button className="cover-dropdown-item" onClick={handleOpenInMaps}>
                                                    <Navigation size={14} /> Open in Maps
                                                </button>
                                            )}
                                            {user?.id === event.hostId && (
                                                <button className="cover-dropdown-item" onClick={() => { window.location.href = `/events/edit/${id}`; }}>
                                                    <Edit3 size={14} /> Edit Event
                                                </button>
                                            )}
                                            {user?.id && user.id !== event.hostId && (
                                                <button className="cover-dropdown-item" style={{ color: 'var(--color-error)' }} onClick={handleReport}>
                                                    <Flag size={14} /> {t('moderation.menu.reportEvent')}
                                                </button>
                                            )}
                                        </div>
                                    </>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                <div className="detail-grid">
                    <div className="main-content">
                        <h1>{event.title}</h1>
                        {(event.organizer || event.host?.profile?.name || event.host?.profile?.company) && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                                <p className="organizer" style={{ margin: 0 }}>
                                    {t('eventDetail.hostedBy', 'Hosted by')}{' '}
                                    {event.host?.id ? (
                                        <Link to={`/builder/${event.host.id}`} style={{ color: 'var(--color-primary)', fontWeight: 600, textDecoration: 'none' }}>
                                            {event.organizer || event.host?.profile?.name || event.host?.profile?.company || 'BIES Community'}
                                        </Link>
                                    ) : (
                                        <span style={{ fontWeight: 600 }}>{event.organizer || 'BIES Community'}</span>
                                    )}
                                </p>
                                {event.host?.nostrPubkey && (
                                    <ZapButton
                                        recipients={[{ pubkey: event.host.nostrPubkey, name: event.host?.profile?.name || event.organizer, avatar: getAssetUrl(event.host?.profile?.avatar) || '', lud16: event.host?.profile?.lightningAddress, bolt12Offer: event.host?.profile?.bolt12Offer }]}
                                        size="sm"
                                    />
                                )}
                            </div>
                        )}

                        <div className="pd-card" style={{ marginTop: '1.5rem', padding: '1.75rem', background: 'var(--color-surface)', borderRadius: '16px', border: '1px solid var(--color-gray-200)', boxShadow: 'var(--shadow-md)' }}>
                            <TranslatableText
                                title={t('eventDetail.aboutEvent', 'About Event')}
                                titleStyle={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--color-gray-900)' }}
                                text={description}
                                isHtml={true}
                                className="description rich-text-content"
                                style={{ color: 'var(--color-gray-700)', fontSize: '0.95rem', lineHeight: 1.75 }}
                            />
                        </div>

                        {Array.isArray(event.tags) && event.tags.length > 0 && (
                            <div className="tags">
                                {event.tags.map(tag => (
                                    <span key={tag} className="tag">
                                        <Tag size={12} /> {tag}
                                    </span>
                                ))}
                            </div>
                        )}

                        {Array.isArray(event.customSections) && event.customSections
                            .filter(s => s.placement === 'LEFT' || !s.placement)
                            .map((section, idx) => (
                                <EventSection key={idx} section={section} />
                            ))
                        }

                    </div>

                    <div className="detail-sidebar">
                        <div className="info-card">
                            <h3>{t('eventDetail.eventDetails', 'Event Details')}</h3>

                            <div className="info-row">
                                <Calendar size={18} />
                                <div>
                                    <span className="info-label">{t('eventDetail.date', 'Date')}</span>
                                    <span className="info-value">{formatDate(event.date || event.startDate)}</span>
                                </div>
                            </div>

                            {(event.time || event.startDate) && (
                                <div className="info-row">
                                    <Clock size={18} />
                                    <div>
                                        <span className="info-label">{t('eventDetail.time', 'Time')}</span>
                                        <span className="info-value">
                                            {event.time || new Date(event.startDate).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                                        </span>
                                    </div>
                                </div>
                            )}

                            <div className="info-row">
                                <MapPin size={18} />
                                <div>
                                    <span className="info-label">{t('eventDetail.locationLabel', 'Location')}</span>
                                    <span className="info-value">{event.location}</span>
                                </div>
                            </div>

                            {(event.attendeeCount > 0 || event._count?.attendees > 0 || (typeof event.attendees === 'number' && event.attendees > 0)) && (
                                <div className="info-row">
                                    <Users size={18} />
                                    <div>
                                        <span className="info-label">{t('eventDetail.attendees', 'Attendees')}</span>
                                        <span className="info-value">
                                            {event.attendeeCount || event._count?.attendees || (typeof event.attendees === 'number' ? event.attendees : 0)}
                                            {` + ${t('eventDetail.expected', 'expected')}`}
                                        </span>
                                    </div>
                                </div>
                            )}

                            {isAuthenticated && (
                                <div style={{ position: 'relative', marginBottom: '0.75rem' }}>
                                    <button
                                        className={`rsvp-btn ${rsvpStatus ? 'going' : ''}`}
                                        onClick={() => setShowRsvpDropdown(!showRsvpDropdown)}
                                        disabled={rsvpLoading}
                                    >
                                        {rsvpStatus === 'GOING' ? <CheckCircle size={16} /> : null}
                                        {getRsvpLabel(rsvpStatus)}
                                    </button>

                                    {showRsvpDropdown && (
                                        <div style={{
                                            position: 'absolute',
                                            top: '100%',
                                            left: 0,
                                            right: 0,
                                            background: 'var(--color-surface)',
                                            borderRadius: '10px',
                                            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                                            border: '1px solid var(--color-gray-200)',
                                            zIndex: 20,
                                            marginTop: '4px',
                                            overflow: 'hidden'
                                        }}>
                                            <button
                                                className="dropdown-item"
                                                onClick={() => handleRsvp('GOING')}
                                                style={{ width: '100%', padding: '0.75rem 1rem', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.9rem', fontWeight: 500, borderBottom: '1px solid var(--color-gray-50)' }}
                                            >
                                                {t('eventDetail.attending', 'Attending')}
                                            </button>
                                            <button
                                                className="dropdown-item"
                                                onClick={() => handleRsvp('INTERESTED')}
                                                style={{ width: '100%', padding: '0.75rem 1rem', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.9rem', fontWeight: 500, borderBottom: '1px solid var(--color-gray-50)' }}
                                            >
                                                {t('eventDetail.thinkingAboutIt', 'Thinking About It')}
                                            </button>
                                            <button
                                                className="dropdown-item"
                                                onClick={() => handleRsvp(null)}
                                                style={{ width: '100%', padding: '0.75rem 1rem', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.9rem', fontWeight: 500, color: '#ef4444' }}
                                            >
                                                {t('eventDetail.notAttending', 'Not Attending')}
                                            </button>
                                        </div>
                                    )}
                                </div>
                            )}

                            {event.priceSats > 0 ? (
                                myTicket ? (
                                    <div className="my-ticket-card">
                                        <div className="my-ticket-title">
                                            <Ticket size={16} style={{ color: '#f7931a' }} /> My Ticket
                                        </div>
                                        <div className="my-ticket-qr">
                                            <QRCodeSVG
                                                value={myTicket.id}
                                                size={140}
                                                level="M"
                                                marginSize={2}
                                                bgColor="#ffffff"
                                                fgColor="#000000"
                                            />
                                        </div>
                                        <div>
                                            <span className={`my-ticket-status ${myTicket.checkedInAt ? 'checked' : ''}`}>
                                                {myTicket.checkedInAt ? <><CheckCircle size={12} /> Checked in</> : 'Not checked in yet'}
                                            </span>
                                        </div>
                                        <p className="my-ticket-hint">
                                            {myTicket.checkedInAt
                                                ? `Checked in on ${new Date(myTicket.checkedInAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
                                                : 'Show this QR code at the door for check-in.'}
                                        </p>
                                    </div>
                                ) : isAuthenticated ? (
                                    <button
                                        type="button"
                                        className="ticket-btn"
                                        onClick={() => setShowTicketModal(true)}
                                    >
                                        <span className="ticket-btn-col">
                                            <span className="ticket-btn-main">
                                                <Zap size={14} /> Buy Ticket · {event.priceSats.toLocaleString()} sats
                                            </span>
                                            {walletConnected && (
                                                <span className="ticket-btn-sub">
                                                    {walletBalance != null
                                                        ? t('eventDetail.paysFromWallet', { defaultValue: '⚡ Pays from your wallet · {{balance}} sats', balance: Math.floor(walletBalance / 1000).toLocaleString() })
                                                        : t('eventDetail.paysFromWalletNoBalance', '⚡ Pays from your wallet')}
                                                </span>
                                            )}
                                        </span>
                                    </button>
                                ) : (
                                    <div className="ticket-price-row">
                                        <Ticket size={16} style={{ color: '#f7931a' }} />
                                        Tickets: {event.priceSats.toLocaleString()} sats — log in to buy
                                    </div>
                                )
                            ) : safeHref(event.externalUrl || event.ticketUrl) ? (
                                <a
                                    href={safeHref(event.externalUrl || event.ticketUrl)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="ticket-btn"
                                >
                                    Get Tickets <ExternalLink size={14} />
                                </a>
                            ) : null}
                        </div>

                        {/* Attendees Card — below Event Details */}
                        {event.attendees && Array.isArray(event.attendees) && event.attendees.filter(a => a.status === 'GOING').length > 0 && (
                            <div className="info-card" style={{ marginTop: '1.25rem' }}>
                                <h3 style={{ marginBottom: '1rem' }}>
                                    Attending
                                    <span style={{ marginLeft: '0.5rem', fontSize: '0.8rem', fontWeight: 500, color: 'var(--color-gray-400)' }}>
                                        ({event.attendees.filter(a => a.status === 'GOING').length})
                                    </span>
                                </h3>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                                    {event.attendees.filter(a => a.status === 'GOING').slice(0, 8).map((attendee) => (
                                        <Link
                                            key={attendee.id}
                                            to={`/builder/${attendee.user?.id}`}
                                            className="attendee-row"
                                        >
                                            <div className="attendee-avatar">
                                                {attendee.user?.profile?.avatar ? (
                                                    <img src={getAssetUrl(attendee.user.profile.avatar)} alt="" />
                                                ) : (
                                                    <span>{attendee.user?.profile?.name?.charAt(0) || '?'}</span>
                                                )}
                                            </div>
                                            <div style={{ minWidth: 0 }}>
                                                <div style={{ fontWeight: 600, fontSize: '0.88rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--color-gray-900)' }}>
                                                    {attendee.user?.profile?.name || 'Community Member'}
                                                </div>
                                                {attendee.user?.profile?.company && (
                                                    <div style={{ fontSize: '0.75rem', color: 'var(--color-gray-500)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                        {attendee.user.profile.company}
                                                    </div>
                                                )}
                                            </div>
                                        </Link>
                                    ))}
                                    {event.attendees.filter(a => a.status === 'GOING').length > 8 && (
                                        <p style={{ fontSize: '0.8rem', color: 'var(--color-gray-400)', marginTop: '0.25rem', textAlign: 'center' }}>
                                            +{event.attendees.filter(a => a.status === 'GOING').length - 8} more attending
                                        </p>
                                    )}
                                </div>
                            </div>
                        )}
                        {/* Right-placement custom sections */}
                        {Array.isArray(event.customSections) && event.customSections
                            .filter(s => s.placement === 'RIGHT')
                            .map((section, idx) => (
                                <EventSection key={`right-${idx}`} section={section} isSidebar />
                            ))
                        }
                    </div>
                </div>
            </div>

            {/* Invite Members Modal */}
            {showInviteModal && (
                <>
                    <div className="modal-overlay" onClick={() => setShowInviteModal(false)} />
                    <div className="invite-modal">
                        <div className="invite-modal-header">
                            <h3>Invite Members</h3>
                            <button onClick={() => setShowInviteModal(false)} className="invite-close"><X size={20} /></button>
                        </div>
                        <div className="invite-search-wrap">
                            <Search size={16} />
                            <input
                                type="text"
                                placeholder="Search members by name..."
                                value={inviteSearch}
                                onChange={(e) => setInviteSearch(e.target.value)}
                                className="invite-search-input"
                                autoFocus
                            />
                        </div>
                        <div className="invite-results">
                            {inviteSearching && (
                                <div className="invite-empty"><Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} /></div>
                            )}
                            {!inviteSearching && inviteSearch.length >= 2 && inviteResults.length === 0 && (
                                <div className="invite-empty">No members found</div>
                            )}
                            {!inviteSearching && inviteSearch.length < 2 && (
                                <div className="invite-empty" style={{ color: 'var(--color-gray-400)' }}>Type at least 2 characters to search</div>
                            )}
                            {inviteResults.map((profile) => {
                                const alreadyInvited = invitedIds.has(profile.userId);
                                const isSending = inviteSending === profile.userId;
                                return (
                                    <div key={profile.userId || profile.id} className="invite-row">
                                        <div className="invite-avatar">
                                            {profile.avatar ? (
                                                <img src={getAssetUrl(profile.avatar)} alt="" />
                                            ) : (
                                                <span>{(profile.name || '?').charAt(0)}</span>
                                            )}
                                        </div>
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{ fontWeight: 600, fontSize: '0.88rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{profile.name}</div>
                                            {profile.title && <div style={{ fontSize: '0.75rem', color: 'var(--color-gray-500)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{profile.title}</div>}
                                        </div>
                                        <button
                                            className={`invite-btn ${alreadyInvited ? 'invited' : ''}`}
                                            onClick={() => !alreadyInvited && handleInvite(profile)}
                                            disabled={alreadyInvited || isSending}
                                        >
                                            {isSending ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
                                                : alreadyInvited ? <><Check size={14} /> Invited</>
                                                : <><UserPlus size={14} /> Invite</>}
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </>
            )}

            {/* In-app Lightning ticket purchase */}
            {event.priceSats > 0 && (
                <TicketPurchaseModal
                    open={showTicketModal}
                    onClose={() => setShowTicketModal(false)}
                    event={{ id: event.id, title: event.title, priceSats: event.priceSats }}
                    onPurchased={handleTicketPurchased}
                />
            )}

            <style jsx>{`
                .event-detail-page {
                    background: var(--color-gray-50);
                    min-height: 100vh;
                    padding-bottom: 4rem;
                }
                .container {
                    max-width: 1100px;
                    margin: 0 auto;
                    padding: 2rem 1rem 0;
                }

                .back-link {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.5rem;
                    color: var(--color-gray-500);
                    font-size: 0.9rem;
                    font-weight: 500;
                    margin: 1.5rem 0;
                    transition: color 0.2s;
                }
                .back-link:hover { color: var(--color-gray-900); }

                .hero-image {
                    width: 100%;
                    height: 400px;
                    border-radius: 16px;
                    overflow: hidden;
                    position: relative;
                    margin-bottom: 2rem;
                    background: linear-gradient(135deg, #0052cc 0%, #0a192f 100%);
                }
                .hero-image img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    position: absolute;
                    inset: 0;
                }

                .category-badge {
                    position: absolute;
                    top: 1.5rem;
                    right: 1.5rem;
                    padding: 0.35rem 1rem;
                    border-radius: 9999px;
                    font-size: 0.8rem;
                    font-weight: 600;
                    backdrop-filter: blur(4px);
                }
                .category-badge.official, .category-badge.conference { background: rgba(0, 71, 171, 0.9); color: white; }
                .category-badge.network, .category-badge.networking { background: rgba(255, 91, 0, 0.9); color: white; }
                .category-badge.community, .category-badge.meetup { background: rgba(16, 185, 129, 0.9); color: white; }
                .category-badge.private { background: rgba(0, 0, 0, 0.8); color: white; }
                .category-badge.education, .category-badge.workshop { background: rgba(124, 58, 237, 0.9); color: white; }
                .category-badge.hackathon { background: rgba(234, 88, 12, 0.9); color: white; }

                .detail-grid {
                    display: grid;
                    grid-template-columns: 1fr 360px;
                    gap: 2rem;
                    align-items: start;
                }

                .main-content h1 {
                    font-size: 2rem;
                    font-weight: 800;
                    margin-bottom: 0.5rem;
                    color: var(--color-gray-900);
                }

                .organizer {
                    color: var(--color-gray-500);
                    font-size: 0.95rem;
                    margin-bottom: 2rem;
                }

                .description p {
                    color: var(--color-gray-700);
                    line-height: 1.75;
                    margin-bottom: 1rem;
                    font-size: 1rem;
                }

                .tags {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 0.5rem;
                    margin-top: 1.5rem;
                }

                .tag {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.35rem;
                    padding: 0.3rem 0.75rem;
                    background: var(--color-gray-200);
                    color: var(--color-gray-600);
                    border-radius: 9999px;
                    font-size: 0.8rem;
                    font-weight: 500;
                }

                .info-card {
                    background: var(--color-surface);
                    border-radius: var(--radius-xl);
                    padding: 1.75rem;
                    box-shadow: var(--shadow-md);
                    border: 1px solid var(--color-gray-200);
                }

                .info-card h3 {
                    font-size: 1.1rem;
                    font-weight: 700;
                    margin-bottom: 1.5rem;
                    color: var(--color-gray-900);
                }

                .info-row {
                    display: flex;
                    align-items: flex-start;
                    gap: 0.75rem;
                    margin-bottom: 1.25rem;
                    color: var(--color-secondary);
                }

                .info-row div {
                    display: flex;
                    flex-direction: column;
                }

                .info-label {
                    font-size: 0.75rem;
                    color: var(--color-gray-400);
                    text-transform: uppercase;
                    font-weight: 600;
                    margin-bottom: 0.15rem;
                }

                .info-value {
                    font-size: 0.95rem;
                    color: var(--color-gray-800);
                    font-weight: 500;
                }

                .rsvp-btn {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 0.5rem;
                    width: 100%;
                    padding: 0.85rem;
                    background: var(--color-primary);
                    color: white;
                    border: none;
                    border-radius: 10px;
                    font-size: 0.9rem;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.2s;
                    margin-bottom: 0.75rem;
                }
                .rsvp-btn:hover:not(:disabled) { opacity: 0.9; }
                .rsvp-btn:disabled { opacity: 0.6; cursor: not-allowed; }
                .rsvp-btn.going { background: var(--color-success); }

                .ticket-btn {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 0.5rem;
                    width: 100%;
                    padding: 0.85rem;
                    background: linear-gradient(135deg, var(--color-secondary) 0%, var(--color-secondary-dark) 100%);
                    color: white;
                    border-radius: 10px;
                    font-size: 0.9rem;
                    font-weight: 600;
                    transition: all 0.2s;
                    margin-top: 0.5rem;
                }
                .ticket-btn:hover {
                    transform: translateY(-1px);
                    box-shadow: 0 4px 12px rgba(249, 115, 22, 0.4);
                }
                button.ticket-btn {
                    border: none;
                    cursor: pointer;
                    font-family: inherit;
                }

                .ticket-btn-col {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 0.15rem;
                    min-width: 0;
                }
                .ticket-btn-main {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.5rem;
                }
                .ticket-btn-sub {
                    font-size: 0.72rem;
                    font-weight: 500;
                    opacity: 0.85;
                }

                .ticket-price-row {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 0.5rem;
                    padding: 0.75rem;
                    margin-top: 0.5rem;
                    border: 1px dashed var(--color-gray-300, var(--color-gray-200));
                    border-radius: 10px;
                    font-size: 0.85rem;
                    font-weight: 600;
                    color: var(--color-gray-600);
                }

                .my-ticket-card {
                    margin-top: 0.5rem;
                    padding: 1rem;
                    border: 1px solid var(--color-gray-200);
                    border-radius: 12px;
                    background: var(--color-gray-50);
                    text-align: center;
                }
                .my-ticket-title {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 0.4rem;
                    font-weight: 700;
                    font-size: 0.9rem;
                    color: var(--color-gray-900);
                    margin-bottom: 0.75rem;
                }
                .my-ticket-qr {
                    display: inline-flex;
                    padding: 0.6rem;
                    background: white;
                    border-radius: 10px;
                    border: 1px solid var(--color-gray-200);
                }
                .my-ticket-status {
                    display: inline-flex;
                    align-items: center;
                    gap: 4px;
                    margin-top: 0.6rem;
                    padding: 2px 10px;
                    border-radius: 99px;
                    font-size: 0.72rem;
                    font-weight: 700;
                    background: var(--color-blue-tint);
                    color: #1d4ed8;
                }
                .my-ticket-status.checked {
                    background: var(--color-green-tint);
                    color: #15803d;
                }
                .my-ticket-hint {
                    font-size: 0.75rem;
                    color: var(--color-gray-500);
                    margin: 0.5rem 0 0;
                }

                .dropdown-item:hover {
                    background-color: var(--color-gray-50);
                }

                .attendee-card:hover {
                    border-color: var(--color-primary) !important;
                    transform: translateY(-2px);
                    box-shadow: var(--shadow-sm);
                }

                .attendee-row {
                    display: flex;
                    align-items: center;
                    gap: 0.65rem;
                    text-decoration: none;
                    color: inherit;
                    padding: 0.4rem 0.5rem;
                    border-radius: 8px;
                    transition: background 0.15s;
                }
                .attendee-row:hover { background: var(--color-gray-50); }
                .attendee-avatar {
                    width: 34px;
                    height: 34px;
                    border-radius: 50%;
                    overflow: hidden;
                    background: var(--color-gray-100);
                    flex-shrink: 0;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-weight: 600;
                    font-size: 0.8rem;
                    color: var(--color-gray-500);
                }
                .attendee-avatar img { width: 100%; height: 100%; object-fit: cover; }

                /* Cover action buttons */
                .cover-actions {
                    position: absolute;
                    bottom: 24px;
                    right: 24px;
                    z-index: 20;
                    display: flex;
                    gap: 0.5rem;
                    align-items: center;
                }
                .cover-btn {
                    border-radius: var(--radius-md);
                    background: var(--color-surface-raised);
                    color: var(--color-gray-900);
                    border: 1px solid var(--color-gray-200);
                    height: 42px;
                    width: 42px;
                    padding: 0;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    cursor: pointer;
                    box-shadow: var(--shadow-sm);
                    transition: all 0.2s;
                }
                .cover-btn:hover { background: var(--color-surface-overlay); }
                .cover-btn.going { background: var(--color-success); color: white; border-color: var(--color-success); }
                .cover-btn.interested { background: var(--color-primary); color: white; border-color: var(--color-primary); }
                .cover-btn:disabled { opacity: 0.6; cursor: not-allowed; }

                .click-overlay {
                    position: fixed;
                    top: 0; left: 0; right: 0; bottom: 0;
                    z-index: 30;
                }
                .cover-dropdown {
                    position: absolute;
                    bottom: calc(100% + 6px);
                    right: 0;
                    background: var(--color-surface);
                    border-radius: 10px;
                    box-shadow: var(--shadow-lg);
                    border: 1px solid var(--color-gray-200);
                    z-index: 31;
                    overflow: hidden;
                    min-width: 160px;
                }
                .cover-dropdown-item {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    width: 100%;
                    padding: 0.7rem 1rem;
                    background: none;
                    border: none;
                    border-bottom: 1px solid var(--color-gray-100);
                    cursor: pointer;
                    font-size: 0.85rem;
                    font-weight: 500;
                    color: var(--color-text, inherit);
                    text-align: left;
                }
                .cover-dropdown-item:last-child { border-bottom: none; }
                .cover-dropdown-item:hover { background: var(--color-gray-50); }

                /* Invite modal */
                .modal-overlay {
                    position: fixed;
                    inset: 0;
                    background: rgba(0,0,0,0.5);
                    z-index: 200;
                    animation: fadeIn 0.2s ease-out;
                }
                @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
                .invite-modal {
                    position: fixed;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    width: 90%;
                    max-width: 440px;
                    max-height: 70vh;
                    background: var(--color-surface);
                    border-radius: 16px;
                    box-shadow: var(--shadow-lg);
                    border: 1px solid var(--color-gray-200);
                    z-index: 201;
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                }
                .invite-modal-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 1.25rem 1.5rem;
                    border-bottom: 1px solid var(--color-gray-200);
                }
                .invite-modal-header h3 {
                    font-size: 1.1rem;
                    font-weight: 700;
                    margin: 0;
                }
                .invite-close {
                    background: none;
                    border: none;
                    cursor: pointer;
                    color: var(--color-gray-500);
                    padding: 4px;
                    border-radius: 6px;
                }
                .invite-close:hover { color: var(--color-text); background: var(--color-gray-100); }
                .invite-search-wrap {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    margin: 1rem 1.5rem;
                    padding: 0.6rem 0.75rem;
                    border: 1px solid var(--color-gray-300);
                    border-radius: 10px;
                    color: var(--color-gray-400);
                    background: var(--color-gray-50);
                }
                .invite-search-wrap:focus-within { border-color: var(--color-primary); }
                .invite-search-input {
                    flex: 1;
                    border: none;
                    outline: none;
                    font-size: 0.9rem;
                    background: transparent;
                    color: var(--color-text, inherit);
                }
                .invite-results {
                    flex: 1;
                    overflow-y: auto;
                    padding: 0 1rem 1rem;
                }
                .invite-empty {
                    text-align: center;
                    padding: 2rem;
                    color: var(--color-gray-500);
                    font-size: 0.85rem;
                }
                .invite-row {
                    display: flex;
                    align-items: center;
                    gap: 0.75rem;
                    padding: 0.6rem 0.5rem;
                    border-radius: 8px;
                    transition: background 0.15s;
                }
                .invite-row:hover { background: var(--color-gray-50); }
                .invite-avatar {
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
                .invite-avatar img { width: 100%; height: 100%; object-fit: cover; }
                .invite-btn {
                    display: flex;
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
                .invite-btn:hover:not(:disabled) { background: var(--color-blue-tint); border-color: var(--color-primary); }
                .invite-btn:disabled { opacity: 0.6; cursor: not-allowed; }
                .invite-btn.invited { background: var(--color-green-tint); color: var(--color-success); border-color: transparent; }

                @keyframes spin { to { transform: rotate(360deg); } }

                @media (max-width: 768px) {
                    .hero-image { height: 250px; }
                    .detail-grid {
                        grid-template-columns: 1fr;
                    }
                    .info-card { position: static; }
                    .main-content h1 { font-size: 1.5rem; }
                    .cover-actions { bottom: 12px; right: 12px; gap: 0.4rem; }
                    .cover-btn { height: 36px; width: 36px; }
                }
            `}</style>
        </div>
    );
};

export default EventDetail;

// ─── Rich Section Renderer ───────────────────────────────────────────────────

const PIE_COLORS = ['#F97316', '#0052cc', '#22c55e', '#8b5cf6', '#ef4444', '#06b6d4', '#eab308', '#ec4899'];

const EventSection = ({ section, isSidebar }) => {
    // Must be resolved here — EventSection is module-level, so the lightbox
    // from the EventDetail component scope is not visible in this function
    const lightbox = useLightbox();
    const stype = section.type || 'TEXT';
    return (
        <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-gray-200)', borderRadius: '12px', padding: isSidebar ? '1.25rem' : '1.75rem', marginTop: '1.5rem' }}>
            {stype === 'TEXT' ? (
                <TranslatableText
                    title={section.title}
                    titleTag="h2"
                    titleStyle={{ fontSize: isSidebar ? '1rem' : '1.35rem', fontWeight: 700, color: '#111827', margin: '0 0 1rem', letterSpacing: '-0.01em' }}
                    text={section.body || section.content || ''}
                    isHtml={true}
                    className="rich-text-content"
                    style={{ color: '#4b5563', fontSize: '0.95rem', lineHeight: 1.75 }}
                />
            ) : (
                <>
                    {section.title && (
                        <h2 style={{ fontSize: isSidebar ? '1rem' : '1.35rem', fontWeight: 700, color: '#111827', margin: '0 0 1rem', letterSpacing: '-0.01em' }}>{section.title}</h2>
                    )}
                </>
            )}
            {stype === 'PHOTO' && section.imageUrl && (
                <img src={section.imageUrl} alt={section.title || ''} onClick={() => lightbox.open(section.imageUrl)} style={{ width: '100%', borderRadius: '10px', objectFit: 'cover', cursor: 'pointer' }} />
            )}
            {stype === 'CAROUSEL' && section.images?.length > 0 && (
                <EventCarousel images={section.images} onImageClick={(img, imgs) => lightbox.open(img, imgs)} />
            )}
            {stype === 'GRAPH' && section.dataPoints?.length > 0 && (
                <div style={{ width: '100%', height: isSidebar ? '240px' : '340px', marginTop: section.title ? '0.5rem' : '0' }}>
                    <ResponsiveContainer width="100%" height="100%">
                        {section.graphType === 'BAR' ? (
                            <BarChart data={section.dataPoints} margin={{ top: 10, right: 20, left: 10, bottom: 20 }}>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                                <XAxis dataKey="label" tick={{ fill: '#6b7280', fontSize: 12 }} axisLine={false} tickLine={false}>
                                    {section.xAxisLabel && <Label value={section.xAxisLabel} offset={-10} position="insideBottom" fill="#4b5563" fontSize={12} fontWeight={600} />}
                                </XAxis>
                                <YAxis tick={{ fill: '#6b7280', fontSize: 12 }} axisLine={false} tickLine={false} />
                                <Tooltip contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)' }} />
                                <Bar dataKey="value" fill="var(--color-primary)" radius={[4, 4, 0, 0]} />
                            </BarChart>
                        ) : section.graphType === 'LINE' ? (
                            <LineChart data={section.dataPoints} margin={{ top: 10, right: 20, left: 10, bottom: 20 }}>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                                <XAxis dataKey="label" tick={{ fill: '#6b7280', fontSize: 12 }} axisLine={false} tickLine={false} />
                                <YAxis tick={{ fill: '#6b7280', fontSize: 12 }} axisLine={false} tickLine={false} />
                                <Tooltip contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)' }} />
                                <Line type="monotone" dataKey="value" stroke="var(--color-primary)" strokeWidth={3} dot={{ fill: 'var(--color-primary)', r: 4 }} />
                            </LineChart>
                        ) : (
                            <PieChart>
                                <Pie data={section.dataPoints} dataKey="value" nameKey="label" cx="50%" cy="50%" outerRadius={isSidebar ? 70 : 110} label>
                                    {section.dataPoints.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                                </Pie>
                                <Tooltip contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)' }} />
                                <Legend />
                            </PieChart>
                        )}
                    </ResponsiveContainer>
                </div>
            )}
        </div>
    );
};

const EventCarousel = ({ images, onImageClick }) => {
    const [idx, setIdx] = useState(0);
    if (!images?.length) return null;
    return (
        <div style={{ position: 'relative', borderRadius: '10px', overflow: 'hidden', background: '#f3f4f6' }}>
            <div style={{ display: 'flex', transition: 'transform 0.4s ease', transform: `translateX(-${idx * 100}%)`, height: '320px' }}>
                {images.map((img, i) => (
                    <img key={i} src={img} alt="" onClick={() => onImageClick && onImageClick(img, images)} style={{ width: '100%', height: '100%', objectFit: 'cover', flexShrink: 0, cursor: 'pointer' }} />
                ))}
            </div>
            {images.length > 1 && (
                <>
                    <button onClick={() => setIdx(p => p === 0 ? images.length - 1 : p - 1)} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', background: 'rgba(255,255,255,0.85)', border: 'none', borderRadius: '50%', width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }}>
                        <ChevronLeft size={20} color="#374151" />
                    </button>
                    <button onClick={() => setIdx(p => p === images.length - 1 ? 0 : p + 1)} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'rgba(255,255,255,0.85)', border: 'none', borderRadius: '50%', width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }}>
                        <ChevronRight size={20} color="#374151" />
                    </button>
                    <div style={{ position: 'absolute', bottom: 10, left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: 6 }}>
                        {images.map((_, i) => (
                            <div key={i} onClick={() => setIdx(i)} style={{ width: 8, height: 8, borderRadius: '50%', background: i === idx ? 'var(--color-primary)' : 'rgba(255,255,255,0.6)', cursor: 'pointer' }} />
                        ))}
                    </div>
                </>
            )}
        </div>
    );
};
