import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { X, MapPin, Users, Clock, Loader2, LogIn, LogOut, Square, AlertCircle, Navigation } from 'lucide-react';
import { coworkApi } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { getAssetUrl } from '../../utils/assets';
import CoworkMap from './CoworkMap';
import OpenWithMapsSheet from './OpenWithMapsSheet';
import { formatAmenity, formatClock, formatDayTime } from './CoworkerCard';
import InitialAvatar from '../InitialAvatar';

/**
 * Session detail modal — portal, bottom sheet on mobile (<=768px).
 * Loads full detail via coworkApi.getSession(id): title, host, venue + map,
 * note, amenities, attendee list, and a Join/Leave (or host End) action with a
 * live attendee count. Optimistic on the user's own action, reconciled from the
 * response + a background refetch. `onChanged` lets the parent refresh its list.
 */
const CoworkSessionModal = ({ sessionId, open, onClose, onChanged }) => {
    const { t } = useTranslation();
    const { user } = useAuth();

    const [detail, setDetail] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [acting, setActing] = useState(false);
    const [actionError, setActionError] = useState('');
    const [mapsOpen, setMapsOpen] = useState(false);

    const normalize = (res) => {
        const s = res && res.data && res.data.id ? res.data : res;
        if (!s || !s.id) return null;
        return {
            ...s,
            amenities: Array.isArray(s.amenities) ? s.amenities : [],
            attendees: Array.isArray(s.attendees) ? s.attendees : [],
            attendeeCount: Number.isFinite(s.attendeeCount)
                ? s.attendeeCount
                : (Array.isArray(s.attendees) ? s.attendees.length : 0),
        };
    };

    const load = useCallback((withSpinner) => {
        if (!sessionId) return Promise.resolve();
        if (withSpinner) setLoading(true);
        return coworkApi.getSession(sessionId)
            .then((res) => {
                const s = normalize(res);
                if (s) setDetail(s);
                else if (withSpinner) setError(t('cowork.detail.notFound', 'This session could not be found.'));
            })
            .catch((err) => {
                console.error('[Cowork] Failed to load session:', err);
                if (withSpinner) setError(t('cowork.detail.loadError', "Couldn't load this session."));
            })
            .finally(() => { if (withSpinner) setLoading(false); });
    }, [sessionId, t]);

    // Fetch detail whenever the modal opens for a session.
    useEffect(() => {
        if (!open || !sessionId) return undefined;
        let cancelled = false;
        setDetail(null);
        setError('');
        setActionError('');
        setActing(false); // persisted instance must reopen unlocked
        setMapsOpen(false);
        setLoading(true);
        coworkApi.getSession(sessionId)
            .then((res) => {
                if (cancelled) return;
                const s = normalize(res);
                if (s) setDetail(s);
                else setError(t('cowork.detail.notFound', 'This session could not be found.'));
            })
            .catch((err) => {
                if (cancelled) return;
                console.error('[Cowork] Failed to load session:', err);
                setError(t('cowork.detail.loadError', "Couldn't load this session."));
            })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [open, sessionId, t]);

    // Idempotent body scroll lock — skip if another modal already locked it.
    useEffect(() => {
        if (!open) return undefined;
        if (document.body.style.position === 'fixed') return undefined;
        const scrollY = window.scrollY;
        document.body.style.position = 'fixed';
        document.body.style.top = `-${scrollY}px`;
        document.body.style.left = '0';
        document.body.style.right = '0';
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.position = '';
            document.body.style.top = '';
            document.body.style.left = '';
            document.body.style.right = '';
            document.body.style.overflow = '';
            window.scrollTo(0, scrollY);
        };
    }, [open]);

    // ESC closes — never mid-action, and not while the maps chooser is open
    // (the sheet has its own ESC handler; one keypress must not close both).
    useEffect(() => {
        if (!open) return undefined;
        const onKey = (e) => {
            if (e.key === 'Escape' && !acting && !mapsOpen) onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, acting, mapsOpen, onClose]);

    if (!open) return null;

    const selfAttendee = () => ({
        id: user?.id,
        name: user?.profile?.name || user?.name || t('cowork.detail.you', 'You'),
        avatar: user?.profile?.avatar || '',
        nostrPubkey: user?.nostrPubkey || '',
        isHost: false,
    });

    const handleJoin = async () => {
        if (!detail || acting) return;
        setActing(true);
        setActionError('');
        const prev = detail;
        const me = selfAttendee();
        setDetail((d) => ({
            ...d,
            isAttending: true,
            attendeeCount: (d.attendeeCount || 0) + 1,
            attendees: d.attendees.some((a) => a.id === me.id) ? d.attendees : [...d.attendees, me],
        }));
        try {
            const res = await coworkApi.joinSession(detail.id);
            setDetail((d) => ({
                ...d,
                attendeeCount: Number.isFinite(res?.attendeeCount) ? res.attendeeCount : d.attendeeCount,
                isAttending: res?.isAttending ?? true,
            }));
            load(false); // reconcile the authoritative attendee list in the background
            if (onChanged) onChanged();
        } catch (err) {
            console.error('[Cowork] Join failed:', err);
            setDetail(prev);
            setActionError(t('cowork.detail.joinError', "Couldn't join. Please try again."));
        } finally {
            setActing(false);
        }
    };

    const handleLeave = async () => {
        if (!detail || acting) return;
        setActing(true);
        setActionError('');
        const prev = detail;
        setDetail((d) => ({
            ...d,
            isAttending: false,
            attendeeCount: Math.max(0, (d.attendeeCount || 0) - 1),
            attendees: d.attendees.filter((a) => a.id !== user?.id),
        }));
        try {
            const res = await coworkApi.leaveSession(detail.id);
            setDetail((d) => ({
                ...d,
                attendeeCount: Number.isFinite(res?.attendeeCount) ? res.attendeeCount : d.attendeeCount,
                isAttending: res?.isAttending ?? false,
            }));
            load(false);
            if (onChanged) onChanged();
        } catch (err) {
            console.error('[Cowork] Leave failed:', err);
            setDetail(prev);
            setActionError(t('cowork.detail.leaveError', "Couldn't leave. Please try again."));
        } finally {
            setActing(false);
        }
    };

    const handleEnd = async () => {
        if (!detail || acting) return;
        setActing(true);
        setActionError('');
        try {
            await coworkApi.endSession(detail.id);
            if (onChanged) onChanged();
            onClose();
        } catch (err) {
            console.error('[Cowork] End session failed:', err);
            setActionError(t('cowork.detail.endError', "Couldn't end the session. Please try again."));
        } finally {
            // The modal instance persists (returns null but stays mounted), so
            // acting must reset on the success path too — otherwise the next
            // reopen renders every control disabled and soft-locks the sheet.
            setActing(false);
        }
    };

    const ended = detail?.status === 'ENDED';
    const hasCoords = detail && Number.isFinite(detail.lat) && Number.isFinite(detail.lng);
    const hostName = detail?.host?.name?.trim() || t('cowork.card.communityMember', 'BIES member');
    const venueLabel = detail?.venue?.name
        ? `${detail.venue.name}${detail.venue.area ? ` · ${detail.venue.area}` : ''}`
        : (detail?.locationName || t('cowork.card.locationTbd', 'Location to be shared'));
    const amenities = (detail?.amenities || []).map((a) => formatAmenity(a, t)).filter(Boolean);
    const attendees = detail?.attendees || [];
    const count = detail ? (detail.attendeeCount || 0) : 0;
    const timeLabel = ended
        ? t('cowork.card.endedAt', { time: formatDayTime(detail?.endTime), defaultValue: 'Ended · {{time}}' })
        : detail?.endTime
            ? t('cowork.card.untilTime', { time: formatClock(detail?.endTime), defaultValue: 'Until {{time}}' })
            : t('cowork.card.ongoing', 'Ongoing');

    return createPortal(
        <div
            className="csm-overlay"
            data-testid="cowork-session-modal"
            onClick={(e) => { if (e.target === e.currentTarget && !acting) onClose(); }}
        >
            <div className="csm-card" role="dialog" aria-modal="true">
                <div className="csm-header">
                    <h3 className="csm-title">
                        {detail ? detail.title : t('cowork.detail.heading', 'Session')}
                    </h3>
                    <button
                        className="csm-close"
                        aria-label={t('common.close', 'Close')}
                        disabled={acting}
                        onClick={onClose}
                    >
                        <X size={20} />
                    </button>
                </div>

                <div className="csm-body">
                    {loading && (
                        <div className="csm-loading">
                            <Loader2 size={26} className="csm-spin" />
                        </div>
                    )}

                    {!loading && error && (
                        <div className="csm-state">
                            <AlertCircle size={36} className="csm-state-icon" />
                            <p>{error}</p>
                        </div>
                    )}

                    {!loading && !error && detail && (
                        <>
                            {ended && (
                                <div className="csm-ended-banner">
                                    {t('cowork.detail.endedBanner', 'This session has ended.')}
                                </div>
                            )}

                            {/* Host */}
                            <div className="csm-host">
                                <div className="csm-avatar">
                                    {detail.host?.avatar
                                        ? <img src={getAssetUrl(detail.host.avatar)} alt="" />
                                        : <InitialAvatar name={detail.host?.name} />}
                                </div>
                                <div className="csm-host-meta">
                                    <span className="csm-host-label">{t('cowork.detail.host', 'Host')}</span>
                                    <span className="csm-host-name">{hostName}</span>
                                </div>
                            </div>

                            {/* Venue + map */}
                            <div className="csm-section">
                                <div className="csm-loc">
                                    <MapPin size={16} />
                                    <span>{venueLabel}</span>
                                </div>
                                {detail.venue?.address && (
                                    <p className="csm-address">{detail.venue.address}</p>
                                )}
                                {hasCoords && (
                                    <div className="csm-map">
                                        <CoworkMap
                                            sessions={[{ pubkey: detail.id, lat: detail.lat, lng: detail.lng }]}
                                            profiles={{ [detail.id]: { name: hostName } }}
                                            height="180px"
                                        />
                                        <button
                                            className="csm-map-open"
                                            data-testid="cowork-map-open"
                                            aria-label={t('cowork.maps.openInMaps', 'Open in maps')}
                                            onClick={() => setMapsOpen(true)}
                                        >
                                            <span className="csm-map-open-pill">
                                                <Navigation size={13} />
                                                {t('cowork.maps.openInMaps', 'Open in maps')}
                                            </span>
                                        </button>
                                    </div>
                                )}
                                <div className="csm-time">
                                    <Clock size={14} />
                                    {timeLabel}
                                </div>
                            </div>

                            {/* Note */}
                            {detail.note && <p className="csm-note">{detail.note}</p>}

                            {/* Amenities */}
                            {amenities.length > 0 && (
                                <div className="csm-chips">
                                    {amenities.map(({ Icon, label }, i) => (
                                        <span key={i} className="csm-chip">
                                            <Icon size={14} />
                                            {label}
                                        </span>
                                    ))}
                                </div>
                            )}

                            {/* Attendees */}
                            <div className="csm-section">
                                <div className="csm-attend-head">
                                    <Users size={16} />
                                    <span>
                                        {t('cowork.detail.attending', 'Attending')}
                                        {' · '}
                                        <span data-testid="cowork-attendee-count">{count}</span>
                                    </span>
                                </div>
                                {attendees.length > 0 ? (
                                    <div className="csm-attendees">
                                        {attendees.map((a) => (
                                            <div key={a.id} className="csm-attendee">
                                                <div className="csm-att-avatar">
                                                    {a.avatar
                                                        ? <img src={getAssetUrl(a.avatar)} alt="" />
                                                        : <InitialAvatar name={a.name} />}
                                                </div>
                                                <span className="csm-att-name">
                                                    {a.name || t('cowork.card.communityMember', 'BIES member')}
                                                </span>
                                                {a.isHost && (
                                                    <span className="csm-att-badge">{t('cowork.detail.hostBadge', 'Host')}</span>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <p className="csm-att-empty">{t('cowork.detail.noAttendees', 'No one has joined yet.')}</p>
                                )}
                            </div>

                            {actionError && (
                                <p className="csm-error">{actionError}</p>
                            )}

                            {/* Actions */}
                            {!ended && (
                                <div className="csm-actions">
                                    {detail.isHost ? (
                                        <button
                                            className="csm-btn csm-end"
                                            data-testid="cowork-end-btn"
                                            disabled={acting}
                                            onClick={handleEnd}
                                        >
                                            {acting ? <Loader2 size={16} className="csm-spin" /> : <Square size={16} />}
                                            {t('cowork.detail.endSession', 'End session')}
                                        </button>
                                    ) : detail.isAttending ? (
                                        <button
                                            className="csm-btn csm-leave"
                                            data-testid="cowork-leave-btn"
                                            disabled={acting}
                                            onClick={handleLeave}
                                        >
                                            {acting ? <Loader2 size={16} className="csm-spin" /> : <LogOut size={16} />}
                                            {t('cowork.detail.leave', 'Leave session')}
                                        </button>
                                    ) : (
                                        <button
                                            className="csm-btn csm-join"
                                            data-testid="cowork-join-btn"
                                            disabled={acting}
                                            onClick={handleJoin}
                                        >
                                            {acting ? <Loader2 size={16} className="csm-spin" /> : <LogIn size={16} />}
                                            {t('cowork.detail.join', 'Join session')}
                                        </button>
                                    )}
                                </div>
                            )}
                        </>
                    )}
                </div>
            </div>

            <OpenWithMapsSheet
                open={mapsOpen}
                onClose={() => setMapsOpen(false)}
                lat={detail?.lat}
                lng={detail?.lng}
                label={venueLabel}
            />

            <style jsx>{`
                .csm-overlay {
                    position: fixed;
                    inset: 0;
                    /* Peer of CheckInModal (10001), above MobileBottomNav's 10000. */
                    z-index: 10001;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background: rgba(0, 0, 0, 0.6);
                    backdrop-filter: blur(4px);
                }

                .csm-card {
                    background: var(--color-surface);
                    border-radius: var(--radius-lg);
                    width: 92vw;
                    max-width: 460px;
                    max-height: 90vh;
                    max-height: calc(100dvh - 2rem);
                    display: flex;
                    flex-direction: column;
                    box-shadow: var(--shadow-lg);
                    overflow: hidden;
                }

                .csm-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 0.75rem;
                    padding: 1rem 1.25rem;
                    border-bottom: 1px solid var(--color-gray-200);
                    flex-shrink: 0;
                }

                .csm-title {
                    margin: 0;
                    font-size: 1.15rem;
                    font-weight: 700;
                    color: var(--color-gray-900);
                    overflow: hidden;
                    text-overflow: ellipsis;
                    display: -webkit-box;
                    -webkit-line-clamp: 2;
                    -webkit-box-orient: vertical;
                }

                .csm-close {
                    display: flex;
                    padding: 4px;
                    border: none;
                    background: none;
                    color: var(--color-gray-500);
                    cursor: pointer;
                    flex-shrink: 0;
                }
                .csm-close:hover:not(:disabled) { color: var(--color-gray-900); }
                .csm-close:disabled { opacity: 0.5; cursor: default; }

                .csm-body {
                    padding: 1.25rem;
                    overflow-y: auto;
                    display: flex;
                    flex-direction: column;
                    gap: 1rem;
                }

                .csm-loading {
                    display: flex;
                    justify-content: center;
                    padding: 2.5rem 0;
                    color: var(--color-primary);
                }

                .csm-state {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 0.5rem;
                    text-align: center;
                    padding: 2.5rem 1rem;
                    color: var(--color-gray-500);
                }
                .csm-state-icon { color: var(--color-gray-300, var(--color-gray-200)); }
                .csm-state p { margin: 0; font-size: 0.9rem; }

                .csm-ended-banner {
                    padding: 0.5rem 0.85rem;
                    border-radius: var(--radius-md);
                    background: var(--color-gray-100);
                    color: var(--color-gray-600, var(--color-gray-500));
                    font-size: 0.82rem;
                    font-weight: 600;
                    text-align: center;
                }

                .csm-host {
                    display: flex;
                    align-items: center;
                    gap: 0.75rem;
                }

                .csm-avatar {
                    width: 46px;
                    height: 46px;
                    border-radius: 50%;
                    overflow: hidden;
                    background: var(--color-gray-100);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-weight: 700;
                    color: var(--color-primary);
                    flex-shrink: 0;
                }
                .csm-avatar img { width: 100%; height: 100%; object-fit: cover; }

                .csm-host-meta { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; }
                .csm-host-label {
                    font-size: 0.72rem;
                    font-weight: 600;
                    color: var(--color-gray-400, var(--color-gray-500));
                    text-transform: uppercase;
                    letter-spacing: 0.04em;
                }
                .csm-host-name {
                    font-size: 0.95rem;
                    font-weight: 700;
                    color: var(--color-gray-900);
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }

                .csm-section {
                    display: flex;
                    flex-direction: column;
                    gap: 0.6rem;
                }

                .csm-loc {
                    display: flex;
                    align-items: center;
                    gap: 0.4rem;
                    font-size: 0.92rem;
                    font-weight: 600;
                    color: var(--color-gray-900);
                }
                .csm-loc :global(svg) { color: var(--color-secondary); flex-shrink: 0; }

                .csm-address {
                    margin: 0;
                    font-size: 0.82rem;
                    color: var(--color-gray-500);
                }

                .csm-map {
                    position: relative;
                    border-radius: var(--radius-md);
                    overflow: hidden;
                    border: 1px solid var(--color-gray-200);
                }

                /* Full-cover click target over the (non-interactive) locator
                   map — opens the "Open with" maps chooser. Sits above every
                   Leaflet pane (tiles 200 … controls 800). */
                .csm-map-open {
                    position: absolute;
                    inset: 0;
                    z-index: 1000;
                    display: flex;
                    align-items: flex-end;
                    justify-content: flex-end;
                    padding: 0.5rem;
                    min-height: 0;
                    border: none;
                    background: transparent;
                    cursor: pointer;
                }

                .csm-map-open-pill {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.3rem;
                    padding: 0.3rem 0.65rem;
                    border-radius: 999px;
                    background: rgba(10, 25, 47, 0.85);
                    color: #fff;
                    font-size: 0.75rem;
                    font-weight: 600;
                    pointer-events: none;
                }

                .csm-time {
                    display: flex;
                    align-items: center;
                    gap: 0.35rem;
                    font-size: 0.82rem;
                    color: var(--color-gray-500);
                }

                .csm-note {
                    margin: 0;
                    font-size: 0.9rem;
                    line-height: 1.55;
                    color: var(--color-gray-700, var(--color-gray-600));
                    white-space: pre-wrap;
                    word-break: break-word;
                }

                .csm-chips {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 0.4rem;
                }
                .csm-chip {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.3rem;
                    padding: 0.25rem 0.65rem;
                    border-radius: var(--radius-full);
                    background: var(--color-gray-100);
                    color: var(--color-gray-600, var(--color-gray-500));
                    font-size: 0.78rem;
                    font-weight: 500;
                }

                .csm-attend-head {
                    display: flex;
                    align-items: center;
                    gap: 0.4rem;
                    font-size: 0.9rem;
                    font-weight: 700;
                    color: var(--color-gray-900);
                }
                .csm-attend-head :global(svg) { color: var(--color-gray-500); }

                .csm-attendees {
                    display: flex;
                    flex-direction: column;
                    gap: 0.5rem;
                }
                .csm-attendee {
                    display: flex;
                    align-items: center;
                    gap: 0.6rem;
                }
                .csm-att-avatar {
                    width: 32px;
                    height: 32px;
                    border-radius: 50%;
                    overflow: hidden;
                    background: var(--color-gray-100);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-weight: 600;
                    font-size: 0.78rem;
                    color: var(--color-gray-500);
                    flex-shrink: 0;
                }
                .csm-att-avatar img { width: 100%; height: 100%; object-fit: cover; }
                .csm-att-name {
                    font-size: 0.88rem;
                    font-weight: 500;
                    color: var(--color-gray-800, var(--color-gray-900));
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    min-width: 0;
                }
                .csm-att-badge {
                    flex-shrink: 0;
                    padding: 0.1rem 0.5rem;
                    border-radius: var(--radius-full);
                    background: var(--color-secondary);
                    color: white;
                    font-size: 0.66rem;
                    font-weight: 700;
                    text-transform: uppercase;
                    letter-spacing: 0.03em;
                }
                .csm-att-empty {
                    margin: 0;
                    font-size: 0.85rem;
                    color: var(--color-gray-400, var(--color-gray-500));
                }

                .csm-error {
                    margin: 0;
                    font-size: 0.82rem;
                    color: var(--color-error, #EF4444);
                }

                .csm-actions {
                    display: flex;
                    gap: 0.5rem;
                }

                .csm-btn {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 0.45rem;
                    width: 100%;
                    padding: 0.8rem;
                    border: none;
                    border-radius: var(--radius-md);
                    font-size: 0.95rem;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.15s;
                }
                .csm-btn:disabled { opacity: 0.6; cursor: wait; }

                .csm-join {
                    background: var(--color-secondary);
                    color: white;
                }
                .csm-join:hover:not(:disabled) { background: var(--color-secondary-dark, #CC4A00); }

                .csm-leave {
                    background: none;
                    border: 1.5px solid var(--color-gray-300, var(--color-gray-200));
                    color: var(--color-gray-700, var(--color-gray-600));
                }
                .csm-leave:hover:not(:disabled) { border-color: var(--color-secondary); color: var(--color-secondary); }

                .csm-end {
                    background: none;
                    border: 1.5px solid var(--color-error, #EF4444);
                    color: var(--color-error, #EF4444);
                }
                .csm-end:hover:not(:disabled) { background: var(--color-error, #EF4444); color: white; }

                .csm-spin { animation: csm-spin 1s linear infinite; }
                @keyframes csm-spin { to { transform: rotate(360deg); } }

                @media (max-width: 768px) {
                    .csm-overlay { align-items: flex-end; }
                    .csm-card {
                        width: 100%;
                        max-width: none;
                        max-height: 92vh;
                        max-height: calc(100dvh - env(safe-area-inset-top, 0px) - 0.5rem);
                        border-radius: var(--radius-lg) var(--radius-lg) 0 0;
                    }
                    .csm-body {
                        padding-bottom: calc(1.25rem + env(safe-area-inset-bottom));
                    }
                }
            `}</style>
        </div>,
        document.body,
    );
};

export default CoworkSessionModal;
