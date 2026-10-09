import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Coffee, Plus, Loader2, WifiOff } from 'lucide-react';
import { useCoworkSessions } from '../hooks/useCoworkSessions';
import { coworkApi } from '../services/api';
import CoworkMap from '../components/cowork/CoworkMap';
import CheckInModal from '../components/cowork/CheckInModal';
import CoworkSessionModal from '../components/cowork/CoworkSessionModal';
import CoworkerCard from '../components/cowork/CoworkerCard';

/**
 * /cowork — server-backed, joinable cowork sessions.
 * Active tab: live-polled sessions (map thumbnail + clickable cards, "+ New
 * session" CTA). Past tab: lazy-loaded ended sessions. Any card opens the
 * shared detail modal.
 */
const Cowork = () => {
    const { t } = useTranslation();
    const { sessions, loading, error, retry } = useCoworkSessions();

    const [tab, setTab] = useState('active'); // 'active' | 'past'
    const [showCheckIn, setShowCheckIn] = useState(false);
    const [selectedSessionId, setSelectedSessionId] = useState(null);

    // Just-created sessions overlaid on the polled list for instant feedback;
    // pruned once the authoritative poll includes them.
    const [justCreated, setJustCreated] = useState([]);

    // Past tab (lazy — fetched on first switch, refetched after an end action).
    const [pastSessions, setPastSessions] = useState([]);
    const [pastLoading, setPastLoading] = useState(false);
    const [pastError, setPastError] = useState(false);
    const [pastLoaded, setPastLoaded] = useState(false);

    const fetchPast = useCallback(() => {
        setPastLoading(true);
        setPastError(false);
        return coworkApi.listSessions('past')
            .then((res) => {
                setPastSessions(Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : []));
            })
            .catch((err) => {
                console.error('[Cowork] Failed to load past sessions:', err);
                setPastError(true);
            })
            .finally(() => {
                // Mark loaded on BOTH outcomes so the lazy-load effect can't
                // re-fire on failure (pastError drives the error UI; Try Again
                // re-invokes fetchPast directly).
                setPastLoaded(true);
                setPastLoading(false);
            });
    }, []);

    // Lazy-load the Past tab the first time it's opened.
    useEffect(() => {
        if (tab === 'past' && !pastLoaded && !pastLoading) fetchPast();
    }, [tab, pastLoaded, pastLoading, fetchPast]);

    // Drop optimistic entries once the poll authoritatively returns them.
    useEffect(() => {
        if (justCreated.length === 0) return;
        setJustCreated((prev) => prev.filter((s) => !sessions.some((h) => h.id === s.id)));
    }, [sessions]);  

    const activeSessions = useMemo(() => {
        const byId = new Map();
        for (const s of justCreated) byId.set(s.id, s);
        for (const s of sessions) byId.set(s.id, s); // server is authoritative
        return [...byId.values()].sort(
            (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
        );
    }, [justCreated, sessions]);

    // Sessions with real coordinates feed the map thumbnail. CoworkMap is plain
    // Leaflet keyed on `pubkey`; map session id -> pubkey and hand it a name via
    // the profiles map so the pin tooltip reads the session title.
    const { mapSessions, mapProfiles } = useMemo(() => {
        const withCoords = activeSessions.filter(
            (s) => Number.isFinite(s.lat) && Number.isFinite(s.lng),
        );
        const profiles = {};
        withCoords.forEach((s) => { profiles[s.id] = { name: s.title }; });
        return {
            mapSessions: withCoords.map((s) => ({ pubkey: s.id, lat: s.lat, lng: s.lng })),
            mapProfiles: profiles,
        };
    }, [activeSessions]);

    const handleCreated = (session) => {
        if (session && session.id) {
            setJustCreated((prev) => [session, ...prev.filter((s) => s.id !== session.id)]);
            setSelectedSessionId(session.id);
        }
        setShowCheckIn(false);
        if (typeof retry === 'function') retry(); // pull the authoritative row
    };

    // A join/leave/end inside the detail modal — refresh whichever tab is live.
    const handleChanged = useCallback(() => {
        if (typeof retry === 'function') retry();
        if (pastLoaded) fetchPast();
    }, [retry, pastLoaded, fetchPast]);

    const isActive = tab === 'active';
    const listSessions = isActive ? activeSessions : pastSessions;
    const listLoading = isActive ? loading : pastLoading;
    const listError = isActive ? error : pastError;
    const listCount = listSessions.length;

    return (
        <div className="cowork-page" data-testid="cowork-page">
            {/* Header */}
            <div className="cw-header">
                <div className="cw-title-block">
                    <Coffee size={26} className="cw-title-icon" />
                    <h1>{t('cowork.title')}</h1>
                </div>
                {isActive && (
                    <button
                        className="cw-new-btn"
                        data-testid="cowork-checkin-btn"
                        onClick={() => setShowCheckIn(true)}
                    >
                        <Plus size={18} />
                        {t('cowork.newSession', 'New session')}
                    </button>
                )}
            </div>

            {/* Active | Past tabs */}
            <div className="cw-tabs" role="tablist">
                <button
                    role="tab"
                    aria-selected={isActive}
                    className={`cw-tab ${isActive ? 'active' : ''}`}
                    data-testid="cowork-tab-active"
                    onClick={() => setTab('active')}
                >
                    {t('cowork.tabActive', 'Active')}
                </button>
                <button
                    role="tab"
                    aria-selected={!isActive}
                    className={`cw-tab ${!isActive ? 'active' : ''}`}
                    data-testid="cowork-tab-past"
                    onClick={() => setTab('past')}
                >
                    {t('cowork.tabPast', 'Past')}
                </button>
            </div>

            {/* Map thumbnail — active sessions with coordinates only */}
            {isActive && mapSessions.length > 0 && (
                <div className="cw-map-thumb">
                    <CoworkMap sessions={mapSessions} profiles={mapProfiles} height="200px" />
                </div>
            )}

            {/* Session list */}
            <div className="cw-list" data-testid="cowork-list">
                {listSessions.map((session) => (
                    <CoworkerCard
                        key={session.id}
                        session={session}
                        onOpen={(id) => setSelectedSessionId(id)}
                    />
                ))}
            </div>

            {listLoading && listCount === 0 && (
                <div className="cw-loading">
                    <Loader2 size={28} className="cw-spin" />
                </div>
            )}

            {!listLoading && listError && listCount === 0 && (
                <div className="cw-empty" data-testid="cowork-error">
                    <WifiOff size={48} className="cw-empty-icon" />
                    <h3>{t('cowork.loadErrorTitle', "Couldn't load sessions")}</h3>
                    <p>{t('cowork.loadErrorBody', 'Check your connection and try again.')}</p>
                    <button className="cw-empty-cta" onClick={() => (isActive ? retry && retry() : fetchPast())}>
                        {t('common.tryAgain', 'Try Again')}
                    </button>
                </div>
            )}

            {!listLoading && !listError && listCount === 0 && (
                isActive ? (
                    <div className="cw-empty" data-testid="cowork-empty">
                        <Coffee size={48} className="cw-empty-icon" />
                        <h3>{t('cowork.emptyTitle')}</h3>
                        <p>{t('cowork.emptyBody')}</p>
                        <button className="cw-empty-cta" onClick={() => setShowCheckIn(true)}>
                            <Plus size={16} />
                            {t('cowork.newSession', 'New session')}
                        </button>
                    </div>
                ) : (
                    <div className="cw-empty" data-testid="cowork-empty-past">
                        <Coffee size={48} className="cw-empty-icon" />
                        <h3>{t('cowork.emptyPastTitle', 'No past sessions yet')}</h3>
                        <p>{t('cowork.emptyPastBody', 'Ended cowork sessions will show up here.')}</p>
                    </div>
                )
            )}

            <CheckInModal
                open={showCheckIn}
                onClose={() => setShowCheckIn(false)}
                onSuccess={handleCreated}
            />

            <CoworkSessionModal
                open={!!selectedSessionId}
                sessionId={selectedSessionId}
                onClose={() => setSelectedSessionId(null)}
                onChanged={handleChanged}
            />

            <style jsx>{`
                .cowork-page {
                    max-width: 720px;
                    width: 100%;
                    margin: 0 auto;
                    padding: 2rem 1rem;
                    display: flex;
                    flex-direction: column;
                    gap: 1.25rem;
                }

                .cw-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 0.75rem;
                }

                .cw-title-block {
                    display: flex;
                    align-items: center;
                    gap: 0.6rem;
                    min-width: 0;
                }

                .cw-title-block h1 {
                    margin: 0;
                    font-size: 1.6rem;
                }

                .cw-title-icon {
                    color: var(--color-secondary);
                    flex-shrink: 0;
                }

                .cw-new-btn {
                    flex-shrink: 0;
                    display: flex;
                    align-items: center;
                    gap: 0.4rem;
                    padding: 0.55rem 1rem;
                    border: none;
                    border-radius: var(--radius-full);
                    background: var(--color-secondary);
                    color: white;
                    font-size: 0.88rem;
                    font-weight: 600;
                    cursor: pointer;
                    transition: background 0.15s;
                }

                .cw-new-btn:hover { background: var(--color-secondary-dark, #CC4A00); }

                .cw-tabs {
                    display: flex;
                    gap: 0.35rem;
                    background: var(--color-gray-100);
                    border-radius: var(--radius-md);
                    padding: 0.25rem;
                }

                .cw-tab {
                    flex: 1;
                    padding: 0.55rem 0.5rem;
                    border: none;
                    background: none;
                    border-radius: var(--radius-sm);
                    font-size: 0.9rem;
                    font-weight: 600;
                    color: var(--color-gray-500);
                    cursor: pointer;
                    transition: all 0.15s;
                }

                .cw-tab.active {
                    background: var(--color-surface);
                    color: var(--color-primary);
                    box-shadow: var(--shadow-sm);
                }

                .cw-map-thumb {
                    position: relative;
                    border-radius: var(--radius-md);
                    overflow: hidden;
                    border: 1px solid var(--color-gray-200);
                    box-shadow: var(--shadow-sm);
                }

                .cw-list {
                    display: flex;
                    flex-direction: column;
                    gap: 0.75rem;
                }

                .cw-loading {
                    display: flex;
                    justify-content: center;
                    padding: 2.5rem 0;
                    color: var(--color-primary);
                }

                .cw-spin {
                    animation: cw-spin 1s linear infinite;
                }

                @keyframes cw-spin {
                    to { transform: rotate(360deg); }
                }

                .cw-empty {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 0.5rem;
                    text-align: center;
                    padding: 3rem 1.5rem;
                    color: var(--color-gray-500);
                }

                .cw-empty h3 {
                    margin: 0;
                    color: var(--color-gray-900);
                }

                .cw-empty p {
                    margin: 0;
                    font-size: 0.9rem;
                    max-width: 340px;
                }

                .cw-empty-icon {
                    color: var(--color-gray-300, var(--color-gray-200));
                }

                .cw-empty-cta {
                    display: flex;
                    align-items: center;
                    gap: 0.4rem;
                    margin-top: 0.75rem;
                    padding: 0.6rem 1.4rem;
                    border: none;
                    border-radius: var(--radius-md);
                    background: var(--color-secondary);
                    color: white;
                    font-size: 0.9rem;
                    font-weight: 600;
                    cursor: pointer;
                    transition: background 0.15s;
                }

                .cw-empty-cta:hover {
                    background: var(--color-secondary-dark, #CC4A00);
                }

                @media (max-width: 768px) {
                    .cowork-page {
                        padding-bottom: calc(90px + env(safe-area-inset-bottom));
                    }
                }
            `}</style>
        </div>
    );
};

export default Cowork;
