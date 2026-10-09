import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Mail, Loader2, AlertCircle } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { openExternal } from '../utils/openExternal';

const CODE_LENGTH = 6;
const LEGAL_PAGES = {
    en: { terms: 'https://buildinelsalvador.com/terms', privacy: 'https://buildinelsalvador.com/privacy' },
    es: { terms: 'https://buildinelsalvador.com/terminos', privacy: 'https://buildinelsalvador.com/privacidad' },
};

/**
 * Email sign-in: a 6-digit code by email, then a session. The first sign-in
 * creates the account, with a Nostr key BIES holds for the member. Used by
 * both Login and Signup.
 *
 * @param {(result: { user, isNewUser, needsProfileSetup }) => void} onSuccess
 */
const EmailSignIn = ({ onSuccess }) => {
    const { t, i18n } = useTranslation();
    const { requestEmailCode, loginWithEmailCode } = useAuth();
    const [step, setStep] = useState('email'); // 'email' | 'code'
    const [email, setEmail] = useState('');
    const [code, setCode] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [resendIn, setResendIn] = useState(0);

    const lang = i18n.language?.startsWith('es') ? 'es' : 'en';

    useEffect(() => {
        if (resendIn <= 0) return undefined;
        const timer = setTimeout(() => setResendIn((s) => s - 1), 1000);
        return () => clearTimeout(timer);
    }, [resendIn]);

    const explain = (result) => {
        switch (result.reason) {
            case 'rate_limited':
                return t('emailSignIn.errors.rateLimited', { count: Math.max(1, Math.ceil((result.retryAfterSeconds || 60) / 60)) });
            case 'busy':
                return t('emailSignIn.errors.busy');
            case 'send_failed':
                return t('emailSignIn.errors.sendFailed');
            case 'invalid_code':
                return result.attemptsLeft > 0
                    ? t('emailSignIn.errors.wrongCode', { count: result.attemptsLeft })
                    : t('emailSignIn.errors.codeUsedUp');
            case 'code_expired':
                return t('emailSignIn.errors.codeExpired');
            case 'suspended':
                return t('emailSignIn.errors.suspended');
            case 'deleted':
                return t('emailSignIn.errors.deleted');
            default:
                return result.error || t('emailSignIn.errors.generic');
        }
    };

    const sendCode = async (e) => {
        e?.preventDefault();
        const address = email.trim();
        if (!address || busy) return;
        setBusy(true);
        setError('');
        const result = await requestEmailCode(address, lang);
        setBusy(false);
        if (result.success) {
            setStep('code');
            setCode('');
            setResendIn(result.resendAfterSeconds || 60);
        } else {
            setError(explain(result));
            if (result.reason === 'rate_limited' && result.retryAfterSeconds) setResendIn(result.retryAfterSeconds);
        }
    };

    const verify = async (value = code) => {
        if (value.length !== CODE_LENGTH || busy) return;
        setBusy(true);
        setError('');
        const result = await loginWithEmailCode(email.trim(), value);
        setBusy(false);
        if (result.success) {
            onSuccess(result);
        } else {
            setError(explain(result));
            setCode('');
        }
    };

    const onCodeChange = (e) => {
        const digits = e.target.value.replace(/\D/g, '').slice(0, CODE_LENGTH);
        setCode(digits);
        // Typed or pasted the whole code: sign in without another tap.
        if (digits.length === CODE_LENGTH) verify(digits);
    };

    const openLegal = (e, page) => {
        e.preventDefault();
        openExternal(LEGAL_PAGES[lang][page]);
    };

    return (
        <div className="email-signin">
            {error && (
                <div className="email-signin-error" role="alert">
                    <AlertCircle size={16} />
                    <span>{error}</span>
                </div>
            )}

            {step === 'email' ? (
                <form onSubmit={sendCode} className="email-signin-form">
                    <label htmlFor="email-signin-address" className="email-signin-label">
                        {t('emailSignIn.emailLabel')}
                    </label>
                    <div className="email-signin-field">
                        <Mail size={16} aria-hidden="true" />
                        <input
                            id="email-signin-address"
                            type="email"
                            inputMode="email"
                            autoComplete="email"
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            placeholder={t('emailSignIn.emailPlaceholder')}
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            required
                        />
                    </div>
                    <button type="submit" className="email-signin-button" disabled={busy || !email.trim()}>
                        {busy ? <Loader2 size={18} className="email-signin-spin" /> : null}
                        <span>{busy ? t('emailSignIn.sending') : t('emailSignIn.sendCode')}</span>
                    </button>
                    <p className="email-signin-hint">{t('emailSignIn.newHere')}</p>
                    <p className="email-signin-legal">
                        {t('emailSignIn.consentBefore')}
                        <a href={LEGAL_PAGES[lang].terms} onClick={(e) => openLegal(e, 'terms')}>{t('emailSignIn.terms')}</a>
                        {t('emailSignIn.consentMiddle')}
                        <a href={LEGAL_PAGES[lang].privacy} onClick={(e) => openLegal(e, 'privacy')}>{t('emailSignIn.privacy')}</a>
                        {t('emailSignIn.consentAfter')}
                    </p>
                </form>
            ) : (
                <form onSubmit={(e) => { e.preventDefault(); verify(); }} className="email-signin-form">
                    <p className="email-signin-sent">{t('emailSignIn.codeSent', { email: email.trim() })}</p>
                    <label htmlFor="email-signin-code" className="email-signin-label">
                        {t('emailSignIn.codeLabel')}
                    </label>
                    <input
                        id="email-signin-code"
                        className="email-signin-code"
                        type="text"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        pattern="[0-9]*"
                        maxLength={CODE_LENGTH}
                        placeholder="000000"
                        value={code}
                        onChange={onCodeChange}
                        autoFocus
                    />
                    <button type="submit" className="email-signin-button" disabled={busy || code.length !== CODE_LENGTH}>
                        {busy ? <Loader2 size={18} className="email-signin-spin" /> : null}
                        <span>{busy ? t('emailSignIn.signingIn') : t('emailSignIn.signIn')}</span>
                    </button>
                    <div className="email-signin-actions">
                        <button type="button" onClick={sendCode} disabled={busy || resendIn > 0}>
                            {resendIn > 0 ? t('emailSignIn.resendIn', { count: resendIn }) : t('emailSignIn.resend')}
                        </button>
                        <button type="button" onClick={() => { setStep('email'); setError(''); setCode(''); }} disabled={busy}>
                            {t('emailSignIn.changeEmail')}
                        </button>
                    </div>
                    <p className="email-signin-hint">{t('emailSignIn.checkSpam')}</p>
                </form>
            )}

            <style>{`
                .email-signin { width: 100%; display: flex; flex-direction: column; gap: 0.75rem; }
                .email-signin-form { display: flex; flex-direction: column; gap: 0.75rem; width: 100%; }
                .email-signin-label { font-size: 0.875rem; font-weight: 600; color: var(--color-text, inherit); }
                .email-signin-field {
                    display: flex; align-items: center; gap: 0.5rem; box-sizing: border-box; width: 100%;
                    padding: 0.85rem 1.25rem; border: 1px solid var(--color-gray-200); border-radius: 9999px;
                    background: var(--color-surface); color: var(--color-gray-500);
                }
                .email-signin-field:focus-within { border-color: var(--color-primary); }
                .email-signin-field input {
                    flex: 1; min-width: 0; border: none; outline: none; background: transparent;
                    font-size: 1rem; color: var(--color-text, inherit);
                }
                .email-signin-code {
                    width: 100%; box-sizing: border-box; text-align: center; font-size: 1.75rem;
                    letter-spacing: 0.5em; padding: 0.75rem 0 0.75rem 0.5em; font-variant-numeric: tabular-nums;
                    border: 1px solid var(--color-gray-200); border-radius: 1rem; outline: none;
                    background: var(--color-surface); color: var(--color-text, inherit);
                }
                .email-signin-code:focus { border-color: var(--color-primary); }
                .email-signin-button {
                    display: flex; align-items: center; justify-content: center; gap: 0.5rem; width: 100%;
                    padding: 0.85rem 1.5rem; border: none; border-radius: 9999px; cursor: pointer;
                    background: var(--color-primary); color: #fff; font-size: 1rem; font-weight: 600;
                }
                .email-signin-button:disabled { opacity: 0.5; cursor: not-allowed; }
                .email-signin-actions {
                    display: flex; flex-direction: column; align-items: center; gap: 0.5rem;
                    font-size: 0.875rem; color: var(--color-gray-500);
                }
                .email-signin-actions button {
                    background: none; border: none; padding: 0; cursor: pointer;
                    color: var(--color-primary); font-size: inherit; font-weight: 500;
                }
                .email-signin-actions button:disabled { color: var(--color-gray-500); cursor: default; }
                .email-signin-sent { font-size: 0.9rem; color: var(--color-text, inherit); text-align: center; margin: 0; }
                .email-signin-hint, .email-signin-legal {
                    font-size: 0.75rem; line-height: 1.5; color: var(--color-gray-500); text-align: center; margin: 0;
                }
                .email-signin-legal a { color: var(--color-primary); }
                .email-signin-error {
                    display: flex; align-items: center; gap: 8px; width: 100%; box-sizing: border-box;
                    padding: 0.75rem 1rem; border-radius: 0.75rem; font-size: 0.875rem;
                    background: var(--color-red-tint); color: var(--color-error); border: 1px solid var(--badge-error-bg);
                }
                .email-signin-spin { animation: email-signin-spin 1s linear infinite; }
                @keyframes email-signin-spin { to { transform: rotate(360deg); } }
            `}</style>
        </div>
    );
};

export default EmailSignIn;
