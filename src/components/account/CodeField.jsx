import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

const CODE_LENGTH = 6;

/** Seconds left before another code may be sent; `start(n)` restarts it. */
export function useCountdown() {
    const [left, setLeft] = useState(0);
    useEffect(() => {
        if (left <= 0) return undefined;
        const timer = setTimeout(() => setLeft((s) => s - 1), 1000);
        return () => clearTimeout(timer);
    }, [left]);
    return [left, setLeft];
}

/**
 * The 6-digit code we emailed, for confirming account deletion or taking the
 * key. The parent owns the submit button: these steps never submit on their
 * own, since they can't be undone.
 */
const CodeField = ({ id, email, value, onChange, onResend, resendIn, busy }) => {
    const { t } = useTranslation();
    return (
        <div className="acct-code">
            <p className="acct-muted">{t('account.code.sent', { email })}</p>
            <label htmlFor={id} className="acct-label">{t('account.code.label')}</label>
            <input
                id={id}
                className="acct-code-input"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={CODE_LENGTH}
                placeholder="000000"
                value={value}
                onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, CODE_LENGTH))}
                autoFocus
            />
            <button type="button" className="acct-link" onClick={onResend} disabled={busy || resendIn > 0}>
                {resendIn > 0 ? t('account.code.resendIn', { count: resendIn }) : t('account.code.resend')}
            </button>
            <p className="acct-hint">{t('account.code.checkSpam')}</p>
        </div>
    );
};

export const isCompleteCode = (value) => value.length === CODE_LENGTH;

export default CodeField;
