import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertCircle, AlertTriangle, ArrowLeft, CheckCircle, Loader2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { accountApi } from '../../services/api';
import { nostrSigner } from '../../services/nostrSigner';
import { endSession } from '../../services/session';
import { confirmationTemplate } from '../../services/accountKey';
import CodeField, { isCompleteCode, useCountdown } from '../../components/account/CodeField';
import { accountErrorMessage } from '../../components/account/accountErrors';
import './AccountFlows.css';

/**
 * Settings → Delete account. Explains what goes, confirms it is the owner
 * (an emailed code for email accounts, a signature for Nostr accounts), then
 * deletes the account for good (server/src/services/account.service.ts).
 *
 * Not behind ProtectedRoute: the session ends while the deletion runs, and
 * the page must stay to show the result.
 */
const DeleteAccount = () => {
    const { t, i18n } = useTranslation();
    const { user, loading } = useAuth();
    const location = useLocation();
    const navigate = useNavigate();
    const lang = i18n.language?.startsWith('es') ? 'es' : 'en';

    const [step, setStep] = useState('intro'); // intro | confirm | deleting | done
    const [understood, setUnderstood] = useState(false);
    const [method, setMethod] = useState(null); // 'email' | 'nostr'
    const [email, setEmail] = useState('');
    const [challenge, setChallenge] = useState('');
    const [code, setCode] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [resendIn, setResendIn] = useCountdown();
    const [emailedTo, setEmailedTo] = useState(null);

    if (loading) return <div className="p-10 text-center">{t('common.loading')}</div>;
    if (!user && step !== 'deleting' && step !== 'done') {
        return <Navigate to="/login" state={{ from: location }} replace />;
    }

    const hosted = !!user?.hostedKey;

    const fail = (err) => {
        setError(accountErrorMessage(t, err));
        if (err?.data?.reason === 'rate_limited' && err.data.retryAfterSeconds) setResendIn(err.data.retryAfterSeconds);
    };

    // Ask for a code (email accounts) or a challenge (Nostr accounts).
    const start = async () => {
        setBusy(true);
        setError('');
        try {
            const res = await accountApi.startDeletion(lang);
            setMethod(res.method);
            if (res.method === 'email') {
                setEmail(res.email);
                setCode('');
                setResendIn(res.resendAfterSeconds || 60);
            } else {
                setChallenge(res.challenge);
            }
            setStep('confirm');
        } catch (err) {
            fail(err);
        } finally {
            setBusy(false);
        }
    };

    const confirm = async () => {
        if (busy) return;
        setBusy(true);
        setError('');
        let proof;
        if (method === 'email') {
            proof = { code };
        } else {
            try {
                proof = {
                    signedEvent: await nostrSigner.signEvent(
                        confirmationTemplate('delete_account', challenge, t('account.delete.signContent')),
                    ),
                };
            } catch {
                setError(t('account.errors.signerFailed'));
                setBusy(false);
                return;
            }
        }

        const accountEmail = user?.email || null;
        setStep('deleting');
        try {
            await accountApi.confirmDeletion(proof, lang);
            setEmailedTo(accountEmail);
            setStep('done');
            // Signed out here too: forget the session and this device's secrets.
            endSession({ force: true });
        } catch (err) {
            setStep('confirm');
            setCode('');
            if (err?.data?.reason === 'challenge_expired') setStep('intro');
            fail(err);
        } finally {
            setBusy(false);
        }
    };

    const errorBox = error && (
        <div className="acct-error" role="alert">
            <AlertCircle size={16} />
            <span>{error}</span>
        </div>
    );

    if (step === 'done') {
        return (
            <div className="acct-page">
                <div className="acct-card acct-done">
                    <CheckCircle size={40} />
                    <h1 className="acct-title">{t('account.delete.doneTitle')}</h1>
                    {emailedTo && <p className="acct-muted">{t('account.delete.doneEmailed', { email: emailedTo })}</p>}
                    <p className="acct-muted">{t('account.delete.doneBody')}</p>
                    <button type="button" className="acct-button secondary" onClick={() => navigate('/login', { replace: true })}>
                        {t('account.delete.doneButton')}
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="acct-page">
            <Link to="/settings" className="acct-back"><ArrowLeft size={16} /> {t('nav.settings')}</Link>
            <h1 className="acct-title">{t('account.delete.title')}</h1>

            {step === 'intro' && (
                <div className="acct-card">
                    <p className="acct-muted">{t('account.delete.intro')}</p>
                    <h2>{t('account.delete.whatGoes')}</h2>
                    <ul className="acct-list">
                        <li>{t('account.delete.goesProfile')}</li>
                        <li>{t('account.delete.goesMessages')}</li>
                        <li>{t('account.delete.goesSessions')}</li>
                        {hosted && <li>{t('account.delete.goesKeyHosted')}</li>}
                    </ul>
                    {!hosted && <p className="acct-muted">{t('account.delete.keepIdentityNostr')}</p>}
                    <p className="acct-hint">{t('account.delete.backups')}</p>
                    {hosted && (
                        <div className="acct-warning">
                            <AlertTriangle size={16} />
                            <span>
                                {t('account.delete.takeKeyFirst')}{' '}
                                <Link to="/settings/your-key" className="acct-link">{t('account.delete.takeKeyFirstLink')}</Link>
                            </span>
                        </div>
                    )}
                    <label className="acct-check">
                        <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
                        <span>{t('account.delete.understand')}</span>
                    </label>
                    {errorBox}
                    <button type="button" className="acct-button danger" disabled={!understood || busy} onClick={start}>
                        {busy && <Loader2 size={18} className="acct-spin" />}
                        {busy && hosted ? t('account.code.sending') : t('account.delete.continue')}
                    </button>
                    <Link to="/settings" className="acct-link">{t('account.delete.cancel')}</Link>
                </div>
            )}

            {(step === 'confirm' || step === 'deleting') && (
                <div className="acct-card">
                    {method === 'email' ? (
                        <>
                            <p className="acct-muted">{t('account.delete.emailStep')}</p>
                            <CodeField
                                id="delete-account-code"
                                email={email}
                                value={code}
                                onChange={setCode}
                                onResend={start}
                                resendIn={resendIn}
                                busy={busy}
                            />
                        </>
                    ) : (
                        <p className="acct-muted">{t('account.delete.nostrStep')}</p>
                    )}
                    {errorBox}
                    <button
                        type="button"
                        className="acct-button danger"
                        disabled={busy || (method === 'email' && !isCompleteCode(code))}
                        onClick={confirm}
                    >
                        {busy && <Loader2 size={18} className="acct-spin" />}
                        {step === 'deleting'
                            ? t('account.delete.deleting')
                            : method === 'email' ? t('account.delete.confirmButton') : t('account.delete.signButton')}
                    </button>
                    <Link to="/settings" className="acct-link">{t('account.delete.cancel')}</Link>
                </div>
            )}
        </div>
    );
};

export default DeleteAccount;
