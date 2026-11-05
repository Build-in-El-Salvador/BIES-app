import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getPublicKey, nip19 } from 'nostr-tools';
import { generateSeedWords, privateKeyFromSeedWords } from 'nostr-tools/nip06';
import { useAuth } from '../context/AuthContext';
import { useNavigate, Link, Navigate } from 'react-router-dom';
import { Copy, CheckCircle, ShieldAlert, ArrowRight, AlertCircle, KeyRound, Loader2, ChevronUp, ChevronDown, AtSign, X } from 'lucide-react';
import { COINOS_SIGNUP_WALLET } from '../config/featureFlags';
import { walletApi, profilesApi } from '../services/api';
import EmailSignIn from '../components/EmailSignIn';
import { saveKey, savedKeyAvailable } from '../services/savedKey';
import { copyText } from '../utils/clipboard';
import { useInviteOnly } from '../hooks/useInviteOnly';
import { inviteStorage, rememberedInvite } from '../utils/inviteCode';

const Signup = () => {
    const { t } = useTranslation();
    const { loginWithNsec, whenTermsAccepted, refreshUser } = useAuth();
    const navigate = useNavigate();
    const [error, setError] = useState('');
    const [submitting, setSubmitting] = useState(false);
    // Invite-only sign-up: the code checked on /invite, sent with sign-up (services/api.js).
    const inviteOnly = useInviteOnly();
    const [invite] = useState(() => rememberedInvite(inviteStorage()));

    // Steps: 0 = Intro, 1 = Key Gen, 2 = Backup, 3 = Profile
    const [step, setStep] = useState(0);
    const [keys, setKeys] = useState(null); // { nsec, npub, sk, pk, mnemonic }
    const [profile, setProfile] = useState({ name: '' });
    const [copiedItem, setCopiedItem] = useState(null);
    const [nip05Name, setNip05Name] = useState('');
    const [nip05Available, setNip05Available] = useState(null);
    const [nip05Checking, setNip05Checking] = useState(false);

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

    const copyToClipboard = async (text, type) => {
        if (!(await copyText(text))) return;
        setCopiedItem(type);
        setTimeout(() => setCopiedItem(null), 2000);
    };

    const handleBackupConfirm = () => {
        setStep(2);
    };

    // In the app: the new key straight into the phone's password manager.
    const [keySave, setKeySave] = useState(''); // '' | 'saving' | 'saved' | 'failed'
    const handleSaveToPasswords = async () => {
        if (!keys) return;
        setKeySave('saving');
        try {
            const { saved, cancelled } = await saveKey(keys.nsec);
            setKeySave(saved ? 'saved' : cancelled ? '' : 'failed');
        } catch {
            setKeySave('failed');
        }
    };

    const handleProfileSubmit = async (e) => {
        e.preventDefault();
        if (!profile.name || submitting) return;

        // Validate Coinos username if opted in
        if (enableCoinos && COINOS_SIGNUP_WALLET) {
            const u = coinosUsername.trim();
            if (!u || u.length < 2 || u.length > 24 || !/^[a-zA-Z0-9]+$/.test(u)) {
                setCoinosError(t('signup.own.walletUsernameError'));
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
                // The terms come first (they show over this page): a profile is public.
                if (!(await whenTermsAccepted(result.user))) return;
                // Update profile name + NIP-05 via API
                const { authService } = await import('../services/authService.js');
                const profileData = { name: profile.name };
                if (nip05Name.trim()) profileData.nip05Name = nip05Name.trim().toLowerCase();
                try {
                    await authService.completeNostrProfile(profileData);
                } catch (err) {
                    // The BIES address was taken meanwhile: the name is kept all
                    // the same, and an address can be claimed in Settings → Nostr.
                    if (err?.status !== 409 || !profileData.nip05Name) throw err;
                    await authService.completeNostrProfile({ name: profile.name });
                }
                // The profile step (ProfileGate) then only asks for a photo.
                await refreshUser();

                // Optionally create Coinos wallet
                if (enableCoinos && COINOS_SIGNUP_WALLET && coinosUsername.trim()) {
                    try {
                        await walletApi.createCoinos(coinosUsername.trim());
                    } catch (err) {
                        // Non-fatal — user can set up wallet later in Settings
                        console.warn('Coinos wallet creation failed:', err.message);
                    }
                }

                navigate('/home');
            } else {
                setError(result.error || t('signup.own.errorRegister'));
            }
        } catch (err) {
            console.error('Signup error:', err);
            setError(err?.message || String(err) || t('signup.own.errorRegister'));
        } finally {
            setSubmitting(false);
        }
    };

    // While sign-up is invite-only, the invite code comes first.
    if (step === 0 && !invite && inviteOnly !== false) {
        return inviteOnly ? <Navigate to="/invite" replace /> : null;
    }

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
                        {invite && (
                            <div className="signup-invite" role="status">
                                <CheckCircle size={16} />
                                <span>{t('invite.added')}</span>
                                <code>{invite.code}</code>
                            </div>
                        )}
                        <h2 className="text-2xl font-bold mb-2">{t('emailSignIn.joinHeading')}</h2>
                        <p className="text-gray-500 mb-6">{t('emailSignIn.joinSubtext')}</p>
                        <EmailSignIn onSuccess={() => navigate('/home')} />
                        <div className="signup-divider"><span>{t('common.or')}</span></div>
                        <p className="text-gray-500 text-sm mb-4">{t('emailSignIn.ownKeyIntro')}</p>
                        <button onClick={generateKeys} className="btn-outline w-full py-3 rounded-full">
                            {t('signup.generateKeys')}
                        </button>
                        <div className="mt-4 text-sm text-gray-400">
                            {t('signup.alreadyHaveKeys')} <Link to="/login/nostr" className="text-blue-500">{t('common.logIn')}</Link>
                        </div>
                    </div>
                )}

                {step === 1 && keys && (
                    <div className="su-step">
                        <h2 className="su-title su-title-warn"><ShieldAlert size={22} aria-hidden="true" /> {t('signup.own.title')}</h2>
                        <p className="su-sub">{t('signup.own.cannotRecover')}</p>

                        <div className="su-keys">
                            <div className="su-key">
                                <span className="su-key-label">{t('signup.own.publicId')}</span>
                                <span className="su-key-value">{truncateKey(keys.npub)}</span>
                                <button type="button" className="su-copy" onClick={() => copyToClipboard(keys.npub, 'npub')}>
                                    <Copy size={14} /> {copiedItem === 'npub' ? t('signup.own.copied') : t('signup.own.copy')}
                                </button>
                            </div>
                            <div className="su-key su-key-secret">
                                <span className="su-key-label">{t('signup.own.secretKey')}</span>
                                <span className="su-key-value">{truncateKey(keys.nsec)}</span>
                                <button type="button" className="su-copy" onClick={() => copyToClipboard(keys.nsec, 'nsec')}>
                                    <Copy size={14} /> {copiedItem === 'nsec' ? t('signup.own.copied') : t('signup.own.copy')}
                                </button>
                            </div>
                        </div>

                        <div className={`su-seed${showSeedPhrase ? ' open' : ''}`}>
                            <button type="button" className="su-seed-toggle" onClick={() => setShowSeedPhrase(!showSeedPhrase)} aria-expanded={showSeedPhrase}>
                                <span><ShieldAlert size={18} aria-hidden="true" /> {t('signup.own.seedTitle')}</span>
                                <span className="su-chevron" aria-hidden="true">{showSeedPhrase ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</span>
                            </button>
                            {showSeedPhrase && (
                                <div className="su-seed-body">
                                    <div className="su-seed-head">
                                        <span className="su-seed-label">{t('signup.own.seedWords')}</span>
                                        <button type="button" className="su-copy" onClick={() => copyToClipboard(keys.mnemonic, 'seed')}>
                                            <Copy size={14} /> {copiedItem === 'seed' ? t('signup.own.copied') : t('signup.own.copyPhrase')}
                                        </button>
                                    </div>
                                    <ol className="su-words">
                                        {keys.mnemonic.split(' ').map((word, i) => (
                                            <li key={i}><span className="su-word-n">{i + 1}.</span> {word}</li>
                                        ))}
                                    </ol>
                                    <p className="su-hint su-center">{t('signup.own.seedHelp')}</p>
                                </div>
                            )}
                        </div>

                        {error && <div className="su-error" role="alert"><AlertCircle size={16} /> <span>{error}</span></div>}

                        <div className="su-backup">
                            <p className="su-backup-title">{t('signup.own.backupTitle')}</p>
                            <p className="su-hint">{t('signup.own.backupHint')}</p>
                            {savedKeyAvailable() && (
                                <>
                                    <button
                                        type="button"
                                        onClick={handleSaveToPasswords}
                                        disabled={keySave === 'saving' || keySave === 'saved'}
                                        className="su-btn su-btn-outline"
                                    >
                                        {keySave === 'saved' ? <CheckCircle size={16} style={{ color: 'var(--color-success)' }} />
                                            : keySave === 'saving' ? <Loader2 size={16} className="spin" />
                                            : <KeyRound size={16} />}
                                        {keySave === 'saved' ? t('savedKey.saved') : t('savedKey.saveButton')}
                                    </button>
                                    {keySave === 'failed' && <p className="su-field-error" role="alert">{t('savedKey.saveFailed')}</p>}
                                </>
                            )}
                        </div>

                        <button type="button" onClick={handleBackupConfirm} className="su-btn su-btn-primary">
                            {t('signup.own.continue')}
                        </button>
                    </div>
                )}

                {step === 2 && (
                    <form onSubmit={handleProfileSubmit} className="su-step" noValidate>
                        <h2 className="su-title">{t('signup.own.profileTitle')}</h2>
                        <p className="su-sub">{t('signup.own.profileHint')}</p>

                        {error && <div className="su-error" role="alert"><AlertCircle size={16} /> <span>{error}</span></div>}

                        <div className="su-group">
                            <label className="su-label" htmlFor="su-name">{t('signup.own.nameLabel')}</label>
                            <input
                                id="su-name"
                                type="text"
                                required
                                className="su-input"
                                placeholder={t('signup.own.namePlaceholder')}
                                value={profile.name}
                                onChange={e => setProfile({ ...profile, name: e.target.value })}
                                maxLength={100}
                                autoComplete="name"
                            />
                        </div>

                        <div className="su-group">
                            <label className="su-label" htmlFor="su-address">{t('signup.own.addressLabel')}</label>
                            <div className="su-address">
                                <div className="su-icon-input">
                                    <AtSign size={16} aria-hidden="true" />
                                    <input
                                        id="su-address"
                                        type="text"
                                        className="su-input"
                                        placeholder="satoshi"
                                        value={nip05Name}
                                        onChange={e => setNip05Name(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ''))}
                                        autoCapitalize="none"
                                        autoCorrect="off"
                                        aria-invalid={nip05Available === false || undefined}
                                        aria-describedby={nip05Name ? 'su-address-hint' : undefined}
                                    />
                                </div>
                                {nip05Checking && <Loader2 size={16} className="spin su-muted" />}
                                {!nip05Checking && nip05Available === true && <CheckCircle size={16} style={{ color: '#16a34a' }} />}
                                {!nip05Checking && nip05Available === false && <X size={16} style={{ color: '#b91c1c' }} />}
                            </div>
                            {nip05Name && (
                                <p id="su-address-hint" className={nip05Available === false ? 'su-field-error' : 'su-hint'}>
                                    {nip05Available === false ? t('signup.own.addressTaken') : `${nip05Name.toLowerCase()}@buildinelsalvador.com`}
                                </p>
                            )}
                        </div>

                        {COINOS_SIGNUP_WALLET && (
                            <div className="su-wallet">
                                <label className="su-check">
                                    <input
                                        type="checkbox"
                                        checked={enableCoinos}
                                        onChange={(e) => { setEnableCoinos(e.target.checked); setCoinosError(''); }}
                                    />
                                    {t('signup.own.walletLabel')}
                                </label>
                                <p className="su-hint">{t('signup.own.walletHint')}</p>
                                {enableCoinos && (
                                    <div className="su-group su-mt">
                                        <input
                                            type="text"
                                            className="su-input"
                                            placeholder={t('signup.own.walletPlaceholder')}
                                            value={coinosUsername}
                                            onChange={(e) => { setCoinosUsername(e.target.value.replace(/[^a-zA-Z0-9]/g, '')); setCoinosError(''); }}
                                            maxLength={24}
                                            aria-label={t('signup.own.walletPlaceholder')}
                                            aria-invalid={!!coinosError || undefined}
                                        />
                                        {coinosUsername && <p className="su-hint">{t('signup.own.walletAddress')} <strong>{coinosUsername}@coinos.io</strong></p>}
                                        {coinosError && <p className="su-field-error" role="alert">{coinosError}</p>}
                                    </div>
                                )}
                            </div>
                        )}

                        <button type="submit" className="su-btn su-btn-primary" disabled={submitting || !profile.name.trim()}>
                            {submitting ? <Loader2 size={18} className="spin" /> : null}
                            {t('signup.own.enter')} {!submitting && <ArrowRight size={18} />}
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
                .signup-invite {
                    display: flex; align-items: center; justify-content: center; gap: 0.4rem; flex-wrap: wrap;
                    background: var(--color-green-tint); color: var(--color-success-text);
                    border: 1px solid #BBF7D0; border-radius: 0.75rem; padding: 0.55rem 0.75rem;
                    font-size: 0.85rem; font-weight: 600; margin-bottom: 1.25rem;
                }
                .signup-invite code { font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-weight: 700; letter-spacing: 0.04em; }
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
                    font-size: 0.95rem;
                    border-radius: 1rem;
                    background: transparent;
                    transition: all 0.2s;
                }
                .btn-outline:hover { background: var(--color-gray-100); color: var(--color-gray-900); }
                .btn-outline:disabled { opacity: 0.5; pointer-events: none; }

                /* Create-your-own-key steps, as the newer forms draw them */
                .su-step { width: 100%; display: flex; flex-direction: column; }
                .su-title { display: flex; align-items: center; justify-content: center; gap: 0.5rem; margin: 0 0 0.4rem; font-size: 1.4rem; font-weight: 700; text-align: center; color: var(--color-gray-900); }
                .su-title-warn { color: #b91c1c; }
                .su-sub { margin: 0 0 1.25rem; text-align: center; font-size: 0.92rem; line-height: 1.5; color: var(--color-gray-500); }
                .su-keys { display: flex; flex-direction: column; gap: 0.6rem; margin-bottom: 1rem; }
                .su-key {
                    display: flex; align-items: center; gap: 0.5rem; padding: 0.7rem 0.85rem; border-radius: var(--radius-md);
                    background: var(--color-gray-100); border: 1px solid var(--color-gray-200); min-width: 0;
                }
                .su-key-secret { background: var(--color-red-tint); border-color: #fecaca; color: #b91c1c; }
                .su-key-label { flex: none; font-size: 0.72rem; font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase; color: var(--color-gray-500); }
                .su-key-secret .su-key-label { color: #b91c1c; }
                .su-key-value { flex: 1; min-width: 0; text-align: center; font-family: var(--font-mono, monospace); font-size: 0.85rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .su-copy {
                    flex: none; display: inline-flex; align-items: center; gap: 0.3rem; min-height: 0; padding: 0.3rem 0.5rem;
                    border: none; background: none; color: var(--color-primary); font-size: 0.82rem; font-weight: 700; cursor: pointer;
                }
                .su-key-secret .su-copy { color: inherit; }
                .su-seed { border: 1px solid var(--color-gray-200); border-radius: var(--radius-lg); overflow: hidden; margin-bottom: 1rem; background: var(--color-surface); }
                .su-seed-toggle {
                    width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.75rem 1rem;
                    border: none; background: none; color: var(--color-gray-900); font-size: 0.92rem; font-weight: 700; cursor: pointer;
                }
                .su-seed-toggle > span:first-child { display: inline-flex; align-items: center; gap: 0.5rem; }
                .su-seed-toggle > span:first-child :global(svg) { color: #b91c1c; }
                .su-seed.open .su-seed-toggle { border-bottom: 1px solid var(--color-gray-200); }
                .su-chevron { display: inline-flex; padding: 4px; border-radius: 50%; background: var(--color-gray-100); color: var(--color-gray-500); }
                .su-seed-body { padding: 1rem; }
                .su-seed-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.75rem; }
                .su-seed-label { font-size: 0.75rem; font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase; color: #b91c1c; }
                .su-words {
                    list-style: none; margin: 0; padding: 0.9rem; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.6rem;
                    background: var(--color-red-tint); border: 1px solid #fecaca; border-radius: var(--radius-md);
                    font-family: var(--font-mono, monospace); font-size: 0.9rem; font-weight: 500; color: #b91c1c;
                }
                .su-words li { white-space: nowrap; }
                .su-word-n { color: #f87171; font-size: 0.75rem; }
                /* Phones: two columns, so a word stays beside its number */
                @media (max-width: 440px) { .su-words { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
                .su-backup { border-top: 1px solid var(--color-gray-200); padding-top: 0.9rem; margin-bottom: 0.9rem; display: flex; flex-direction: column; gap: 0.5rem; }
                .su-backup-title { margin: 0; font-size: 0.92rem; font-weight: 700; color: var(--color-gray-700); }
                .su-group { margin-bottom: 1.1rem; min-width: 0; }
                .su-mt { margin: 0.6rem 0 0; }
                .su-label { display: block; font-size: 0.85rem; font-weight: 600; color: var(--color-gray-700); margin-bottom: 0.4rem; }
                .su-input {
                    width: 100%; box-sizing: border-box; padding: 0.65rem 0.9rem; border: 1px solid var(--color-gray-300); border-radius: var(--radius-md);
                    background: var(--color-surface); color: inherit; font: inherit; font-size: 0.95rem; outline: none;
                    transition: border-color 0.2s, box-shadow 0.2s;
                }
                .su-input:focus { border-color: var(--color-primary); box-shadow: 0 0 0 3px rgba(0, 71, 171, 0.1); }
                .su-input[aria-invalid='true'] { border-color: #b91c1c; }
                .su-address { display: flex; align-items: center; gap: 0.4rem; }
                .su-icon-input { position: relative; flex: 1; min-width: 0; }
                .su-icon-input > :global(svg) { position: absolute; left: 0.8rem; top: 50%; transform: translateY(-50%); color: var(--color-gray-400); pointer-events: none; }
                .su-icon-input .su-input { padding-left: 2.3rem; }
                .su-hint { margin: 0.35rem 0 0; font-size: 0.8rem; line-height: 1.45; color: var(--color-gray-500); }
                .su-center { text-align: center; }
                .su-field-error { margin: 0.35rem 0 0; font-size: 0.82rem; font-weight: 600; color: #b91c1c; }
                .su-error {
                    display: flex; align-items: center; gap: 0.5rem; padding: 0.75rem 1rem; margin-bottom: 1rem; border-radius: var(--radius-md);
                    background: var(--color-red-tint); color: var(--color-error, #B91C1C); font-size: 0.9rem;
                }
                .su-wallet { margin-bottom: 1.1rem; padding: 0.85rem; border: 1px solid var(--color-gray-200); border-radius: var(--radius-md); background: var(--color-surface); }
                .su-check { display: flex; align-items: center; gap: 0.5rem; font-size: 0.92rem; font-weight: 600; color: var(--color-gray-700); cursor: pointer; }
                .su-check input { width: 18px; height: 18px; margin: 0; accent-color: #f7931a; flex: none; }
                .su-btn {
                    width: 100%; display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem; min-height: 46px; padding: 0 1.25rem;
                    border-radius: var(--radius-full); font-size: 0.98rem; font-weight: 700; cursor: pointer;
                }
                .su-btn:disabled { opacity: 0.55; cursor: default; }
                .su-btn-primary { border: none; background: var(--color-primary); color: white; }
                .su-btn-outline { border: 1px solid var(--color-gray-300); background: var(--color-surface); color: var(--color-gray-700); }
                .su-muted { color: var(--color-gray-400); }

                /* :global() for the icon components: styled-jsx only scopes plain elements */
                .signup-card :global(.spin) {
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
