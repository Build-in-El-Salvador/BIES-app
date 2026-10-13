import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Globe, GalleryVerticalEnd, Lock, Plus, Users } from 'lucide-react';
import { albumsApi } from '../../services/api';
import { getAssetUrl } from '../../utils/assets';
import AlbumForm from './AlbumForm';
import './Albums.css';

export const AUDIENCE_ICONS = { PUBLIC: Globe, MEMBERS: Users, ONLY_ME: Lock };

/**
 * A member's or a listing's albums, and whether the viewer can add one.
 * The page decides whether to show the block (it wraps it in its own
 * section): `show` is true when there are albums, or the viewer can add.
 */
export function useAlbums({ userId, listingId }) {
    const [state, setState] = useState({ albums: [], canManage: false, loaded: false });
    const load = useCallback(() => {
        if (!userId && !listingId) return Promise.resolve();
        return (userId ? albumsApi.forUser(userId) : albumsApi.forListing(listingId))
            .then((res) => setState({ albums: res?.data || [], canManage: !!res?.canManage, loaded: true }))
            .catch(() => setState((s) => ({ ...s, loaded: true })));
    }, [userId, listingId]);
    useEffect(() => { load(); }, [load]);
    return { ...state, show: state.albums.length > 0 || state.canManage, reload: load };
}

/**
 * The Albums heading, "New album" for those who can add one, and a grid of
 * albums (cover, title, how many photos, who can see it). Each opens its
 * page (/albums/:id).
 *
 * @param {{ albums: object[], canManage: boolean }} albums  from useAlbums
 */
export default function AlbumsBlock({ albums, canManage, listingId, titleStyle, titleClassName }) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [creating, setCreating] = useState(false);

    return (
        <div className="alb-block">
            <div className="alb-head">
                <h2 className={titleClassName} style={titleStyle}>{t('albums.title')}</h2>
                {canManage && (
                    <button type="button" className="alb-new" onClick={() => setCreating(true)} data-testid="album-new">
                        <Plus size={16} /> {t('albums.new')}
                    </button>
                )}
            </div>
            {albums.length === 0 ? (
                canManage && <p className="alb-hint">{t(listingId ? 'albums.emptyListing' : 'albums.emptyOwn')}</p>
            ) : (
                <ul className="alb-grid">
                    {albums.map((a) => {
                        const Icon = AUDIENCE_ICONS[a.visibility] || Users;
                        return (
                            <li key={a.id}>
                                <Link to={`/albums/${a.id}`} className="alb-card">
                                    <span className="alb-cover">
                                        {a.cover ? <img src={getAssetUrl(a.cover.url)} alt="" loading="lazy" /> : <GalleryVerticalEnd size={30} />}
                                    </span>
                                    <span className="alb-card-title">{a.title}</span>
                                    <span className="alb-card-meta">
                                        <Icon size={13} aria-label={t(`albums.audiences.${a.visibility}`)} />
                                        {t('albums.photoCount', { count: a.photoCount })}
                                    </span>
                                </Link>
                            </li>
                        );
                    })}
                </ul>
            )}
            {creating && (
                <AlbumForm
                    listingId={listingId}
                    onClose={() => setCreating(false)}
                    onSaved={(album) => navigate(`/albums/${album.id}`)}
                />
            )}
        </div>
    );
}
