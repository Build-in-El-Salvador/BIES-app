import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FileText, Loader2, Check, X, Clock } from 'lucide-react';
import { projectsApi } from '../../services/api';
import { openExternal } from '../../utils/openExternal';
import { isNativePlatform } from '../../utils/platform';
import { getAssetUrl } from '../../utils/assets';
import { isPlaceholderName } from '../../utils/profileComplete';

/**
 * An investment's pitch deck. Members open it when it's shared with all of
 * them, or ask for it and wait for a yes; its member opens their own and
 * answers the requests (newest first). The deck itself only ever opens
 * through a 15-minute link (GET /projects/:id/deck).
 *
 * @param {object} opportunity - from projectsApi.get, with deckAccess
 * @param {string} ownerName
 */
const DeckPanel = ({ opportunity, ownerName }) => {
    const { t } = useTranslation();
    const [access, setAccess] = useState(opportunity.deckAccess);
    const [opening, setOpening] = useState(false);
    const [asking, setAsking] = useState(false);
    const [note, setNote] = useState('');
    const [showNote, setShowNote] = useState(false);
    const [problem, setProblem] = useState('');
    const [requests, setRequests] = useState(null);
    const [answering, setAnswering] = useState(null);
    const own = access === 'own';

    const loadRequests = useCallback(async () => {
        try {
            const result = await projectsApi.getDeckRequests(opportunity.id);
            setRequests(Array.isArray(result?.data) ? result.data : []);
        } catch {
            setRequests([]);
        }
    }, [opportunity.id]);

    useEffect(() => {
        if (own) loadRequests();
    }, [own, loadRequests]);

    const open = async () => {
        setOpening(true);
        setProblem('');
        try {
            const result = await projectsApi.getDeck(opportunity.id);
            if (!result?.url) return;
            // The app opens it in its browser. A web page downloads it (it comes
            // as a download, so the page stays): a new tab opened after waiting
            // for the link is what pop-up blockers (Safari's) stop.
            if (isNativePlatform()) openExternal(result.url);
            else window.location.assign(getAssetUrl(result.url));
        } catch (err) {
            setProblem(err.message || t('opportunities.deck.openFailed'));
        } finally {
            setOpening(false);
        }
    };

    const ask = async () => {
        setAsking(true);
        setProblem('');
        try {
            await projectsApi.requestDeck(opportunity.id, { message: note.trim() });
            setAccess('pending');
            setShowNote(false);
        } catch (err) {
            setProblem(err.message || t('opportunities.deck.askFailed'));
        } finally {
            setAsking(false);
        }
    };

    const answer = async (request, status) => {
        setAnswering(request.id);
        try {
            await projectsApi.reviewDeckRequest(opportunity.id, request.id, status);
            setRequests((list) => list.map((r) => (r.id === request.id ? { ...r, status } : r)));
        } catch (err) {
            setProblem(err.message || t('opportunities.deck.answerFailed'));
        } finally {
            setAnswering(null);
        }
    };

    const openButton = (
        <button type="button" className="deck-btn primary" onClick={open} disabled={opening}>
            {opening ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> : <FileText size={16} />}
            {own ? t('opportunities.deck.openOwn') : t('opportunities.deck.open')}
        </button>
    );

    const pending = (requests || []).filter((r) => r.status === 'PENDING');
    const answered = (requests || []).filter((r) => r.status !== 'PENDING');

    return (
        <section className="deck-panel" aria-labelledby="deck-title">
            <h2 id="deck-title" className="deck-title"><FileText size={18} aria-hidden="true" /> {t('opportunities.deck.title')}</h2>

            {own && (
                <>
                    <p className="deck-text">
                        {opportunity.requiresDeckApproval ? t('opportunities.deck.ownAsk') : t('opportunities.deck.ownShared')}
                    </p>
                    {openButton}
                    {requests === null ? (
                        <Loader2 size={18} style={{ animation: 'spin 1s linear infinite', marginTop: 12, color: 'var(--color-gray-500)' }} />
                    ) : requests.length > 0 && (
                        <ul className="deck-requests">
                            {[...pending, ...answered].map((r) => {
                                const who = r.investor?.profile?.name;
                                const name = isPlaceholderName(who) ? t('profileView.newMember') : who;
                                return (
                                    <li key={r.id} className="deck-request">
                                        <div className="deck-request-who">
                                            <Link to={`/builder/${r.investor?.id || r.investorId}`} className="deck-request-name">{name}</Link>
                                            {r.message && <p className="deck-request-note">“{r.message}”</p>}
                                        </div>
                                        {r.status === 'PENDING' ? (
                                            <div className="deck-request-buttons">
                                                <button type="button" className="deck-btn small" onClick={() => answer(r, 'DENIED')} disabled={answering === r.id}>
                                                    <X size={14} /> {t('opportunities.deck.no')}
                                                </button>
                                                <button type="button" className="deck-btn small primary" onClick={() => answer(r, 'APPROVED')} disabled={answering === r.id}>
                                                    <Check size={14} /> {t('opportunities.deck.yes')}
                                                </button>
                                            </div>
                                        ) : (
                                            <span className={`deck-request-status ${r.status === 'APPROVED' ? 'yes' : 'no'}`}>
                                                {r.status === 'APPROVED' ? t('opportunities.deck.shared') : t('opportunities.deck.notShared')}
                                            </span>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </>
            )}

            {(access === 'open' || access === 'approved') && (
                <>
                    <p className="deck-text">{access === 'open' ? t('opportunities.deck.sharedWithMembers') : t('opportunities.deck.approved', { name: ownerName })}</p>
                    {openButton}
                </>
            )}

            {access === 'ask' && (
                <>
                    <p className="deck-text">{t('opportunities.deck.askText', { name: ownerName })}</p>
                    {showNote ? (
                        <div className="deck-ask">
                            <label className="deck-label" htmlFor="deck-note">{t('opportunities.deck.noteLabel')}</label>
                            <textarea
                                id="deck-note"
                                className="deck-note"
                                rows={3}
                                maxLength={500}
                                value={note}
                                onChange={(e) => setNote(e.target.value)}
                                placeholder={t('opportunities.deck.notePlaceholder')}
                            />
                            <div className="deck-request-buttons">
                                <button type="button" className="deck-btn" onClick={() => setShowNote(false)} disabled={asking}>{t('common.cancel')}</button>
                                <button type="button" className="deck-btn primary" onClick={ask} disabled={asking}>
                                    {asking && <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />}
                                    {t('opportunities.deck.send')}
                                </button>
                            </div>
                        </div>
                    ) : (
                        <button type="button" className="deck-btn primary" onClick={() => setShowNote(true)}>
                            <FileText size={16} /> {t('opportunities.deck.ask')}
                        </button>
                    )}
                </>
            )}

            {access === 'pending' && (
                <p className="deck-text deck-waiting"><Clock size={15} aria-hidden="true" /><span>{t('opportunities.deck.pending', { name: ownerName })}</span></p>
            )}

            {access === 'denied' && (
                <p className="deck-text">{t('opportunities.deck.denied')}</p>
            )}

            {problem && <p className="deck-problem" role="alert">{problem}</p>}

            <style jsx>{`
                .deck-panel {
                    margin-top: 1.75rem;
                    padding: 1.1rem 1.2rem;
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-lg);
                    background: var(--color-surface);
                }
                .deck-title {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    font-size: 1.05rem;
                    font-weight: 700;
                    margin: 0 0 0.5rem;
                }
                .deck-text {
                    display: flex;
                    align-items: flex-start;
                    gap: 6px;
                    margin: 0 0 0.85rem;
                    color: var(--color-gray-600);
                    font-size: 0.92rem;
                    line-height: 1.5;
                }
                .deck-waiting {
                    color: var(--color-orange-text, #b45309);
                    font-weight: 600;
                    margin: 0;
                }
                .deck-waiting :global(svg) {
                    flex-shrink: 0;
                    margin-top: 3px;
                }
                /* openButton is built before the returned tree, which styled-jsx doesn't scope */
                .deck-panel :global(.deck-btn) {
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                    padding: 0.55rem 1.05rem;
                    border-radius: var(--radius-full);
                    border: 1px solid var(--color-gray-300);
                    background: var(--color-surface);
                    color: var(--color-gray-700);
                    font-weight: 600;
                    font-size: 0.9rem;
                    cursor: pointer;
                }
                .deck-panel :global(.deck-btn.primary) {
                    background: var(--color-primary);
                    border-color: var(--color-primary);
                    color: white;
                }
                .deck-panel :global(.deck-btn.small) {
                    padding: 0.35rem 0.8rem;
                    font-size: 0.82rem;
                }
                .deck-panel :global(.deck-btn:disabled) {
                    opacity: 0.6;
                    cursor: not-allowed;
                }
                .deck-ask {
                    display: flex;
                    flex-direction: column;
                    gap: 0.5rem;
                }
                .deck-label {
                    font-size: 0.85rem;
                    font-weight: 600;
                    color: var(--color-gray-700);
                }
                .deck-note {
                    width: 100%;
                    box-sizing: border-box;
                    padding: 0.6rem 0.8rem;
                    border: 1px solid var(--color-gray-300);
                    border-radius: var(--radius-md);
                    font: inherit;
                    font-size: 0.92rem;
                    resize: vertical;
                    background: var(--color-surface);
                    color: inherit;
                }
                .deck-requests {
                    list-style: none;
                    margin: 1rem 0 0;
                    padding: 0;
                    display: flex;
                    flex-direction: column;
                    gap: 0.6rem;
                }
                .deck-request {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 0.75rem;
                    padding-top: 0.6rem;
                    border-top: 1px solid var(--color-gray-100);
                }
                .deck-request-who {
                    min-width: 0;
                }
                .deck-request-who :global(.deck-request-name) {
                    font-weight: 600;
                    color: var(--color-gray-800);
                    text-decoration: none;
                }
                .deck-request-note {
                    margin: 2px 0 0;
                    font-size: 0.85rem;
                    color: var(--color-gray-500);
                    overflow-wrap: anywhere;
                }
                .deck-request-buttons {
                    display: flex;
                    gap: 6px;
                    flex-shrink: 0;
                }
                .deck-request-status {
                    font-size: 0.8rem;
                    font-weight: 700;
                    flex-shrink: 0;
                }
                .deck-request-status.yes { color: var(--color-success-text, #047857); }
                .deck-request-status.no { color: var(--color-gray-500); }
                .deck-problem {
                    margin: 0.75rem 0 0;
                    color: #b91c1c;
                    font-size: 0.85rem;
                    font-weight: 600;
                }
            `}</style>
        </section>
    );
};

export default DeckPanel;
