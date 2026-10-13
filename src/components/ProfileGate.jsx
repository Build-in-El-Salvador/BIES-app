import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Camera, Loader2, User } from 'lucide-react';
import { profilesApi, uploadApi } from '../services/api';
import { nostrService, PUBLIC_RELAYS } from '../services/nostrService';
import { nostrSigner } from '../services/nostrSigner';
import { getAssetUrl } from '../utils/assets';
import { isPlaceholderName } from '../utils/profileComplete';
import { objectionableMessage } from './moderation/objectionable';
import ModerationSheet from './moderation/ModerationSheet';
import ImageCropModal from './ImageCropModal';
import './moderation/Moderation.css';
import './ProfileGate.css';

const NAME_MAX = 60;

/**
 * The cropped photo goes to BIES, like listing photos (no signing step, and
 * it stays with BIES). A full URL, since Nostr profiles carry it too.
 */
async function uploadPhoto(file) {
    const { url } = await uploadApi.media(file);
    return new URL(getAssetUrl(url), window.location.origin).href;
}

/**
 * A member's BIES name, asked for before anything else (after the terms of
 * use) until there is one: new accounts, and Nostr sign-ins that only have a
 * "nostr:1a2b3c4d" placeholder. A photo is offered too; only the name is
 * needed to continue. It can't be dismissed, only finished or signed out of.
 * A Nostr sign-in starts from their Nostr name and picture, and can change
 * either for BIES: the new ones go to the BIES relay, never their public
 * Nostr profile.
 */
const ProfileGate = ({ user, onDone, onSignOut }) => {
    const { t } = useTranslation();
    const current = user.profile || {};
    const isNew = isPlaceholderName(current.name);
    const [name, setName] = useState(isNew ? '' : current.name);
    const [avatar, setAvatar] = useState(current.avatar || '');
    const [nostrProfile, setNostrProfile] = useState(null);
    const [fromNostr, setFromNostr] = useState(false); // filled in from their Nostr profile
    const [crop, setCrop] = useState(null); // object URL of the photo being cropped
    const [uploading, setUploading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const fileRef = useRef(null);
    // What the member already typed or picked wins over their Nostr profile.
    const touched = useRef({ name: false, avatar: false });

    useEffect(() => {
        if (!nostrSigner.signsOnDevice || !user.nostrPubkey) return undefined;
        let cancelled = false;
        nostrService.getProfile(user.nostrPubkey, PUBLIC_RELAYS).then((found) => {
            if (cancelled || !found) return;
            setNostrProfile(found);
            const nostrName = (found.display_name || found.name || '').trim().slice(0, NAME_MAX);
            const useName = isNew && nostrName && !touched.current.name;
            const usePicture = !current.avatar && /^https:\/\//.test(found.picture || '') && !touched.current.avatar;
            if (useName) setName(nostrName);
            if (usePicture) setAvatar(found.picture);
            if (useName || usePicture) setFromNostr(true);
        }).catch(() => {});
        return () => { cancelled = true; };
    }, [user.nostrPubkey, isNew, current.avatar]);

    // A name saved meanwhile (the create-a-key sign-up asks for one).
    useEffect(() => {
        if (!touched.current.name && !isPlaceholderName(current.name)) setName(current.name);
    }, [current.name]);

    const pickPhoto = (e) => {
        const file = e.target.files?.[0];
        e.target.value = ''; // the same file can be picked again
        if (!file) return;
        if (!file.type.startsWith('image/')) { setError(t('profileGate.notImage')); return; }
        setError('');
        setCrop(URL.createObjectURL(file));
    };

    const closeCrop = () => {
        if (crop) URL.revokeObjectURL(crop);
        setCrop(null);
    };

    const cropped = async (file) => {
        closeCrop();
        touched.current.avatar = true;
        setUploading(true);
        setError('');
        try {
            setAvatar(await uploadPhoto(file));
        } catch {
            setError(t('profileGate.uploadFailed'));
        } finally {
            setUploading(false);
        }
    };

    const clean = name.trim();
    const ready = !!clean && !uploading && !busy;

    const save = async (e) => {
        e.preventDefault();
        if (!ready) return;
        if (isPlaceholderName(clean)) { setError(t('profileGate.nameNeeded')); return; }
        setBusy(true);
        setError('');
        try {
            const updates = { name: clean };
            if (avatar) updates.avatar = avatar;
            // The rest of a Nostr profile comes along where BIES has nothing yet.
            const found = nostrProfile || {};
            if (!current.bio && found.about) updates.bio = found.about;
            if (!current.banner && found.banner) updates.banner = found.banner;
            if (!current.website && /^https?:\/\//.test(found.website || '')) updates.website = found.website;
            await profilesApi.update(updates);

            // Email accounts: the server publishes their profile on save.
            if (nostrSigner.signsOnDevice) {
                await nostrService.updateProfileToBiesRelay({ name: clean, display_name: clean, ...(avatar ? { picture: avatar } : {}) })
                    .catch((err) => console.warn('[ProfileGate] BIES relay profile failed:', err));
            }
            // Welcome a new member in the BIES feed (never on public relays).
            if (isNew) {
                await nostrService.publishToBiesRelay({
                    kind: 1,
                    created_at: Math.floor(Date.now() / 1000),
                    tags: [['t', 'bies'], ['t', 'new-user'], ['t', 'introductions'], ['t', 'buildinelsalvador']],
                    content: `${clean} just joined the Builder Hub! Welcome to the Highest Signal Builder Ecosystem of El Salvador. #introductions #buildinelsalvador`,
                }).catch((err) => console.warn('[ProfileGate] Welcome post failed:', err));
            }
            await onDone();
        } catch (err) {
            setError(objectionableMessage(t, err) || t('profileGate.saveFailed'));
            setBusy(false);
        }
    };

    const photoLabel = avatar ? t('profileGate.changePhoto') : t('profileGate.addPhoto');

    return (
        <ModerationSheet title={t('profileGate.title')} className="profile-gate">
            <p className="mod-muted">{t('profileGate.intro')}</p>
            {fromNostr && <p className="mod-hint pg-from-nostr">{t('profileGate.fromNostr')}</p>}
            <form className="pg-form" onSubmit={save} noValidate>
                <div className="pg-photo">
                    <button
                        type="button"
                        className="pg-avatar"
                        onClick={() => fileRef.current?.click()}
                        disabled={uploading || busy}
                        aria-label={photoLabel}
                    >
                        {avatar ? <img src={getAssetUrl(avatar)} alt="" /> : <User size={44} aria-hidden="true" />}
                        <span className="pg-avatar-badge" aria-hidden="true">
                            {uploading ? <Loader2 size={16} className="mod-spin" /> : <Camera size={16} />}
                        </span>
                    </button>
                    <button type="button" className="mod-link" onClick={() => fileRef.current?.click()} disabled={uploading || busy}>
                        {uploading ? t('profileGate.uploading') : photoLabel}
                    </button>
                    <input ref={fileRef} type="file" accept="image/*" hidden onChange={pickPhoto} />
                </div>

                <label className="mod-label" htmlFor="pg-name">{t('profileGate.nameLabel')}</label>
                <input
                    id="pg-name"
                    className="pg-input"
                    type="text"
                    value={name}
                    maxLength={NAME_MAX}
                    autoComplete="name"
                    autoCapitalize="words"
                    placeholder={t('profileGate.namePlaceholder')}
                    aria-describedby="pg-name-hint"
                    onChange={(e) => { touched.current.name = true; setName(e.target.value); }}
                />
                <p className="mod-hint" id="pg-name-hint">{t('profileGate.nameHint')}</p>

                {error && (
                    <div className="mod-error" role="alert"><AlertCircle size={16} /><span>{error}</span></div>
                )}

                <div className="mod-actions">
                    <button type="submit" className="mod-button" disabled={!ready}>
                        {busy && <Loader2 size={18} className="mod-spin" />}
                        {t('profileGate.continue')}
                    </button>
                    {!clean && !busy && !uploading && (
                        <p className="mod-hint pg-missing">{t('profileGate.needName')}</p>
                    )}
                    <button type="button" className="mod-link" onClick={onSignOut} disabled={busy}>
                        {t('moderation.terms.signOut')}
                    </button>
                </div>
            </form>

            {/* Above the sheet, which sits over every other modal. */}
            {crop && createPortal(
                <div className="pg-crop-layer">
                    <ImageCropModal imageSrc={crop} aspect={1} shape="round" onCrop={cropped} onCancel={closeCrop} />
                </div>,
                document.body,
            )}
        </ModerationSheet>
    );
};

export default ProfileGate;
