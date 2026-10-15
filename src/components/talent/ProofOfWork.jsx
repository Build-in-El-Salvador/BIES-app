import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, FileText, Layers, Link2, Play } from 'lucide-react';
import { getAssetUrl } from '../../utils/assets';
import { openExternal } from '../../utils/openExternal';
import ModerationSheet from '../moderation/ModerationSheet';
import { isVideo, mediaOf, pictureOf, shortLink } from './talentOptions';
import './ProofOfWork.css';

/**
 * A member's proof of work: examples of what they made or did, as tiles
 * (its first photo, or a video's still, and its title), the way Behance,
 * Dribbble and Contra show work. A tile opens the work in a sheet: what they
 * did, its link, and all its photos and videos.
 *
 * @param {Array<{title: string, details?: string, link?: string, year?: string, media?: {url: string, poster?: string}[]}>} works
 */
const ProofOfWork = ({ works }) => {
    const { t } = useTranslation();
    const [open, setOpen] = useState(null); // the index of the work shown
    const list = Array.isArray(works) ? works.filter((w) => w?.title) : [];
    const work = open !== null ? list[open] : null;

    return (
        <>
            <ul className="pow-grid">
                {list.map((w, i) => {
                    const media = mediaOf(w);
                    const first = media[0];
                    const picture = pictureOf(first);
                    const Icon = w.link ? Link2 : FileText;
                    return (
                        <li key={`${w.title}-${i}`}>
                            <button type="button" className="pow-tile" onClick={() => setOpen(i)} aria-haspopup="dialog">
                                <span className="pow-tile-photo">
                                    {picture
                                        ? <img src={getAssetUrl(picture)} alt="" loading="lazy" />
                                        : first ? <span className="pow-tile-blank" /> : <Icon size={28} aria-hidden="true" />}
                                    {first && isVideo(first.url) && (
                                        <span className="pow-tile-play" role="img" aria-label={t('talent.video')}>
                                            <Play size={16} fill="currentColor" aria-hidden="true" />
                                        </span>
                                    )}
                                    {media.length > 1 && (
                                        <span className="pow-tile-count">
                                            <Layers size={12} aria-hidden="true" />
                                            <span className="pow-sr">{t('talent.mediaCount', { count: media.length })}</span>
                                            <span aria-hidden="true">{media.length}</span>
                                        </span>
                                    )}
                                </span>
                                <span className="pow-tile-title">{w.title}</span>
                                {w.year && <span className="pow-tile-year">{w.year}</span>}
                            </button>
                        </li>
                    );
                })}
            </ul>

            {work && (
                <ModerationSheet title={work.title} onClose={() => setOpen(null)} className="pow-sheet">
                    {work.year && <p className="pow-year">{work.year}</p>}
                    {work.details && <p className="pow-details">{work.details}</p>}
                    {work.link && (
                        <button type="button" className="pow-link" onClick={() => openExternal(work.link)}>
                            <ExternalLink size={16} aria-hidden="true" />
                            <span>{shortLink(work.link)}</span>
                        </button>
                    )}
                    {mediaOf(work).map((item, i) => (isVideo(item.url) ? (
                        // Plays here, not full screen; nothing loads until it's played.
                        <video
                            key={item.url}
                            className="pow-video"
                            src={getAssetUrl(item.url)}
                            poster={item.poster ? getAssetUrl(item.poster) : undefined}
                            controls
                            playsInline
                            preload="none"
                            aria-label={t('talent.workVideo', { title: work.title, n: i + 1 })}
                        />
                    ) : (
                        <img
                            key={item.url}
                            className="pow-photo"
                            src={getAssetUrl(item.url)}
                            alt={t('talent.workPhoto', { title: work.title, n: i + 1 })}
                            loading="lazy"
                        />
                    )))}
                </ModerationSheet>
            )}
        </>
    );
};

export default ProofOfWork;
