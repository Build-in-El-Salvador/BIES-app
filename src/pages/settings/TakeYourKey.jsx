import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { nip19 } from 'nostr-tools';
import { QRCodeSVG } from 'qrcode.react';
import { AlertCircle, AlertTriangle, ArrowLeft, CheckCircle, Copy, Download, Eye, EyeOff, Loader2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { accountApi } from '../../services/api';
import { nostrSigner } from '../../services/nostrSigner';
import { keyfileService } from '../../services/keyfileService';
import {
    buildBackup,
    confirmationTemplate,
    hexToBytes,
    keyMatches,
    readKeyInput,
    signConfirmation,
    unlockBackup,
} from '../../services/accountKey';
import { isNativePlatform } from '../../utils/platform';
import CodeField, { isCompleteCode, useCountdown } from '../../components/account/CodeField';
import { accountErrorMessage } from '../../components/account/accountErrors';
import './AccountFlows.css';

const MIN_PASSWORD = 8;

/**
 * Settings → Take your key, for email accounts. BIES shows the key once,
 * after an emailed code. The member saves it, proves it by bringing it back
 * (pasted, or from the backup file, or through a browser extension that now
 * holds it), and BIES deletes its copy. This device then signs with the
 * member's own key; the account's other sessions end
 * (server/src/services/account.service.ts).
 */
const TakeYourKey = () => {
    const { t, i18n } = useTranslation();
    const { user, refreshUser } = useAuth();
    const navigate = useNavigate();
    const lang = i18n.language?.startsWith('es') ? 'es' : 'en';
    const native = isNativePlatform();

    const [step, setStep] = useState('intro'); // intro | code | key | verify | finishing | done
    const [email, setEmail] = useState('');
    const [code, setCode] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [resendIn, setResendIn] = useCountdown();

    // The key, while this page is open. Wiped when it closes.
    const secretRef = useRef(null);
    const [nsec, setNsec] = useState('');
    const [challenge, setChallenge] = useState('');
    const [revealed, setRevealed] = useState(false);
    const [showQr, setShowQr] = useState(false);
    const [copied, setCopied] = useState('');
    const [password, setPassword] = useState('');
    const [password2, setPassword2] = useState('');
    const [backupNote, setBackupNote] = useState('');

    const [proofText, setProofText] = useState('');
    const [proofPassword, setProofPassword] = useState('');

    useEffect(() => () => {
        secretRef.current?.fill(0);
        secretRef.current = null;
    }, []);

    const fail = (err) => {
        setError(accountErrorMessage(t, err));
        if (err?.data?.reason === 'rate_limited' && err.data.retryAfterSeconds) setResendIn(err.data.retryAfterSeconds);
        if (err?.data?.reason === 'challenge_expired') setStep('intro');
    };

    const copy = async (text, label) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(label);
            setTimeout(() => setCopied(''), 2000);
        } catch { /* clipboard unavailable */ }
    };

    // ─── Steps ───────────────────────────────────────────────────────────────

    const sendCode = async () => {
        setBusy(true);
        setError('');
        try {
            const res = await accountApi.startKeyExport(lang);
            setEmail(res.email);
            setCode('');
            setResendIn(res.resendAfterSeconds || 60);
            setStep('code');
        } catch (err) {
            fail(err);
        } finally {
            setBusy(false);
        }
    };

    const showKey = async () => {
        if (busy) return;
        setBusy(true);
        setError('');
        try {
            const res = await accountApi.exportKey(code);
            const secretKey = hexToBytes(res.secretKey);
            if (!keyMatches(secretKey, user.nostrPubkey)) throw new Error('key mismatch');
            secretRef.current = secretKey;
            setNsec(nip19.nsecEncode(secretKey));
            setChallenge(res.challenge);
            setStep('key');
        } catch (err) {
            setCode('');
            fail(err);
        } finally {
            setBusy(false);
        }
    };

    const backupProblem = password.length < MIN_PASSWORD
        ? t('account.key.passwordShort')
        : password !== password2 ? t('account.key.passwordMismatch') : '';

    const saveBackup = async () => {
        if (backupProblem || !secretRef.current) return;
        const { json, filename } = buildBackup(secretRef.current, password);
        if (native) {
            // No downloads in the app: copy the encrypted key, for a password manager.
            await copy(JSON.parse(json).ncryptsec, 'backup');
            setBackupNote(t('account.key.copied'));
        } else {
            keyfileService.triggerDownload(json, filename);
            setBackupNote(t('account.key.backupSaved', { filename }));
        }
    };

    const openFile = async (e) => {
        const file = e.target.files?.[0];
        if (file) setProofText((await file.text()).trim());
        e.target.value = '';
    };

    const proof = readKeyInput(proofText);

    // Prove the key was saved: sign the challenge with the key brought back.
    const confirmSaved = async () => {
        setError('');
        let secretKey;
        try {
            if (!proof) throw new Error('not_a_key');
            secretKey = proof.encrypted ? unlockBackup(proof.encrypted, proofPassword) : proof.secretKey;
        } catch (err) {
            setError(err.message === 'not_a_key' ? t('account.key.notAKey') : t('account.key.wrongPassword'));
            return;
        }
        if (!keyMatches(secretKey, user.nostrPubkey)) {
            setError(t('account.key.wrongKey'));
            return;
        }
        const signed = signConfirmation(secretKey, 'take_key', challenge, t('account.key.signContent'));
        await finish(signed, () => nostrSigner.setNsec(new Uint8Array(secretKey)));
        secretKey.fill(0);
    };

    // Or through a browser extension the member imported the key into.
    const confirmWithExtension = async () => {
        setError('');
        let signed;
        try {
            if ((await window.nostr.getPublicKey()) !== user.nostrPubkey) {
                setError(t('account.key.wrongKey'));
                return;
            }
            signed = await window.nostr.signEvent(confirmationTemplate('take_key', challenge, t('account.key.signContent')));
        } catch {
            setError(t('account.errors.signerFailed'));
            return;
        }
        await finish(signed, () => nostrSigner.setExtensionMode());
    };

    const finish = async (signedEvent, switchSigner) => {
        setBusy(true);
        setStep('finishing');
        try {
            await accountApi.releaseKey(signedEvent, lang);
            // From now on this device signs with the member's key.
            switchSigner();
            secretRef.current?.fill(0);
            secretRef.current = null;
            setNsec('');
            setStep('done');
            // The account no longer has a hosted key; Settings should know.
            refreshUser().catch(() => {});
        } catch (err) {
            setStep('verify');
            fail(err);
        } finally {
            setBusy(false);
        }
    };

    // ─── Render ──────────────────────────────────────────────────────────────

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
                    <h1 className="acct-title">{t('account.key.doneTitle')}</h1>
                    <p className="acct-muted">{t('account.key.doneBody')}</p>
                    <p className="acct-muted">{t('account.key.doneHow')}</p>
                    <button type="button" className="acct-button secondary" onClick={() => navigate('/settings')}>
                        {t('account.key.doneButton')}
                    </button>
                </div>
            </div>
        );
    }

    if (!user?.hostedKey) {
        return (
            <div className="acct-page">
                <Link to="/settings" className="acct-back"><ArrowLeft size={16} /> {t('nav.settings')}</Link>
                <h1 className="acct-title">{t('account.key.title')}</h1>
                <div className="acct-card"><p className="acct-muted">{t('account.key.notHosted')}</p></div>
            </div>
        );
    }

    return (
        <div className="acct-page">
            <Link to="/settings" className="acct-back"><ArrowLeft size={16} /> {t('nav.settings')}</Link>
            <h1 className="acct-title">{t('account.key.title')}</h1>

            {step === 'intro' && (
                <div className="acct-card">
                    <p className="acct-muted">{t('account.key.intro')}</p>
                    <h2>{t('account.key.whatChanges')}</h2>
                    <ul className="acct-list">
                        <li>{t('account.key.same')}</li>
                        <li>{t('account.key.signIn')}</li>
                        <li>{t('account.key.deleted')}</li>
                    </ul>
                    <div className="acct-warning">
                        <AlertTriangle size={16} />
                        <span>{t('account.key.noRecovery')}</span>
                    </div>
                    <p className="acct-hint">{t('account.key.backups')}</p>
                    {errorBox}
                    <button type="button" className="acct-button" disabled={busy} onClick={sendCode}>
                        {busy && <Loader2 size={18} className="acct-spin" />}
                        {busy ? t('account.code.sending') : t('account.key.start')}
                    </button>
                </div>
            )}

            {step === 'code' && (
                <div className="acct-card">
                    <p className="acct-muted">{t('account.key.codeStep')}</p>
                    <CodeField
                        id="take-key-code"
                        email={email}
                        value={code}
                        onChange={setCode}
                        onResend={sendCode}
                        resendIn={resendIn}
                        busy={busy}
                    />
                    {errorBox}
                    <button type="button" className="acct-button" disabled={busy || !isCompleteCode(code)} onClick={showKey}>
                        {busy && <Loader2 size={18} className="acct-spin" />}
                        {t('account.key.showKey')}
                    </button>
                </div>
            )}

            {step === 'key' && (
                <>
                    <div className="acct-card">
                        <h2>{t('account.key.keyTitle')}</h2>
                        <div className="acct-warning">
                            <AlertTriangle size={16} />
                            <span>{t('account.key.keyWarning')}</span>
                        </div>
                        <div className="acct-key">
                            <code>{revealed ? nsec : 'nsec1' + '•'.repeat(32)}</code>
                            <div className="acct-key-actions">
                                <button type="button" onClick={() => setRevealed((r) => !r)}>
                                    {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
                                    {revealed ? t('account.key.hide') : t('account.key.reveal')}
                                </button>
                                <button type="button" onClick={() => copy(nsec, 'nsec')}>
                                    {copied === 'nsec' ? <CheckCircle size={14} /> : <Copy size={14} />}
                                    {copied === 'nsec' ? t('account.key.copied') : t('account.key.copy')}
                                </button>
                            </div>
                        </div>
                        <button type="button" className="acct-link" onClick={() => setShowQr((s) => !s)}>
                            {showQr ? t('account.key.hideQr') : t('account.key.showQr')}
                        </button>
                        {showQr && <div className="acct-qr"><QRCodeSVG value={nsec} size={200} /></div>}
                    </div>

                    <div className="acct-card">
                        <h2>{t('account.key.backupTitle')}</h2>
                        <p className="acct-muted">{t('account.key.backupDesc')}</p>
                        <input
                            className="acct-input"
                            type="password"
                            autoComplete="new-password"
                            placeholder={t('account.key.password')}
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                        />
                        <input
                            className="acct-input"
                            type="password"
                            autoComplete="new-password"
                            placeholder={t('account.key.passwordRepeat')}
                            value={password2}
                            onChange={(e) => setPassword2(e.target.value)}
                        />
                        {password && backupProblem && <p className="acct-hint">{backupProblem}</p>}
                        <button type="button" className="acct-button secondary" disabled={!!backupProblem} onClick={saveBackup}>
                            {native ? <Copy size={16} /> : <Download size={16} />}
                            {native ? t('account.key.copyBackup') : t('account.key.downloadBackup')}
                        </button>
                        {backupNote && <p className="acct-hint">{backupNote}</p>}
                    </div>

                    <div className="acct-card">
                        <button type="button" className="acct-button" onClick={() => { setError(''); setStep('verify'); }}>
                            {t('account.key.savedButton')}
                        </button>
                    </div>
                </>
            )}

            {(step === 'verify' || step === 'finishing') && (
                <div className="acct-card">
                    <h2>{t('account.key.verifyTitle')}</h2>
                    <p className="acct-muted">{t('account.key.verifyIntro')}</p>
                    <textarea
                        className="acct-textarea"
                        autoComplete="off"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        placeholder={t('account.key.verifyPlaceholder')}
                        value={proofText}
                        onChange={(e) => setProofText(e.target.value)}
                    />
                    {!native && (
                        <label className="acct-link">
                            {t('account.key.openFile')}
                            <input type="file" accept=".nostrkey,.txt,.json" onChange={openFile} hidden />
                        </label>
                    )}
                    {proof?.encrypted && (
                        <input
                            className="acct-input"
                            type="password"
                            autoComplete="current-password"
                            placeholder={t('account.key.backupPassword')}
                            value={proofPassword}
                            onChange={(e) => setProofPassword(e.target.value)}
                        />
                    )}
                    {errorBox}
                    <button
                        type="button"
                        className="acct-button"
                        disabled={busy || !proofText.trim() || (proof?.encrypted && !proofPassword)}
                        onClick={confirmSaved}
                    >
                        {busy && <Loader2 size={18} className="acct-spin" />}
                        {step === 'finishing' ? t('account.key.finishing') : t('account.key.confirm')}
                    </button>
                    {!native && typeof window !== 'undefined' && window.nostr && (
                        <button type="button" className="acct-button secondary" disabled={busy} onClick={confirmWithExtension}>
                            {t('account.key.useExtension')}
                        </button>
                    )}
                    <button type="button" className="acct-link" disabled={busy} onClick={() => { setError(''); setStep('key'); }}>
                        {t('account.key.back')}
                    </button>
                </div>
            )}
        </div>
    );
};

export default TakeYourKey;
