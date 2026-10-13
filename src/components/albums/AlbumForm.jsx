import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Loader2 } from 'lucide-react';
import { albumsApi } from '../../services/api';
import ModerationSheet from '../moderation/ModerationSheet';
import '../moderation/Moderation.css';
import './Albums.css';

/** Who can see an album: a member's has all three; a farm's or business's, the first two. */
export const audiencesFor = (forListing) => (forListing ? ['PUBLIC', 'MEMBERS'] : ['PUBLIC', 'MEMBERS', 'ONLY_ME']);

const errorText = (err, t) => (err?.status === 422 ? t('albums.objectionable') : err?.message || t('albums.saveFailed'));

/**
 * New album, or edit one (`album`): a title, a few words, and who can see
 * it. For a farm or business, `listingId`.
 *
 * @param {(album: object) => void} onSaved
 */
export default function AlbumForm({ album, listingId, forListing = !!listingId, onClose, onSaved }) {
    const { t } = useTranslation();
    const [title, setTitle] = useState(album?.title || '');
    const [description, setDescription] = useState(album?.description || '');
    const [visibility, setVisibility] = useState(album?.visibility || 'MEMBERS');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const save = async (e) => {
        e.preventDefault();
        if (!title.trim()) return;
        setBusy(true);
        setError('');
        try {
            const body = { title: title.trim(), description: description.trim(), visibility };
            const saved = album
                ? await albumsApi.update(album.id, body)
                : await albumsApi.create({ ...body, ...(listingId ? { listingId } : {}) });
            onSaved(saved);
        } catch (err) {
            setError(errorText(err, t));
            setBusy(false);
        }
    };

    return (
        <ModerationSheet title={t(album ? 'albums.editTitle' : 'albums.newTitle')} onClose={busy ? undefined : onClose}>
            <form onSubmit={save} style={{ display: 'contents' }}>
                <div className="alb-field">
                    <label className="mod-label" htmlFor="alb-title">{t('albums.name')}</label>
                    <input
                        id="alb-title"
                        className="alb-input"
                        value={title}
                        maxLength={80}
                        placeholder={t(forListing ? 'albums.namePlaceholderListing' : 'albums.namePlaceholder')}
                        onChange={(e) => setTitle(e.target.value)}
                        autoFocus
                    />
                </div>
                <div className="alb-field">
                    <label className="mod-label" htmlFor="alb-desc">{t('albums.description')}</label>
                    <textarea
                        id="alb-desc"
                        className="mod-textarea"
                        value={description}
                        maxLength={500}
                        placeholder={t('albums.descriptionPlaceholder')}
                        onChange={(e) => setDescription(e.target.value)}
                    />
                </div>
                <div className="alb-field">
                    <label className="mod-label" htmlFor="alb-audience">{t('albums.audience')}</label>
                    <select id="alb-audience" className="alb-select" value={visibility} onChange={(e) => setVisibility(e.target.value)}>
                        {audiencesFor(forListing).map((v) => <option key={v} value={v}>{t(`albums.audiences.${v}`)}</option>)}
                    </select>
                    <p className="mod-hint">{t(`albums.audienceHints.${visibility}`)}</p>
                </div>
                {error && <div className="mod-error" role="alert"><AlertCircle size={16} /><span>{error}</span></div>}
                <div className="mod-actions">
                    <button type="submit" className="mod-button" disabled={busy || !title.trim()}>
                        {busy && <Loader2 size={18} className="mod-spin" />}
                        {t(album ? 'albums.save' : 'albums.create')}
                    </button>
                </div>
            </form>
        </ModerationSheet>
    );
}
