import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { QRCodeSVG } from 'qrcode.react';
import { Loader2, Copy, CheckCircle, Smartphone, RefreshCw } from 'lucide-react';
import { nostrConnectService } from '../services/nostrConnectService';
import { useAuth } from '../context/AuthContext';
import { isMobileUA } from '../utils/device';

const NOSTRCONNECT_TIMEOUT_MS = 120_000;

/**
 * NostrConnectQR — client-initiated NIP-46 pairing (nostrconnect://).
 *
 * Generates a nostrconnect:// URI and renders it as a QR code (desktop:
 * scan with Amber/phone signer) and a tappable deep link (mobile: opens
 * the signer app on the same device). Waits for the signer's connect
 * response over the rendezvous relays, then completes the BIES
 * challenge-response login.
 *
 * @param {function} props.onSuccess - receives the AuthContext login result
 * @param {function} props.onError - receives an error message string
 */
const NostrConnectQR = ({ onSuccess, onError }) => {
    const { t } = useTranslation();
    const { loginWithNostrConnect } = useAuth();
    // waiting | connecting | timeout | cancelled | error
    const [status, setStatus] = useState('waiting');
    const [uri, setUri] = useState('');
    const [copied, setCopied] = useState(false);
    const controllerRef = useRef(null);
    // Guards stale fromURI resolutions after regenerate/unmount.
    const sessionIdRef = useRef(0);
    const mobile = isMobileUA();

    const startSession = useCallback(async () => {
        controllerRef.current?.abort();
        const controller = new AbortController();
        controllerRef.current = controller;
        const sessionId = ++sessionIdRef.current;

        const { uri: connectUri, clientSk } = nostrConnectService.createConnectSession();
        setUri(connectUri);
        setStatus('waiting');
        setCopied(false);

        // Settle on abort/timeout independently of fromURI's promise: with the
        // production multi-relay config, nostr-tools can leave the pairing
        // promise pending on abort (each relay overwrites the AbortSignal's
        // onabort), so we race it against explicit abort + timeout guards to
        // guarantee the UI never hangs.
        const guarded = () => new Promise((resolve, reject) => {
            let done = false;
            const settle = (fn, arg) => { if (!done) { done = true; fn(arg); } };
            controller.signal.addEventListener('abort', () => {
                const e = new Error('cancelled'); e.name = 'AbortError';
                settle(reject, e);
            }, { once: true });
            const timer = setTimeout(() => settle(reject, new Error('timeout')), NOSTRCONNECT_TIMEOUT_MS);
            nostrConnectService.connectViaURI(connectUri, clientSk, controller.signal)
                .then((s) => { clearTimeout(timer); settle(resolve, s); })
                .catch((e) => { clearTimeout(timer); settle(reject, e); });
        });

        let signer;
        try {
            signer = await guarded();
        } catch (err) {
            if (sessionId !== sessionIdRef.current) return; // stale session
            if (controller.signal.aborted || err.name === 'AbortError') {
                setStatus('cancelled');
            } else {
                setStatus('timeout');
            }
            return;
        }
        if (sessionId !== sessionIdRef.current) return; // stale session

        // Paired — now run the BIES challenge-response login.
        setStatus('connecting');
        try {
            const result = await loginWithNostrConnect(signer);
            if (sessionId !== sessionIdRef.current) return;
            if (result.success) {
                onSuccess?.(result);
            } else {
                // Pairing succeeded and is persisted — only the JWT pipeline
                // failed. "Try again" retries login without re-pairing.
                setStatus('error');
                onError?.(result.error || 'Login failed.');
            }
        } catch (err) {
            if (sessionId !== sessionIdRef.current) return;
            setStatus('error');
            onError?.(err.message || 'Login failed.');
        }
    }, [loginWithNostrConnect, onSuccess, onError]);

    // Retry just the JWT pipeline with the already-paired signer.
    const retryLogin = useCallback(async () => {
        const signer = nostrConnectService.getSigner();
        if (!signer) { startSession(); return; }
        setStatus('connecting');
        try {
            const result = await loginWithNostrConnect(signer);
            if (result.success) onSuccess?.(result);
            else { setStatus('error'); onError?.(result.error || 'Login failed.'); }
        } catch (err) {
            setStatus('error');
            onError?.(err.message || 'Login failed.');
        }
    }, [loginWithNostrConnect, onSuccess, onError, startSession]);

    useEffect(() => {
        startSession();
        return () => {
            sessionIdRef.current++;
            controllerRef.current?.abort();
        };
         
    }, []);

    const copyUri = () => {
        navigator.clipboard.writeText(uri);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="ncq-root">
            {status === 'waiting' && (
                <>
                    {/* Mobile: deep link first; desktop: QR first */}
                    {mobile && (
                        <a className="ncq-open-btn" href={uri}>
                            <Smartphone size={18} />
                            {t('login.openInSigner')}
                        </a>
                    )}
                    <div className="ncq-qr-wrapper">
                        <QRCodeSVG
                            value={uri}
                            size={220}
                            level="M"
                            marginSize={2}
                            bgColor="#ffffff"
                            fgColor="#000000"
                        />
                    </div>
                    {!mobile && (
                        <a className="ncq-open-link" href={uri}>
                            <Smartphone size={14} />
                            {t('login.openInSigner')}
                        </a>
                    )}
                    {/* Hidden URI field — copy source + E2E hook */}
                    <input
                        type="text"
                        readOnly
                        value={uri}
                        data-testid="nostrconnect-uri"
                        className="ncq-uri-field"
                        onFocus={(e) => e.target.select()}
                    />
                    <button type="button" className="ncq-copy-btn" onClick={copyUri}>
                        {copied ? <><CheckCircle size={14} /> {t('login.uriCopied')}</> : <><Copy size={14} /> {t('login.copyUri')}</>}
                    </button>
                    <p className="ncq-status">
                        <Loader2 size={14} className="ncq-spin" />
                        {t('login.waitingApproval')}
                    </p>
                    <button type="button" className="ncq-cancel-btn" onClick={() => controllerRef.current?.abort()}>
                        {t('common.cancel', 'Cancel')}
                    </button>
                </>
            )}

            {status === 'connecting' && (
                <p className="ncq-status ncq-center">
                    <Loader2 size={18} className="ncq-spin" />
                    {t('login.connectingToSigner')}
                </p>
            )}

            {(status === 'timeout' || status === 'cancelled') && (
                <div className="ncq-center-col">
                    <p className="ncq-status">
                        {status === 'timeout' ? t('login.connectTimedOut') : t('login.connectCancelled')}
                    </p>
                    <button type="button" className="ncq-regen-btn" onClick={startSession}>
                        <RefreshCw size={14} />
                        {t('login.regenerateQr')}
                    </button>
                </div>
            )}

            {status === 'error' && (
                <div className="ncq-center-col">
                    <button type="button" className="ncq-regen-btn" onClick={retryLogin}>
                        <RefreshCw size={14} />
                        {t('passkeySave.tryAgain')}
                    </button>
                </div>
            )}

            <style jsx>{`
                .ncq-root {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 0.75rem;
                    padding: 0.5rem 0;
                }

                .ncq-qr-wrapper {
                    background: #ffffff;
                    padding: 12px;
                    border-radius: 0.75rem;
                    border: 1px solid var(--color-gray-200);
                    line-height: 0;
                }

                .ncq-open-btn {
                    width: 100%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 0.5rem;
                    padding: 0.85rem;
                    background: #1e1b4b;
                    color: white;
                    border: none;
                    border-radius: 9999px;
                    font-size: 0.95rem;
                    font-weight: 600;
                    text-decoration: none;
                }

                .ncq-open-link {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.35rem;
                    font-size: 0.85rem;
                    color: var(--color-primary, #4338ca);
                    text-decoration: none;
                }
                .ncq-open-link:hover { text-decoration: underline; }

                .ncq-uri-field {
                    position: absolute;
                    width: 1px;
                    height: 1px;
                    opacity: 0;
                    pointer-events: none;
                }

                .ncq-copy-btn {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.4rem;
                    background: none;
                    border: 1px solid var(--color-gray-300);
                    border-radius: 9999px;
                    padding: 0.4rem 0.9rem;
                    font-size: 0.8rem;
                    color: var(--color-gray-600);
                    cursor: pointer;
                }
                .ncq-copy-btn:hover { border-color: var(--color-gray-400); }

                .ncq-status {
                    display: flex;
                    align-items: center;
                    gap: 0.4rem;
                    font-size: 0.85rem;
                    color: var(--color-gray-500);
                    margin: 0;
                }

                .ncq-center { justify-content: center; padding: 1.5rem 0; }

                .ncq-center-col {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 0.75rem;
                    padding: 1rem 0;
                }

                .ncq-regen-btn {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.4rem;
                    background: #1e1b4b;
                    color: white;
                    border: none;
                    border-radius: 9999px;
                    padding: 0.6rem 1.2rem;
                    font-size: 0.85rem;
                    font-weight: 600;
                    cursor: pointer;
                }
                .ncq-regen-btn:hover { opacity: 0.9; }

                .ncq-cancel-btn {
                    background: none;
                    border: none;
                    color: var(--color-gray-500);
                    font-size: 0.85rem;
                    cursor: pointer;
                    padding: 0.25rem 1rem;
                }
                .ncq-cancel-btn:hover { color: var(--color-gray-700); }

                .ncq-spin {
                    animation: ncq-spin 1s linear infinite;
                }
                @keyframes ncq-spin {
                    to { transform: rotate(360deg); }
                }
            `}</style>
        </div>
    );
};

export default NostrConnectQR;
