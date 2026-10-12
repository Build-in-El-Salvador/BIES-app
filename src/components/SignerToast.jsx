import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { KeyRound, ExternalLink, X } from 'lucide-react';
import { isSafeAuthUrl } from '../services/nostrConnectService';

const MAX_TOASTS = 2;

/**
 * SignerToast — global toasts for NIP-46 remote-signer events.
 *
 * Listens for:
 *  - `bies:nip46-auth-url` — the signer requires web-based approval. The URL
 *    arrives from a relay callback (no user gesture), so window.open() would
 *    be popup-blocked; we render a clickable link instead.
 *  - `bies:signer-disconnected` — the stored NIP-46 session was terminally
 *    rejected. The JWT is still valid (browsing works); signing needs a
 *    re-login, so we link to /login rather than forcing a logout.
 *
 * Mounted unconditionally in App.jsx — auth-url toasts must show during
 * login, before any user exists.
 */
const SignerToast = () => {
    const { t } = useTranslation();
    const [toasts, setToasts] = useState([]);
    const idRef = useRef(0);

    const dismiss = useCallback((id) => {
        setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, []);

    useEffect(() => {
        const onAuthUrl = (e) => {
            const url = e.detail?.url;
            // Defense-in-depth: only ever render http(s) links (the dispatcher
            // already filters, but never trust a URL reaching an href sink).
            if (!isSafeAuthUrl(url)) return;
            const id = ++idRef.current;
            setToasts((prev) => [...prev.slice(-(MAX_TOASTS - 1)), { id, type: 'auth-url', url }]);
        };
        const onDisconnected = () => {
            const id = ++idRef.current;
            setToasts((prev) => {
                // Only one disconnect toast at a time
                if (prev.some((toast) => toast.type === 'disconnected')) return prev;
                return [...prev.slice(-(MAX_TOASTS - 1)), { id, type: 'disconnected' }];
            });
        };
        window.addEventListener('bies:nip46-auth-url', onAuthUrl);
        window.addEventListener('bies:signer-disconnected', onDisconnected);
        return () => {
            window.removeEventListener('bies:nip46-auth-url', onAuthUrl);
            window.removeEventListener('bies:signer-disconnected', onDisconnected);
        };
    }, []);

    if (toasts.length === 0) return null;

    return (
        <div className="st-root" role="status" aria-live="polite">
            {toasts.map(({ id, type, url }) => (
                <div key={id} className="st-toast" data-testid="signer-toast">
                    <span className="st-icon">
                        <KeyRound size={18} style={{ color: '#4338ca' }} />
                    </span>
                    <div className="st-body">
                        {type === 'auth-url' ? (
                            <>
                                <p className="st-text">{t('signer.authRequired')}</p>
                                <a
                                    className="st-action"
                                    href={url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={() => dismiss(id)}
                                >
                                    {t('signer.openApproval')} <ExternalLink size={12} />
                                </a>
                            </>
                        ) : (
                            <>
                                <p className="st-text">{t('signer.disconnected')}</p>
                                <Link className="st-action" to="/login/nostr" onClick={() => dismiss(id)}>
                                    {t('signer.reLogin')}
                                </Link>
                            </>
                        )}
                    </div>
                    <button className="st-close" aria-label={t('common.close', 'Close')} onClick={() => dismiss(id)}>
                        <X size={14} />
                    </button>
                </div>
            ))}

            {/* Same styled-jsx scoping pattern as GamificationToast: rows come
                out of a .map, so descendants use `.st-root :global(...)`. */}
            <style jsx>{`
                .st-root {
                    position: fixed;
                    left: 50%;
                    transform: translateX(-50%);
                    bottom: 24px;
                    z-index: 10600; /* above GamificationToast (10500) */
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                    width: min(420px, calc(100vw - 32px));
                    pointer-events: none;
                }

                .st-root :global(.st-toast) {
                    display: flex;
                    align-items: flex-start;
                    gap: 10px;
                    background: var(--color-surface);
                    color: var(--color-gray-900);
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-md);
                    box-shadow: var(--shadow-lg);
                    padding: 10px 12px;
                    pointer-events: auto;
                    animation: st-slide-up 0.25s ease-out;
                }

                @keyframes st-slide-up {
                    from { opacity: 0; transform: translateY(12px); }
                    to { opacity: 1; transform: translateY(0); }
                }

                .st-root :global(.st-icon) {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 32px;
                    height: 32px;
                    border-radius: 50%;
                    background: var(--color-primary-light, #eff6ff);
                    flex-shrink: 0;
                }

                .st-root :global(.st-body) {
                    flex: 1;
                    min-width: 0;
                }

                .st-root :global(.st-text) {
                    margin: 0 0 4px;
                    font-size: 0.875rem;
                    line-height: 1.4;
                    font-weight: 500;
                }

                .st-root :global(.st-action) {
                    display: inline-flex;
                    align-items: center;
                    gap: 4px;
                    font-size: 0.8rem;
                    font-weight: 600;
                    color: var(--color-primary, #4338ca);
                    text-decoration: none;
                }
                .st-root :global(.st-action:hover) { text-decoration: underline; }

                .st-root :global(.st-close) {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background: none;
                    border: none;
                    color: var(--color-gray-400);
                    cursor: pointer;
                    padding: 4px;
                    border-radius: var(--radius-sm);
                    flex-shrink: 0;
                    transition: background 0.15s, color 0.15s;
                }

                .st-root :global(.st-close:hover) {
                    background: var(--color-gray-100);
                    color: var(--color-gray-700);
                }

                @media (max-width: 768px) {
                    .st-root {
                        bottom: calc(76px + env(safe-area-inset-bottom, 0px));
                    }
                }
            `}</style>
        </div>
    );
};

export default SignerToast;
