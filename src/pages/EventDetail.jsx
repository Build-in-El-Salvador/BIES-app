import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
    CalendarDays, CalendarPlus, MapPin, Video, Share, Check, MoreHorizontal, Edit3, Trash2,
    Flag, UserMinus, ChevronRight, ExternalLink, Lock, Loader2, User,
} from 'lucide-react';
import { eventsApi } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import { useLightbox } from '../context/LightboxContext';
import { getAssetUrl } from '../utils/assets';
import { openExternal } from '../utils/openExternal';
import { publicUrl } from '../utils/publicUrl';
import { isNativePlatform } from '../utils/platform';
import { isPlaceholderName } from '../utils/profileComplete';
import { bothTicketLinks, fullDay, hostOf, partnerPath, timeRange } from '../utils/eventFormat';
import Avatar from '../components/Avatar';
import BackButton from '../components/BackButton';
import TranslatableText from '../components/TranslatableText';
import TicketPurchaseModal from '../components/TicketPurchaseModal';
import ModerationSheet from '../components/moderation/ModerationSheet';
import { useModerationDialogs } from '../components/moderation/useModerationDialogs';
import { BiesTag, PriceLine, TicketButton } from '../components/events/EventBits';
import biesLogo from '../assets/logo-icon.svg';
import '../components/moderation/Moderation.css';

/**
 * An event, for members: its cover, when and where, who hosts it (a member
 * or a business, and co-hosts), its sponsors, what it's about and who's
 * going. Tickets are the host's page (Luma, pretix…), from a bar that stays
 * at the bottom; a free event with no ticket link has "I'm going" there.
 * Signed out, the route shows the shared preview instead (SharePreview).
 */

const pad = (n) => String(n).padStart(2, '0');
const icsDate = (d) => { const x = new Date(d); return `${x.getUTCFullYear()}${pad(x.getUTCMonth() + 1)}${pad(x.getUTCDate())}T${pad(x.getUTCHours())}${pad(x.getUTCMinutes())}00Z`; };
const placeOf = (e) => (e.isOnline ? 'Online' : [e.locationName, e.locationAddress].filter(Boolean).join(', ') || e.location || '');
const plain = (html) => (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/** Save it to a calendar: an .ics file on the web, Google Calendar in the phone app. */
function addToCalendar(event) {
    const end = event.endDate || new Date(new Date(event.startDate).getTime() + 2 * 3600_000).toISOString();
    const url = publicUrl(`/events/${event.id}`);
    if (isNativePlatform()) {
        const q = new URLSearchParams({
            action: 'TEMPLATE', text: event.title, dates: `${icsDate(event.startDate)}/${icsDate(end)}`,
            details: `${plain(event.description).slice(0, 500)}\n\n${url}`, location: placeOf(event),
        });
        openExternal(`https://calendar.google.com/calendar/render?${q}`);
        return;
    }
    const esc = (s) => String(s).replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
    const ics = [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//BIES//Events//EN', 'BEGIN:VEVENT',
        `UID:${event.id}@buildinelsalvador.com`, `DTSTAMP:${icsDate(new Date())}`,
        `DTSTART:${icsDate(event.startDate)}`, `DTEND:${icsDate(end)}`,
        `SUMMARY:${esc(event.title)}`, `DESCRIPTION:${esc(`${plain(event.description).slice(0, 500)}\n\n${url}`)}`,
        `LOCATION:${esc(placeOf(event))}`, `URL:${url}`, 'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
    a.download = `${event.title.replace(/[^\w-]+/g, '-').slice(0, 60) || 'event'}.ics`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const EventDetail = () => {
    const { id } = useParams();
    const { t, i18n } = useTranslation();
    const lang = i18n.language;
    const location = useLocation();
    const navigate = useNavigate();
    const { user } = useAuth();
    const { flags } = useFeatureFlags();
    const lightbox = useLightbox();
    const preview = location.state?.preview?.id === id ? location.state.preview : null;
    const [event, setEvent] = useState(preview);
    const [missing, setMissing] = useState(false);
    const [going, setGoing] = useState(null); // after a tap; null: as loaded
    const [busy, setBusy] = useState(false);
    const [copied, setCopied] = useState(false);
    const [menu, setMenu] = useState(false);
    const [sheet, setSheet] = useState(null); // 'delete'
    const [notice, setNotice] = useState('');
    const [ticket, setTicket] = useState(null);
    const [buying, setBuying] = useState(false);
    const menuButton = useRef(null);
    const { dialogs, openReport } = useModerationDialogs({ onBlocked: () => navigate('/events') });

    const load = useCallback(async () => {
        try {
            const full = await eventsApi.get(id);
            setEvent(full);
            setMissing(false);
        } catch (err) {
            if (err?.status === 404 || err?.status === 403) setMissing(true);
        }
    }, [id]);
    useEffect(() => { load(); }, [load]);

    // Sats tickets only while the wallet is on (the zaps switch).
    const satsTickets = !!flags?.zaps && event?.priceSats > 0;
    useEffect(() => {
        if (!satsTickets || !event?.id) return;
        eventsApi.myEventTickets(event.id)
            .then((res) => setTicket((res?.data || res || []).find?.((tk) => tk.status === 'PAID') || null))
            .catch(() => {});
    }, [satsTickets, event?.id]);

    if (missing) {
        return (
            <div className="container ev-missing">
                <BackButton fallback="/events" label={t('events.detail.back')} />
                <CalendarDays size={32} aria-hidden="true" />
                <h1>{t('events.detail.notFound')}</h1>
                <p>{t('events.detail.notFoundHint')}</p>
                <Link to="/events" className="ev-missing-link">{t('events.detail.back')}</Link>
                <style jsx>{`
                    .ev-missing { padding: 2rem 1rem 4rem; display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center; color: var(--color-gray-500); }
                    .ev-missing h1 { margin: 0; font-family: var(--font-display); color: var(--color-gray-900); }
                    .ev-missing :global(.ev-missing-link) { color: var(--color-primary); font-weight: 600; }
                `}</style>
            </div>
        );
    }
    if (!event) {
        return <div className="container" style={{ padding: '4rem 1rem', textAlign: 'center' }}><Loader2 size={28} style={{ animation: 'spin 1s linear infinite' }} /></div>;
    }

    const host = hostOf(event);
    const partners = event.partners || [];
    const cohosts = partners.filter((p) => p.role === 'COHOST');
    const sponsors = partners.filter((p) => p.role === 'SPONSOR');
    const isGoing = going ?? event.rsvpStatus === 'GOING';
    const goingPeople = (event.going || []).filter((p) => p.id !== user?.id);
    const goingCount = Math.max(0, (event.goingCount || 0) - (event.rsvpStatus === 'GOING' ? 1 : 0)) + (isGoing ? 1 : 0);
    const kind = event.category ? t(`events.kinds.${event.category}`, { defaultValue: '' }) : '';
    const sections = (event.customSections || []).filter((s) => s && (s.body || s.content || s.imageUrl || s.images?.length));
    const isFull = 'canEdit' in event; // the card from the list is shown until the full event loads
    const hasTickets = !!(event.ticketUrl || event.bitcoinUrl);

    const rsvp = async (next) => {
        setGoing(next);
        setBusy(true);
        try {
            if (next) await eventsApi.rsvp(event.id, 'GOING');
            else await eventsApi.cancelRsvp(event.id);
        } catch {
            setGoing(!next);
        } finally {
            setBusy(false);
        }
    };
    const share = async () => {
        const url = publicUrl(`/events/${event.id}`);
        try {
            if (navigator.share) { await navigator.share({ title: event.title, url }); return; }
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch { /* cancelled */ }
    };
    const closeMenu = () => { setMenu(false); menuButton.current?.focus({ preventScroll: true }); };
    const takeNameOff = async () => {
        closeMenu();
        try {
            await Promise.all((event.myPartnerIds || []).map((pid) => eventsApi.removePartner(event.id, pid)));
            setNotice(t('events.detail.nameOff'));
            load();
        } catch { /* stays as it was */ }
    };
    const remove = async () => {
        setBusy(true);
        try {
            await eventsApi.delete(event.id);
            navigate('/events', { replace: true });
        } catch {
            setBusy(false);
            setSheet(null);
        }
    };
    const hasMenu = isFull && (event.canEdit || event.canDelete || event.myPartnerIds?.length || !event.canEdit);
    const mapUrl = event.locationMapUrl || (event.locationAddress || event.locationName
        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([event.locationName, event.locationAddress].filter(Boolean).join(', '))}`
        : '');

    return (
        <div className="event-page">
            {dialogs}
            <div className="ev-hero-wrap">
                <div className={`ev-hero${event.thumbnail ? '' : ' empty'}`}>
                    {event.thumbnail && (
                        <button type="button" className="ev-hero-photo" onClick={() => lightbox.open(getAssetUrl(event.thumbnail))} aria-label={event.title}>
                            <img src={getAssetUrl(event.thumbnail)} alt="" />
                        </button>
                    )}
                    <BackButton fallback="/events" overlay label={t('events.detail.back')} />
                    {event.isOfficial && <span className="ev-hero-tag"><BiesTag /></span>}
                </div>
                <div className="ev-hero-tools">
                    <button type="button" className="ev-tool" onClick={share} aria-label={copied ? t('events.detail.copied') : t('events.detail.share')}>
                        {copied ? <Check size={18} /> : <Share size={18} />}
                    </button>
                    {hasMenu && (
                        <button ref={menuButton} type="button" className="ev-tool" aria-label={t('events.detail.more')} aria-expanded={menu} onClick={() => setMenu((v) => !v)}>
                            <MoreHorizontal size={20} />
                        </button>
                    )}
                    {hasMenu && menu && (
                        <>
                            <div className="ev-menu-backdrop" onClick={() => setMenu(false)} />
                            <div className="ev-menu" role="menu">
                                {event.canEdit && (
                                    <button type="button" role="menuitem" onClick={() => { setMenu(false); navigate(`/events/edit/${event.id}`); }}>
                                        <Edit3 size={16} /> {t('events.detail.edit')}
                                    </button>
                                )}
                                {event.myPartnerIds?.length > 0 && (
                                    <button type="button" role="menuitem" onClick={takeNameOff}><UserMinus size={16} /> {t('events.detail.takeNameOff')}</button>
                                )}
                                {event.canDelete && (
                                    <button type="button" role="menuitem" className="danger" onClick={() => { closeMenu(); setSheet('delete'); }}><Trash2 size={16} /> {t('events.detail.delete')}</button>
                                )}
                                {!event.canEdit && (
                                    <button type="button" role="menuitem" onClick={() => { closeMenu(); openReport({ type: 'event', id: event.id }, { name: event.title, blockTarget: { userId: event.hostId } }); }}>
                                        <Flag size={16} /> {t('events.detail.report')}
                                    </button>
                                )}
                            </div>
                        </>
                    )}
                </div>
            </div>

            <div className="ev-body">
                {notice && <p className="ev-notice" role="status">{notice}</p>}
                {event.canEdit && (event.visibility === 'DRAFT' || event.visibility === 'PRIVATE') && (
                    <p className="ev-notice"><Lock size={15} aria-hidden="true" /> {event.visibility === 'DRAFT' ? t('events.detail.draft') : t('events.detail.private')}</p>
                )}
                <div>
                    {kind && <p className="ev-kind">{kind}</p>}
                    <h1 className="ev-title">{event.title}</h1>
                </div>

                <div className="ev-facts">
                    <div className="ev-fact">
                        <span className="ev-fact-icon"><CalendarDays size={19} aria-hidden="true" /></span>
                        <span className="ev-fact-text">
                            <b>{fullDay(event.startDate, lang)}</b>
                            <span>{timeRange(event.startDate, event.endDate, lang)}</span>
                        </span>
                        <button type="button" className="ev-fact-link" onClick={() => addToCalendar(event)}>
                            <CalendarPlus size={15} aria-hidden="true" /> {t('events.detail.addToCalendar')}
                        </button>
                    </div>
                    {event.isOnline ? (
                        <div className="ev-fact">
                            <span className="ev-fact-icon"><Video size={19} aria-hidden="true" /></span>
                            <span className="ev-fact-text"><b>{t('events.detail.online')}</b></span>
                            {event.onlineUrl && (
                                <button type="button" className="ev-fact-link" onClick={() => openExternal(event.onlineUrl)}>{t('events.detail.joinLink')} <ExternalLink size={13} aria-hidden="true" /></button>
                            )}
                        </div>
                    ) : (event.locationName || event.locationAddress || event.location) && (
                        <div className="ev-fact">
                            <span className="ev-fact-icon"><MapPin size={19} aria-hidden="true" /></span>
                            <span className="ev-fact-text">
                                <b>{event.locationName || event.location}</b>
                                {event.locationAddress && <span>{event.locationAddress}</span>}
                            </span>
                            {mapUrl && <button type="button" className="ev-fact-link" onClick={() => openExternal(mapUrl)}>{t('events.detail.map')}</button>}
                        </div>
                    )}
                </div>

                <section className="ev-people" aria-labelledby="ev-hosts">
                    <h2 id="ev-hosts" className="ev-h">{t('events.detail.hostedBy')}</h2>
                    <div className="ev-person-list">
                        <PersonRow
                            to={host.path}
                            image={host.isOfficial ? biesLogo : host.image}
                            round={host.kind === 'member'}
                            name={isPlaceholderName(host.name) ? t('directory.ownership.aMember') : host.name}
                            sub={host.isOfficial ? t('events.card.biesEvent') : host.kind === 'listing' ? t('events.detail.business') : t('events.detail.member')}
                        />
                        {cohosts.map((p) => (
                            <PersonRow
                                key={p.id}
                                to={partnerPath(p)}
                                href={p.kind === 'other' ? p.url : ''}
                                image={p.image}
                                round={p.kind === 'member'}
                                name={p.name}
                                sub={t('events.detail.cohost')}
                            />
                        ))}
                    </div>
                </section>

                {sponsors.length > 0 && (
                    <section aria-labelledby="ev-sponsors">
                        <h2 id="ev-sponsors" className="ev-h">{t('events.detail.sponsoredBy')}</h2>
                        <ul className="ev-sponsors">
                            {sponsors.map((p) => <li key={p.id}><SponsorTile partner={p} /></li>)}
                        </ul>
                    </section>
                )}

                {event.description && (
                    <TranslatableText
                        title={t('events.detail.about')}
                        titleStyle={{ fontSize: '0.75rem', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--color-gray-500)' }}
                        text={event.description}
                        isHtml
                        className="ev-about rich-text-content"
                    />
                )}

                {sections.map((s, i) => (
                    <section key={i} className="ev-section">
                        {s.title && <h2 className="ev-h">{s.title}</h2>}
                        {(s.body || s.content) && <TranslatableText text={s.body || s.content} isHtml className="rich-text-content" />}
                        {[s.imageUrl, ...(s.images || [])].filter(Boolean).length > 0 && (
                            <div className="ev-photos">
                                {[s.imageUrl, ...(s.images || [])].filter(Boolean).map((src, j) => (
                                    <button key={j} type="button" onClick={() => lightbox.open(getAssetUrl(src))}><img src={getAssetUrl(src)} alt="" /></button>
                                ))}
                            </div>
                        )}
                    </section>
                ))}

                {(goingCount > 0 || (hasTickets && isFull)) && (
                    <div className="ev-going">
                        {goingPeople.length > 0 && (
                            <span className="ev-going-pile">
                                {goingPeople.slice(0, 3).map((p) => (
                                    <span key={p.id} className="ev-going-face"><Avatar src={p.profile?.avatar} size={28} fallback={<User size={14} />} /></span>
                                ))}
                            </span>
                        )}
                        <span className="ev-going-text">{goingCount > 0 ? t('events.detail.going', { count: goingCount }) : ''}</span>
                        {hasTickets && (
                            <button type="button" className={`ev-going-btn${isGoing ? ' on' : ''}`} aria-pressed={isGoing} disabled={busy} onClick={() => rsvp(!isGoing)}>
                                {isGoing && <Check size={15} aria-hidden="true" />} {isGoing ? t('events.detail.youreGoing') : t('events.detail.imGoing')}
                            </button>
                        )}
                    </div>
                )}
            </div>

            <div className={`ev-bar${!satsTickets && bothTicketLinks(event) ? ' two' : ''}`}>
                {satsTickets ? (
                    <>
                        <PriceLine event={{ ...event, priceLabel: `${Number(event.priceSats).toLocaleString()} sats`, ticketUrl: '', bitcoinUrl: '' }} />
                        {ticket
                            ? <span className="ev-have"><Check size={16} /> {t('events.detail.ticketBought')}</span>
                            : <button type="button" className="ev-buy" onClick={() => setBuying(true)}>{t('events.detail.buySats', { sats: Number(event.priceSats).toLocaleString() })}</button>}
                    </>
                ) : (
                    <>
                        <PriceLine event={event} />
                        <TicketButton event={event} size="lg" going={isGoing} onGoing={rsvp} busy={busy} />
                    </>
                )}
            </div>

            {buying && (
                <TicketPurchaseModal
                    open
                    onClose={() => setBuying(false)}
                    event={{ id: event.id, title: event.title, priceSats: event.priceSats }}
                    onPurchased={(tk) => { setTicket(tk); setBuying(false); setGoing(true); }}
                />
            )}
            {sheet === 'delete' && (
                <ModerationSheet title={t('events.detail.delete')} onClose={() => setSheet(null)}>
                    <p className="mod-muted">{t('events.detail.deleteConfirm')}</p>
                    <div className="mod-actions">
                        <button type="button" className="mod-button secondary" onClick={() => setSheet(null)}>{t('events.detail.cancel')}</button>
                        <button type="button" className="mod-button danger" onClick={remove} disabled={busy}>
                            {busy && <Loader2 size={18} className="mod-spin" />} {t('events.detail.deleteYes')}
                        </button>
                    </div>
                </ModerationSheet>
            )}

            <style jsx>{`
                .event-page { padding-bottom: 1rem; }
                .ev-hero-wrap { position: relative; max-width: 760px; margin: 0 auto; }
                .ev-hero { position: relative; aspect-ratio: 16 / 10; max-height: 52vh; overflow: hidden; background: var(--color-gray-100); }
                .ev-hero.empty { background: linear-gradient(135deg, rgba(0, 71, 171, 0.18), rgba(255, 91, 0, 0.12)); }
                .ev-hero-photo { position: absolute; inset: 0; border: 0; padding: 0; background: none; cursor: zoom-in; }
                .ev-hero-photo img { width: 100%; height: 100%; object-fit: cover; display: block; }
                .ev-hero :global(.bies-back) { position: absolute; left: 12px; top: 12px; z-index: 2; }
                .ev-hero-tag { position: absolute; left: 12px; bottom: 12px; z-index: 2; }
                .ev-hero-tools { position: absolute; right: 12px; bottom: 12px; z-index: 5; display: flex; gap: 8px; align-items: center; }
                .ev-tool {
                    width: 40px; height: 40px; border-radius: 50%; border: 0; cursor: pointer;
                    display: flex; align-items: center; justify-content: center;
                    background: rgba(255, 255, 255, 0.95); color: #0F172A; box-shadow: 0 1px 4px rgba(15, 23, 42, 0.2);
                }
                .ev-menu-backdrop { position: fixed; inset: 0; z-index: 4; }
                .ev-menu {
                    position: absolute; right: 0; top: 46px; z-index: 6; min-width: 220px; padding: 6px;
                    background: var(--color-surface); border: 1px solid var(--color-gray-200); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg);
                    display: flex; flex-direction: column;
                }
                .ev-menu button {
                    display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 0; background: none; cursor: pointer;
                    border-radius: var(--radius-md); font-size: 0.9rem; color: var(--color-gray-800); text-align: left;
                }
                .ev-menu button:hover { background: var(--color-gray-100); }
                .ev-menu button.danger { color: #DC2626; }
                .ev-body { max-width: 760px; margin: 0 auto; padding: 1.25rem 1rem 0; display: flex; flex-direction: column; gap: 18px; }
                .ev-notice { margin: 0; display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-radius: var(--radius-md); background: var(--color-orange-tint); color: var(--color-orange-text); font-size: 0.875rem; }
                .ev-kind { margin: 0 0 4px; font-size: 0.85rem; font-weight: 600; color: var(--color-primary); }
                .ev-title { margin: 0; font-family: var(--font-display); font-size: 2rem; line-height: 1.05; color: var(--color-gray-900); text-wrap: balance; overflow-wrap: anywhere; }
                .ev-facts { background: var(--color-surface); border: 1px solid var(--color-gray-200); border-radius: 16px; padding: 4px 14px; }
                .ev-fact { display: flex; gap: 12px; align-items: center; padding: 12px 0; }
                .ev-fact + .ev-fact { border-top: 1px solid var(--color-gray-200); }
                .ev-fact-icon { width: 40px; height: 40px; border-radius: 12px; background: var(--color-orange-tint); color: var(--color-secondary); display: flex; align-items: center; justify-content: center; flex: none; }
                .ev-fact-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
                .ev-fact-text b { font-size: 0.95rem; color: var(--color-gray-900); }
                .ev-fact-text span { font-size: 0.85rem; color: var(--color-gray-500); }
                .ev-fact-link { display: inline-flex; align-items: center; gap: 4px; border: 0; background: none; cursor: pointer; color: var(--color-primary); font-weight: 600; font-size: 0.85rem; white-space: nowrap; padding: 6px 0; }
                .ev-h { margin: 0 0 8px; font-size: 0.75rem; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; color: var(--color-gray-500); }
                .ev-person-list { display: flex; flex-direction: column; gap: 8px; }
                .ev-sponsors { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
                .ev-body :global(.ev-about) { margin: 0; }
                .ev-photos { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; margin-top: 8px; }
                .ev-photos button { border: 0; padding: 0; border-radius: 12px; overflow: hidden; aspect-ratio: 1; cursor: zoom-in; background: var(--color-gray-100); }
                .ev-photos img { width: 100%; height: 100%; object-fit: cover; display: block; }
                .ev-going { display: flex; align-items: center; gap: 10px; font-size: 0.875rem; color: var(--color-gray-500); flex-wrap: wrap; }
                .ev-going-pile { display: flex; }
                .ev-going-face { width: 28px; height: 28px; border-radius: 50%; overflow: hidden; margin-left: -8px; border: 2px solid var(--color-surface); background: var(--color-gray-100); display: inline-flex; align-items: center; justify-content: center; color: var(--color-gray-400); }
                .ev-going-face:first-child { margin-left: 0; }
                .ev-going-face :global(img) { width: 100%; height: 100%; object-fit: cover; }
                .ev-going-text { flex: 1; min-width: 0; }
                .ev-going-btn {
                    display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 14px; border-radius: var(--radius-full); cursor: pointer;
                    border: 1.5px solid var(--color-primary); background: var(--color-surface); color: var(--color-primary); font-weight: 700; font-size: 0.85rem;
                }
                .ev-going-btn.on { background: var(--color-primary); color: #FFFFFF; }
                /* Stays at the foot of the screen while the page scrolls, above the
                   bottom tabs on a phone (66px and the safe area). */
                .ev-bar {
                    position: sticky; bottom: 0; z-index: 30; max-width: 760px; margin: 24px auto 0;
                    display: flex; align-items: center; justify-content: space-between; gap: 12px;
                    padding: 12px 16px 14px; box-sizing: border-box;
                    background: var(--color-surface); border-top: 1px solid var(--color-gray-200); box-shadow: 0 -4px 16px rgba(15, 23, 42, 0.06);
                }
                .ev-bar.two { flex-direction: column; align-items: stretch; gap: 10px; }
                @media (max-width: 768px) {
                    .ev-bar { bottom: calc(66px + env(safe-area-inset-bottom, 0px)); }
                }
                .ev-buy { height: 48px; padding: 0 20px; border: 0; border-radius: var(--radius-full); background: #F7931A; color: #FFFFFF; font-weight: 700; cursor: pointer; }
                .ev-have { display: inline-flex; align-items: center; gap: 6px; font-weight: 700; color: var(--color-success-text); }
                @media (min-width: 769px) {
                    .ev-hero-wrap { padding-top: 1.5rem; }
                    .ev-hero { border-radius: 20px; }
                    .ev-bar { border: 1px solid var(--color-gray-200); border-radius: 16px 16px 0 0; }
                }
            `}</style>
        </div>
    );
};

/** A host or co-host: a member, a business, or someone not on BIES (their link). */
function PersonRow({ to, href, image, round, name, sub }) {
    const { t } = useTranslation();
    const inner = (
        <>
            <span className={`pr-photo${round ? '' : ' square'}`}>
                <Avatar src={image} size={40} fallback={<span className="pr-initial">{(name || '?')[0].toUpperCase()}</span>} />
            </span>
            <span className="pr-text"><b>{name || t('directory.ownership.aMember')}</b><span>{sub}</span></span>
            {(to || href) && (href ? <ExternalLink size={16} className="pr-go" /> : <ChevronRight size={18} className="pr-go" />)}
            <style jsx>{`
                .pr-photo { width: 40px; height: 40px; border-radius: 50%; overflow: hidden; flex: none; background: var(--color-gray-100); display: flex; align-items: center; justify-content: center; }
                .pr-photo.square { border-radius: 11px; }
                .pr-photo :global(img) { width: 100%; height: 100%; object-fit: cover; display: block; }
                .pr-initial { font-weight: 700; color: var(--color-primary); }
                .pr-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
                .pr-text b { font-size: 0.95rem; color: var(--color-gray-900); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .pr-text span { font-size: 0.8rem; color: var(--color-gray-500); }
                :global(.pr-go) { color: var(--color-gray-400); flex: none; }
                :global(.ev-person) {
                    display: flex; align-items: center; gap: 12px; padding: 10px 12px; text-decoration: none; color: inherit; text-align: left; width: 100%;
                    background: var(--color-surface); border: 1px solid var(--color-gray-200); border-radius: 14px; font: inherit; cursor: pointer;
                }
            `}</style>
        </>
    );
    if (to) return <Link to={to} className="ev-person">{inner}</Link>;
    if (href) return <button type="button" className="ev-person" onClick={() => openExternal(href)}>{inner}</button>;
    return <div className="ev-person">{inner}</div>;
}

/** A sponsor as a logo tile; it opens their page, or their website. */
function SponsorTile({ partner }) {
    const to = partnerPath(partner);
    const inner = (
        <>
            <span className={`st-logo${partner.kind === 'member' ? ' round' : ''}`}>
                <Avatar src={partner.image} size={44} fallback={<span className="st-initial">{(partner.name || '?').slice(0, 2).toUpperCase()}</span>} />
            </span>
            <span className="st-name">{partner.name}</span>
            <style jsx>{`
                .st-logo { width: 44px; height: 44px; border-radius: 12px; overflow: hidden; background: var(--color-gray-100); display: flex; align-items: center; justify-content: center; }
                .st-logo.round { border-radius: 50%; }
                .st-logo :global(img) { width: 100%; height: 100%; object-fit: cover; display: block; }
                .st-initial { font-size: 0.8rem; font-weight: 700; color: var(--color-primary); }
                .st-name { font-size: 0.8rem; font-weight: 600; line-height: 1.25; color: var(--color-gray-900); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
                :global(.ev-sponsor) {
                    display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center; padding: 12px 8px; height: 100%;
                    background: var(--color-surface); border: 1px solid var(--color-gray-200); border-radius: 14px; text-decoration: none; color: inherit; width: 100%; font: inherit; cursor: pointer;
                }
            `}</style>
        </>
    );
    if (to) return <Link to={to} className="ev-sponsor">{inner}</Link>;
    if (partner.url) return <button type="button" className="ev-sponsor" onClick={() => openExternal(partner.url)}>{inner}</button>;
    return <div className="ev-sponsor">{inner}</div>;
}

export default EventDetail;
