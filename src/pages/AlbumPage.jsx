import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Flag, ImagePlus, GalleryVerticalEnd, Loader2, MoreHorizontal, Pencil, Star, Trash2 } from 'lucide-react';
import { albumsApi } from '../services/api';
import { mediaService } from '../services/mediaService';
import { useLightbox } from '../context/LightboxContext';
import { getAssetUrl } from '../utils/assets';
import BackButton from '../components/BackButton';
import AlbumForm from '../components/albums/AlbumForm';
import { AUDIENCE_ICONS } from '../components/albums/AlbumsBlock';
import ModerationSheet from '../components/moderation/ModerationSheet';
import { useModerationDialogs } from '../components/moderation/useModerationDialogs';
import '../components/albums/Albums.css';

const BATCH = 20; // photos per request (album.controller.ts addPhotosSchema)

/**
 * One album (/albums/:id): its photos in the order they were added, each
 * with its caption and date, so an album can tell a story (a harvest week by
 * week, a renovation). Whoever runs it adds photos, edits captions, picks
 * the cover, and edits or deletes it; anyone else can report it or a photo.
 */
const AlbumPage = () => {
    const { t, i18n } = useTranslation();
    const { id } = useParams();
    const navigate = useNavigate();
    const lightbox = useLightbox();
    const fileRef = useRef(null);
    const [album, setAlbum] = useState(null);
    const [missing, setMissing] = useState(false);
    const [uploading, setUploading] = useState(null); // { done, total }
    const [error, setError] = useState('');
    const [editing, setEditing] = useState(false);
    const [menu, setMenu] = useState(null); // 'album' | a photo
    const [captionFor, setCaptionFor] = useState(null);
    const { openReport, dialogs } = useModerationDialogs();

    const load = useCallback(() => albumsApi.get(id)
        .then((a) => { setAlbum(a); setMissing(false); })
        .catch(() => setMissing(true)), [id]);
    useEffect(() => { load(); }, [load]);

    if (missing) {
        return (
            <div className="alb-missing">
                <GalleryVerticalEnd size={36} />
                <p>{t('albums.unavailable')}</p>
                <Link to="/home" className="mod-link">{t('albums.goHome')}</Link>
            </div>
        );
    }
    if (!album) {
        return <div className="alb-missing"><Loader2 size={28} className="mod-spin" /></div>;
    }

    const forListing = album.owner.type === 'listing';
    const Audience = AUDIENCE_ICONS[album.visibility];
    const coverId = album.coverPhotoId || album.photos[0]?.id;
    const urls = album.photos.map((p) => getAssetUrl(p.url));
    const date = (d) => new Date(d).toLocaleDateString(i18n.language?.startsWith('es') ? 'es' : 'en', { day: 'numeric', month: 'short', year: 'numeric' });

    const addPhotos = async (e) => {
        const files = Array.from(e.target.files || []).filter((f) => f.type.startsWith('image/'));
        e.target.value = '';
        if (!files.length) return;
        setError('');
        setUploading({ done: 0, total: files.length });
        try {
            const uploaded = [];
            for (const file of files) {
                const err = mediaService.validateFile(file, 0);
                if (err) throw new Error(err);
                const { path, width, height } = await mediaService.uploadFile(file);
                uploaded.push({ url: path, ...(width && height ? { width, height } : {}) });
                setUploading({ done: uploaded.length, total: files.length });
            }
            for (let i = 0; i < uploaded.length; i += BATCH) await albumsApi.addPhotos(album.id, uploaded.slice(i, i + BATCH));
            await load();
        } catch (err) {
            setError(err?.message || t('albums.uploadFailed'));
            await load();
        } finally {
            setUploading(null);
        }
    };

    const run = async (fn) => {
        setMenu(null);
        setError('');
        try { await fn(); await load(); } catch (err) { setError(err?.message || t('albums.saveFailed')); }
    };
    const deleteAlbum = () => {
        setMenu(null);
        if (!window.confirm(t('albums.deleteConfirm'))) return;
        albumsApi.delete(album.id).then(() => navigate(album.owner.path, { replace: true })).catch((err) => setError(err?.message || t('albums.saveFailed')));
    };
    const deletePhoto = (photo) => {
        if (!window.confirm(t('albums.deletePhotoConfirm'))) { setMenu(null); return; }
        run(() => albumsApi.deletePhoto(album.id, photo.id));
    };

    return (
        <div className="alb-page">
            <div className="back-head">
                <BackButton fallback={album.owner.path} />
                <h1 className="alb-title">{album.title}</h1>
            </div>
            <p className="alb-meta">
                <Link to={album.owner.path}>{album.owner.name || t('profileView.newMember')}</Link>
                <span aria-hidden="true">·</span>
                <Audience size={14} aria-hidden="true" />
                <span>{t(`albums.audiences.${album.visibility}`)}</span>
                <span aria-hidden="true">·</span>
                <span>{t('albums.photoCount', { count: album.photos.length })}</span>
            </p>
            {album.description && <p className="alb-desc">{album.description}</p>}

            <div className="alb-toolbar">
                {album.canManage && (
                    <>
                        <button type="button" className="alb-btn primary" onClick={() => fileRef.current?.click()} disabled={!!uploading} data-testid="album-add-photos">
                            {uploading ? <Loader2 size={18} className="mod-spin" /> : <ImagePlus size={18} />}
                            {t('albums.addPhotos')}
                        </button>
                        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={addPhotos} data-testid="album-file" />
                    </>
                )}
                <button type="button" className="alb-btn icon" aria-label={t('moderation.menu.more', 'More options')} onClick={() => setMenu('album')}>
                    <MoreHorizontal size={20} />
                </button>
            </div>

            {uploading && <p className="alb-status" role="status"><Loader2 size={16} className="mod-spin" />{t('albums.uploading', { done: uploading.done, total: uploading.total })}</p>}
            {error && <p className="alb-error" role="alert"><AlertCircle size={15} style={{ verticalAlign: '-2px' }} /> {error}</p>}

            {album.photos.length === 0 ? (
                <div className="alb-empty">
                    <GalleryVerticalEnd size={36} />
                    <p style={{ margin: 0 }}>{t(album.canManage ? 'albums.noPhotosOwn' : 'albums.noPhotos')}</p>
                </div>
            ) : (
                <ul className="alb-photos">
                    {album.photos.map((p, i) => (
                        <li key={p.id} className="alb-photo">
                            <button type="button" className="alb-photo-img" onClick={() => lightbox?.open(urls[i], urls)} aria-label={p.caption || t('albums.photo')}>
                                <img src={urls[i]} alt={p.caption || ''} loading="lazy" />
                            </button>
                            {album.canManage && p.id === coverId && album.photos.length > 1 && <span className="alb-cover-badge">{t('albums.cover')}</span>}
                            <button type="button" className="alb-photo-more" aria-label={t('albums.photoOptions')} onClick={() => setMenu(p)}>
                                <MoreHorizontal size={16} />
                            </button>
                            {p.caption && <p className="alb-caption">{p.caption}</p>}
                            <p className="alb-date">{date(p.createdAt)}</p>
                        </li>
                    ))}
                </ul>
            )}

            {menu === 'album' && (
                <ModerationSheet title={album.title} onClose={() => setMenu(null)}>
                    <div className="alb-sheet-actions">
                        {album.canManage ? (
                            <>
                                <button type="button" className="alb-sheet-row" onClick={() => { setMenu(null); setEditing(true); }}><Pencil size={18} /> {t('albums.edit')}</button>
                                <button type="button" className="alb-sheet-row danger" onClick={deleteAlbum}><Trash2 size={18} /> {t('albums.delete')}</button>
                            </>
                        ) : (
                            <button type="button" className="alb-sheet-row danger" onClick={() => { setMenu(null); openReport({ type: 'album', id: album.id }, { name: album.owner.name }); }}>
                                <Flag size={18} /> {t('albums.reportAlbum')}
                            </button>
                        )}
                    </div>
                </ModerationSheet>
            )}

            {menu && menu !== 'album' && (
                <ModerationSheet title={t('albums.photo')} onClose={() => setMenu(null)}>
                    <div className="alb-sheet-actions">
                        {album.canManage ? (
                            <>
                                <button type="button" className="alb-sheet-row" onClick={() => { setCaptionFor(menu); setMenu(null); }}><Pencil size={18} /> {t(menu.caption ? 'albums.editCaption' : 'albums.addCaption')}</button>
                                {menu.id !== coverId && (
                                    <button type="button" className="alb-sheet-row" onClick={() => run(() => albumsApi.update(album.id, { coverPhotoId: menu.id }))}><Star size={18} /> {t('albums.makeCover')}</button>
                                )}
                                <button type="button" className="alb-sheet-row danger" onClick={() => deletePhoto(menu)}><Trash2 size={18} /> {t('albums.deletePhoto')}</button>
                            </>
                        ) : (
                            <button type="button" className="alb-sheet-row danger" onClick={() => { const photo = menu; setMenu(null); openReport({ type: 'photo', id: photo.id }, { name: album.owner.name }); }}>
                                <Flag size={18} /> {t('albums.reportPhoto')}
                            </button>
                        )}
                    </div>
                </ModerationSheet>
            )}

            {captionFor && (
                <CaptionSheet
                    photo={captionFor}
                    onClose={() => setCaptionFor(null)}
                    onSave={(caption) => albumsApi.updatePhoto(album.id, captionFor.id, { caption }).then(() => { setCaptionFor(null); load(); })}
                />
            )}

            {editing && (
                <AlbumForm
                    album={album}
                    forListing={forListing}
                    onClose={() => setEditing(false)}
                    onSaved={() => { setEditing(false); load(); }}
                />
            )}
            {dialogs}
        </div>
    );
};

/** A photo's caption: a few words on what it shows, or when. */
function CaptionSheet({ photo, onClose, onSave }) {
    const { t } = useTranslation();
    const [caption, setCaption] = useState(photo.caption || '');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const save = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try { await onSave(caption.trim()); } catch (err) {
            setError(err?.status === 422 ? t('albums.objectionable') : err?.message || t('albums.saveFailed'));
            setBusy(false);
        }
    };
    return (
        <ModerationSheet title={t(photo.caption ? 'albums.editCaption' : 'albums.addCaption')} onClose={busy ? undefined : onClose}>
            <form onSubmit={save} style={{ display: 'contents' }}>
                <textarea className="mod-textarea" value={caption} maxLength={300} placeholder={t('albums.captionPlaceholder')} onChange={(e) => setCaption(e.target.value)} autoFocus aria-label={t('albums.caption')} />
                {error && <div className="mod-error" role="alert"><AlertCircle size={16} /><span>{error}</span></div>}
                <div className="mod-actions">
                    <button type="submit" className="mod-button" disabled={busy}>
                        {busy && <Loader2 size={18} className="mod-spin" />}
                        {t('albums.save')}
                    </button>
                </div>
            </form>
        </ModerationSheet>
    );
}

export default AlbumPage;
