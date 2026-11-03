import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { AlertCircle, CheckCircle2, Copy, ExternalLink, Loader2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { inviteApi } from '../services/api';
import { useInviteOnly } from '../hooks/useInviteOnly';
import { isNativePlatform } from '../utils/platform';
import { openExternal } from '../utils/openExternal';
import { copyText } from '../utils/clipboard';
import { APP_STORE_URL, PLAY_STORE_URL } from '../config/storeLinks';
import {
    formatAsTyped,
    formatInviteCode,
    inviteCodeFromHash,
    inviteStorage,
    normalizeInviteCode,
    rememberInvite,
    rememberedInvite,
} from '../utils/inviteCode';
import logoIcon from '../assets/logo-icon.svg';

const WEBSITE = 'https://buildinelsalvador.com';

/**
 * /invite: the first screen while sign-up is invite-only, and where an
 * invite link lands (/invite#BIES-K7M4-Q9TX, the code after # so it never
 * reaches a server log). The code is checked here, then kept on this device
 * for sign-up (services/api.js sends it); it's used up only when the account
 * is made. Members sign in from here.
 */
const Invite = () => {
    const { t, i18n } = useTranslation();
    const { user, loading } = useAuth();
    const navigate = useNavigate();
    const location = useLocation();
    const inviteOnly = useInviteOnly();
    const native = isNativePlatform();

    // The link's code: taken out of the address straight after it's read.
    const [fromLink, setFromLink] = useState(() => inviteCodeFromHash(location.hash));
    const [kept] = useState(() => rememberedInvite(inviteStorage()));
    const [code, setCode] = useState(() => fromLink || kept?.code || '');
    const [state, setState] = useState(() => (fromLink ? 'checking' : kept ? 'valid' : 'idle')); // idle | checking | valid | invalid
    const [expiresAt, setExpiresAt] = useState(() => (fromLink ? null : kept?.expiresAt ?? null));
    const [error, setError] = useState('');
    const [help, setHelp] = useState(false);
    const [copied, setCopied] = useState(false);
    const canPaste = typeof navigator !== 'undefined' && !!navigator.clipboard?.readText;

    const lang = i18n.language?.startsWith('es') ? 'es' : 'en';
    const until = expiresAt
        ? new Date(expiresAt).toLocaleDateString(lang, { weekday: 'short', day: 'numeric', month: 'short' })
        : '';

    const check = async (value) => {
        const formatted = formatInviteCode(value);
        if (!formatted) {
            setState('invalid');
            setError(t('invite.errors.invalid'));
            return false;
        }
        setState('checking');
        setError('');
        try {
            const res = await inviteApi.check(formatted);
            rememberInvite(inviteStorage(), formatted, res.expiresAt);
            setExpiresAt(res.expiresAt);
            setState('valid');
            return true;
        } catch (err) {
            setState('invalid');
            setError(err?.data?.reason === 'invite_rate_limited' ? t('invite.errors.tooMany') : t('invite.errors.invalid'));
            return false;
        }
    };

    // The code comes out of the address at once. It's checked (and kept)
    // only for someone signed out: a member opening a link keeps nothing.
    // A link opened while this screen is already up (the app was open on it)
    // brings its code in the same way.
    const [checked, setChecked] = useState(false);
    useEffect(() => {
        if (!location.hash) return;
        const linked = inviteCodeFromHash(location.hash);
        navigate(location.pathname, { replace: true });
        if (!linked || linked === fromLink) return;
        setFromLink(linked);
        setCode(linked);
        setExpiresAt(null);
        setState('checking');
        setChecked(false);
    }, [location.hash]);
    useEffect(() => {
        if (loading || checked) return;
        setChecked(true);
        if (fromLink && !user) check(fromLink);
    }, [loading, user, checked]);

    if (loading) return null;
    if (user) return <Navigate to="/home" replace />;
    // Sign-up is open and there's no invite to use: the usual way in.
    if (inviteOnly === false && !fromLink && !kept) return <Navigate to="/signup" replace />;

    const onChange = (e) => {
        setCode(formatAsTyped(e.target.value));
        setState('idle');
        setError('');
    };

    const paste = async () => {
        try {
            const text = await navigator.clipboard.readText();
            const formatted = formatInviteCode(text) || formatAsTyped(text);
            if (formatted) {
                setCode(formatted);
                setState('idle');
                setError('');
            }
        } catch { /* not allowed: they can still type or long-press */ }
    };

    const onContinue = async (e) => {
        e.preventDefault();
        const ready = state === 'valid' && formatInviteCode(code) === rememberedInvite(inviteStorage())?.code;
        if (ready || await check(code)) navigate('/signup');
    };

    const copyCode = async () => {
        if (await copyText(formatInviteCode(code) || code)) {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    };

    const invited = !!fromLink;
    const busy = state === 'checking';

    return (
        <div className="invite-page">
            <div className="invite-card">
                <img src={logoIcon} alt="BIES" className="invite-logo" />
                <h1 className="invite-title">{invited ? t('invite.invitedTitle') : t('invite.joinTitle')}</h1>
                <p className="invite-subtext">
                    {invited && state === 'valid' && until
                        ? t('invite.invitedBody', { date: until })
                        : inviteOnly === false ? t('invite.openBody') : t('invite.joinBody')}
                </p>

                {/* On the web, from a link: the app first, or carry on here. */}
                {!native && invited && (
                    <div className="invite-stores">
                        <p className="invite-step"><span>1</span>{t('invite.getApp')}</p>
                        {APP_STORE_URL || PLAY_STORE_URL ? (
                            <div className="invite-store-buttons">
                                {APP_STORE_URL && <a href={APP_STORE_URL} className="invite-store" rel="noopener noreferrer">App Store</a>}
                                {PLAY_STORE_URL && <a href={PLAY_STORE_URL} className="invite-store" rel="noopener noreferrer">Google Play</a>}
                            </div>
                        ) : (
                            <p className="invite-hint">{t('invite.searchStores')}</p>
                        )}
                        <p className="invite-step"><span>2</span>{t('invite.thenEnter')}</p>
                        <button type="button" className="invite-secondary" onClick={copyCode} disabled={!normalizeInviteCode(code)}>
                            <Copy size={16} /> {copied ? t('invite.copied') : t('invite.copyCode')}
                        </button>
                        <p className="invite-hint invite-or-web">{t('invite.orHere')}</p>
                    </div>
                )}

                <form onSubmit={onContinue} className="invite-form">
                    <label htmlFor="invite-code" className="invite-label">{t('invite.codeLabel')}</label>
                    <div className={`invite-field invite-field-${state}`}>
                        <input
                            id="invite-code"
                            value={code}
                            onChange={onChange}
                            placeholder="BIES-XXXX-XXXX"
                            autoComplete="off"
                            autoCapitalize="characters"
                            autoCorrect="off"
                            spellCheck={false}
                            maxLength={20}
                            aria-invalid={state === 'invalid'}
                        />
                        {state === 'valid' ? (
                            <CheckCircle2 size={20} className="invite-ok" aria-label={t('invite.valid')} />
                        ) : canPaste ? (
                            <button type="button" className="invite-paste" onClick={paste}>{t('invite.paste')}</button>
                        ) : null}
                    </div>
                    <p className="invite-hint">{t('invite.caseHint')}</p>
                    {error && (
                        <div className="invite-error" role="alert">
                            <AlertCircle size={16} />
                            <span>{error}</span>
                        </div>
                    )}
                    <button type="submit" className="invite-primary" disabled={busy || !normalizeInviteCode(code)}>
                        {busy ? <Loader2 size={18} className="invite-spin" /> : null}
                        <span>{t('invite.continue')}</span>
                    </button>
                </form>

                <button type="button" className="invite-link" onClick={() => setHelp((v) => !v)} aria-expanded={help}>
                    {t('invite.noCode')}
                </button>
                {help && (
                    <div className="invite-help">
                        <p className="invite-help-title">{t('invite.noCodeTitle')}</p>
                        <p>{t('invite.noCodeBody')}</p>
                        <button type="button" className="invite-secondary" onClick={() => openExternal(WEBSITE)}>
                            <ExternalLink size={16} /> {t('invite.visitWebsite')}
                        </button>
                    </div>
                )}

                <div className="invite-divider"><span>{t('invite.alreadyMember')}</span></div>
                <Link to="/login" className="invite-secondary invite-signin">{t('invite.signIn')}</Link>
            </div>

            <style jsx>{`
                .invite-page {
                    min-height: calc(100vh - 150px);
                    min-height: calc(100dvh - 150px);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background: var(--color-gray-50);
                    padding: clamp(1rem, 3vh, 2rem) clamp(0.5rem, 2vh, 1rem);
                }
                .invite-card {
                    background: var(--color-surface);
                    color: var(--color-text, inherit);
                    padding: clamp(1.25rem, 3vh, 2rem);
                    border-radius: 1.5rem;
                    box-shadow: 0 4px 24px rgba(0,0,0,0.08);
                    border: 1px solid var(--color-gray-200);
                    width: 100%;
                    max-width: 440px;
                    display: flex;
                    flex-direction: column;
                    align-items: stretch;
                }
                .invite-logo { height: 64px; width: auto; margin: 0 auto 1rem; }
                .invite-title { font-size: 1.5rem; font-weight: 700; text-align: center; margin: 0 0 0.4rem; }
                .invite-subtext { font-size: 0.9rem; color: var(--color-gray-500); text-align: center; margin: 0 0 1.5rem; line-height: 1.45; }
                .invite-form { display: flex; flex-direction: column; gap: 0.6rem; }
                .invite-label { font-size: 0.875rem; font-weight: 600; }
                .invite-field {
                    display: flex; align-items: center; gap: 0.5rem;
                    padding: 0.35rem 0.5rem 0.35rem 1.1rem;
                    border: 1px solid var(--color-gray-200); border-radius: 9999px;
                    background: var(--color-surface);
                }
                .invite-field:focus-within { border-color: var(--color-primary); box-shadow: 0 0 0 3px var(--color-blue-tint); }
                .invite-field-valid { border-color: var(--color-success); }
                .invite-field-invalid { border-color: var(--color-error); }
                .invite-field input {
                    flex: 1; min-width: 0; border: none; outline: none; background: transparent; color: inherit;
                    font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-weight: 700; font-size: 1.05rem;
                    letter-spacing: 0.06em; padding: 0.55rem 0;
                }
                .invite-field input::placeholder { color: var(--color-gray-400); font-weight: 500; }
                .invite-paste {
                    border: none; background: var(--color-blue-tint); color: var(--color-primary);
                    font-weight: 600; font-size: 0.8rem; padding: 0.45rem 0.8rem; border-radius: 9999px; cursor: pointer;
                }
                .invite-field :global(.invite-ok) { color: var(--color-success-text); margin-right: 0.5rem; flex-shrink: 0; }
                .invite-hint { font-size: 0.75rem; color: var(--color-gray-500); margin: 0; }
                .invite-error {
                    display: flex; gap: 0.5rem; align-items: flex-start;
                    background: var(--color-red-tint); color: var(--badge-error-text, #b91c1c);
                    border-radius: 0.75rem; padding: 0.65rem 0.8rem; font-size: 0.85rem; line-height: 1.4;
                }
                .invite-error :global(svg) { flex-shrink: 0; margin-top: 2px; }
                .invite-primary {
                    display: flex; align-items: center; justify-content: center; gap: 0.5rem;
                    background: var(--color-primary); color: white; border: none; cursor: pointer;
                    font-size: 1rem; font-weight: 600; border-radius: 9999px; padding: 0.85rem 1.5rem; margin-top: 0.4rem;
                }
                .invite-primary:disabled { opacity: 0.5; cursor: not-allowed; }
                .invite-primary :global(.invite-spin) { animation: spin 1s linear infinite; }
                .invite-secondary, .invite-card :global(.invite-secondary) {
                    display: flex; align-items: center; justify-content: center; gap: 0.5rem;
                    background: transparent; color: var(--color-primary); text-decoration: none;
                    border: 1px solid var(--color-gray-200); cursor: pointer;
                    font-size: 0.95rem; font-weight: 600; border-radius: 9999px; padding: 0.75rem 1.25rem;
                }
                .invite-secondary:disabled { opacity: 0.5; cursor: not-allowed; }
                .invite-link {
                    background: none; border: none; color: var(--color-primary); font-weight: 600;
                    font-size: 0.875rem; cursor: pointer; margin: 1rem auto 0; padding: 0.25rem;
                }
                .invite-help {
                    background: var(--color-gray-50); border: 1px solid var(--color-gray-200); border-radius: 1rem;
                    padding: 0.9rem 1rem; margin-top: 0.6rem; font-size: 0.85rem; line-height: 1.45;
                    display: flex; flex-direction: column; gap: 0.6rem;
                }
                .invite-help p { margin: 0; color: var(--color-gray-600); }
                .invite-help .invite-help-title { font-weight: 700; color: inherit; }
                .invite-divider {
                    display: flex; align-items: center; gap: 0.75rem; margin: 1.25rem 0 0.75rem;
                    color: var(--color-gray-500); font-size: 0.8rem;
                }
                .invite-divider::before, .invite-divider::after { content: ''; flex: 1; height: 1px; background: var(--color-gray-200); }
                .invite-stores {
                    display: flex; flex-direction: column; gap: 0.6rem; margin-bottom: 1.25rem;
                    padding-bottom: 1.25rem; border-bottom: 1px solid var(--color-gray-200);
                }
                .invite-step { display: flex; align-items: center; gap: 0.6rem; font-size: 0.9rem; font-weight: 600; margin: 0; }
                .invite-step span {
                    width: 22px; height: 22px; border-radius: 50%; background: var(--color-secondary); color: white;
                    font-size: 0.75rem; display: grid; place-items: center; flex-shrink: 0;
                }
                .invite-store-buttons { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; }
                .invite-store {
                    background: #111; color: #fff; text-decoration: none; text-align: center;
                    border-radius: 0.6rem; padding: 0.65rem; font-weight: 600; font-size: 0.9rem;
                }
                .invite-or-web { text-align: center; margin-top: 0.25rem; }
            `}</style>
        </div>
    );
};

export default Invite;
