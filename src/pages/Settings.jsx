import React, { useState, useEffect, useCallback } from 'react';
import { Moon, Bell, Lock, Globe, Eye, Zap, LayoutGrid, Play, Key, Copy, CheckCircle, EyeOff, AlertTriangle, Fingerprint, Smartphone, Wallet, Trash2, UserCog } from 'lucide-react';
import { Link } from 'react-router-dom';
import { nip19 } from 'nostr-tools';
import WalletConnect from '../components/WalletConnect';
import { useTheme } from '../context/ThemeContext';
import { useViewPreference } from '../context/ViewContext';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { useFeature } from '../context/FeatureFlagsContext';
import { investorApi, preferencesApi, notificationsApi } from '../services/api';
import { requestNotificationPermission, subscribeToPush, unsubscribeFromPush, getPushSubscriptionState } from '../utils/notificationManager';
import { nostrSigner } from '../services/nostrSigner';
import { keytrService, isLikelyExtensionInterference, isPrfUnsupportedError } from '../services/keytrService';
import { PASSKEY_ENABLED, CUSTOM_BOTTOM_NAV_ENABLED } from '../config/featureFlags';
import { isNativePlatform } from '../utils/platform';

const Settings = () => {
    const { theme, setTheme } = useTheme();
    const { defaultView, setDefaultView } = useViewPreference();
    const [projectsView, setProjectsView] = useState(() => localStorage.getItem('bies_projects_view') || defaultView || 'list');
    const [membersView, setMembersView] = useState(() => localStorage.getItem('bies_members_view') || defaultView || 'list');
    const [eventsView, setEventsView] = useState(() => localStorage.getItem('bies_events_view') || defaultView || 'list');
    const [mediaView, setMediaView] = useState(() => localStorage.getItem('bies_media_view') || 'card');

    // Load preferences from backend on mount (restores after logout/login)
    useEffect(() => {
        preferencesApi.get().then(prefs => {
            if (prefs.theme && prefs.theme !== theme) setTheme(prefs.theme);
            if (prefs.language && prefs.language !== i18n.language) i18n.changeLanguage(prefs.language);
            if (prefs.projectsView) { setProjectsView(prefs.projectsView); localStorage.setItem('bies_projects_view', prefs.projectsView); setDefaultView(prefs.projectsView); }
            if (prefs.membersView) { setMembersView(prefs.membersView); localStorage.setItem('bies_members_view', prefs.membersView); }
            if (prefs.eventsView) { setEventsView(prefs.eventsView); localStorage.setItem('bies_events_view', prefs.eventsView); }
            if (prefs.mediaView) { setMediaView(prefs.mediaView); localStorage.setItem('bies_media_view', prefs.mediaView); }
        }).catch(() => {});
    }, []);

    // Save a preference to both localStorage and backend
    const savePref = useCallback((key, value) => {
        localStorage.setItem(key, value);
        const prefKey = key.replace('bies_', '').replace(/_([a-z])/g, (_, c) => c.toUpperCase()); // bies_projects_view → projectsView
        preferencesApi.save({ [prefKey]: value }).catch(() => {});
    }, []);

    const handleViewChange = (key, setter) => (e) => {
        const v = e.target.value;
        setter(v);
        savePref(key, v);
        if (key === 'bies_projects_view') setDefaultView(v);
    };
    const { t, i18n } = useTranslation();

    const handleLanguageChange = (e) => {
        i18n.changeLanguage(e.target.value);
        preferencesApi.save({ language: e.target.value }).catch(() => {});
    };

    const { user } = useAuth();
    const zapsOn = useFeature('zaps');
    const [investorMessage, setInvestorMessage] = React.useState('');
    const [submittingInvestor, setSubmittingInvestor] = React.useState(false);
    const [investorRequested, setInvestorRequested] = React.useState(false);
    const [investorError, setInvestorError] = React.useState('');

    // Push notification state: unsupported | denied | prompt | subscribed | unsubscribed
    const [pushState, setPushState] = useState('unsupported');

    useEffect(() => {
        (async () => {
            if (!('PushManager' in window)) { setPushState('unsupported'); return; }
            if (typeof Notification === 'undefined') { setPushState('unsupported'); return; }
            if (Notification.permission === 'denied') { setPushState('denied'); return; }
            if (Notification.permission === 'default') { setPushState('prompt'); return; }
            const { subscribed } = await getPushSubscriptionState();
            setPushState(subscribed ? 'subscribed' : 'unsubscribed');
        })();
    }, []);

    const handleTogglePush = async () => {
        if (pushState === 'subscribed') {
            const endpoint = await unsubscribeFromPush();
            if (endpoint) await notificationsApi.pushUnsubscribe(endpoint).catch(() => {});
            setPushState('unsubscribed');
        } else {
            if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
                const perm = await requestNotificationPermission();
                if (perm !== 'granted') { setPushState('denied'); return; }
            }
            try {
                const { publicKey } = await notificationsApi.getVapidKey();
                const sub = await subscribeToPush(publicKey);
                if (sub) {
                    await notificationsApi.pushSubscribe(sub);
                    setPushState('subscribed');
                }
            } catch {
                // Push registration failed
            }
        }
    };

    // Nostr key management state
    const [nsecRevealed, setNsecRevealed] = useState(false);
    const [nsecValue, setNsecValue] = useState(null);
    const [nsecLoading, setNsecLoading] = useState(false);
    const [nsecError, setNsecError] = useState('');
    const [copiedKey, setCopiedKey] = useState(null);

    // Passkey management state
    const [passkeySupported, setPasskeySupported] = useState(false);
    const [prfSupport, setPrfSupport] = useState({ supported: true });
    const [hasPasskey, setHasPasskey] = useState(() => keytrService.hasCredential(user?.nostrPubkey));
    const [savingPasskey, setSavingPasskey] = useState(false);
    const [savingBackup, setSavingBackup] = useState(false);
    const [removingPasskey, setRemovingPasskey] = useState(false);
    const [passkeyError, setPasskeyError] = useState('');
    const [passkeySuccess, setPasskeySuccess] = useState('');

    React.useEffect(() => {
        // WebAuthn does not exist in WKWebView (Capacitor native shell)
        if (typeof PublicKeyCredential === 'undefined' || isNativePlatform()) return;
        keytrService.checkSupport().then(setPasskeySupported);
        // PRF gates registration only (keytr 0.8.0 is PRF-only for new passkeys);
        // login/remove of existing credentials stays available regardless.
        keytrService.checkPrfSupport().then(setPrfSupport);
    }, []);

    const npub = user?.nostrPubkey ? nip19.npubEncode(user.nostrPubkey) : null;
    const loginMethod = nostrSigner.storedMethod; // 'extension' | 'nsec' | 'bunker' | 'amber' | 'hosted' | null

    const copyToClipboard = useCallback((text, label) => {
        navigator.clipboard.writeText(text);
        setCopiedKey(label);
        setTimeout(() => setCopiedKey(null), 2000);
    }, []);

    const handleRevealNsec = useCallback(async () => {
        setNsecError('');
        // Key already in memory
        const inMemory = nostrSigner.getNsec();
        if (inMemory) {
            setNsecValue(inMemory);
            setNsecRevealed(true);
            return;
        }
        // Try re-acquiring via passkey (unavailable in the native WKWebView shell)
        if (PASSKEY_ENABLED && typeof PublicKeyCredential !== 'undefined' && !isNativePlatform() && keytrService.hasCredential()) {
            setNsecLoading(true);
            try {
                const nsec = await keytrService.loginWithPasskey();
                nostrSigner.setNsec(nsec);
                setNsecValue(nsec);
                setNsecRevealed(true);
            } catch {
                setNsecError('Passkey authentication failed. Try logging in again with your nsec or seed phrase to access your key.');
            } finally {
                setNsecLoading(false);
            }
            return;
        }
        setNsecError('Your secret key is not available in this session. Log in with your nsec or seed phrase, or use your passkey to reveal it.');
    }, []);

    const handleHideNsec = useCallback(() => {
        setNsecRevealed(false);
        setNsecValue(null);
    }, []);

    const getNsecForPasskey = useCallback(() => {
        const nsec = nsecValue || nostrSigner.getNsec();
        if (!nsec) {
            setPasskeyError('Reveal your secret key first so it can be encrypted with your passkey.');
            return null;
        }
        return nsec;
    }, [nsecValue]);

    const handleSavePasskey = useCallback(async () => {
        setPasskeyError('');
        setPasskeySuccess('');
        const nsec = getNsecForPasskey();
        if (!nsec) return;
        setSavingPasskey(true);
        try {
            await keytrService.saveWithPasskey(nsec, user.nostrPubkey);
            setHasPasskey(true);
            setPasskeySuccess('Passkey saved! Your key is encrypted and stored on Nostr relays.');
        } catch (err) {
            if (isPrfUnsupportedError(err)) {
                setPasskeyError("This device can't create passkeys (missing PRF support). Try a device with a fingerprint or face sensor.");
            } else if (!err.cancelled) {
                setPasskeyError(err.message || 'Failed to save passkey.');
            }
        } finally {
            setSavingPasskey(false);
        }
    }, [getNsecForPasskey, user?.nostrPubkey]);

    const handleAddBackupGateway = useCallback(async () => {
        setPasskeyError('');
        setPasskeySuccess('');
        const nsec = getNsecForPasskey();
        if (!nsec) return;
        setSavingBackup(true);
        try {
            await keytrService.addBackupGateway(nsec, user.nostrPubkey);
            setPasskeySuccess('Backup gateway added (nostkey.org). You now have redundant passkey recovery.');
        } catch (err) {
            if (isPrfUnsupportedError(err)) {
                setPasskeyError("This device can't create passkeys (missing PRF support). Try a device with a fingerprint or face sensor.");
            } else if (!err.cancelled) {
                setPasskeyError(err.message || 'Failed to add backup gateway.');
            }
        } finally {
            setSavingBackup(false);
        }
    }, [getNsecForPasskey, user?.nostrPubkey]);

    const handleRemovePasskey = useCallback(() => {
        setPasskeyError('');
        setPasskeySuccess('');
        setRemovingPasskey(true);
        try {
            keytrService.removeCredential(user.nostrPubkey);
            setHasPasskey(false);
            setPasskeySuccess('Passkey credential removed from this device.');
        } catch (err) {
            setPasskeyError(err.message || 'Failed to remove passkey.');
        } finally {
            setRemovingPasskey(false);
        }
    }, [user?.nostrPubkey]);

    const handleApplyInvestor = async () => {
        if (!user) return;
        setSubmittingInvestor(true);
        setInvestorError('');
        try {
            await investorApi.requestRole({ message: investorMessage });
            setInvestorRequested(true);
        } catch (err) {
            setInvestorError(err.message || 'Failed to submit application.');
        } finally {
            setSubmittingInvestor(false);
        }
    };

    return (
        <div className="container py-8 max-w-3xl" style={{ paddingTop: '1.5rem' }}>
            <h1 className="mb-8 page-title-block">{t('settings.title')}</h1>

            <div className="settings-section">
                <h2>{t('settings.preferences')}</h2>
                <div className="setting-item">
                    <div className="setting-info">
                        <div className="icon-box"><Moon size={20} /></div>
                        <div>
                            <p className="setting-label">{t('settings.darkMode')}</p>
                            <p className="setting-desc">{t('settings.darkModeDesc')}</p>
                        </div>
                    </div>
                    <select
                        className="select-input"
                        value={theme}
                        onChange={(e) => { setTheme(e.target.value); preferencesApi.save({ theme: e.target.value }).catch(() => {}); }}
                    >
                        <option value="light">{t('settings.light')}</option>
                        <option value="dark">{t('settings.dark')}</option>
                        <option value="system">{t('settings.system')}</option>
                    </select>
                </div>
                <div className="setting-item">
                    <div className="setting-info">
                        <div className="icon-box"><Globe size={20} /></div>
                        <div>
                            <p className="setting-label">{t('settings.language')}</p>
                            <p className="setting-desc">{t('settings.languageDesc')}</p>
                        </div>
                    </div>
                    <select
                        className="select-input"
                        value={i18n.language?.startsWith('es') ? 'es' : 'en'}
                        onChange={handleLanguageChange}
                    >
                        <option value="en">English</option>
                        <option value="es">Espanol</option>
                    </select>
                </div>
                <div className="setting-item">
                    <div className="setting-info">
                        <div className="icon-box"><LayoutGrid size={20} /></div>
                        <div>
                            <p className="setting-label">Projects View</p>
                            <p className="setting-desc">Default layout for the Discover projects page</p>
                        </div>
                    </div>
                    <select className="select-input" value={projectsView} onChange={handleViewChange('bies_projects_view', setProjectsView)}>
                        <option value="list">List</option>
                        <option value="standard">Grid</option>
                    </select>
                </div>
                <div className="setting-item">
                    <div className="setting-info">
                        <div className="icon-box"><Eye size={20} /></div>
                        <div>
                            <p className="setting-label">Members View</p>
                            <p className="setting-desc">Default layout for the Discover members page</p>
                        </div>
                    </div>
                    <select className="select-input" value={membersView} onChange={handleViewChange('bies_members_view', setMembersView)}>
                        <option value="list">List</option>
                        <option value="standard">Cards</option>
                        <option value="icons">Icons</option>
                    </select>
                </div>
                <div className="setting-item">
                    <div className="setting-info">
                        <div className="icon-box"><LayoutGrid size={20} /></div>
                        <div>
                            <p className="setting-label">Events View</p>
                            <p className="setting-desc">Default layout for the Events page</p>
                        </div>
                    </div>
                    <select className="select-input" value={eventsView} onChange={handleViewChange('bies_events_view', setEventsView)}>
                        <option value="list">List</option>
                        <option value="standard">Grid</option>
                    </select>
                </div>
                <div className="setting-item">
                    <div className="setting-info">
                        <div className="icon-box"><Play size={20} /></div>
                        <div>
                            <p className="setting-label">Media View</p>
                            <p className="setting-desc">Default layout for the Media page</p>
                        </div>
                    </div>
                    <select className="select-input" value={mediaView} onChange={handleViewChange('bies_media_view', setMediaView)}>
                        <option value="card">Cards</option>
                        <option value="list">List</option>
                        <option value="icon">Icons</option>
                    </select>
                </div>
            </div>

            {CUSTOM_BOTTOM_NAV_ENABLED && (
            <div className="settings-section">
                <h2>{t('customNav.sectionTitle')}</h2>
                <div className="setting-item">
                    <div className="setting-info">
                        <div className="icon-box"><Smartphone size={20} /></div>
                        <div>
                            <p className="setting-label">{t('customNav.settingLabel')}</p>
                            <p className="setting-desc">{t('customNav.settingDesc')}</p>
                        </div>
                    </div>
                    <Link to="/settings/navbar" className="toggle-btn" data-testid="customize-nav-link" style={{ width: 'auto', textDecoration: 'none', textAlign: 'center', whiteSpace: 'nowrap' }}>
                        {t('customNav.customize')}
                    </Link>
                </div>
            </div>
            )}

            <div className="settings-section">
                <h2>{t('settings.notifications')}</h2>
                <div className="setting-item">
                    <div className="setting-info">
                        <div className="icon-box"><Bell size={20} /></div>
                        <div>
                            <p className="setting-label">{t('settings.emailNotifications')}</p>
                            <p className="setting-desc">{t('settings.emailNotificationsDesc')}</p>
                        </div>
                    </div>
                    <button className="toggle-btn active">{t('common.on')}</button>
                </div>
                <div className="setting-item">
                    <div className="setting-info">
                        <div className="icon-box"><Bell size={20} /></div>
                        <div>
                            <p className="setting-label">Push Notifications</p>
                            <p className="setting-desc">
                                {pushState === 'unsupported' && 'Not supported on this browser'}
                                {pushState === 'denied' && 'Blocked in browser settings'}
                                {pushState === 'prompt' && 'Get notified when the app is closed'}
                                {pushState === 'subscribed' && 'Receiving push notifications'}
                                {pushState === 'unsubscribed' && 'Not receiving push notifications'}
                            </p>
                        </div>
                    </div>
                    <button
                        className={`toggle-btn ${pushState === 'subscribed' ? 'active' : ''}`}
                        disabled={pushState === 'unsupported' || pushState === 'denied'}
                        onClick={handleTogglePush}
                    >
                        {pushState === 'subscribed' ? t('common.on') : t('common.off')}
                    </button>
                </div>
                <div className="setting-item">
                    <div className="setting-info">
                        <div className="icon-box"><Eye size={20} /></div>
                        <div>
                            <p className="setting-label">{t('settings.profileVisibility')}</p>
                            <p className="setting-desc">{t('settings.profileVisibilityDesc')}</p>
                        </div>
                    </div>
                    <button className="toggle-btn active">{t('common.on')}</button>
                </div>
            </div>

            <div className="settings-section">
                <h2>Account Roles</h2>
                {user?.role === 'INVESTOR' ? (
                    <div className="setting-item">
                        <div className="setting-info">
                            <div className="icon-box" style={{ background: 'var(--color-primary-light)', color: 'white' }}><Globe size={20} /></div>
                            <div>
                                <p className="setting-label">Investor Status</p>
                                <p className="setting-desc">You are currently verified as an Investor.</p>
                            </div>
                        </div>
                        <span className="badge-shield" style={{ position: 'static', padding: '4px 12px', background: 'var(--color-primary)', color: 'white', borderRadius: '99px', fontSize: '0.85rem' }}>Verified</span>
                    </div>
                ) : (
                    <div className="setting-item" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '1rem' }}>
                        <div className="setting-info" style={{ width: '100%' }}>
                            <div className="icon-box"><Globe size={20} /></div>
                            <div>
                                <p className="setting-label">Apply for Investor Role</p>
                                <p className="setting-desc">Investors must be vetted. Submit an application to gain the Investor badge.</p>
                            </div>
                        </div>
                        {investorRequested ? (
                            <div style={{ background: 'var(--color-green-tint)', color: 'var(--color-green-700)', padding: '0.75rem 1rem', borderRadius: '12px', width: '100%', fontSize: '0.9rem', fontWeight: 500 }}>
                                Your application has been submitted and is pending review!
                            </div>
                        ) : (
                            <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                                <textarea
                                    className="select-input"
                                    placeholder="Briefly describe your investment focus or background (optional)"
                                    value={investorMessage}
                                    onChange={(e) => setInvestorMessage(e.target.value)}
                                    rows={3}
                                    style={{ width: '100%', resize: 'none', fontFamily: 'inherit' }}
                                />
                                {investorError && <p style={{ color: 'var(--color-danger)', fontSize: '0.85rem', margin: 0 }}>{investorError}</p>}
                                <button
                                    onClick={handleApplyInvestor}
                                    disabled={submittingInvestor}
                                    className="btn btn-outline btn-sm"
                                    style={{ alignSelf: 'flex-end', marginLeft: 'auto' }}
                                >
                                    {submittingInvestor ? 'Submitting...' : 'Submit Request'}
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </div>


            <div className="settings-section">
                <h2>{t('settings.security')}</h2>
                <div className="setting-item">
                    <div className="setting-info">
                        <div className="icon-box"><Lock size={20} /></div>
                        <div>
                            <p className="setting-label">{t('settings.changePassword')}</p>
                            <p className="setting-desc">{t('settings.changePasswordDesc')}</p>
                        </div>
                    </div>
                    <button className="btn btn-outline btn-sm">{t('common.update')}</button>
                </div>
            </div>

            <div className="settings-section">
                <h2><Zap size={16} /> {t('settings.lightningWallet')}</h2>
                {zapsOn && (
                    <div className="setting-item">
                        <div className="setting-info">
                            <div className="icon-box"><Wallet size={20} /></div>
                            <div>
                                <p className="setting-label">{t('settings.openWalletLabel', 'BIES Wallet')}</p>
                                <p className="setting-desc">{t('settings.openWalletDesc', 'Check your balance, send and receive sats')}</p>
                            </div>
                        </div>
                        <Link to="/wallet" className="btn btn-outline btn-sm" data-testid="settings-open-wallet" style={{ textDecoration: 'none', whiteSpace: 'nowrap' }}>
                            <Wallet size={14} style={{ marginRight: '0.4rem' }} /> {t('settings.openWallet', 'Open wallet')}
                        </Link>
                    </div>
                )}
                <div className="setting-item">
                    <WalletConnect />
                </div>
            </div>

            {npub && (
            <div className="settings-section">
                <h2><Key size={16} /> Nostr Keys</h2>

                {/* Public Key (npub) */}
                <div className="setting-item" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '0.75rem' }}>
                    <div className="setting-info" style={{ width: '100%' }}>
                        <div className="icon-box"><Globe size={20} /></div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <p className="setting-label">Public Key (npub)</p>
                            <p className="setting-desc">Your Nostr public identity</p>
                        </div>
                    </div>
                    <div className="key-display">
                        <code className="key-value">{npub}</code>
                        <button onClick={() => copyToClipboard(npub, 'npub')} className="key-copy-btn">
                            {copiedKey === 'npub' ? <><CheckCircle size={14} /> Copied</> : <><Copy size={14} /> Copy</>}
                        </button>
                    </div>
                </div>

                {/* Secret Key (nsec) */}
                <div className="setting-item" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '0.75rem' }}>
                    <div className="setting-info" style={{ width: '100%' }}>
                        <div className="icon-box" style={{ background: 'var(--color-danger-light, #fef2f2)', color: 'var(--color-danger, #dc2626)' }}><Lock size={20} /></div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <p className="setting-label">Secret Key (nsec)</p>
                            <p className="setting-desc">
                                {loginMethod === 'extension'
                                    ? 'Your key is managed by your browser extension'
                                    : loginMethod === 'bunker'
                                    ? 'Your key is managed by your remote signer'
                                    : loginMethod === 'amber'
                                    ? 'Your key is managed by the Amber app on this device'
                                    : loginMethod === 'hosted'
                                    ? 'BIES holds your key for you'
                                    : 'Reveal your private key for backup'}
                            </p>
                        </div>
                    </div>

                    {loginMethod === 'extension' ? (
                        <div className="key-info-banner">
                            <AlertTriangle size={16} />
                            <span>Your secret key lives in your Nostr browser extension. Check your extension settings to export it.</span>
                        </div>
                    ) : loginMethod === 'bunker' ? (
                        <div className="key-info-banner">
                            <AlertTriangle size={16} />
                            <span>Your secret key is held by your remote signer (NIP-46). Check your signer app to manage it.</span>
                        </div>
                    ) : loginMethod === 'amber' ? (
                        <div className="key-info-banner">
                            <AlertTriangle size={16} />
                            <span>Your secret key is held by the Amber app (NIP-55). Open Amber to manage or export it.</span>
                        </div>
                    ) : loginMethod === 'hosted' ? (
                        <div className="key-info-banner">
                            <AlertTriangle size={16} />
                            <span>
                                You signed up with your email, so BIES keeps your secret key on its server and signs for you. It never comes to this device.{' '}
                                <Link to="/settings/your-key">{t('account.takeKeyButton')}</Link>
                            </span>
                        </div>
                    ) : nsecRevealed && nsecValue ? (
                        <>
                            <div className="key-warning">
                                <AlertTriangle size={14} />
                                <span>Never share your nsec. Anyone with this key has full control of your Nostr identity.</span>
                            </div>
                            <div className="key-display">
                                <code className="key-value nsec-value">{nsecValue}</code>
                                <button onClick={() => copyToClipboard(nsecValue, 'nsec')} className="key-copy-btn">
                                    {copiedKey === 'nsec' ? <><CheckCircle size={14} /> Copied</> : <><Copy size={14} /> Copy</>}
                                </button>
                            </div>
                            <button onClick={handleHideNsec} className="btn btn-outline btn-sm" style={{ alignSelf: 'flex-end' }}>
                                <EyeOff size={14} style={{ marginRight: '0.4rem' }} /> Hide Key
                            </button>
                        </>
                    ) : (
                        <>
                            {nsecError && <p className="key-error">{nsecError}</p>}
                            <button onClick={handleRevealNsec} disabled={nsecLoading} className="btn btn-outline btn-sm btn-danger-outline">
                                {nsecLoading ? (
                                    <><Fingerprint size={14} style={{ marginRight: '0.4rem' }} /> Authenticating...</>
                                ) : (
                                    <><Eye size={14} style={{ marginRight: '0.4rem' }} /> Reveal Secret Key</>
                                )}
                            </button>
                        </>
                    )}
                </div>

                {/* Passkey Quick Login (keytr) — hidden on native (no WebAuthn
                    in WKWebView) and for sessions with no in-browser nsec:
                    external signers (extension/bunker/amber) and email
                    accounts (hosted). */}
                {PASSKEY_ENABLED && !isNativePlatform() && loginMethod !== 'extension' && loginMethod !== 'bunker' && loginMethod !== 'amber' && loginMethod !== 'hosted' && (
                <div className="setting-item" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '0.75rem' }}>
                    <div className="setting-info" style={{ width: '100%' }}>
                        <div className="icon-box" style={{ background: 'var(--color-primary-light, #eff6ff)', color: 'var(--color-primary)' }}><Fingerprint size={20} /></div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <p className="setting-label">Passkey Quick Login</p>
                            <p className="setting-desc">
                                {hasPasskey
                                    ? 'Your key is encrypted with a passkey via keytr.org'
                                    : 'Save your key to a passkey for quick biometric login on any device'}
                            </p>
                        </div>
                    </div>

                    {!passkeySupported ? (
                        <div className="key-info-banner">
                            <AlertTriangle size={16} />
                            <span>Your browser or device does not support passkeys. Try a modern browser like Chrome, Edge, or Safari.</span>
                        </div>
                    ) : !prfSupport.supported && !hasPasskey ? (
                        <div className="key-info-banner">
                            <AlertTriangle size={16} />
                            <span>This device can't create new passkeys (missing PRF support). Try a device with a fingerprint or face sensor.</span>
                        </div>
                    ) : hasPasskey ? (
                        <>
                            <div className="passkey-status">
                                <CheckCircle size={14} />
                                <span>Passkey active for this account</span>
                            </div>
                            {passkeySuccess && <p className="passkey-success">{passkeySuccess}</p>}
                            {passkeyError && (
                                <>
                                    <p className="key-error">{passkeyError}</p>
                                    {isLikelyExtensionInterference(passkeyError) && (
                                        <div className="key-info-banner">
                                            <AlertTriangle size={16} />
                                            <span>This error is usually caused by a password manager browser extension (such as Bitwarden, 1Password, or Dashlane) intercepting the passkey request. Try disabling your password manager's passkey/WebAuthn feature and retry.</span>
                                        </div>
                                    )}
                                </>
                            )}
                            {!prfSupport.supported && (
                                <div className="key-info-banner">
                                    <AlertTriangle size={16} />
                                    <span>This device can't create new passkeys (missing PRF support). Your existing passkey still works for login.</span>
                                </div>
                            )}
                            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                                <button onClick={handleAddBackupGateway} disabled={savingBackup || !prfSupport.supported} className="btn btn-outline btn-sm">
                                    {savingBackup ? (
                                        <><Fingerprint size={14} style={{ marginRight: '0.4rem' }} /> Saving...</>
                                    ) : (
                                        <><Fingerprint size={14} style={{ marginRight: '0.4rem' }} /> Add Backup Gateway</>
                                    )}
                                </button>
                                <button onClick={handleRemovePasskey} disabled={removingPasskey} className="btn btn-outline btn-sm btn-danger-outline">
                                    Remove Passkey
                                </button>
                            </div>
                        </>
                    ) : (
                        <>
                            {passkeySuccess && <p className="passkey-success">{passkeySuccess}</p>}
                            {passkeyError && (
                                <>
                                    <p className="key-error">{passkeyError}</p>
                                    {isLikelyExtensionInterference(passkeyError) && (
                                        <div className="key-info-banner">
                                            <AlertTriangle size={16} />
                                            <span>This error is usually caused by a password manager browser extension (such as Bitwarden, 1Password, or Dashlane) intercepting the passkey request. Try disabling your password manager's passkey/WebAuthn feature and retry.</span>
                                        </div>
                                    )}
                                </>
                            )}
                            <button onClick={handleSavePasskey} disabled={savingPasskey} className="btn btn-outline btn-sm">
                                {savingPasskey ? (
                                    <><Fingerprint size={14} style={{ marginRight: '0.4rem' }} /> Saving...</>
                                ) : (
                                    <><Fingerprint size={14} style={{ marginRight: '0.4rem' }} /> Save to Passkey</>
                                )}
                            </button>
                            <p className="setting-desc" style={{ fontSize: '0.8rem', lineHeight: 1.4 }}>
                                Your key is encrypted with your passkey and stored on Nostr relays via keytr.org. You can recover it from any device using the same passkey.
                            </p>
                        </>
                    )}
                </div>
                )}
            </div>
            )}

            <div className="settings-section">
                <h2><UserCog size={16} /> {t('account.sectionTitle')}</h2>
                {user?.hostedKey && (
                    <div className="setting-item">
                        <div className="setting-info">
                            <div className="icon-box"><Key size={20} /></div>
                            <div>
                                <p className="setting-label">{t('account.takeKeyLabel')}</p>
                                <p className="setting-desc">{t('account.takeKeyDesc')}</p>
                            </div>
                        </div>
                        <Link to="/settings/your-key" className="btn btn-outline btn-sm" data-testid="settings-take-key" style={{ textDecoration: 'none', whiteSpace: 'nowrap' }}>
                            {t('account.takeKeyButton')}
                        </Link>
                    </div>
                )}
                <div className="setting-item">
                    <div className="setting-info">
                        <div className="icon-box" style={{ background: 'var(--color-danger-light, #fef2f2)', color: 'var(--color-danger, #dc2626)' }}><Trash2 size={20} /></div>
                        <div>
                            <p className="setting-label">{t('account.deleteLabel')}</p>
                            <p className="setting-desc">{t('account.deleteDesc')}</p>
                        </div>
                    </div>
                    <Link to="/settings/delete-account" className="btn btn-outline btn-sm btn-danger-outline" data-testid="settings-delete-account" style={{ textDecoration: 'none', whiteSpace: 'nowrap' }}>
                        {t('account.deleteButton')}
                    </Link>
                </div>
            </div>

            <div className="version-footer">
                BIES v{__APP_VERSION__}
            </div>

            <style jsx>{`
                .max-w-3xl { max-width: 48rem; }

                .settings-section { background: var(--color-surface); border: 1px solid var(--color-gray-200); border-radius: var(--radius-lg); overflow: hidden; margin-bottom: 2rem; }
                .settings-section h2 { padding: 1rem 1.5rem; background: var(--color-gray-50); border-bottom: 1px solid var(--color-gray-200); font-size: 1rem; color: var(--color-gray-600); }

                .setting-item { padding: 0.75rem 1.5rem; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--color-gray-100); }
                .setting-item:last-child { border-bottom: none; }

                .setting-info { display: flex; align-items: center; gap: 1rem; }
                .icon-box { width: 40px; height: 40px; background: var(--color-gray-100); border-radius: 50%; display: flex; align-items: center; justify-content: center; color: var(--color-gray-600); }

                .setting-label { font-weight: 600; margin-bottom: 2px; }
                .setting-desc { font-size: 0.85rem; color: var(--color-gray-500); }

                .toggle-btn {
                    padding: 0.5rem 1rem;
                    border-radius: 99px;
                    border: 1px solid var(--color-gray-300);
                    background: var(--color-surface);
                    color: var(--color-gray-500);
                    font-size: 0.85rem;
                    cursor: pointer;
                    width: 60px;
                }
                .toggle-btn.active { background: var(--color-primary); color: white; border-color: var(--color-primary); }

                .select-input { padding: 0.5rem; border-radius: var(--radius-md); border: 1px solid var(--color-gray-300); background-color: var(--color-surface); color: var(--color-gray-900); }
                .btn-sm { font-size: 0.85rem; padding: 0.5rem 1rem; }

                .key-display { display: flex; align-items: center; gap: 0.5rem; width: 100%; background: var(--color-gray-50); border: 1px solid var(--color-gray-200); border-radius: var(--radius-md); padding: 0.5rem 0.75rem; overflow: hidden; }
                .key-value { font-size: 0.8rem; word-break: break-all; flex: 1; min-width: 0; color: var(--color-gray-700); background: none; padding: 0; }
                .nsec-value { color: var(--color-danger, #dc2626); }
                .key-copy-btn { display: flex; align-items: center; gap: 0.3rem; font-size: 0.8rem; font-weight: 600; background: transparent; border: none; color: var(--color-primary); cursor: pointer; white-space: nowrap; padding: 0.25rem 0.5rem; border-radius: var(--radius-sm); }
                .key-copy-btn:hover { background: var(--color-gray-100); }

                .key-warning { display: flex; align-items: flex-start; gap: 0.5rem; font-size: 0.8rem; color: var(--color-danger, #dc2626); background: var(--color-danger-light, #fef2f2); padding: 0.6rem 0.75rem; border-radius: var(--radius-md); width: 100%; line-height: 1.4; }
                .key-warning svg { flex-shrink: 0; margin-top: 1px; }

                .key-info-banner { display: flex; align-items: flex-start; gap: 0.5rem; font-size: 0.85rem; color: var(--color-gray-600); background: var(--color-gray-50); padding: 0.75rem; border-radius: var(--radius-md); width: 100%; line-height: 1.4; border: 1px solid var(--color-gray-200); }
                .key-info-banner svg { flex-shrink: 0; margin-top: 2px; color: var(--color-gray-400); }

                .key-error { font-size: 0.8rem; color: var(--color-danger, #dc2626); margin: 0; }

                .btn-danger-outline { border-color: var(--color-danger, #dc2626); color: var(--color-danger, #dc2626); }
                .btn-danger-outline:hover { background: var(--color-danger-light, #fef2f2); }

                .passkey-status { display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem; font-weight: 500; color: var(--color-green-700, #15803d); background: var(--color-green-tint, #f0fdf4); padding: 0.5rem 0.75rem; border-radius: var(--radius-md); width: 100%; }
                .passkey-success { font-size: 0.8rem; color: var(--color-green-700, #15803d); margin: 0; }

                .version-footer { text-align: center; padding: 1.5rem 0 0.5rem; font-size: 0.75rem; color: var(--color-gray-400); letter-spacing: 0.02em; }
            `}</style>
        </div>
    );
};

export default Settings;
