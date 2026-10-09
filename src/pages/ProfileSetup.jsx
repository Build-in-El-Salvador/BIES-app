import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { nostrService, PUBLIC_RELAYS } from '../services/nostrService';
import { nip19 } from 'nostr-tools';
import { profilesApi } from '../services/api';
import { nostrSigner } from '../services/nostrSigner';
import { ArrowRight, Loader2, AlertCircle, ChevronDown, ChevronUp, Send, AtSign, CheckCircle, X } from 'lucide-react';
import NostrIcon from '../components/NostrIcon';

const ProfileSetup = () => {
    const { t } = useTranslation();
    const { user, refreshUser } = useAuth();
    const navigate = useNavigate();
    const [nostrProfile, setNostrProfile] = useState(null);
    const [loadingNostr, setLoadingNostr] = useState(true);
    const [biesName, setBiesName] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');
    const [showNostrEdit, setShowNostrEdit] = useState(false);
    const [nostrForm, setNostrForm] = useState({ name: '', about: '', picture: '', website: '', nip05: '', lud16: '' });
    const [nip05Name, setNip05Name] = useState('');
    const [nip05Available, setNip05Available] = useState(null);
    const [nip05Checking, setNip05Checking] = useState(false);

    useEffect(() => {
        // Redirect if user doesn't need setup (returning user)
        if (user?.profile?.name && !user.profile.name.startsWith('nostr:')) {
            navigate('/feed', { replace: true });
            return;
        }

        // Fetch Nostr kind:0 profile from public relays (new user won't have one on BIES yet)
        if (user?.nostrPubkey) {
            nostrService.getProfile(user.nostrPubkey, PUBLIC_RELAYS).then((profile) => {
                setNostrProfile(profile);
                if (profile?.name) {
                    setBiesName(profile.name);
                }
                if (profile) {
                    setNostrForm({
                        name: profile.name || '',
                        about: profile.about || '',
                        picture: profile.picture || '',
                        website: profile.website || '',
                        nip05: profile.nip05 || '',
                        lud16: profile.lud16 || '',
                    });
                }
                // Auto-fill BIES NIP-05 when user has no existing NIP-05
                if (!profile?.nip05 && user?.profile?.nip05Name) {
                    setNip05Name(user.profile.nip05Name);
                }
            }).finally(() => setLoadingNostr(false));
        } else {
            setLoadingNostr(false);
        }
    }, [user, navigate]);

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

    const handleNostrFormChange = (field) => (e) => {
        setNostrForm(prev => ({ ...prev, [field]: e.target.value }));
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!biesName.trim() || submitting) return;

        setSubmitting(true);
        setError('');

        try {
            // Save BIES profile
            const updateData = { name: biesName.trim() };
            if (nip05Name.trim()) updateData.nip05Name = nip05Name.trim().toLowerCase();
            if (user?.nostrPubkey) updateData.nostrNpub = nip19.npubEncode(user.nostrPubkey);
            if (nostrForm.picture || nostrProfile?.picture) updateData.avatar = nostrForm.picture || nostrProfile?.picture;
            if (nostrProfile?.banner) updateData.banner = nostrProfile.banner;
            if (nostrForm.about || nostrProfile?.about) updateData.bio = nostrForm.about || nostrProfile?.about;
            if (nostrForm.website || nostrProfile?.website) updateData.website = nostrForm.website || nostrProfile?.website;

            await profilesApi.update(updateData);

            // Email accounts skip this: the server publishes their kind:0 when the
            // profile is saved, and a second, different kind:0 would race it.
            if (nostrSigner.signsOnDevice) {
                // Publish Nostr kind:0 — always sync to private BIES relay;
                // if user edited the Nostr section, also broadcast to public relays
                try {
                    const data = {};
                    if (nostrForm.name || biesName.trim()) data.name = nostrForm.name || biesName.trim();
                    if (nostrForm.about) data.about = nostrForm.about;
                    if (nostrForm.picture || nostrProfile?.picture) data.picture = nostrForm.picture || nostrProfile?.picture;
                    if (nostrForm.website || nostrProfile?.website) data.website = nostrForm.website || nostrProfile?.website;
                    if (nip05Name.trim()) data.nip05 = `${nip05Name.trim().toLowerCase()}@buildinelsalvador.com`;
                    else if (nostrForm.nip05) data.nip05 = nostrForm.nip05;
                    if (nostrForm.lud16) data.lud16 = nostrForm.lud16;
                    if (showNostrEdit && nostrForm.name) {
                        // User edited Nostr profile — publish to all relays
                        await nostrService.updateProfile(data);
                    } else if (nip05Name.trim() && !nostrProfile?.nip05) {
                        // User had no NIP-05, got BIES identity — publish to public relays so it's verifiable
                        await nostrService.updateProfile(data);
                    } else {
                        await nostrService.updateProfileToBiesRelay(data);
                    }
                } catch (nostrErr) {
                    console.error('Nostr profile sync failed (non-blocking):', nostrErr);
                }
            }

            // Announce new user on both public and private relays
            try {
                const announceEvent = {
                    kind: 1,
                    created_at: Math.floor(Date.now() / 1000),
                    tags: [['t', 'bies'], ['t', 'new-user'], ['t', 'introductions'], ['t', 'buildinelsalvador']],
                    content: `${biesName.trim()} just joined the Builder Hub! Welcome to the Highest Signal Builder Ecosystem of El Salvador. #introductions #buildinelsalvador`,
                };
                await Promise.allSettled([
                    nostrService.publishToBiesRelay(announceEvent),
                    nostrService.publishEvent(announceEvent),
                ]);
            } catch (announceErr) {
                console.error('New user announcement failed (non-blocking):', announceErr);
            }

            await refreshUser();
            navigate('/feed');
        } catch (err) {
            setError(err.message || 'Failed to save profile.');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="setup-container">
            <div className="setup-card">
                <div className="text-center mb-6">
                    <NostrIcon size={32} className="mx-auto mb-3" color="#8b5cf6" />
                    <h2 className="text-2xl font-bold mb-2">{t('profileSetup.welcome')}</h2>
                    <p className="text-gray-500 text-sm">
                        {t('profileSetup.setupDesc')}
                    </p>
                </div>

                {/* Nostr Profile Preview */}
                {loadingNostr ? (
                    <div className="nostr-preview loading">
                        <Loader2 size={20} className="spin" />
                        <span className="text-sm text-gray-400">{t('profileSetup.fetchingNostr')}</span>
                    </div>
                ) : nostrProfile ? (
                    <div className="nostr-preview">
                        <div className="nostr-header">
                            {nostrProfile.picture && (
                                <img src={nostrProfile.picture} alt="" className="nostr-avatar" />
                            )}
                            <div>
                                <p className="font-bold text-gray-900">{nostrProfile.name || t('common.unnamed')}</p>
                                {nostrProfile.nip05 && (
                                    <p className="text-xs text-gray-400">{nostrProfile.nip05}</p>
                                )}
                            </div>
                        </div>
                        {nostrProfile.about && (
                            <p className="text-sm text-gray-600 mt-3 nostr-about">
                                {nostrProfile.about.length > 150
                                    ? nostrProfile.about.substring(0, 150) + '...'
                                    : nostrProfile.about}
                            </p>
                        )}
                        <p className="text-xs text-gray-400 mt-2">{t('profileSetup.nostrFromRelays')}</p>
                    </div>
                ) : (
                    <div className="nostr-preview empty">
                        <p className="text-sm text-gray-400">{t('profileSetup.noNostrProfile')}</p>
                    </div>
                )}

                {error && (
                    <div className="error-banner">
                        <AlertCircle size={16} />
                        <span>{error}</span>
                    </div>
                )}

                <form onSubmit={handleSubmit} className="w-full">
                    <div className="mb-4">
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                            {t('profileSetup.biesDisplayName')}
                        </label>
                        <input
                            type="text"
                            required
                            className="w-full p-3 border rounded-lg input-field"
                            placeholder={t('profileSetup.namePlaceholder')}
                            value={biesName}
                            onChange={e => setBiesName(e.target.value)}
                        />
                        <p className="text-xs text-gray-400 mt-1">
                            {t('profileSetup.nameNote')}
                        </p>
                    </div>

                    {/* NIP-05 Identity Picker */}
                    {!loadingNostr && (
                        nostrProfile?.nip05 ? (
                            <div className="mb-4">
                                <label className="block text-sm font-medium text-gray-700 mb-1">
                                    Your Nostr Identity
                                </label>
                                <input
                                    type="text" readOnly
                                    className="w-full p-3 border rounded-lg input-field"
                                    value={nostrProfile.nip05}
                                    style={{ opacity: 0.7, cursor: 'default' }}
                                />
                                <p className="text-xs text-gray-400 mt-1">
                                    You already have a NIP-05 identity. You can also claim a <strong>@buildinelsalvador.com</strong> identity below.
                                </p>
                                <div style={{ marginTop: '0.75rem' }}>
                                    <label className="block text-xs font-medium text-gray-600 mb-1">
                                        Claim your BIES identity (optional)
                                    </label>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                                        <div style={{ flex: 1, position: 'relative', display: 'flex', alignItems: 'center' }}>
                                            <AtSign size={16} style={{ position: 'absolute', left: '0.75rem', color: 'var(--color-gray-400)' }} />
                                            <input
                                                type="text"
                                                className="w-full p-3 border rounded-lg input-field"
                                                style={{ paddingLeft: '2.25rem' }}
                                                placeholder="alice"
                                                value={nip05Name}
                                                onChange={e => setNip05Name(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ''))}
                                            />
                                        </div>
                                        {nip05Checking && <Loader2 size={16} className="spin" style={{ color: 'var(--color-gray-400)' }} />}
                                        {!nip05Checking && nip05Available === true && <CheckCircle size={16} style={{ color: '#16a34a' }} />}
                                        {!nip05Checking && nip05Available === false && <X size={16} style={{ color: '#ef4444' }} />}
                                    </div>
                                    {nip05Name && (
                                        <p className="text-xs mt-1" style={{ color: nip05Available === false ? '#ef4444' : 'var(--color-gray-400)' }}>
                                            {nip05Available === false ? 'Taken — try another name' : `${nip05Name.toLowerCase()}@buildinelsalvador.com`}
                                        </p>
                                    )}
                                </div>
                            </div>
                        ) : (
                            <div className="mb-4">
                                <label className="block text-sm font-medium text-gray-700 mb-1">
                                    Your BIES Identity
                                </label>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                                    <div style={{ flex: 1, position: 'relative', display: 'flex', alignItems: 'center' }}>
                                        <AtSign size={16} style={{ position: 'absolute', left: '0.75rem', color: 'var(--color-gray-400)' }} />
                                        <input
                                            type="text"
                                            className="w-full p-3 border rounded-lg input-field"
                                            style={{ paddingLeft: '2.25rem' }}
                                            placeholder="alice"
                                            value={nip05Name}
                                            onChange={e => setNip05Name(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ''))}
                                        />
                                    </div>
                                    {nip05Checking && <Loader2 size={16} className="spin" style={{ color: 'var(--color-gray-400)' }} />}
                                    {!nip05Checking && nip05Available === true && <CheckCircle size={16} style={{ color: '#16a34a' }} />}
                                    {!nip05Checking && nip05Available === false && <X size={16} style={{ color: '#ef4444' }} />}
                                </div>
                                {nip05Name && (
                                    <p className="text-xs mt-1" style={{ color: nip05Available === false ? '#ef4444' : 'var(--color-gray-400)' }}>
                                        {nip05Available === false ? 'Taken — try another name' : `${nip05Name.toLowerCase()}@buildinelsalvador.com`}
                                    </p>
                                )}
                                <p className="text-xs text-gray-400 mt-1">
                                    We've assigned you a @buildinelsalvador.com identity. You can customize it above.
                                </p>
                            </div>
                        )
                    )}

                    {/* Nostr Profile Editing (collapsible) */}
                    <div className="mb-4">
                        <button
                            type="button"
                            onClick={() => setShowNostrEdit(!showNostrEdit)}
                            className="nostr-edit-toggle"
                        >
                            <NostrIcon size={16} style={{ color: '#8b5cf6' }} />
                            <span>{showNostrEdit ? t('profileSetup.hideNostrProfile') : t('profileSetup.editNostrProfile')}</span>
                            {showNostrEdit ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                        </button>

                        {showNostrEdit && (
                            <div className="nostr-edit-section">
                                <p className="text-xs text-gray-400 mb-3">{t('profileSetup.nostrPublishNote')}</p>
                                <div className="mb-3">
                                    <label className="block text-xs font-medium text-gray-600 mb-1">{t('profileSetup.nostrName')}</label>
                                    <input type="text" className="input-field text-sm" value={nostrForm.name} onChange={handleNostrFormChange('name')} placeholder={t('profileSetup.nostrNamePlaceholder')} />
                                </div>
                                <div className="mb-3">
                                    <label className="block text-xs font-medium text-gray-600 mb-1">{t('profileSetup.aboutLabel')}</label>
                                    <textarea rows="2" className="input-field text-sm" value={nostrForm.about} onChange={handleNostrFormChange('about')} placeholder={t('profileSetup.aboutPlaceholder')}></textarea>
                                </div>
                                <div className="mb-3">
                                    <label className="block text-xs font-medium text-gray-600 mb-1">{t('profileSetup.pictureUrl')}</label>
                                    <input type="url" className="input-field text-sm" value={nostrForm.picture} onChange={handleNostrFormChange('picture')} placeholder="https://..." />
                                </div>
                                <div className="mb-3">
                                    <label className="block text-xs font-medium text-gray-600 mb-1">{t('profileSetup.website')}</label>
                                    <input type="url" className="input-field text-sm" value={nostrForm.website} onChange={handleNostrFormChange('website')} placeholder="https://..." />
                                </div>
                                <div className="mb-3">
                                    <label className="block text-xs font-medium text-gray-600 mb-1">{t('profileSetup.nip05')}</label>
                                    <input type="text" className="input-field text-sm" value={nostrForm.nip05} onChange={handleNostrFormChange('nip05')} placeholder="you@domain.com" />
                                </div>
                                <div className="mb-3">
                                    <label className="block text-xs font-medium text-gray-600 mb-1">{t('profileSetup.lightningAddress')}</label>
                                    <input type="text" className="input-field text-sm" value={nostrForm.lud16} onChange={handleNostrFormChange('lud16')} placeholder="you@wallet.com" />
                                </div>
                            </div>
                        )}
                    </div>


                    <button
                        type="submit"
                        disabled={submitting || !biesName.trim()}
                        className="btn-primary w-full py-3 rounded-full flex items-center justify-center gap-2"
                    >
                        {submitting ? (
                            <Loader2 size={18} className="spin" />
                        ) : (
                            <>{t('profileSetup.enterBIES')} <ArrowRight size={18} /></>
                        )}
                    </button>
                </form>
            </div>

            <style jsx>{`
                .setup-container {
                    min-height: calc(100vh - 150px);
                    min-height: calc(100dvh - 150px);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background: var(--color-gray-50);
                    padding: clamp(1rem, 3vh, 2rem) clamp(0.5rem, 2vh, 1rem);
                }
                .setup-card {
                    background: var(--color-surface);
                    padding: clamp(1rem, 2vh, 2.5rem);
                    border-radius: var(--radius-xl);
                    box-shadow: var(--shadow-lg);
                    width: 100%;
                    max-width: 500px;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                }
                .mx-auto { margin-left: auto; margin-right: auto; display: block; }
                .text-center { text-align: center; }
                .text-yellow-400 { color: #facc15; }
                .fill-yellow-400 { fill: #facc15; }
                .text-gray-400 { color: var(--color-gray-400); }
                .text-gray-500 { color: var(--color-gray-500); }
                .text-gray-600 { color: var(--color-gray-600); }
                .text-gray-700 { color: var(--color-gray-700); }
                .text-gray-900 { color: var(--color-gray-900); }
                .text-sm { font-size: 0.875rem; }
                .text-xs { font-size: 0.75rem; }
                .text-2xl { font-size: 1.5rem; line-height: 2rem; }
                .font-bold { font-weight: 700; font-family: var(--font-display); }
                .font-medium { font-weight: 500; }
                .mb-1 { margin-bottom: 0.25rem; }
                .mb-2 { margin-bottom: 0.5rem; }
                .mb-3 { margin-bottom: 0.75rem; }
                .mb-4 { margin-bottom: 1rem; }
                .mb-6 { margin-bottom: 3rem; }
                .mt-1 { margin-top: 0.25rem; }
                .mt-2 { margin-top: 0.5rem; }
                .mt-3 { margin-top: 0.75rem; }
                .w-full { width: 100%; }
                .block { display: block; }

                .nostr-preview {
                    width: 100%;
                    padding: 1.25rem;
                    border-radius: var(--radius-lg);
                    border: 1px solid var(--color-gray-200);
                    background: var(--color-gray-100);
                    margin-bottom: 1.5rem;
                }
                .nostr-preview.loading {
                    display: flex;
                    align-items: center;
                    gap: 0.75rem;
                    justify-content: center;
                    padding: 1.5rem;
                }
                .nostr-preview.empty {
                    text-align: center;
                    padding: 1.5rem;
                }
                .nostr-header {
                    display: flex;
                    align-items: center;
                    gap: 0.75rem;
                }
                .nostr-avatar {
                    width: 44px;
                    height: 44px;
                    border-radius: 50%;
                    object-fit: cover;
                    border: 2px solid var(--color-surface);
                    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
                }
                .nostr-about {
                    line-height: 1.5;
                }

                .nostr-edit-toggle {
                    width: 100%;
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    padding: 0.75rem 1rem;
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-md);
                    background: var(--color-gray-100);
                    color: var(--color-gray-700);
                    font-size: 0.875rem;
                    font-weight: 500;
                    cursor: pointer;
                    transition: all 0.2s;
                }
                .nostr-edit-toggle:hover {
                    border-color: var(--color-gray-300);
                    background: var(--color-gray-200);
                }
                .nostr-edit-toggle span { flex: 1; text-align: left; }
                .nostr-edit-section {
                    margin-top: 0.75rem;
                    padding: 1rem;
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-md);
                    background: var(--color-gray-100);
                }

                .error-banner {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    background: var(--color-red-tint);
                    color: var(--color-error);
                    padding: 0.75rem 1rem;
                    border-radius: var(--radius-md);
                    font-size: 0.875rem;
                    width: 100%;
                    margin-bottom: 1rem;
                    border: 1px solid var(--badge-error-bg);
                }

                .input-field {
                    width: 100%;
                    padding: 0.75rem 1rem;
                    border: 1px solid var(--color-gray-200);
                    background: var(--color-surface);
                    border-radius: 1rem;
                    font-size: 0.95rem;
                    outline: none;
                    transition: all 0.2s;
                    color: var(--color-text, inherit);
                }
                .input-field:focus {
                    border-color: var(--color-primary);
                }

                .btn-primary {
                    background: var(--color-primary);
                    color: white;
                    font-weight: 600;
                    transition: opacity 0.2s;
                    border: none;
                    cursor: pointer;
                    border-radius: 9999px;
                    padding: clamp(0.75rem, 2vh, 1rem) 1.5rem;
                }
                .btn-primary:hover { opacity: 0.9; }
                .btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }

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

export default ProfileSetup;
