import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, Link } from 'react-router-dom';
import { Loader2, Smartphone, CheckCircle, AlertCircle } from 'lucide-react';
import { amberSignerService } from '../services/amberSignerService';
import { authService } from '../services/authService';
import { useAuth } from '../context/AuthContext';

/**
 * AmberCallback — landing route for NIP-55 `nostrsigner:` results.
 *
 * Amber redirects here (`/amber-callback?op=<id>&result=<payload>`) after
 * each signing operation. This page hands the result to
 * amberSignerService.handleCallback() and acts on its directive:
 *
 *  - continue-login: got the pubkey — request the BIES challenge and bounce
 *    back to Amber for the signature (round trip 2 of 2).
 *  - finish-login: got the signed challenge — exchange for a JWT, wire up
 *    AuthContext, and navigate into the app.
 *  - resume-same-tab: a generic signing op whose initiating page context
 *    died with this tab's reload — return to where the user was; they retry
 *    the action (instant, permissions were pre-granted at login).
 *  - close-me: the initiating tab is alive and already got the result via a
 *    storage event — this (Amber-opened) tab can be closed.
 *  - stale / error: informational dead ends with a way back.
 *
 * Auto-navigation to Amber from here happens WITHOUT a user gesture, which
 * Android Chrome may block — so a manual "Continue in Amber" button is
 * always rendered alongside the attempt.
 */
const AmberCallback = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { completeExternalLogin } = useAuth();
    // processing | approve-in-amber | signed-other-tab | stale | error
    const [phase, setPhase] = useState('processing');
    const [message, setMessage] = useState('');
    const [returnPath, setReturnPath] = useState('/feed');
    const retryNavRef = useRef(null); // re-navigation closure for the manual button
    const ranRef = useRef(false);

    useEffect(() => {
        if (ranRef.current) return; // StrictMode double-mount guard
        ranRef.current = true;

        const directive = amberSignerService.handleCallback(window.location.search);

        const run = async () => {
            switch (directive.kind) {
                case 'continue-login': {
                    setPhase('processing');
                    setMessage(t('amberCallback.requestingChallenge'));
                    try {
                        // Fires the second nostrsigner: navigation (no gesture —
                        // may be blocked; the manual button covers that).
                        const signPromise = authService.continueAmberLogin(directive.pubkey);
                        retryNavRef.current = () => authService.continueAmberLogin(directive.pubkey);
                        setPhase('approve-in-amber');
                        setMessage(t('amberCallback.approveInAmber'));
                        // If this tab survives and the result lands in another
                        // tab, the promise resolves — finish here too.
                        const signedEvent = await signPromise;
                        const user = await authService.finishAmberLogin(signedEvent);
                        navigate(completeExternalLogin(user), { replace: true });
                    } catch (err) {
                        setPhase('error');
                        setMessage(err.message || 'Login failed.');
                    }
                    break;
                }
                case 'finish-login': {
                    setPhase('processing');
                    setMessage(t('amberCallback.processing'));
                    try {
                        const user = await authService.finishAmberLogin(directive.signedEvent);
                        navigate(completeExternalLogin(user), { replace: true });
                    } catch (err) {
                        setPhase('error');
                        setMessage(err.message || 'Login failed.');
                    }
                    break;
                }
                case 'resume-same-tab': {
                    navigate(directive.returnPath || '/feed', { replace: true });
                    break;
                }
                case 'close-me': {
                    setReturnPath(directive.returnPath || '/feed');
                    setPhase('signed-other-tab');
                    break;
                }
                case 'stale': {
                    setPhase('stale');
                    break;
                }
                default: {
                    setPhase('error');
                    setMessage(directive.message || 'Unexpected callback.');
                }
            }
        };
        run();
         
    }, []);

    const handleReturnToApp = () => {
        // Amber-opened tabs can usually be closed by script; fall back to
        // navigating if the browser refuses.
        window.close();
        setTimeout(() => navigate(returnPath, { replace: true }), 250);
    };

    return (
        <div className="ac-container">
            <div className="ac-card">
                {(phase === 'processing' || phase === 'approve-in-amber') && (
                    <>
                        <Loader2 size={32} className="ac-spin" />
                        <p className="ac-text">{message || t('amberCallback.processing')}</p>
                        {phase === 'approve-in-amber' && (
                            <button
                                className="ac-btn"
                                onClick={() => retryNavRef.current?.()}
                            >
                                <Smartphone size={18} />
                                {t('amberCallback.continueInAmber')}
                            </button>
                        )}
                    </>
                )}

                {phase === 'signed-other-tab' && (
                    <>
                        <CheckCircle size={32} className="ac-ok" />
                        <p className="ac-text">{t('amberCallback.signedReturn')}</p>
                        <button className="ac-btn" onClick={handleReturnToApp}>
                            {t('amberCallback.returnToApp')}
                        </button>
                    </>
                )}

                {phase === 'stale' && (
                    <>
                        <AlertCircle size={32} className="ac-warn" />
                        <p className="ac-text">{t('amberCallback.expired')}</p>
                        <Link className="ac-btn" to="/login">{t('amberCallback.backToLogin')}</Link>
                    </>
                )}

                {phase === 'error' && (
                    <>
                        <AlertCircle size={32} className="ac-warn" />
                        <p className="ac-text">{message}</p>
                        <Link className="ac-btn" to="/login">{t('amberCallback.backToLogin')}</Link>
                    </>
                )}
            </div>

            <style jsx>{`
                .ac-container {
                    min-height: 100vh;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 1rem;
                    background: var(--color-background, #fafafa);
                }

                .ac-card {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 1rem;
                    background: var(--color-surface, #fff);
                    border: 1px solid var(--color-gray-200);
                    border-radius: 1.25rem;
                    padding: 2.5rem 2rem;
                    width: 100%;
                    max-width: 380px;
                    text-align: center;
                    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.06);
                }

                .ac-text {
                    margin: 0;
                    font-size: 0.95rem;
                    color: var(--color-gray-600);
                    line-height: 1.5;
                }

                .ac-btn {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    gap: 0.5rem;
                    padding: 0.75rem 1.5rem;
                    background: #1e1b4b;
                    color: white;
                    border: none;
                    border-radius: 9999px;
                    font-size: 0.9rem;
                    font-weight: 600;
                    cursor: pointer;
                    text-decoration: none;
                }
                .ac-btn:hover { opacity: 0.9; }

                .ac-spin {
                    animation: ac-spin 1s linear infinite;
                    color: #4338ca;
                }
                @keyframes ac-spin {
                    to { transform: rotate(360deg); }
                }

                .ac-ok { color: #10b981; }
                .ac-warn { color: var(--color-error, #ef4444); }
            `}</style>
        </div>
    );
};

export default AmberCallback;
