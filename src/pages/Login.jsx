import { useState, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { AlertCircle, ArrowLeft, Loader2, Key, KeyRound, Globe, FileText, FileKey, Fingerprint, Smartphone, QrCode } from 'lucide-react';
import { nip19, getPublicKey } from 'nostr-tools';
import { privateKeyFromSeedWords, validateWords } from 'nostr-tools/nip06';
import { PASSKEY_ENABLED, NIP46_ENABLED, AMBER_NIP55_ENABLED } from '../config/featureFlags';
import { isLikelyExtensionInterference, keytrService } from '../services/keytrService';
import { isNativePlatform } from '../utils/platform';
import { authService } from '../services/authService';
import { isMobileUA, isAndroid } from '../utils/device';
import logoIcon from '../assets/logo-icon.svg';
import NostrIcon from '../components/NostrIcon';
import NostrConnectQR from '../components/NostrConnectQR';
import EmailSignIn from '../components/EmailSignIn';
import { readKeyInput, unlockBackup } from '../services/accountKey';
import { declineSave, getSavedKey, rememberSaved, saveKey, savedKeyAvailable, shouldOfferToSave } from '../services/savedKey';

/**
 * Sign-in, on two screens: /login is email, and /login/nostr (`nostr`) holds
 * the Nostr methods, with a Back to the email screen.
 */
const Login = ({ nostr = false }) => {
    const { t } = useTranslation();
    const { user: authedUser, loading: authLoading, loginWithNostr, loginWithNsec, loginWithSeedPhrase, loginWithBunker, loginWithPasskey } = useAuth();
    const navigate = useNavigate();
    const location = useLocation();
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [nsecInput, setNsecInput] = useState('');
    const [seedInput, setSeedInput] = useState('');
    const [loginMode, setLoginMode] = useState('nsec'); // 'nsec', 'seed', 'file' or 'bunker'
    // A password-protected key backup (.nostrkey or ncryptsec), such as the
    // one "Take your key" makes.
    const [keyFileText, setKeyFileText] = useState('');
    const [keyFileName, setKeyFileName] = useState('');
    const [keyFilePassword, setKeyFilePassword] = useState('');
    const keyFileInput = useRef(null);
    const [bunkerInput, setBunkerInput] = useState('');
    // Remote-signer sub-view: QR pairing (default on mobile — tap opens the
    // signer app) vs bunker:// paste (default on desktop).
    const [bunkerView, setBunkerView] = useState(() => (isMobileUA() ? 'scan' : 'paste'));
    const [hasNostrExtension, setHasNostrExtension] = useState(
        typeof window !== 'undefined' && !!window.nostr
    );
    // An error belongs to the screen it happened on.
    useEffect(() => setError(''), [nostr]);

    // In the app, a key typed or pasted here can go to the phone's password
    // manager once it has signed in (services/savedKey.js). `offering` holds
    // the redirect below back while that offer is decided.
    const canSaveKeys = savedKeyAvailable();
    const offering = useRef(false);
    const [offer, setOffer] = useState(null); // { nsec, pubkey, result }
    const [offerBusy, setOfferBusy] = useState(false);
    const [offerNote, setOfferNote] = useState('');

    // Back to the page that asked for sign-in (a shared post), or Home.
    const from = location.state?.from;
    const afterSignIn = from?.pathname && !from.pathname.startsWith('/login')
        ? `${from.pathname}${from.search || ''}`
        : '/home';
    const openNostr = () => navigate('/login/nostr', { state: { fromEmail: true, from } });
    // Back through history when the email screen is behind this one, so the
    // device's own back button agrees; arriving by a link replaces instead.
    const backToEmail = () => {
        if (location.state?.fromEmail) navigate(-1);
        else navigate('/login', { replace: true });
    };

    // Passkey — shown when the feature flag is on AND WebAuthn actually exists.
    // WKWebView (Capacitor native shell) has no PublicKeyCredential, so the
    // passkey UI is hidden there to avoid an opaque hard failure.
    // discoverAndLogin handles both stored-credential and discoverable flows.
    const passkeyAvailable = PASSKEY_ENABLED &&
        typeof PublicKeyCredential !== 'undefined' &&
        !isNativePlatform();

    useEffect(() => {
        if (hasNostrExtension) return;

        const check = setInterval(() => {
            if (window.nostr) {
                setHasNostrExtension(true);
                clearInterval(check);
            }
        }, 100);

        const timeout = setTimeout(() => clearInterval(check), 3000);

        return () => {
            clearInterval(check);
            clearTimeout(timeout);
        };
    }, [hasNostrExtension]);

    // Redirect to dashboard if already logged in
    useEffect(() => {
        if (!authLoading && authedUser && !offering.current) {
            navigate(afterSignIn, { replace: true });
        }
    }, [authLoading, authedUser, navigate]);

    const handleResult = (result) => {
        offering.current = false;
        if (result.success) {
            navigate(afterSignIn);
        } else {
            setError(result.error || 'Login failed. Please try again.');
        }
    };

    /** Sign in with a key held here, then offer to save it (native, once per key). */
    const signInWithKey = async (nsec) => {
        offering.current = canSaveKeys;
        try {
            const result = await loginWithNsec(nsec);
            const pubkey = result.user?.nostrPubkey;
            if (result.success && shouldOfferToSave(pubkey)) {
                setOffer({ nsec, pubkey, result });
                return;
            }
            handleResult(result);
        } catch (err) {
            offering.current = false;
            throw err;
        }
    };

    const saveOfferedKey = async () => {
        setOfferBusy(true);
        setOfferNote('');
        try {
            const { saved, cancelled } = await saveKey(offer.nsec);
            if (!saved && !cancelled) {
                setOfferNote(t('savedKey.saveFailed'));
                return;
            }
        } catch {
            setOfferNote(t('savedKey.saveFailed'));
            return;
        } finally {
            setOfferBusy(false);
        }
        handleResult(offer.result);
        setOffer(null);
    };

    const skipOffer = () => {
        declineSave(offer.pubkey);
        handleResult(offer.result);
        setOffer(null);
    };

    const handleSavedKeyLogin = async () => {
        setError('');
        let found;
        try {
            found = await getSavedKey();
        } catch {
            setError(t('savedKey.unavailable'));
            return;
        }
        if (!found) return; // closed the sheet
        if (found.none) { setError(t('savedKey.none')); return; }
        if (found.notAKey) { setError(t('savedKey.notAKey')); return; }
        setLoading(true);
        try {
            const result = await loginWithNsec(found.nsec);
            if (result.success) rememberSaved(result.user?.nostrPubkey);
            handleResult(result);
        } catch (err) {
            setError(err?.message || String(err));
        } finally {
            setLoading(false);
        }
    };

    const handleExtensionLogin = async () => {
        setError('');
        setLoading(true);
        try {
            const result = await loginWithNostr();
            handleResult(result);
        } catch (err) {
            setError(err.message || 'An unexpected error occurred.');
        } finally {
            setLoading(false);
        }
    };

    const friendlyPasskeyError = (msg = '') => {
        if (/rp\.?id.*origin|origin.*rp\.?id/i.test(msg)) {
            if (isLikelyExtensionInterference(msg)) {
                return 'A password manager extension is intercepting passkey requests. ' +
                    'Disable it (e.g. Bitwarden, 1Password) and try again.';
            }
            return 'Cross-origin passkey failed. Try disabling password manager extensions, ' +
                'or use Chrome, Edge, or Safari.';
        }
        if (/credential manager/i.test(msg)) {
            return 'The credential manager encountered an error. ' +
                'Try restarting your browser or use your nsec key to log in.';
        }
        if (/prf/i.test(msg)) {
            return t('passkeySave.prfUnsupported');
        }
        if (/no discoverable passkey found|no event matches credential/i.test(msg)) {
            return 'No passkey found for this device. ' +
                'Log in with your nsec key, then set up a new passkey in Settings.';
        }
        return msg || 'Passkey login failed.';
    };

    const handlePasskeyLogin = async () => {
        setError('');
        setLoading(true);
        try {
            // If the nsec field has a real nsec, login with it and save as passkey
            const trimmed = nsecInput.trim();
            if (trimmed.startsWith('nsec1')) {
                const result = await loginWithNsec(trimmed);
                if (!result.success) {
                    setError(result.error || 'Invalid nsec key.');
                    return;
                }
                // Login succeeded — now register the passkey for future logins
                try {
                    const pubkey = result.user?.nostrPubkey;
                    if (pubkey) {
                        await keytrService.saveWithPasskey(trimmed, pubkey);
                    }
                } catch (saveErr) {
                    // Passkey save failed but login succeeded — continue anyway
                    console.warn('[Login] Passkey save failed:', saveErr.message);
                }
                handleResult(result);
                return;
            }

            // No nsec present — normal passkey login flow
            const result = await loginWithPasskey();
            if (result.cancelled) return;
            if (!result.success) {
                setError(friendlyPasskeyError(result.error));
                return;
            }
            handleResult(result);
        } catch (err) {
            setError(friendlyPasskeyError(err.message));
        } finally {
            setLoading(false);
        }
    };

    const handleKeyFileLogin = async (e) => {
        e.preventDefault();
        setError('');
        const read = readKeyInput(keyFileText);
        if (!read) {
            setError(t('login.keyFileInvalid'));
            return;
        }
        if (read.tooNew) {
            setError(t('account.key.tooNew'));
            return;
        }
        setLoading(true);
        // Let "Unlocking…" show before scrypt (NIP-49) blocks for a moment.
        await new Promise((resolve) => setTimeout(resolve, 0));
        let secretKey = read.secretKey;
        if (read.encrypted) {
            try {
                secretKey = unlockBackup(read.encrypted, keyFilePassword);
            } catch {
                setError(t('login.keyFileWrongPassword'));
                setLoading(false);
                return;
            }
        }
        try {
            await signInWithKey(nip19.nsecEncode(secretKey));
        } catch (err) {
            setError(err?.message || String(err));
        } finally {
            secretKey.fill(0);
            setLoading(false);
        }
    };

    const openKeyFile = async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        setKeyFileText((await file.text()).trim());
        setKeyFileName(file.name);
        setError('');
    };

    // The npub of a typed nsec: what a password manager files the key under.
    const nsecNpub = useMemo(() => {
        try {
            const decoded = nip19.decode(nsecInput.trim());
            return decoded.type === 'nsec' ? nip19.npubEncode(getPublicKey(decoded.data)) : '';
        } catch {
            return '';
        }
    }, [nsecInput]);

    const handleNsecLogin = async (e) => {
        e.preventDefault();
        if (!nsecInput.trim()) return;

        setError('');
        setLoading(true);
        try {
            await signInWithKey(nsecInput.trim());
        } catch (err) {
            console.error('nsec login error:', err);
            setError(err?.message || String(err) || 'Invalid nsec key or login failed.');
        } finally {
            setLoading(false);
        }
    };

    const handleSeedLogin = async (e) => {
        e.preventDefault();
        if (!seedInput.trim()) return;

        setError('');
        setLoading(true);
        try {
            // In the app, the key the phrase stands for is what gets saved.
            const words = seedInput.trim().toLowerCase();
            if (canSaveKeys && validateWords(words)) {
                await signInWithKey(nip19.nsecEncode(privateKeyFromSeedWords(words)));
            } else {
                handleResult(await loginWithSeedPhrase(seedInput));
            }
        } catch (err) {
            setError(err.message || 'Invalid seed phrase or login failed.');
        } finally {
            setLoading(false);
        }
    };

    const handleBunkerLogin = async (e) => {
        e.preventDefault();
        if (!bunkerInput.trim()) return;
        setError('');
        setLoading(true);
        try {
            const result = await loginWithBunker(bunkerInput);
            handleResult(result);
        } catch (err) {
            setError(err.message || 'Failed to connect to remote signer.');
        } finally {
            setLoading(false);
        }
    };

    /**
     * NIP-55 Amber login (Android). Navigates to the Amber app; the flow
     * resumes on /amber-callback. Only the not-installed watchdog (and
     * out-of-tab completions) settle the promise in THIS tab.
     */
    const handleAmberLogin = async () => {
        setError('');
        try {
            await authService.startAmberLogin();
        } catch (err) {
            if (/not found/i.test(err.message || '')) {
                setError(t('login.amberNotFound'));
                setLoginMode('bunker');
                setBunkerView('scan');
            } else if (!/timed out/i.test(err.message || '')) {
                setError(err.message || 'Amber login failed.');
            }
        }
    };



    // ─── Main login form ─────────────────────────────────────────────────────
    return (
        <div className="login-container">
            <div className="login-card">
                {nostr && !offer && (
                    <button type="button" className="login-back" onClick={backToEmail} aria-label={t('login.backToEmail')}>
                        <ArrowLeft size={16} /> {t('common.back')}
                    </button>
                )}

                <div className="logo mb-6">
                    <img src={logoIcon} alt="BIES" style={{ height: '64px', width: 'auto' }} />
                </div>

                <h2 className="login-heading" style={{ fontSize: '1.5rem', textAlign: 'center' }}>
                    {offer ? t('savedKey.offerTitle') : nostr ? t('emailSignIn.useNostr') : t('login.welcomeBack')}
                </h2>
                <p className="login-subtext" style={{ marginBottom: nostr ? '1.5rem' : '2rem', textAlign: 'center' }}>
                    {offer ? t('savedKey.offerBody') : nostr ? t('emailSignIn.nostrIntro') : t('login.accessEcosystem')}
                </p>

                {offer && (<>
                {offerNote && (
                    <div className="error-banner" role="alert">
                        <AlertCircle size={16} />
                        <span>{offerNote}</span>
                    </div>
                )}
                <div className="quick-login-buttons">
                    <button
                        type="button"
                        onClick={saveOfferedKey}
                        disabled={offerBusy}
                        className="w-full btn-login flex items-center justify-center gap-3 py-3 rounded-full"
                    >
                        {offerBusy ? <Loader2 size={20} className="spin" /> : <KeyRound size={20} />}
                        <span>{t('savedKey.save')}</span>
                    </button>
                    <button type="button" onClick={skipOffer} disabled={offerBusy} className="login-link-btn" style={{ padding: '0.5rem' }}>
                        {t('savedKey.notNow')}
                    </button>
                </div>
                </>)}

                {!nostr && (<>
                <EmailSignIn onSuccess={handleResult} />

                <div className="divider"><span>{t('common.or')}</span></div>

                <button
                    type="button"
                    onClick={openNostr}
                    className="w-full btn-nostr flex items-center justify-center gap-3 py-3 rounded-full"
                >
                    <NostrIcon size={20} color="#8b5cf6" />
                    <span>{t('emailSignIn.useNostr')}</span>
                </button>
                </>)}

                {nostr && !offer && (<>
                {error && (
                    <div className="error-banner">
                        <AlertCircle size={16} />
                        <span>{error}</span>
                    </div>
                )}

                {/* In the app: a key kept in the phone's password manager */}
                {canSaveKeys && (<>
                    <button
                        type="button"
                        onClick={handleSavedKeyLogin}
                        disabled={loading}
                        className="w-full btn-login flex items-center justify-center gap-3 py-3 rounded-full"
                    >
                        <KeyRound size={20} />
                        <span>{t('savedKey.useSaved')}</span>
                    </button>
                    <div className="divider"><span>{t('common.or')}</span></div>
                </>)}

                {/* Quick login methods — passkey shown when WebAuthn is available */}
                {(hasNostrExtension || passkeyAvailable) && (
                    <div className="quick-login-buttons">
                        {passkeyAvailable && (
                            <button
                                onClick={handlePasskeyLogin}
                                disabled={loading}
                                className="w-full btn-passkey flex items-center justify-center gap-3 py-3 rounded-full"
                            >
                                {loading ? (
                                    <Loader2 size={20} className="spin" />
                                ) : (
                                    <Fingerprint size={20} />
                                )}
                                <span>{t('login.loginWithPasskey')}</span>
                            </button>
                        )}
                        {hasNostrExtension && (
                            <button
                                onClick={handleExtensionLogin}
                                disabled={loading}
                                className="w-full btn-login flex items-center justify-center gap-3 py-3 rounded-full"
                            >
                                {loading && !nsecInput.trim() ? (
                                    <Loader2 size={20} className="spin" />
                                ) : (
                                    <Globe size={20} />
                                )}
                                <span>{loading && !nsecInput.trim() ? t('common.connecting') : t('login.loginWithExtension')}</span>
                            </button>
                        )}
                        {AMBER_NIP55_ENABLED && isAndroid() && (
                            <>
                                <button
                                    onClick={handleAmberLogin}
                                    disabled={loading}
                                    className="w-full btn-login flex items-center justify-center gap-3 py-3 rounded-full"
                                >
                                    <Smartphone size={20} />
                                    <span>{t('login.signInWithAmberApp')}</span>
                                </button>
                                <p className="login-hint" style={{ textAlign: 'center', margin: 0 }}>
                                    {t('login.amberHint')}{' '}
                                    <button
                                        type="button"
                                        className="login-link-btn"
                                        onClick={() => { setLoginMode('bunker'); setBunkerView('scan'); setError(''); }}
                                    >
                                        {t('login.remoteSignerScan')}
                                    </button>
                                </p>
                            </>
                        )}
                    </div>
                )}

                {/* Divider between quick methods and manual methods */}
                {(hasNostrExtension || passkeyAvailable) && (
                    <div className="divider"><span>{t('common.or')}</span></div>
                )}

                {/* Login mode tabs */}
                <div className="mode-tabs">
                    <button
                        className={`mode-tab ${loginMode === 'nsec' ? 'active' : ''}`}
                        onClick={() => { setLoginMode('nsec'); setError(''); }}
                    >
                        <Key size={14} /> {t('login.nsecKey')}
                    </button>
                    <button
                        className={`mode-tab ${loginMode === 'seed' ? 'active' : ''}`}
                        onClick={() => { setLoginMode('seed'); setError(''); }}
                    >
                        <FileText size={14} /> {t('login.seedPhrase')}
                    </button>
                    <button
                        className={`mode-tab ${loginMode === 'file' ? 'active' : ''}`}
                        onClick={() => { setLoginMode('file'); setError(''); }}
                    >
                        <FileKey size={14} /> {t('login.keyFile')}
                    </button>
                    {NIP46_ENABLED && (
                        <button
                            className={`mode-tab ${loginMode === 'bunker' ? 'active' : ''}`}
                            onClick={() => { setLoginMode('bunker'); setError(''); }}
                        >
                            <Smartphone size={14} /> {t('login.remote')}
                        </button>
                    )}
                </div>

                {/* Login with a password-protected key backup */}
                {loginMode === 'file' && (
                    <form onSubmit={handleKeyFileLogin} className="w-full" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                        <p className="login-subtext" style={{ margin: 0 }}>{t('login.keyFileOrPaste')}</p>
                        <button
                            type="button"
                            onClick={() => keyFileInput.current?.click()}
                            className="w-full btn-nostr flex items-center justify-center gap-3 py-3 rounded-full"
                        >
                            <FileKey size={18} />
                            <span>{keyFileName || t('login.keyFileChoose')}</span>
                        </button>
                        {/* Android drops extensions it has no type for, so the types are listed too. */}
                        <input
                            ref={keyFileInput}
                            type="file"
                            accept=".nostrkey,.txt,.json,application/json,text/plain,application/octet-stream"
                            onChange={openKeyFile}
                            hidden
                        />
                        <textarea
                            value={keyFileName ? '' : keyFileText}
                            onChange={(e) => { setKeyFileText(e.target.value); setKeyFileName(''); }}
                            placeholder="ncryptsec1…"
                            aria-label={t('login.keyFileBackupLabel')}
                            className="key-input"
                            rows={3}
                            autoComplete="off"
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            style={{ fontFamily: 'Menlo, Consolas, monospace', fontSize: '0.8rem', padding: '0.75rem 1rem', borderRadius: '1rem', resize: 'vertical' }}
                        />
                        <div className="key-input-wrapper">
                            <Key size={16} className="key-input-icon" />
                            <input
                                type="password"
                                placeholder={t('login.keyFilePasswordLabel')}
                                aria-label={t('login.keyFilePasswordLabel')}
                                value={keyFilePassword}
                                onChange={(e) => setKeyFilePassword(e.target.value)}
                                className="key-input"
                                autoComplete="current-password"
                            />
                        </div>
                        <button
                            type="submit"
                            disabled={loading || !keyFileText.trim()}
                            className="w-full btn-login flex items-center justify-center gap-3 py-3 rounded-full"
                        >
                            {loading ? <Loader2 size={20} className="spin" /> : <NostrIcon size={20} color="#8b5cf6" />}
                            <span>{loading ? t('login.keyFileUnlocking') : t('login.keyFileSignIn')}</span>
                        </button>
                    </form>
                )}

                {/* Login with nsec */}
                {loginMode === 'nsec' && (
                    <form onSubmit={handleNsecLogin} className="w-full" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                        {/* For password managers: the key is the password, its npub the username. */}
                        <input
                            type="text"
                            name="username"
                            autoComplete="username"
                            value={nsecNpub}
                            onChange={() => {}}
                            tabIndex={-1}
                            aria-hidden="true"
                            className="pm-username"
                        />
                        <div className="key-input-wrapper">
                            <Key size={16} className="key-input-icon" />
                            <input
                                type="password"
                                name="password"
                                placeholder="Paste your nsec key..."
                                value={nsecInput}
                                onChange={(e) => setNsecInput(e.target.value)}
                                className="key-input"
                                autoComplete="current-password"
                                autoCapitalize="none"
                                autoCorrect="off"
                                spellCheck={false}
                            />
                        </div>
                        <button
                            type="submit"
                            disabled={loading || !nsecInput.trim()}
                            className="w-full btn-login flex items-center justify-center gap-3 py-3 rounded-full"
                        >
                            {loading && nsecInput.trim() ? (
                                <Loader2 size={20} className="spin" />
                            ) : (
                                <NostrIcon size={20} color="#8b5cf6" />
                            )}
                            <span>{loading && nsecInput.trim() ? 'Connecting...' : 'Login with nsec'}</span>
                        </button>
                    </form>
                )}

                {/* Login with seed phrase */}
                {loginMode === 'seed' && (
                    <form onSubmit={handleSeedLogin} className="w-full" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                        <textarea
                            placeholder="Enter your 12 or 24 word seed phrase..."
                            value={seedInput}
                            onChange={(e) => setSeedInput(e.target.value)}
                            className="seed-input"
                            autoComplete="off"
                            rows={3}
                        />
                        <button
                            type="submit"
                            disabled={loading || !seedInput.trim()}
                            className="w-full btn-login flex items-center justify-center gap-3 py-3 rounded-full"
                        >
                            {loading && seedInput.trim() ? (
                                <Loader2 size={20} className="spin" />
                            ) : (
                                <NostrIcon size={20} color="#8b5cf6" />
                            )}
                            <span>{loading && seedInput.trim() ? 'Connecting...' : 'Login with Seed Phrase'}</span>
                        </button>
                    </form>
                )}

                {/* Login with remote signer (NIP-46) */}
                {loginMode === 'bunker' && (
                    <div className="w-full" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                        {/* Sub-toggle: QR pairing vs bunker:// paste */}
                        <div className="mode-tabs">
                            <button
                                type="button"
                                className={`mode-tab ${bunkerView === 'scan' ? 'active' : ''}`}
                                onClick={() => { setBunkerView('scan'); setError(''); }}
                            >
                                <QrCode size={14} /> {t('login.remoteSignerScan')}
                            </button>
                            <button
                                type="button"
                                className={`mode-tab ${bunkerView === 'paste' ? 'active' : ''}`}
                                onClick={() => { setBunkerView('paste'); setError(''); }}
                            >
                                <Key size={14} /> {t('login.remoteSignerPaste')}
                            </button>
                        </div>

                        {bunkerView === 'scan' ? (
                            <NostrConnectQR
                                onSuccess={handleResult}
                                onError={(msg) => setError(msg)}
                            />
                        ) : (
                            <form onSubmit={handleBunkerLogin} className="w-full" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                                <div className="key-input-wrapper">
                                    <Smartphone size={16} className="key-input-icon" />
                                    <input
                                        type="text"
                                        placeholder="bunker://... or name@domain.com"
                                        value={bunkerInput}
                                        onChange={(e) => setBunkerInput(e.target.value)}
                                        className="key-input"
                                        autoComplete="off"
                                    />
                                </div>
                                <button
                                    type="submit"
                                    disabled={loading || !bunkerInput.trim()}
                                    className="w-full btn-login flex items-center justify-center gap-3 py-3 rounded-full"
                                >
                                    {loading && bunkerInput.trim() ? (
                                        <Loader2 size={20} className="spin" />
                                    ) : (
                                        <NostrIcon size={20} color="#8b5cf6" />
                                    )}
                                    <span>{loading && bunkerInput.trim() ? t('login.connectingToSigner') : t('login.loginWithRemoteSigner')}</span>
                                </button>
                            </form>
                        )}
                        <p className="login-hint" style={{ textAlign: 'center' }}>
                            {t('login.worksWithSigners')}
                        </p>
                    </div>
                )}

                {/* Create a Nostr key */}
                <div className="login-footer">
                    <p className="login-subtext" style={{ marginBottom: '0.5rem' }}>{t('emailSignIn.ownKeyPrompt')}</p>
                    <Link to="/signup" className="btn-create-account">
                        {t('emailSignIn.createKey')}
                    </Link>
                </div>

                {/* Extension hint — on the web, when no extension was detected */}
                {!hasNostrExtension && !isNativePlatform() && (
                    <>
                        <div className="divider mt-4"><span>or</span></div>
                        <p className="login-subtext" style={{ textAlign: 'center' }}>
                            Have a Nostr browser extension?{' '}
                            <button
                                onClick={handleExtensionLogin}
                                disabled={loading}
                                className="login-link-btn"
                            >
                                Login with Extension
                            </button>
                        </p>
                        <div className="extension-links">
                            <p className="login-hint">No extension detected? Install one:</p>
                            <div className="flex gap-3 mt-1 justify-center">
                                <a href="https://chromewebstore.google.com/detail/nos2x/kpgefcfmnafjgpblomihpgcdlhiodkdc" target="_blank" rel="noopener noreferrer" className="extension-link">
                                    Chrome (nos2x)
                                </a>
                                <span className="text-xs text-gray-300">|</span>
                                <a href="https://addons.mozilla.org/en-US/firefox/addon/nos2x-fox/" target="_blank" rel="noopener noreferrer" className="extension-link">
                                    Firefox (nos2x-fox)
                                </a>
                            </div>
                        </div>
                    </>
                )}
                </>)}
            </div>

            <style jsx>{`
                .login-container {
                    min-height: calc(100vh - 150px);
                    min-height: calc(100dvh - 150px);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background: var(--color-gray-50);
                    padding: clamp(1rem, 3vh, 2rem) clamp(0.5rem, 2vh, 1rem);
                }
                .login-card {
                    background: var(--color-surface);
                    color: var(--color-text, inherit);
                    padding: clamp(1rem, 2.5vh, 2rem);
                    border-radius: 1.5rem;
                    box-shadow: 0 4px 24px rgba(0,0,0,0.08);
                    border: 1px solid var(--color-gray-200);
                    width: 100%;
                    max-width: 440px;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                }
                .login-heading {
                    font-size: clamp(1.25rem, 3vh, 1.5rem);
                    font-weight: 700;
                    margin-bottom: clamp(0.25rem, 1vh, 0.5rem);
                    color: var(--color-text, inherit);
                }
                .login-subtext {
                    font-size: 0.875rem;
                    color: var(--color-gray-500);
                }
                .login-hint {
                    font-size: 0.75rem;
                    color: var(--color-gray-500);
                }
                .login-label {
                    display: block;
                    margin-bottom: 4px;
                    font-size: 0.875rem;
                    color: var(--color-gray-500);
                }
                .login-back {
                    align-self: flex-start;
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                    margin: -0.25rem 0 0.5rem;
                    padding: 0.25rem 0;
                    background: none;
                    border: none;
                    color: var(--color-gray-500);
                    font-size: 0.875rem;
                    font-weight: 500;
                    cursor: pointer;
                }
                .login-back:hover { color: var(--color-primary); }
                .login-footer {
                    margin-top: clamp(1rem, 3vh, 1.5rem);
                    padding-top: clamp(0.5rem, 1.5vh, 0.75rem);
                    border-top: 1px solid var(--color-gray-200);
                    width: 100%;
                    text-align: center;
                }
                .quick-login-buttons {
                    display: flex;
                    flex-direction: column;
                    gap: 0.75rem;
                    width: 100%;
                }
                .btn-login {
                    background: var(--color-primary);
                    color: white;
                    font-size: 1rem;
                    font-weight: 600;
                    transition: all 0.2s;
                    border: none;
                    cursor: pointer;
                    border-radius: 9999px;
                    padding: clamp(0.75rem, 2vh, 1rem) 1.5rem;
                }
                .btn-login:hover { opacity: 0.9; }
                .btn-login:disabled { opacity: 0.5; cursor: not-allowed; }
                .btn-nostr {
                    background: transparent;
                    color: var(--color-text, inherit);
                    font-size: 1rem;
                    font-weight: 600;
                    border: 1px solid var(--color-gray-200);
                    cursor: pointer;
                    border-radius: 9999px;
                    padding: clamp(0.75rem, 2vh, 1rem) 1.5rem;
                    transition: border-color 0.2s;
                }
                .btn-nostr:hover { border-color: var(--color-primary); }
                .btn-passkey {
                    background: #1e1b4b;
                    color: white;
                    font-weight: 600;
                    transition: all 0.2s;
                    border: none;
                    cursor: pointer;
                    border-radius: 9999px;
                    padding: clamp(0.75rem, 2vh, 1rem) 1.5rem;
                }
                .btn-passkey:hover { opacity: 0.9; }
                .btn-passkey:disabled { opacity: 0.5; cursor: not-allowed; }
                /* :global() for components (Link, icons): styled-jsx only scopes plain elements */
                .login-footer :global(.btn-create-account) {
                    display: block;
                    width: 100%;
                    padding: clamp(0.75rem, 2vh, 1rem) 1.5rem;
                    background: var(--color-primary);
                    color: white;
                    font-size: 1rem;
                    font-weight: 600;
                    text-decoration: none;
                    text-align: center;
                    border-radius: 9999px;
                    transition: opacity 0.2s;
                }
                .login-footer :global(.btn-create-account:hover) { opacity: 0.9; }
                .login-link-btn {
                    background: none;
                    border: none;
                    color: var(--color-primary);
                    font-weight: 500;
                    cursor: pointer;
                    padding: 0;
                    font-size: inherit;
                }
                .login-link-btn:hover { text-decoration: underline; }
                .divider {
                    width: 100%;
                    display: flex;
                    align-items: center;
                    gap: 1rem;
                    margin: 0.75rem 0;
                    color: var(--color-gray-500);
                    font-size: 0.875rem;
                }
                .divider::before,
                .divider::after {
                    content: '';
                    flex: 1;
                    height: 1px;
                    background: var(--color-gray-200);
                }
                .mode-tabs {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    width: 100%;
                    gap: 0.75rem;
                    margin-bottom: clamp(0.75rem, 2vh, 1.5rem);
                }
                .mode-tab {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 6px;
                    padding: 0.75rem 0.5rem;
                    border: 1px solid var(--color-gray-200);
                    border-radius: 9999px;
                    background: transparent;
                    color: var(--color-gray-500);
                    font-size: 0.8rem;
                    font-weight: 500;
                    cursor: pointer;
                    transition: all 0.2s;
                }
                .mode-tab:hover {
                    border-color: var(--color-gray-400);
                    color: var(--color-text, inherit);
                }
                .mode-tab.active {
                    border-color: var(--color-primary);
                    color: var(--color-primary);
                    background: var(--color-blue-tint);
                    font-weight: 600;
                }
                .pm-username {
                    position: absolute;
                    width: 1px;
                    height: 1px;
                    opacity: 0;
                    pointer-events: none;
                }
                .key-input-wrapper {
                    width: 100%;
                    box-sizing: border-box;
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    padding: clamp(0.75rem, 2vh, 1rem) 1.5rem;
                    border: 1px solid var(--color-gray-200);
                    border-radius: 9999px;
                    background: var(--color-surface);
                    transition: border-color 0.2s;
                }
                .key-input-wrapper:focus-within {
                    border-color: var(--color-primary);
                }
                .key-input-wrapper :global(.key-input-icon) {
                    flex-shrink: 0;
                    color: var(--color-gray-500);
                }
                .key-input {
                    flex: 1;
                    min-width: 0;
                    border: none;
                    outline: none;
                    font-size: 0.875rem;
                    background: transparent;
                    color: var(--color-text, inherit);
                }
                .key-input::placeholder,
                .seed-input::placeholder {
                    color: var(--color-gray-500);
                }
                .seed-input {
                    width: 100%;
                    padding: 0.75rem;
                    border: 1px solid var(--color-gray-200);
                    border-radius: 1rem;
                    font-size: 0.875rem;
                    font-family: monospace;
                    outline: none;
                    resize: none;
                    transition: border-color 0.2s;
                    background: var(--color-surface);
                    color: var(--color-text, inherit);
                }
                .seed-input:focus {
                    border-color: var(--color-primary);
                }
                .extension-links {
                    margin-top: 0.75rem;
                    text-align: center;
                }
                .extension-link {
                    font-size: 0.75rem;
                    color: var(--color-primary);
                    text-decoration: none;
                    font-weight: 500;
                }
                .extension-link:hover {
                    text-decoration: underline;
                }
                .error-banner {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    background: var(--color-red-tint);
                    color: var(--color-error);
                    padding: 0.75rem 1rem;
                    border-radius: 0.75rem;
                    font-size: 0.875rem;
                    width: 100%;
                    margin-bottom: 1rem;
                    border: 1px solid var(--badge-error-bg);
                }
                .login-card :global(.spin) {
                    animation: spin 1s linear infinite;
                }
                @keyframes spin {
                    from { transform: rotate(0deg); }
                    to { transform: rotate(360deg); }
                }
            `}</style>
        </div>
    );
};

export default Login;
