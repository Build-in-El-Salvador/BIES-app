import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { nip19 } from 'nostr-tools';
import { QRCodeSVG } from 'qrcode.react';
import { AtSign, BadgeCheck, CheckCircle, Copy, Globe, Key, Loader2, QrCode, User, X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { profilesApi, settingsApi, signerApi } from '../../services/api';
import { nostrSigner } from '../../services/nostrSigner';
import { nostrService } from '../../services/nostrService';
import { publishPublicProfile } from '../../services/publicNostrProfile';
import { isNativePlatform } from '../../utils/platform';
import { SettingsPage, SettingsGroup, SettingsRow, Switch } from '../../components/settings/SettingsUI';

const DOMAIN = 'buildinelsalvador.com';
const NAME_RE = /^[a-z0-9._-]{3,30}$/;
// Names like the ones sign-up used to hand out (server: services/nip05.ts).
const GIVEN_AT_SIGNUP = /^nostr-[0-9a-f]{8}\d*$/;

// The parts of a BIES profile a public profile can show (server: services/publicNostrProfile.ts).
const PARTS = ['name', 'picture', 'banner', 'about', 'website', 'lightning', 'nip05'];

// Signatures the log leaves out: one per relay connection, one per upload.
const QUIET_KINDS = [22242, 24242];

// npub1abcdefgh…wxyz: enough to recognise it, on one line.
const shortNpub = (npub) => `${npub.slice(0, 12)}…${npub.slice(-6)}`;
const KIND_LABELS = {
    0: 'profile', 1: 'post', 3: 'follows', 5: 'deletion', 6: 'repost', 7: 'reaction', 1984: 'report',
    9734: 'zap', 10002: 'relays', 27235: 'keyProof', 30402: 'listing', 31923: 'event', 31925: 'rsvp',
};

/**
 * Settings → Nostr: the member's Nostr identity (npub, with a QR code, and
 * where their key is), their BIES address, which is what makes them
 * verified, their profile on public Nostr, and, for keys BIES holds, what
 * BIES signed for them. The key itself (reveal, passkeys, take your key)
 * is one level down, at /settings/nostr/key.
 *
 * Public Nostr is off until the member switches it on, and nothing goes out
 * until they press Publish. It's on the website only for now: the phone
 * apps show only what can be changed in them (Mike, 2026-11-02). A public
 * profile published on the website still follows changes made in the app.
 */
const NostrSettings = () => {
    const { t, i18n } = useTranslation();
    const { user, refreshUser } = useAuth();
    const native = isNativePlatform();
    const npub = user?.nostrPubkey ? nip19.npubEncode(user.nostrPubkey) : null;
    const method = nostrSigner.storedMethod; // 'extension' | 'nsec' | 'bunker' | 'amber' | 'hosted' | null

    const [state, setState] = useState(null);
    const [loadError, setLoadError] = useState('');
    const [copied, setCopied] = useState(false);
    const [showQr, setShowQr] = useState(false);

    const load = useCallback(() => {
        setLoadError('');
        // The phone apps don't show the public profile: no preview to fetch.
        return settingsApi.getNostr({ preview: native ? 0 : 1 })
            .then(setState)
            .catch(() => setLoadError(t('nostrSettings.loadFailed')));
    }, [t, native]);
    useEffect(() => { load(); }, [load]);

    const copyNpub = () => {
        navigator.clipboard?.writeText(npub);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const keyWhere = {
        hosted: t('nostrSettings.keyHosted'),
        extension: t('nostrSettings.keyExtension'),
        bunker: t('nostrSettings.keyBunker'),
        amber: t('nostrSettings.keyAmber'),
    }[method] || t('nostrSettings.keyDevice');

    if (!npub) {
        return (
            <SettingsPage title={t('nostrSettings.title')} back="/settings">
                <SettingsGroup><div className="set-pad"><p className="ns-muted">{t('settings.noNostrKey')}</p></div></SettingsGroup>
            </SettingsPage>
        );
    }

    return (
        <SettingsPage title={t('nostrSettings.title')} back="/settings">
            <div className="nostr-settings">
                <SettingsGroup title={t('nostrSettings.identity')} footer={t('nostrSettings.identityFooter')}>
                    <div className="set-pad">
                        {/* Shortened to one line; Copy and the QR code copy or show all of it. */}
                        <div className="ns-key">
                            <code className="ns-key-value" title={npub} data-testid="nostr-npub">{shortNpub(npub)}</code>
                            <button type="button" onClick={copyNpub} className="ns-icon-btn" aria-label={copied ? t('nostrSettings.copied') : t('nostrSettings.copy')} title={t('nostrSettings.copy')}>
                                {copied ? <CheckCircle size={18} /> : <Copy size={18} />}
                            </button>
                            <button type="button" onClick={() => setShowQr((v) => !v)} className={`ns-icon-btn${showQr ? ' on' : ''}`} aria-expanded={showQr} aria-label={showQr ? t('nostrSettings.hideQr') : t('nostrSettings.showQr')} title={t('nostrSettings.showQr')}>
                                <QrCode size={18} />
                            </button>
                        </div>
                        {copied && <p className="ns-ok" role="status">{t('nostrSettings.copied')}</p>}
                        {showQr && <div className="ns-qr"><QRCodeSVG value={`nostr:${npub}`} size={184} /></div>}
                    </div>
                    <SettingsRow icon={Key} label={t('nostrSettings.yourKey')} desc={keyWhere} to="/settings/nostr/key" testId="nostr-your-key" />
                </SettingsGroup>

                {loadError && (
                    <SettingsGroup>
                        <div className="set-pad">
                            <p className="ns-error" role="alert">{loadError}</p>
                            <button type="button" className="btn btn-outline btn-sm ns-start" onClick={load}>{t('nostrSettings.retry')}</button>
                        </div>
                    </SettingsGroup>
                )}
                {!state && !loadError && (
                    <div className="ns-loading"><Loader2 size={20} className="ns-spin" aria-label={t('nostrSettings.loading')} /></div>
                )}

                {state && (
                    <>
                        <BiesAddress state={state} native={native} onSaved={() => { load(); refreshUser?.(); }} />
                        {!native && <PublicProfile state={state} setState={setState} reload={load} />}
                        {state.hosted && <SigningLog language={i18n.language} />}
                    </>
                )}
            </div>
            <style jsx>{`
                .nostr-settings :global(.ns-key) { display: flex; align-items: center; gap: 0.25rem; background: var(--color-gray-50); border: 1px solid var(--color-gray-200); border-radius: var(--radius-md); padding: 0.25rem 0.35rem 0.25rem 0.75rem; min-width: 0; }
                .nostr-settings :global(.ns-key-value) { flex: 1; min-width: 0; font-size: 0.9rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--color-gray-700); background: none; padding: 0; }
                .nostr-settings :global(.ns-icon-btn) { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border: none; border-radius: 50%; background: none; color: var(--color-primary); cursor: pointer; }
                .nostr-settings :global(.ns-icon-btn:active), .nostr-settings :global(.ns-icon-btn.on) { background: var(--color-gray-200); }
                .nostr-settings :global(.ns-link-btn) { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.85rem; font-weight: 600; background: none; border: none; color: var(--color-primary); cursor: pointer; padding: 0.25rem 0; white-space: nowrap; }
                .nostr-settings :global(.ns-start) { align-self: flex-start; }
                .nostr-settings :global(.ns-qr) { align-self: center; background: #fff; padding: 12px; border-radius: var(--radius-md); border: 1px solid var(--color-gray-200); }
                .nostr-settings :global(.ns-muted) { margin: 0; font-size: 0.88rem; line-height: 1.45; color: var(--color-gray-600); }
                .nostr-settings :global(.ns-error) { margin: 0; font-size: 0.85rem; color: var(--color-danger, #dc2626); }
                .nostr-settings :global(.ns-ok) { margin: 0; font-size: 0.85rem; color: var(--color-green-700, #15803d); }
                .nostr-settings :global(.ns-loading) { display: flex; justify-content: center; padding: 24px; color: var(--color-gray-400); }
                .nostr-settings :global(.ns-spin) { animation: spin 1s linear infinite; }
                .nostr-settings :global(.ns-address) { display: flex; align-items: center; gap: 0.4rem; font-weight: 600; word-break: break-all; }
                .nostr-settings :global(.ns-address svg) { flex-shrink: 0; color: var(--color-primary); }
                .nostr-settings :global(.ns-name-field) { display: flex; align-items: center; border: 1px solid var(--color-gray-300); border-radius: var(--radius-md); background: var(--color-surface, #fff); overflow: hidden; }
                .nostr-settings :global(.ns-name-field:focus-within) { border-color: var(--color-primary); }
                .nostr-settings :global(.ns-name-field input) { flex: 1; min-width: 0; border: none; outline: none; background: none; padding: 0.6rem 0.4rem 0.6rem 0.75rem; font-size: 1rem; color: inherit; }
                .nostr-settings :global(.ns-name-suffix) { padding-right: 0.75rem; font-size: 0.9rem; color: var(--color-gray-500); white-space: nowrap; }
                .nostr-settings :global(.ns-hint) { margin: 0; font-size: 0.82rem; color: var(--color-gray-500); display: flex; align-items: center; gap: 0.3rem; }
                .nostr-settings :global(.ns-hint.bad) { color: var(--color-danger, #dc2626); }
                .nostr-settings :global(.ns-hint.good) { color: var(--color-green-700, #15803d); }
                .nostr-settings :global(.ns-actions) { display: flex; gap: 0.5rem; flex-wrap: wrap; }
                .nostr-settings :global(.btn-sm) { font-size: 0.88rem; padding: 0.5rem 1rem; }
                .nostr-settings :global(.ns-danger) { border-color: var(--color-danger, #dc2626); color: var(--color-danger, #dc2626); }
                .nostr-settings :global(.ns-preview-label) { margin: 0; font-size: 0.78rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--color-gray-500); }
                .nostr-settings :global(.ns-card) { border: 1px solid var(--color-gray-200); border-radius: var(--radius-md); overflow: hidden; }
                .nostr-settings :global(.ns-card-banner) { display: block; width: 100%; height: 72px; object-fit: cover; background: var(--color-gray-100); }
                .nostr-settings :global(.ns-card-body) { display: flex; gap: 12px; padding: 12px; }
                .nostr-settings :global(.ns-card-photo) { width: 52px; height: 52px; border-radius: 50%; flex-shrink: 0; overflow: hidden; display: flex; align-items: center; justify-content: center; background: var(--color-gray-100); color: var(--color-gray-400); }
                .nostr-settings :global(.ns-card-photo img) { width: 100%; height: 100%; object-fit: cover; }
                .nostr-settings :global(.ns-card-text) { min-width: 0; display: flex; flex-direction: column; gap: 2px; font-size: 0.85rem; color: var(--color-gray-600); }
                .nostr-settings :global(.ns-card-name) { font-size: 1rem; font-weight: 700; color: var(--color-gray-900); word-break: break-word; }
                .nostr-settings :global(.ns-card-line) { word-break: break-all; }
                .nostr-settings :global(.ns-card-about) { margin-top: 4px; white-space: pre-line; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; word-break: break-word; }
                .nostr-settings :global(.ns-details summary) { cursor: pointer; font-size: 0.88rem; font-weight: 600; color: var(--color-primary); }
                .nostr-settings :global(.ns-details[open] summary) { margin-bottom: 8px; }
            `}</style>
        </SettingsPage>
    );
};

/** Why a name can't be had, as a message, or '' when it can. */
function nameProblem(t, name, check) {
    if (!name) return '';
    if (!NAME_RE.test(name)) return t('nostrSettings.nameRules');
    if (GIVEN_AT_SIGNUP.test(name)) return t('nostrSettings.nameReserved');
    if (check?.name !== name) return '';
    if (check.reason === 'reserved') return t('nostrSettings.nameReserved');
    if (check.available === false) return t('nostrSettings.nameTaken');
    return '';
}

/** The member's BIES address: claim one, change it or remove it. */
function BiesAddress({ state, native, onSaved }) {
    const { t } = useTranslation();
    const current = state.nip05Name || '';
    const verified = state.verified;
    const [editing, setEditing] = useState(false);
    const [name, setName] = useState('');
    const [check, setCheck] = useState(null); // { name, available, reason }
    const [saving, setSaving] = useState(false);
    const [confirmRemove, setConfirmRemove] = useState(false);
    const [error, setError] = useState('');
    const [done, setDone] = useState('');

    const formOpen = editing || !verified;

    // Availability, a moment after typing stops.
    useEffect(() => {
        if (!formOpen || !NAME_RE.test(name) || name === current) { setCheck(null); return undefined; }
        const timer = setTimeout(() => {
            profilesApi.checkNip05(name).then((res) => setCheck({ name, ...res })).catch(() => setCheck(null));
        }, 400);
        return () => clearTimeout(timer);
    }, [name, current, formOpen]);

    useEffect(() => {
        if (!confirmRemove) return undefined;
        const timer = setTimeout(() => setConfirmRemove(false), 8000);
        return () => clearTimeout(timer);
    }, [confirmRemove]);

    const save = async (next) => {
        setSaving(true);
        setError('');
        setDone('');
        try {
            const saved = await profilesApi.update({ nip05Name: next });
            // The member's own key: the app updates their profile on BIES's
            // relay and, if they published one, on public Nostr, so neither
            // keeps an address that no longer works (the server does both for
            // keys it holds). One signature after the other, and not where
            // each is an app switch (Amber).
            if (!state.hosted && nostrSigner.canSignSilently) {
                const privacy = await settingsApi.getPrivacy().catch(() => null);
                const nip05 = next && privacy?.links !== 'ONLY_ME' ? `${next}@${DOMAIN}` : '';
                await nostrService.updateProfileToBiesRelay({ nip05 })
                    .catch((err) => console.error('Relay profile sync failed (non-blocking):', err));
                if (saved?.publicNostrStale) {
                    await publishPublicProfile().catch((err) => console.error('Public profile sync failed (non-blocking):', err));
                }
            }
            setEditing(false);
            setName('');
            setConfirmRemove(false);
            setDone(next ? t('nostrSettings.claimed', { address: `${next}@${DOMAIN}` }) : t('nostrSettings.removed'));
            onSaved();
        } catch (err) {
            setError(err?.status === 409
                ? (err.data?.reason === 'reserved' ? t('nostrSettings.nameReserved') : t('nostrSettings.nameTaken'))
                : t('nostrSettings.saveFailed'));
        } finally {
            setSaving(false);
        }
    };

    const problem = nameProblem(t, name, check);
    const available = !problem && check?.name === name && check.available === true;

    return (
        <SettingsGroup title={t('nostrSettings.addressTitle')} footer={t(native ? 'nostrSettings.addressFooterApp' : 'nostrSettings.addressFooter')}>
            <div className="set-pad">
                {verified && (
                    <div className="ns-address" data-testid="nostr-address">
                        <BadgeCheck size={18} aria-hidden="true" />
                        <span>{current}@{DOMAIN}</span>
                    </div>
                )}
                {verified && !editing && <p className="ns-muted">{t('nostrSettings.verifiedNote')}</p>}
                {!verified && current && (
                    <p className="ns-muted">{t('nostrSettings.signupAddress', { address: `${current}@${DOMAIN}` })}</p>
                )}
                {!verified && !current && <p className="ns-muted">{t('nostrSettings.claimIntro')}</p>}

                {formOpen && (
                    <form
                        onSubmit={(e) => { e.preventDefault(); if (available && !saving) save(name); }}
                        style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                    >
                        <label className="ns-name-field">
                            <AtSign size={16} style={{ marginLeft: 10, color: 'var(--color-gray-400)', flexShrink: 0 }} aria-hidden="true" />
                            <input
                                value={name}
                                onChange={(e) => { setName(e.target.value.toLowerCase().replace(/\s/g, '')); setError(''); setDone(''); }}
                                placeholder={t('nostrSettings.namePlaceholder')}
                                autoCapitalize="none"
                                autoCorrect="off"
                                spellCheck={false}
                                maxLength={30}
                                aria-label={t('nostrSettings.nameLabel')}
                                data-testid="nostr-address-input"
                            />
                            <span className="ns-name-suffix">@{DOMAIN}</span>
                        </label>
                        {problem && <p className="ns-hint bad"><X size={13} /> {problem}</p>}
                        {available && <p className="ns-hint good"><CheckCircle size={13} /> {t('nostrSettings.nameFree')}</p>}
                        <div className="ns-actions">
                            <button type="submit" className="btn btn-primary btn-sm" disabled={!available || saving} data-testid="nostr-address-claim">
                                {saving ? t('nostrSettings.saving') : verified ? t('nostrSettings.change') : t('nostrSettings.claim')}
                            </button>
                            {editing && (
                                <button type="button" className="btn btn-outline btn-sm" onClick={() => { setEditing(false); setName(''); }}>
                                    {t('common.cancel')}
                                </button>
                            )}
                        </div>
                    </form>
                )}

                {!verified && current && !editing && (
                    <button
                        type="button"
                        className="ns-link-btn ns-start"
                        disabled={saving}
                        onClick={() => (confirmRemove ? save('') : setConfirmRemove(true))}
                        data-testid="nostr-signup-address-remove"
                    >
                        {confirmRemove ? t('nostrSettings.removeOldConfirm') : t('nostrSettings.removeOld')}
                    </button>
                )}
                {verified && !editing && (
                    <div className="ns-actions">
                        <button type="button" className="btn btn-outline btn-sm" onClick={() => { setEditing(true); setDone(''); }} data-testid="nostr-address-change">
                            {t('nostrSettings.changeName')}
                        </button>
                        <button
                            type="button"
                            className="btn btn-outline btn-sm ns-danger"
                            disabled={saving}
                            onClick={() => (confirmRemove ? save('') : setConfirmRemove(true))}
                            data-testid="nostr-address-remove"
                        >
                            {confirmRemove ? t('nostrSettings.removeConfirm') : t('nostrSettings.remove')}
                        </button>
                    </div>
                )}
                {confirmRemove && <p className="ns-muted">{t(verified ? 'nostrSettings.removeWarning' : 'nostrSettings.removeOldWarning')}</p>}
                {error && <p className="ns-error" role="alert">{error}</p>}
                {done && <p className="ns-ok" role="status">{done}</p>}
            </div>
        </SettingsGroup>
    );
}

// A photo address from a Nostr profile, which anyone can write: web addresses only.
const webImage = (url) => (typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null);
const text = (value) => (typeof value === 'string' ? value : '');

/** A Nostr profile as other apps would show it. */
function ProfileCard({ profile }) {
    const { t } = useTranslation();
    const name = text(profile.display_name) || text(profile.name);
    const banner = webImage(profile.banner);
    const picture = webImage(profile.picture);
    return (
        <div className="ns-card">
            {banner && <img className="ns-card-banner" src={banner} alt="" />}
            <div className="ns-card-body">
                <div className="ns-card-photo">{picture ? <img src={picture} alt="" /> : <User size={24} />}</div>
                <div className="ns-card-text">
                    <span className="ns-card-name">{name || t('nostrSettings.noName')}</span>
                    {text(profile.name) && text(profile.display_name) && profile.name !== profile.display_name && <span className="ns-card-line">@{profile.name}</span>}
                    {text(profile.nip05) && <span className="ns-card-line">{profile.nip05}</span>}
                    {text(profile.website) && <span className="ns-card-line">{profile.website}</span>}
                    {(text(profile.lud16) || text(profile.lud06)) && <span className="ns-card-line">⚡ {text(profile.lud16) || t('nostrSettings.lnurl')}</span>}
                    {text(profile.about) && <span className="ns-card-about">{profile.about}</span>}
                </div>
            </div>
        </div>
    );
}

const PUBLISH_ERRORS = {
    relays_unreachable: 'nostrSettings.relaysUnreachable',
    relays_refused: 'nostrSettings.relaysRefused',
};

/** The switch, the ticked parts, a preview, and Publish. */
function PublicProfile({ state, setState, reload }) {
    const { t, i18n } = useTranslation();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [done, setDone] = useState('');
    const saves = useRef(Promise.resolve());
    const waiting = useRef(0);
    // What the member last chose: each save sends all of it, so quick taps
    // can't undo each other, and the page reloads (a fresh preview) only once
    // the last one is saved.
    const wanted = useRef(null);

    const change = (changes) => {
        wanted.current = { on: state.on, parts: state.parts, ...wanted.current, ...changes };
        setState((s) => ({ ...s, ...changes }));
        setError('');
        setDone('');
        waiting.current += 1;
        saves.current = saves.current
            .then(() => settingsApi.updateNostr(wanted.current))
            .catch(() => setError(t('nostrSettings.saveFailed')))
            .then(() => {
                waiting.current -= 1;
                if (waiting.current === 0) { wanted.current = null; return reload(); }
                return undefined;
            });
    };

    const togglePart = (part, on) => {
        const now = wanted.current?.parts ?? state.parts;
        const parts = on ? [...now, part] : now.filter((p) => p !== part);
        change({ parts: PARTS.filter((p) => parts.includes(p)) });
    };

    const publish = async () => {
        setBusy(true);
        setError('');
        setDone('');
        try {
            await saves.current;
            // What the preview showed as on public Nostr now: if the relays
            // give back less this time, the server publishes nothing.
            await publishPublicProfile(state.currentAt ?? null);
            setDone(t('nostrSettings.published'));
            await reload();
        } catch (err) {
            setError(t(PUBLISH_ERRORS[err?.data?.reason] || 'nostrSettings.publishFailed'));
        } finally {
            setBusy(false);
        }
    };

    const when = state.publishedAt
        ? new Date(state.publishedAt).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' })
        : null;

    return (
        <>
            <SettingsGroup title={t('nostrSettings.publicTitle')} footer={state.on ? t('nostrSettings.publicFooterOn') : t('nostrSettings.publicFooterOff')}>
                <SettingsRow icon={Globe} label={t('nostrSettings.publicSwitch')} desc={t('nostrSettings.publicSwitchDesc')}>
                    <Switch
                        checked={state.on}
                        onChange={(on) => change({ on })}
                        label={t('nostrSettings.publicSwitch')}
                        testId="nostr-public-switch"
                    />
                </SettingsRow>
                {state.on && PARTS.map((part) => (
                    <SettingsRow
                        key={part}
                        label={t(`nostrSettings.parts.${part}`)}
                        desc={part === 'nip05' && !state.verified ? t('nostrSettings.parts.nip05None') : undefined}
                    >
                        <Switch
                            checked={state.parts.includes(part)}
                            onChange={(on) => togglePart(part, on)}
                            label={t(`nostrSettings.parts.${part}`)}
                            testId={`nostr-part-${part}`}
                        />
                    </SettingsRow>
                ))}
            </SettingsGroup>

            {state.on && (
                <SettingsGroup title={t('nostrSettings.previewTitle')} footer={t('nostrSettings.previewFooter')}>
                    <div className="set-pad">
                        {state.next ? (
                            <>
                                <p className="ns-preview-label">{t('nostrSettings.afterPublishing')}</p>
                                <ProfileCard profile={state.next} />
                                <details className="ns-details">
                                    <summary>{t('nostrSettings.nowOnPublic')}</summary>
                                    {state.current ? <ProfileCard profile={state.current} /> : <p className="ns-muted">{t('nostrSettings.nothingYet')}</p>}
                                </details>
                                {!state.current && !state.publishedAt && <p className="ns-muted">{t('nostrSettings.nothingFoundNote')}</p>}
                            </>
                        ) : (
                            <div className="ns-loading"><Loader2 size={18} className="ns-spin" aria-label={t('nostrSettings.loading')} /></div>
                        )}
                        <button type="button" className="btn btn-primary btn-sm ns-start" onClick={publish} disabled={busy || !state.next} data-testid="nostr-publish">
                            {busy ? t('nostrSettings.publishing') : t('nostrSettings.publish')}
                        </button>
                        <p className="ns-muted">{when ? t('nostrSettings.lastPublished', { when }) : t('nostrSettings.notPublished')}</p>
                        {error && <p className="ns-error" role="alert">{error}</p>}
                        {done && <p className="ns-ok" role="status">{done}</p>}
                    </div>
                </SettingsGroup>
            )}
        </>
    );
}

/** What BIES signed with the key it keeps for the member. */
function SigningLog({ language }) {
    const { t } = useTranslation();
    const [rows, setRows] = useState(null);
    const [next, setNext] = useState(null); // where the next page starts
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(false);

    const loadPage = useCallback((before) => {
        setLoading(true);
        return signerApi.log(20, QUIET_KINDS, before)
            .then((res) => {
                setRows((r) => [...(before ? r || [] : []), ...(res.signatures || [])]);
                setNext(res.next);
                setError(false);
            })
            .catch(() => setError(true))
            .finally(() => setLoading(false));
    }, []);
    useEffect(() => { loadPage(null); }, [loadPage]);

    return (
        <SettingsGroup title={t('nostrSettings.logTitle')} footer={t('nostrSettings.logFooter')}>
            {error && <div className="set-pad"><p className="ns-error">{t('nostrSettings.logFailed')}</p></div>}
            {!error && rows === null && <div className="ns-loading"><Loader2 size={18} className="ns-spin" aria-label={t('nostrSettings.loading')} /></div>}
            {rows?.length === 0 && <div className="set-pad"><p className="ns-muted">{t('nostrSettings.logEmpty')}</p></div>}
            {rows?.map((s) => (
                <SettingsRow
                    key={s.id}
                    label={KIND_LABELS[s.kind] ? t(`nostrSettings.kinds.${KIND_LABELS[s.kind]}`) : t('nostrSettings.kinds.other', { kind: s.kind })}
                    desc={`${s.source === 'app' ? t('nostrSettings.byYou') : t('nostrSettings.byBies')} · ${new Date(s.createdAt).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' })}`}
                />
            ))}
            {next && <SettingsRow label={t('nostrSettings.showMore')} onClick={() => loadPage(next)} disabled={loading} center />}
        </SettingsGroup>
    );
}

export default NostrSettings;
