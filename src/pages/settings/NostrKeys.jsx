import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { nip19 } from 'nostr-tools';
import { AlertTriangle, CheckCircle, Copy, Eye, EyeOff, Fingerprint } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { nostrSigner } from '../../services/nostrSigner';
import { keytrService, isLikelyExtensionInterference, isPrfUnsupportedError, isUserCancellation } from '../../services/keytrService';
import { PASSKEY_ENABLED } from '../../config/featureFlags';
import { isNativePlatform } from '../../utils/platform';
import { confirmDeviceOwner } from '../../services/deviceAuth';
import { SettingsPage, SettingsGroup } from '../../components/settings/SettingsUI';

const EXTENSION_HINT = "This error is usually caused by a password manager browser extension (such as Bitwarden, 1Password, or Dashlane) intercepting the passkey request. Try disabling your password manager's passkey/WebAuthn feature and retry.";
const NO_PRF = "This device can't create passkeys (missing PRF support). Try a device with a fingerprint or face sensor.";

/**
 * Settings → Nostr key: the public key to copy, the secret key (revealed
 * on request, or where it's held: an extension, a signer, Amber, or BIES
 * for email accounts), and the passkey backup on the web. Moved here from
 * the Settings page as it was.
 */
const NostrKeys = () => {
    const { t } = useTranslation();
    const { user } = useAuth();
    const npub = user?.nostrPubkey ? nip19.npubEncode(user.nostrPubkey) : null;
    const loginMethod = nostrSigner.storedMethod; // 'extension' | 'nsec' | 'bunker' | 'amber' | 'hosted' | null

    const [nsecRevealed, setNsecRevealed] = useState(false);
    const [nsecValue, setNsecValue] = useState(null);
    const [nsecLoading, setNsecLoading] = useState(false);
    const [nsecError, setNsecError] = useState('');
    const [copiedKey, setCopiedKey] = useState(null);

    const [passkeySupported, setPasskeySupported] = useState(false);
    const [prfSupport, setPrfSupport] = useState({ supported: true });
    const [hasPasskey, setHasPasskey] = useState(() => keytrService.hasCredential(user?.nostrPubkey));
    const [savingPasskey, setSavingPasskey] = useState(false);
    const [savingBackup, setSavingBackup] = useState(false);
    const [removingPasskey, setRemovingPasskey] = useState(false);
    const [confirmRemove, setConfirmRemove] = useState(false);
    const [passkeyError, setPasskeyError] = useState('');
    const [passkeySuccess, setPasskeySuccess] = useState('');

    useEffect(() => {
        // WebAuthn does not exist in WKWebView (Capacitor native shell)
        if (typeof PublicKeyCredential === 'undefined' || isNativePlatform()) return;
        keytrService.checkSupport().then(setPasskeySupported);
        // PRF gates registration only (keytr 0.8.0 is PRF-only for new passkeys);
        // login/remove of existing credentials stays available regardless.
        keytrService.checkPrfSupport().then(setPrfSupport);
    }, []);

    const copyToClipboard = useCallback((text, label) => {
        navigator.clipboard.writeText(text);
        setCopiedKey(label);
        setTimeout(() => setCopiedKey(null), 2000);
    }, []);

    const handleRevealNsec = useCallback(async () => {
        setNsecError('');
        // In the phone app, only for the phone's owner: Face ID or the passcode.
        const owner = await confirmDeviceOwner({ reason: t('account.key.deviceReason'), cancelTitle: t('common.cancel') });
        if (owner === 'no-lock') { setNsecError(t('account.key.deviceNoLock')); return; }
        if (owner !== 'ok') return;
        // Key already in memory
        const inMemory = nostrSigner.getNsec();
        if (inMemory) {
            setNsecValue(inMemory);
            setNsecRevealed(true);
            return;
        }
        // Try re-acquiring via passkey (unavailable in the native WKWebView shell)
        if (PASSKEY_ENABLED && typeof PublicKeyCredential !== 'undefined' && !isNativePlatform() && keytrService.hasCredential(user?.nostrPubkey)) {
            setNsecLoading(true);
            try {
                // Only this account's key — never another account's passkey.
                const nsec = await keytrService.loginWithPasskey({ expectedPubkey: user.nostrPubkey });
                nostrSigner.setNsec(nsec);
                setNsecValue(nsec);
                setNsecRevealed(true);
            } catch (err) {
                if (isUserCancellation(err)) return;
                setNsecError(err.pubkeyMismatch
                    ? 'That passkey belongs to a different account. Choose the passkey for this account, or log in again with your nsec or seed phrase.'
                    : 'Passkey authentication failed. Try logging in again with your nsec or seed phrase to access your key.');
            } finally {
                setNsecLoading(false);
            }
            return;
        }
        setNsecError('Your secret key is not available in this session. Log in with your nsec or seed phrase, or use your passkey to reveal it.');
    }, [t, user?.nostrPubkey]);

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
            if (isPrfUnsupportedError(err)) setPasskeyError(NO_PRF);
            else if (!isUserCancellation(err)) setPasskeyError(err.message || 'Failed to save passkey.');
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
            const added = await keytrService.addBackupGateway(nsec, user.nostrPubkey);
            setPasskeySuccess(`Backup gateways added (${added.map(a => a.gateway).join(', ')}). You now have redundant passkey recovery.`);
        } catch (err) {
            if (isPrfUnsupportedError(err)) setPasskeyError(NO_PRF);
            else if (!isUserCancellation(err)) setPasskeyError(err.message || 'Failed to add backup gateway.');
        } finally {
            setSavingBackup(false);
        }
    }, [getNsecForPasskey, user?.nostrPubkey]);

    // Two clicks: the first arms the button, the second retracts the backup.
    const handleRemovePasskey = useCallback(async () => {
        setPasskeyError('');
        setPasskeySuccess('');
        if (!confirmRemove) { setConfirmRemove(true); return; }
        setConfirmRemove(false);
        setRemovingPasskey(true);
        try {
            await keytrService.removePasskey(user.nostrPubkey);
            setHasPasskey(false);
            setPasskeySuccess('Passkey backup removed: a deletion request was sent to the relays. Also delete the "BIES Account" passkey from your device or password manager.');
        } catch (err) {
            if (!isUserCancellation(err)) setPasskeyError(err.message || 'Failed to remove passkey.');
        } finally {
            setRemovingPasskey(false);
        }
    }, [confirmRemove, user?.nostrPubkey]);

    const keyHeldElsewhere = {
        extension: 'Your secret key lives in your Nostr browser extension. Check your extension settings to export it.',
        bunker: 'Your secret key is held by your remote signer (NIP-46). Check your signer app to manage it.',
        amber: 'Your secret key is held by the Amber app (NIP-55). Open Amber to manage or export it.',
    }[loginMethod];

    const passkeyErrorBlock = passkeyError && (
        <>
            <p className="key-error">{passkeyError}</p>
            {isLikelyExtensionInterference(passkeyError) && (
                <div className="key-info-banner"><AlertTriangle size={16} /><span>{EXTENSION_HINT}</span></div>
            )}
        </>
    );

    return (
        <SettingsPage title={t('settings.nostrKey')} back="/settings">
            <div className="nostr-keys">
            {!npub ? (
                <SettingsGroup>
                    <div className="set-pad"><p className="key-muted">{t('settings.noNostrKey')}</p></div>
                </SettingsGroup>
            ) : (
                <>
                    <SettingsGroup title="Public key (npub)" footer="Your Nostr public identity. Anyone can see it.">
                        <div className="set-pad">
                            <div className="key-display">
                                <code className="key-value">{npub}</code>
                                <button onClick={() => copyToClipboard(npub, 'npub')} className="key-copy-btn">
                                    {copiedKey === 'npub' ? <><CheckCircle size={14} /> Copied</> : <><Copy size={14} /> Copy</>}
                                </button>
                            </div>
                        </div>
                    </SettingsGroup>

                    <SettingsGroup title="Secret key (nsec)">
                        <div className="set-pad">
                            {keyHeldElsewhere ? (
                                <div className="key-info-banner"><AlertTriangle size={16} /><span>{keyHeldElsewhere}</span></div>
                            ) : loginMethod === 'hosted' ? (
                                <div className="key-info-banner">
                                    <AlertTriangle size={16} />
                                    <span>
                                        {t('account.hostedBanner')}{' '}
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
                                    <p className="key-muted">Reveal your private key for backup.</p>
                                    {nsecError && <p className="key-error">{nsecError}</p>}
                                    <button onClick={handleRevealNsec} disabled={nsecLoading} className="btn btn-outline btn-sm btn-danger-outline" style={{ alignSelf: 'flex-start' }}>
                                        {nsecLoading
                                            ? <><Fingerprint size={14} style={{ marginRight: '0.4rem' }} /> Authenticating...</>
                                            : <><Eye size={14} style={{ marginRight: '0.4rem' }} /> Reveal Secret Key</>}
                                    </button>
                                </>
                            )}
                        </div>
                    </SettingsGroup>

                    {/* Passkey Quick Login (keytr): hidden on native (no WebAuthn in
                        WKWebView) and for sessions with no in-browser nsec: external
                        signers (extension/bunker/amber) and email accounts (hosted). */}
                    {PASSKEY_ENABLED && !isNativePlatform() && !keyHeldElsewhere && loginMethod !== 'hosted' && (
                        <SettingsGroup
                            title="Passkey quick login (optional)"
                            footer="Your key is encrypted with your passkey (NIP-K1) and the encrypted copy is stored on Nostr relays. Saving a new passkey needs a device or browser with passkey PRF support; most password-manager extensions don't have it. Always keep your nsec or seed phrase backup too."
                        >
                            <div className="set-pad">
                                {!passkeySupported ? (
                                    <div className="key-info-banner"><AlertTriangle size={16} /><span>Your browser or device does not support passkeys. Try a modern browser like Chrome, Edge, or Safari.</span></div>
                                ) : !prfSupport.supported && !hasPasskey ? (
                                    <div className="key-info-banner"><AlertTriangle size={16} /><span>{NO_PRF}</span></div>
                                ) : hasPasskey ? (
                                    <>
                                        <div className="passkey-status"><CheckCircle size={14} /><span>Passkey active for this account</span></div>
                                        {passkeySuccess && <p className="passkey-success">{passkeySuccess}</p>}
                                        {passkeyErrorBlock}
                                        {!prfSupport.supported && (
                                            <div className="key-info-banner"><AlertTriangle size={16} /><span>This device can't create new passkeys (missing PRF support). Your existing passkey still works for login.</span></div>
                                        )}
                                        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                                            <button onClick={handleAddBackupGateway} disabled={savingBackup || !prfSupport.supported} className="btn btn-outline btn-sm">
                                                <Fingerprint size={14} style={{ marginRight: '0.4rem' }} /> {savingBackup ? 'Saving...' : 'Add Backup Gateway'}
                                            </button>
                                            <button onClick={handleRemovePasskey} disabled={removingPasskey} className="btn btn-outline btn-sm btn-danger-outline">
                                                {removingPasskey ? 'Removing...' : confirmRemove ? 'Confirm: remove passkey backup' : 'Remove Passkey'}
                                            </button>
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <p className="key-muted">Save your key to a passkey for quick biometric login on any device.</p>
                                        {passkeySuccess && <p className="passkey-success">{passkeySuccess}</p>}
                                        {passkeyErrorBlock}
                                        <button onClick={handleSavePasskey} disabled={savingPasskey} className="btn btn-outline btn-sm" style={{ alignSelf: 'flex-start' }}>
                                            <Fingerprint size={14} style={{ marginRight: '0.4rem' }} /> {savingPasskey ? 'Saving...' : 'Save to Passkey'}
                                        </button>
                                    </>
                                )}
                            </div>
                        </SettingsGroup>
                    )}
                </>
            )}
            </div>

            {/* Global under .nostr-keys: some of this JSX is built outside the returned tree. */}
            <style jsx>{`
                .nostr-keys :global(.key-display) { display: flex; align-items: center; gap: 0.5rem; width: 100%; box-sizing: border-box; background: var(--color-gray-50); border: 1px solid var(--color-gray-200); border-radius: var(--radius-md); padding: 0.5rem 0.75rem; overflow: hidden; }
                .nostr-keys :global(.key-value) { font-size: 0.8rem; word-break: break-all; flex: 1; min-width: 0; color: var(--color-gray-700); background: none; padding: 0; }
                .nostr-keys :global(.nsec-value) { color: var(--color-danger, #dc2626); }
                .nostr-keys :global(.key-copy-btn) { display: flex; align-items: center; gap: 0.3rem; font-size: 0.8rem; font-weight: 600; background: transparent; border: none; color: var(--color-primary); cursor: pointer; white-space: nowrap; padding: 0.25rem 0.5rem; border-radius: var(--radius-sm); }
                .nostr-keys :global(.key-muted) { margin: 0; font-size: 0.9rem; color: var(--color-gray-600); line-height: 1.45; }
                .nostr-keys :global(.key-warning) { display: flex; align-items: flex-start; gap: 0.5rem; font-size: 0.8rem; color: var(--color-danger, #dc2626); background: var(--color-danger-light, #fef2f2); padding: 0.6rem 0.75rem; border-radius: var(--radius-md); line-height: 1.4; }
                .nostr-keys :global(.key-info-banner) { display: flex; align-items: flex-start; gap: 0.5rem; font-size: 0.85rem; color: var(--color-gray-600); background: var(--color-gray-50); padding: 0.75rem; border-radius: var(--radius-md); line-height: 1.4; border: 1px solid var(--color-gray-200); }
                .nostr-keys :global(.key-error) { font-size: 0.8rem; color: var(--color-danger, #dc2626); margin: 0; }
                .nostr-keys :global(.passkey-status) { display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem; font-weight: 500; color: var(--color-green-700, #15803d); background: var(--color-green-tint, #f0fdf4); padding: 0.5rem 0.75rem; border-radius: var(--radius-md); }
                .nostr-keys :global(.passkey-success) { font-size: 0.8rem; color: var(--color-green-700, #15803d); margin: 0; }
                .nostr-keys :global(.btn-sm) { font-size: 0.85rem; padding: 0.5rem 1rem; }
                .nostr-keys :global(.btn-danger-outline) { border-color: var(--color-danger, #dc2626); color: var(--color-danger, #dc2626); }
                .nostr-keys :global(.key-warning svg), .nostr-keys :global(.key-info-banner svg) { flex-shrink: 0; margin-top: 2px; }
            `}</style>
        </SettingsPage>
    );
};

export default NostrKeys;
