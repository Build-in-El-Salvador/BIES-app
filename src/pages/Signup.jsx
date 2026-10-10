import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getPublicKey, nip19 } from 'nostr-tools';
import { generateSeedWords, privateKeyFromSeedWords } from 'nostr-tools/nip06';
import { useAuth } from '../context/AuthContext';
import { useNavigate, Link } from 'react-router-dom';
import { Copy, CheckCircle, ShieldAlert, ArrowRight, AlertCircle, Fingerprint, Loader2, ChevronUp, ChevronDown, AtSign, X } from 'lucide-react';
import { keytrService, isPrfUnsupportedError } from '../services/keytrService';
import { nostrSigner } from '../services/nostrSigner';
import { PASSKEY_ENABLED, COINOS_SIGNUP_WALLET } from '../config/featureFlags';
import { walletApi, profilesApi } from '../services/api';
import { isNativePlatform } from '../utils/platform';
import EmailSignIn from '../components/EmailSignIn';

const Signup = () => {
    const { t } = useTranslation();
    const { loginWithNsec } = useAuth();
    const navigate = useNavigate();
    const [error, setError] = useState('');
    const [submitting, setSubmitting] = useState(false);

    // Steps: 0 = Intro, 1 = Key Gen, 2 = Backup, 3 = Profile
    const [step, setStep] = useState(0);
    const [keys, setKeys] = useState(null); // { nsec, npub, sk, pk, mnemonic }
    const [profile, setProfile] = useState({ name: '' });
    const [copiedItem, setCopiedItem] = useState(null);
    const [savingPasskey, setSavingPasskey] = useState(false);
    const [passkeySaved, setPasskeySaved] = useState(false);
    const [passkeySupported, setPasskeySupported] = useState(false);
    const [nip05Name, setNip05Name] = useState('');
    const [nip05Available, setNip05Available] = useState(null);
    const [nip05Checking, setNip05Checking] = useState(false);

    useEffect(() => {
        if (!PASSKEY_ENABLED) return;
        // WebAuthn does not exist in WKWebView (Capacitor native shell) — hide
        // the passkey save UI there instead of letting it hard-fail.
        if (typeof PublicKeyCredential === 'undefined' || isNativePlatform()) return;
        // Signup only *registers* passkeys, which is PRF-only in keytr 0.8.0 —
        // hide the step entirely when the device can't create one.
        keytrService.canRegisterPasskey().then(setPasskeySupported);
    }, []);
    // NIP-05 availability check (debounced)
    useEffect(() => {
        const name = nip05Name.trim().toLowerCase();
        if (!name || name.length < 3) { setNip05Available(null); return; }
        if (!/^[a-z0-9._-]+$/.test(name)) { setNip05Available(false); return; }
        setNip05Checking(true);
        const timer = setTimeout(async () => {
            try {
                const res = await profilesApi.checkNip05(name);
                setNip05Available(res.available);
            } catch { setNip05Available(null); }
            finally { setNip05Checking(false); }
        }, 500);
        return () => clearTimeout(timer);
    }, [nip05Name]);

    const [showSeedPhrase, setShowSeedPhrase] = useState(false);
    // Coinos wallet (signup)
    const [enableCoinos, setEnableCoinos] = useState(false);
    const [coinosUsername, setCoinosUsername] = useState('');
    const [coinosError, setCoinosError] = useState('');

    const truncateKey = (key) => key ? `${key.slice(0, 10)}...${key.slice(-10)}` : '';

    const generateKeys = () => {
        const mnemonic = generateSeedWords();
        const sk = privateKeyFromSeedWords(mnemonic);
        const pk = getPublicKey(sk);

        const nsec = nip19.nsecEncode(sk);
        const npub = nip19.npubEncode(pk);

        setKeys({ sk, pk, nsec, npub, mnemonic });
        setStep(1);
    };

    const copyToClipboard = (text, type) => {
        navigator.clipboard.writeText(text);
        setCopiedItem(type);
        setTimeout(() => setCopiedItem(null), 2000);
    };

    const handleBackupConfirm = () => {
        setStep(2);
    };

    const handleSavePasskey = async () => {
        if (!keys) return;
        setSavingPasskey(true);
        setError('');
        try {
            // Set up signer so keytrService can sign the kind:31777 relay event
            nostrSigner.setNsec(keys.nsec);
            await keytrService.saveWithPasskey(keys.nsec, keys.pk);
            setPasskeySaved(true);
            // Prevent the post-login PasskeySavePrompt modal from appearing
            sessionStorage.setItem('bies_passkey_prompt_dismissed', '1');
        } catch (err) {
            if (err.name === 'NotAllowedError') {
                // User cancelled the WebAuthn prompt — not an error
                return;
            }
            if (isPrfUnsupportedError(err)) {
                setError(t('passkeySave.prfUnsupported'));
                return;
            }
            setError(err.message || 'Failed to save passkey.');
        } finally {
            setSavingPasskey(false);
        }
    };

    const handleProfileSubmit = async (e) => {
        e.preventDefault();
        if (!profile.name || submitting) return;

        // Validate Coinos username if opted in
        if (enableCoinos && COINOS_SIGNUP_WALLET) {
            const u = coinosUsername.trim();
            if (!u || u.length < 2 || u.length > 24 || !/^[a-zA-Z0-9]+$/.test(u)) {
                setCoinosError('Username must be 2-24 alphanumeric characters');
                return;
            }
            setCoinosError('');
        }

        setError('');
        setSubmitting(true);

        try {
            // Log in with the nsec we generated — no extension needed.
            const result = await loginWithNsec(keys.nsec);

            if (result.success) {
                // Update profile name + NIP-05 via API
                const { authService } = await import('../services/authService.js');
                const profileData = { name: profile.name };
                if (nip05Name.trim()) profileData.nip05Name = nip05Name.trim().toLowerCase();
                await authService.completeNostrProfile(profileData);

                // Optionally create Coinos wallet
                if (enableCoinos && COINOS_SIGNUP_WALLET && coinosUsername.trim()) {
                    try {
                        await walletApi.createCoinos(coinosUsername.trim());
                    } catch (err) {
                        // Non-fatal — user can set up wallet later in Settings
                        console.warn('Coinos wallet creation failed:', err.message);
                    }
                }

                navigate('/dashboard');
            } else {
                setError(result.error || 'Failed to register. Please try again.');
            }
        } catch (err) {
            console.error('Signup error:', err);
            setError(err?.message || String(err) || 'Registration failed.');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="signup-container">
            <div className="signup-card">
                {/* Progress through the create-your-own-key steps */}
                {step > 0 && (
                    <div className="progress-bar mb-8">
                        <div className={`step ${step >= 0 ? 'active' : ''}`}>1</div>
                        <div className="line"></div>
                        <div className={`step ${step >= 1 ? 'active' : ''}`}>2</div>
                        <div className="line"></div>
                        <div className={`step ${step >= 2 ? 'active' : ''}`}>3</div>
                    </div>
                )}

                {step === 0 && (
                    <div className="text-center w-full">
                        <h2 className="text-2xl font-bold mb-2">{t('emailSignIn.joinHeading')}</h2>
                        <p className="text-gray-500 mb-6">{t('emailSignIn.joinSubtext')}</p>
                        <EmailSignIn onSuccess={(result) => navigate(result.needsProfileSetup ? '/profile-setup' : '/feed')} />
                        <div className="signup-divider"><span>{t('common.or')}</span></div>
                        <p className="text-gray-500 text-sm mb-4">{t('emailSignIn.ownKeyIntro')}</p>
                        <button onClick={generateKeys} className="btn-outline w-full py-3 rounded-full">
                            {t('signup.generateKeys')}
                        </button>
                        <div className="mt-4 text-sm text-gray-400">
                            {t('signup.alreadyHaveKeys')} <Link to="/login" className="text-blue-500">{t('common.logIn')}</Link>
                        </div>
                    </div>
                )}

                {step === 1 && keys && (
                    <div className="key-display">
                        <h2 className="text-xl font-bold mb-2 text-center text-red-500 flex items-center justify-center gap-2">
                            <ShieldAlert size={24} />
                            Save Your Secret Key!
                        </h2>
                        <p className="text-sm text-gray-500 mb-6 text-center">
                            We cannot recover this for you. If you lose it, your account is gone forever.
                        </p>

                        <div className="flex flex-col gap-5 mb-4">
                            <div className="flex items-center justify-between p-3 rounded-2xl" style={{ background: 'var(--color-gray-100)', color: 'var(--color-text, inherit)' }}>
                                <span className="text-xs font-black shrink-0 tracking-wide" style={{ color: 'var(--color-gray-400)' }}>PUBLIC ID</span>
                                <span className="text-sm tracking-widest font-mono truncate" style={{ opacity: 0.8, flex: 1, textAlign: 'center', margin: '0 0.5rem' }}>
                                    {truncateKey(keys.npub)}
                                </span>
                                <button onClick={() => copyToClipboard(keys.npub, 'npub')} className="text-xs font-semibold flex items-center gap-2 px-2 py-1 shrink-0" style={{ background: 'transparent', color: 'var(--color-primary)', border: 'none' }}>
                                    <Copy size={14} /> {copiedItem === 'npub' ? 'Copied!' : 'Copy'}
                                </button>
                            </div>

                            <div className="flex items-center justify-between p-3 rounded-2xl border" style={{ background: 'var(--color-red-tint)', borderColor: 'var(--badge-error-bg)', color: 'var(--color-error)' }}>
                                <span className="text-xs font-black shrink-0 tracking-wide" style={{ color: 'var(--color-error)' }}>SECRET KEY</span>
                                <span className="text-sm tracking-widest font-mono truncate" style={{ opacity: 0.8, flex: 1, textAlign: 'center', margin: '0 0.5rem' }}>
                                    {truncateKey(keys.nsec)}
                                </span>
                                <button onClick={() => copyToClipboard(keys.nsec, 'nsec')} className="text-xs font-semibold flex items-center gap-2 px-2 py-1 shrink-0" style={{ background: 'transparent', color: 'inherit', border: 'none' }}>
                                    <Copy size={14} /> {copiedItem === 'nsec' ? 'Copied!' : 'Copy'}
                                </button>
                            </div>
                        </div>

                        <div 
                            className="key-box mb-6 transition-all"
                            style={{ 
                                background: showSeedPhrase ? 'var(--color-gray-50)' : 'var(--color-surface)',
                                border: '1px solid var(--color-gray-200)', 
                                borderRadius: '1.5rem',
                                overflow: 'hidden',
                                boxShadow: 'var(--shadow-sm)'
                            }}
                        >
                            <button
                                onClick={() => setShowSeedPhrase(!showSeedPhrase)}
                                className="w-full flex items-center justify-between"
                                style={{ padding: '0.625rem 1rem', color: 'var(--color-gray-800)', borderBottom: showSeedPhrase ? '1px solid var(--color-gray-200)' : 'none' }}
                            >
                                <span className="text-sm font-bold flex items-center gap-2">
                                    <ShieldAlert size={18} style={{ color: 'var(--color-error)' }} /> Seed Phrase Backup
                                </span>
                                <div style={{ background: 'var(--color-gray-100)', borderRadius: '50%', padding: '4px', display: 'flex', color: 'var(--color-gray-500)' }}>
                                    {showSeedPhrase ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                                </div>
                            </button>

                            {showSeedPhrase && (
                                <div className="p-5" style={{ background: 'transparent' }}>
                                    <div className="flex justify-between items-center mb-4">
                                        <span className="text-xs font-black tracking-wide" style={{ color: 'var(--color-error)' }}>12 WORDS (Keep Safe!)</span>
                                        <button onClick={() => copyToClipboard(keys.mnemonic, 'seed')} className="text-xs font-semibold flex items-center gap-2 px-2 py-1" style={{ background: 'transparent', color: 'var(--color-primary)', border: 'none' }}>
                                            <Copy size={14} /> {copiedItem === 'seed' ? 'Copied!' : 'Copy Phrase'}
                                        </button>
                                    </div>
                                    <div className="shadow-sm" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.75rem', background: 'var(--color-red-tint)', padding: '1rem', borderRadius: '1.25rem', border: '1px solid var(--badge-error-bg)', fontFamily: 'monospace', fontSize: '0.875rem', color: 'var(--color-error)' }}>
                                        {keys.mnemonic.split(' ').map((word, i) => (
                                            <span key={i} style={{ display: 'flex', gap: '0.25rem', alignItems: 'center' }}>
                                                <span style={{ color: '#fca5a5', fontSize: '0.75rem', minWidth: '1.25rem' }}>{i + 1}.</span>
                                                <span style={{ fontWeight: '500' }}>{word}</span>
                                            </span>
                                        ))}
                                    </div>
                                    <p className="text-xs mt-4 text-center" style={{ color: 'var(--color-gray-500)', maxWidth: '280px', margin: '1rem auto 0' }}>
                                        You can log in with this 12-word seed phrase instead of your secret key.
                                    </p>
                                </div>
                            )}
                        </div>

                        {error && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--color-red-tint)', color: 'var(--color-error)', padding: '0.75rem 1rem', borderRadius: 8, fontSize: '0.875rem', width: '100%', marginBottom: '0.75rem', border: '1px solid var(--badge-error-bg)' }}>
                                <AlertCircle size={16} />
                                <span>{error}</span>
                            </div>
                        )}

                        <div className="backup-buttons">
                            {/* ── Backup section ── */}
                            <div style={{ borderTop: '1px solid var(--color-gray-200)', paddingTop: '0.75rem', marginTop: '0.25rem' }}>
                                <p className="text-sm font-bold" style={{ marginBottom: 4, color: 'var(--color-gray-600)' }}>Backup Your Keys</p>
                                <p className="text-xs" style={{ marginBottom: '0.75rem', color: 'var(--color-gray-400)' }}>
                                    Copy the nsec or seed phrase above to back up your keys.
                                </p>
                            </div>

                            {/* ── Quick Login section (separate from backup) ── */}
                            {PASSKEY_ENABLED && passkeySupported && (
                                <div style={{ borderTop: '1px solid var(--color-gray-200)', paddingTop: '0.75rem', marginTop: '0.25rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                    <p className="text-sm font-bold" style={{ marginBottom: 2, color: 'var(--color-gray-600)' }}>Quick Login (NIP-K1)</p>
                                    <button
                                        onClick={handleSavePasskey}
                                        disabled={savingPasskey || passkeySaved}
                                        className="w-full btn-primary py-3 rounded-full flex items-center justify-center gap-2"
                                        style={{ backgroundColor: 'var(--color-warning)' }}
                                    >
                                        {passkeySaved ? (
                                            <><CheckCircle size={16} style={{ color: 'var(--color-success)' }} /> Passkey Saved</>
                                        ) : savingPasskey ? (
                                            <><Loader2 size={16} className="spin" /> Saving...</>
                                        ) : (
                                            <><Fingerprint size={16} /> Save to Passkey</>
                                        )}
                                    </button>
                                    <p className="text-xs" style={{ color: 'var(--color-warning)', lineHeight: 1.3 }}>
                                        Your key is encrypted with your passkey and stored on Nostr relays. You can recover it from any device using the same passkey. Always keep a separate backup above.
                                    </p>
                                </div>
                            )}

                            <button
                                onClick={handleBackupConfirm}
                                className="w-full btn-primary py-3 rounded-full"
                                style={{ marginTop: '0.25rem' }}
                            >
                                Continue
                            </button>
                        </div>
                    </div>
                )}

                {step === 2 && (
                    <form onSubmit={handleProfileSubmit} className="w-full">
                        <h2 className="text-2xl font-bold mb-6 text-center">Complete Profile</h2>

                        <p className="text-sm text-gray-500 mb-4 text-center">
                            Set up your display name to get started.
                        </p>

                        {error && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--color-red-tint)', color: 'var(--color-error)', padding: '0.75rem 1rem', borderRadius: 8, fontSize: '0.875rem', width: '100%', marginBottom: '1rem', border: '1px solid var(--badge-error-bg)' }}>
                                <AlertCircle size={16} />
                                <span>{error}</span>
                            </div>
                        )}

                        <div className="mb-4">
                            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--color-gray-700)' }}>Display Name</label>
                            <input
                                type="text"
                                required
                                className="w-full p-3 border input-box"
                                placeholder="e.g. Satoshi Nakamoto"
                                value={profile.name}
                                onChange={e => setProfile({ ...profile, name: e.target.value })}
                            />
                        </div>

                        <div className="mb-4">
                            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--color-gray-700)' }}>Choose your BIES identity</label>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                                <div style={{ flex: 1, position: 'relative', display: 'flex', alignItems: 'center' }}>
                                    <AtSign size={16} style={{ position: 'absolute', left: '0.75rem', color: 'var(--color-gray-400)' }} />
                                    <input
                                        type="text"
                                        className="w-full p-3 border input-box"
                                        style={{ paddingLeft: '2.25rem' }}
                                        placeholder="satoshi"
                                        value={nip05Name}
                                        onChange={e => setNip05Name(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ''))}
                                    />
                                </div>
                                {nip05Checking && <Loader2 size={16} className="spin" style={{ color: 'var(--color-gray-400)' }} />}
                                {!nip05Checking && nip05Available === true && <CheckCircle size={16} style={{ color: '#16a34a' }} />}
                                {!nip05Checking && nip05Available === false && <X size={16} style={{ color: '#ef4444' }} />}
                            </div>
                            {nip05Name && (
                                <p className="text-xs" style={{ marginTop: '0.25rem', color: nip05Available === false ? '#ef4444' : 'var(--color-gray-400)' }}>
                                    {nip05Available === false ? 'Taken — try another name' : `${nip05Name.toLowerCase()}@buildinelsalvador.com`}
                                </p>
                            )}
                        </div>

                        {COINOS_SIGNUP_WALLET && (
                            <div className="mb-4" style={{ border: '1px solid var(--color-gray-200)', borderRadius: 12, padding: '0.75rem', background: 'var(--color-surface)' }}>
                                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.9rem', fontWeight: 600, color: 'var(--color-gray-700)' }}>
                                    <input
                                        type="checkbox"
                                        checked={enableCoinos}
                                        onChange={(e) => { setEnableCoinos(e.target.checked); setCoinosError(''); }}
                                        style={{ accentColor: '#f7931a', width: 18, height: 18 }}
                                    />
                                    Enable Instant Wallet (Coinos)
                                </label>
                                <p className="text-xs" style={{ color: 'var(--color-gray-400)', marginTop: 4, lineHeight: 1.4 }}>
                                    Get a Lightning wallet instantly so you can send and receive sats right away. You can also connect your own wallet later in Settings.
                                </p>
                                {enableCoinos && (
                                    <div style={{ marginTop: '0.5rem' }}>
                                        <input
                                            type="text"
                                            className="w-full p-2 border input-box"
                                            placeholder="Choose a wallet username (2-24 chars, alphanumeric)"
                                            value={coinosUsername}
                                            onChange={(e) => { setCoinosUsername(e.target.value.replace(/[^a-zA-Z0-9]/g, '')); setCoinosError(''); }}
                                            maxLength={24}
                                            style={{ fontSize: '0.85rem' }}
                                        />
                                        {coinosUsername && (
                                            <p className="text-xs" style={{ color: 'var(--color-gray-500)', marginTop: 4 }}>
                                                Your Lightning address: <strong>{coinosUsername}@coinos.io</strong>
                                            </p>
                                        )}
                                        {coinosError && (
                                            <p className="text-xs" style={{ color: 'var(--color-error)', marginTop: 4 }}>{coinosError}</p>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}

                        <button type="submit" className="btn-primary w-full py-3 rounded-full flex items-center justify-center gap-2">
                            Enter Dashboard <ArrowRight size={18} />
                        </button>
                    </form>
                )}
            </div>

            <style jsx>{`
                .signup-container {
                    min-height: calc(100vh - 150px);
                    min-height: calc(100dvh - 150px);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background: var(--color-gray-50);
                    padding: clamp(1rem, 3vh, 2rem) clamp(0.5rem, 2vh, 1rem);
                }
                .signup-card {
                    background: var(--color-surface);
                    color: var(--color-text, inherit);
                    padding: clamp(1rem, 2vh, 2.5rem);
                    border-radius: var(--radius-xl);
                    box-shadow: var(--shadow-lg);
                    width: 100%;
                    max-width: 500px;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    border: 1px solid var(--color-gray-200);
                }
                .signup-divider {
                    width: 100%;
                    display: flex;
                    align-items: center;
                    gap: 1rem;
                    margin: 1.25rem 0 1rem;
                    color: var(--color-gray-500);
                    font-size: 0.875rem;
                }
                .signup-divider::before,
                .signup-divider::after {
                    content: '';
                    flex: 1;
                    height: 1px;
                    background: var(--color-gray-200);
                }
                .progress-bar {
                    display: flex;
                    align-items: center;
                    width: 100%;
                    max-width: 200px;
                }
                .step {
                    width: 30px;
                    height: 30px;
                    border-radius: 50%;
                    background: var(--color-gray-200);
                    color: var(--color-gray-500);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 0.8rem;
                    font-weight: bold;
                }
                .step.active {
                    background: var(--color-primary);
                    color: white;
                }
                .line {
                    flex: 1;
                    height: 2px;
                    background: var(--color-gray-200);
                    margin: 0 5px;
                }

                .btn-primary {
                    background: var(--color-primary);
                    color: white;
                    font-weight: 600;
                    transition: opacity 0.2s;
                    border: none;
                    border-radius: 9999px;
                    padding: clamp(0.75rem, 2vh, 1rem) 1.5rem;
                }
                .btn-primary:hover { opacity: 0.9; }

                .btn-outline {
                    border: 1px solid var(--color-gray-300);
                    color: var(--color-gray-600);
                    border-radius: 1rem;
                    background: transparent;
                    transition: all 0.2s;
                }
                .btn-outline:hover { background: var(--color-gray-100); color: var(--color-gray-900); }
                .btn-outline:disabled { opacity: 0.5; pointer-events: none; }

                .input-box {
                    background: var(--color-surface);
                    border: 1px solid var(--color-gray-200);
                    border-radius: 1rem;
                    color: var(--color-text, inherit);
                    transition: border-color 0.2s;
                    outline: none;
                }
                .input-box:focus {
                    border-color: var(--color-primary);
                }

                .backup-buttons {
                    display: flex;
                    flex-direction: column;
                    gap: 0.75rem;
                    width: 100%;
                }

                .spin {
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

export default Signup;
