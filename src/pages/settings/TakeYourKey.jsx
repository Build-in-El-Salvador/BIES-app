import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { nip19 } from 'nostr-tools';
import { QRCodeSVG } from 'qrcode.react';
import { AlertCircle, AlertTriangle, ArrowLeft, CheckCircle, Copy, Download, Eye, EyeOff, Loader2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { accountApi } from '../../services/api';
import { nostrSigner } from '../../services/nostrSigner';
import { keyfileService } from '../../services/keyfileService';
import { getAccessToken } from '../../services/session';
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
const KEY_FILE_TYPES = '.nostrkey,.txt,.json,application/json,text/plain,application/octet-stream';

// Lets the page show "Encrypting…" before scrypt (NIP-49) blocks for a moment.
const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

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
    const [copyNote, setCopyNote] = useState('');
    const [password, setPassword] = useState('');
    const [password2, setPassword2] = useState('');
    const [saving, setSaving] = useState(false);
    const [backupNote, setBackupNote] = useState('');
    const [manualCopy, setManualCopy] = useState('');

    const [proofText, setProofText] = useState('');
    const [proofPassword, setProofPassword] = useState('');
    const proof = useMemo(() => readKeyInput(proofText), [proofText]);

    // Answers that arrive after the page closed, or after the member signed
    // out, must not touch this device's signer.
    const aliveRef = useRef(true);
    const userIdRef = useRef(user?.id);
    const busyRef = useRef(false);
    const stepRef = useRef(null);
    const fileRef = useRef(null);

    useEffect(() => { userIdRef.current = user?.id; }, [user?.id]);
    useEffect(() => () => {
        aliveRef.current = false;
        secretRef.current?.fill(0);
        secretRef.current = null;
    }, []);
    // Each step starts where a screen reader or keyboard can find it.
    useEffect(() => { stepRef.current?.focus(); }, [step]);

    const begin = () => {
        if (busyRef.current) return false;
        busyRef.current = true;
        setBusy(true);
        setError('');
        return true;
    };
    const end = () => {
        busyRef.current = false;
        if (aliveRef.current) setBusy(false);
    };

    const fail = (err) => {
        if (!aliveRef.current) return;
        setError(accountErrorMessage(t, err));
        if (err?.data?.reason === 'rate_limited' && err.data.retryAfterSeconds) setResendIn(err.data.retryAfterSeconds);
        if (err?.data?.reason === 'challenge_expired') setStep('intro');
    };

    const copy = async (text, label) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(label);
            setTimeout(() => { if (aliveRef.current) setCopied(''); }, 2000);
            return true;
        } catch {
            return false;
        }
    };

    // ─── Steps ───────────────────────────────────────────────────────────────

    const sendCode = async () => {
        if (!begin()) return;
        try {
            const res = await accountApi.startKeyExport(lang);
            if (!aliveRef.current) return;
            setEmail(res.email);
            setCode('');
            setResendIn(res.resendAfterSeconds || 60);
            setStep('code');
        } catch (err) {
            fail(err);
        } finally {
            end();
        }
    };

    const showKey = async () => {
        if (!begin()) return;
        try {
            const res = await accountApi.exportKey(code);
            if (!aliveRef.current) return;
            const secretKey = hexToBytes(res.secretKey);
            if (!keyMatches(secretKey, user.nostrPubkey)) {
                secretKey.fill(0);
                throw new Error('key mismatch');
            }
            secretRef.current?.fill(0); // from an earlier export
            secretRef.current = secretKey;
            setNsec(nip19.nsecEncode(secretKey));
            setChallenge(res.challenge);
            setStep('key');
        } catch (err) {
            setCode('');
            fail(err);
        } finally {
            end();
        }
    };

    const copyKey = async () => {
        setCopyNote('');
        if (!(await copy(nsec, 'nsec'))) {
            setRevealed(true);
            setCopyNote(t('account.key.copyFailed'));
        }
    };

    const backupProblem = password.length < MIN_PASSWORD
        ? t('account.key.passwordShort')
        : password !== password2 ? t('account.key.passwordMismatch') : '';

    const saveBackup = async () => {
        if (backupProblem || saving || !secretRef.current) return;
        setSaving(true);
        setBackupNote('');
        setManualCopy('');
        await nextTick();
        try {
            if (!secretRef.current) return;
            const { json, filename } = buildBackup(secretRef.current, password);
            if (native) {
                // No downloads in the app: the encrypted key, for a password manager.
                const { ncryptsec } = JSON.parse(json);
                if (await copy(ncryptsec, 'backup')) {
                    setBackupNote(t('account.key.copiedBackup'));
                } else {
                    setManualCopy(ncryptsec);
                    setBackupNote(t('account.key.copyFailed'));
                }
            } else {
                keyfileService.triggerDownload(json, filename);
                setBackupNote(t('account.key.backupSaved', { filename }));
            }
        } finally {
            if (aliveRef.current) setSaving(false);
        }
    };

    const openFile = async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (file) setProofText((await file.text()).trim());
    };

    // Prove the key was saved: sign the challenge with the key brought back.
    const confirmSaved = async () => {
        if (busyRef.current) return;
        if (!proof) { setError(t('account.key.notAKey')); return; }
        if (proof.tooNew) { setError(t('account.key.tooNew')); return; }
        if (!begin()) return;
        await nextTick();

        let secretKey;
        try {
            secretKey = proof.encrypted ? unlockBackup(proof.encrypted, proofPassword) : new Uint8Array(proof.secretKey);
        } catch {
            setError(t('account.key.wrongPassword'));
            end();
            return;
        }
        if (!keyMatches(secretKey, user.nostrPubkey)) {
            secretKey.fill(0);
            setError(t('account.key.wrongKey'));
            end();
            return;
        }
        const signed = signConfirmation(secretKey, 'take_key', challenge, t('account.key.signContent'));
        await finish(signed, () => nostrSigner.setNsec(new Uint8Array(secretKey)));
        secretKey.fill(0);
    };

    // Or through a browser extension the member imported the key into.
    const confirmWithExtension = async () => {
        if (!begin()) return;
        let signed = null;
        try {
            if ((await window.nostr.getPublicKey()) === user.nostrPubkey) {
                signed = await window.nostr.signEvent(confirmationTemplate('take_key', challenge, t('account.key.signContent')));
            } else {
                setError(t('account.key.wrongKey'));
            }
        } catch {
            setError(t('account.errors.signerFailed'));
        }
        if (!signed) { end(); return; }
        await finish(signed, () => nostrSigner.setExtensionMode());
    };

    // BIES deletes its copy; `switchSigner` makes this device sign with the
    // member's key from now on.
    const finish = async (signedEvent, switchSigner) => {
        busyRef.current = true;
        setBusy(true);
        setStep('finishing');
        const forUser = userIdRef.current;
        let released = false;
        try {
            await accountApi.releaseKey(signedEvent, lang);
            released = true;
        } catch (err) {
            // BIES already holds no key: an earlier release went through and
            // its answer was lost. The member has just shown they hold it.
            if (err?.data?.reason === 'not_hosted') {
                released = true;
            } else if (aliveRef.current) {
                setStep('verify');
                fail(err);
            }
        }
        // Only on the page, and for the member, that asked: if the session
        // ended meanwhile, the key must not be left on this device.
        if (released && aliveRef.current && userIdRef.current === forUser && getAccessToken()) {
            switchSigner();
            secretRef.current?.fill(0);
            secretRef.current = null;
            setNsec('');
            setStep('done');
            // The account no longer has a hosted key; Settings should know.
            refreshUser().catch(() => {});
        }
        end();
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
                <div className="acct-card acct-done" ref={stepRef} tabIndex={-1}>
                    <CheckCircle size={40} />
                    <h1 className="acct-title">{t('account.key.doneTitle')}</h1>
                    <p className="acct-muted">{t('account.key.doneBody')}</p>
                    <p className="acct-muted">{native ? t('account.key.doneHowNative') : t('account.key.doneHow')}</p>
                    <button type="button" className="acct-button secondary" onClick={() => navigate('/settings')}>
                        {t('account.key.doneButton')}
                    </button>
                </div>
            </div>
        );
    }

    const backLink = step !== 'finishing' && (
        <Link to="/settings" className="acct-back"><ArrowLeft size={16} /> {t('account.backToSettings')}</Link>
    );

    if (!user?.hostedKey && step !== 'finishing') {
        return (
            <div className="acct-page">
                {backLink}
                <h1 className="acct-title">{t('account.key.title')}</h1>
                <div className="acct-card"><p className="acct-muted">{t('account.key.notHosted')}</p></div>
            </div>
        );
    }

    return (
        <div className="acct-page">
            {backLink}
            <h1 className="acct-title">{t('account.key.title')}</h1>

            {step === 'intro' && (
                <div className="acct-card" ref={stepRef} tabIndex={-1}>
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
                <div className="acct-card" ref={stepRef} tabIndex={-1}>
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
                    <div className="acct-card" ref={stepRef} tabIndex={-1}>
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
                                <button type="button" onClick={copyKey}>
                                    {copied === 'nsec' ? <CheckCircle size={14} /> : <Copy size={14} />}
                                    {copied === 'nsec' ? t('account.key.copied') : t('account.key.copy')}
                                </button>
                            </div>
                        </div>
                        {copyNote && <p className="acct-hint" role="status">{copyNote}</p>}
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
                            aria-label={t('account.key.password')}
                            placeholder={t('account.key.password')}
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                        />
                        <input
                            className="acct-input"
                            type="password"
                            autoComplete="new-password"
                            aria-label={t('account.key.passwordRepeat')}
                            placeholder={t('account.key.passwordRepeat')}
                            value={password2}
                            onChange={(e) => setPassword2(e.target.value)}
                        />
                        {password && backupProblem && <p className="acct-hint">{backupProblem}</p>}
                        <button type="button" className="acct-button secondary" disabled={!!backupProblem || saving} onClick={saveBackup}>
                            {saving ? <Loader2 size={16} className="acct-spin" /> : native ? <Copy size={16} /> : <Download size={16} />}
                            {saving ? t('account.key.saving') : native ? t('account.key.copyBackup') : t('account.key.downloadBackup')}
                        </button>
                        {backupNote && <p className="acct-hint" role="status">{backupNote}</p>}
                        {manualCopy && (
                            <textarea
                                className="acct-textarea"
                                readOnly
                                aria-label={t('account.key.backupTitle')}
                                value={manualCopy}
                                onFocus={(e) => e.target.select()}
                            />
                        )}
                    </div>

                    <div className="acct-card">
                        <button type="button" className="acct-button" onClick={() => { setError(''); setStep('verify'); }}>
                            {t('account.key.savedButton')}
                        </button>
                    </div>
                </>
            )}

            {(step === 'verify' || step === 'finishing') && (
                <div className="acct-card" ref={stepRef} tabIndex={-1}>
                    <h2>{t('account.key.verifyTitle')}</h2>
                    <p className="acct-muted">{native ? t('account.key.verifyIntroNative') : t('account.key.verifyIntro')}</p>
                    <textarea
                        className="acct-textarea"
                        autoComplete="off"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        aria-label={t('account.key.verifyLabel')}
                        placeholder={t('account.key.verifyPlaceholder')}
                        value={proofText}
                        onChange={(e) => setProofText(e.target.value)}
                        disabled={busy}
                    />
                    {!native && (
                        <>
                            <button type="button" className="acct-link" disabled={busy} onClick={() => fileRef.current?.click()}>
                                {t('account.key.openFile')}
                            </button>
                            <input ref={fileRef} type="file" accept={KEY_FILE_TYPES} onChange={openFile} hidden />
                        </>
                    )}
                    {proof?.encrypted && (
                        <input
                            className="acct-input"
                            type="password"
                            autoComplete="current-password"
                            aria-label={t('account.key.backupPassword')}
                            placeholder={t('account.key.backupPassword')}
                            value={proofPassword}
                            onChange={(e) => setProofPassword(e.target.value)}
                            disabled={busy}
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
                    {step === 'verify' && (
                        <button type="button" className="acct-link" disabled={busy} onClick={() => { setError(''); setStep('key'); }}>
                            {t('account.key.back')}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
};

export default TakeYourKey;
