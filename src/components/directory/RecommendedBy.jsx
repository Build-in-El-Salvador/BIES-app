import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { User } from 'lucide-react';
import { getAssetUrl } from '../../utils/assets';
import { isPlaceholderName } from '../../utils/profileComplete';
import { recommenders } from './recommenders';

/**
 * "Recommended by": the faces of the members who vouch for a listing, in one
 * row that scrolls sideways, like Network on a profile. Each opens that
 * member's profile, where their Recommendations are.
 */
export default function RecommendedBy({ listing, titleStyle }) {
    const { t } = useTranslation();
    const people = recommenders(listing);
    if (people.length === 0) return null;

    return (
        <section className="dir-recommended" aria-labelledby="dir-recommended-title">
            <h2 id="dir-recommended-title" style={titleStyle}>
                {t('directory.recommendedBy')}
                <span className="dir-recommended-count">{people.length}</span>
            </h2>
            <ul className="dir-recommended-row">
                {people.map((r) => {
                    const name = isPlaceholderName(r.user.profile?.name) ? '' : r.user.profile.name.trim();
                    // No photo: their initial, as in the reviews below.
                    const fallback = name ? <span className="dir-recommender-initial">{name[0].toUpperCase()}</span> : <User size={26} />;
                    return (
                        <li key={r.id}>
                            <Link to={`/builder/${r.user.nostrPubkey || r.user.id}`} className="dir-recommender">
                                <span className="dir-recommender-photo">
                                    {r.user.profile?.avatar ? <img src={getAssetUrl(r.user.profile.avatar)} alt="" /> : fallback}
                                </span>
                                <span className="dir-recommender-name">
                                    {name || t('profileView.newMember')}
                                </span>
                            </Link>
                        </li>
                    );
                })}
            </ul>

            <style jsx>{`
                .dir-recommended { margin-top: 1.75rem; }
                .dir-recommended-count { margin-left: 8px; font-weight: 500; color: var(--color-gray-500); }
                .dir-recommended-row {
                    list-style: none;
                    margin: 0;
                    padding: 0 0 4px;
                    display: flex;
                    gap: 12px;
                    overflow-x: auto;
                    scroll-snap-type: x proximity;
                    -webkit-overflow-scrolling: touch;
                    scrollbar-width: none;
                }
                .dir-recommended-row::-webkit-scrollbar { display: none; }
                .dir-recommended-row li { flex: 0 0 76px; scroll-snap-align: start; }
                .dir-recommended-row :global(.dir-recommender) {
                    display: flex; flex-direction: column; align-items: center; gap: 6px;
                    text-decoration: none; color: var(--color-gray-900); text-align: center;
                }
                .dir-recommender-photo {
                    width: 64px; height: 64px; border-radius: 50%; overflow: hidden;
                    display: flex; align-items: center; justify-content: center;
                    background: var(--color-gray-100); color: var(--color-gray-400);
                }
                .dir-recommender-photo img { width: 100%; height: 100%; object-fit: cover; }
                .dir-recommender-initial { font-size: 1.5rem; font-weight: 700; color: var(--color-primary); }
                .dir-recommender-name {
                    max-width: 100%;
                    font-size: 0.82rem; font-weight: 600; line-height: 1.25;
                    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
                    overflow-wrap: anywhere;
                }
            `}</style>
        </section>
    );
}
