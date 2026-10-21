import React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MapPin, User, Play } from 'lucide-react';
import { getAssetUrl } from '../../utils/assets';
import { isPlaceholderName } from '../../utils/profileComplete';
import { isVideo, pictureOf, workMedia } from './talentOptions';
import TalentPills from './TalentPills';

/**
 * A talent in the list, as a person (LinkedIn and Upwork rows): their photo,
 * what they offer, their name, the category and skills in blue, where they
 * work, whether they're taking work and what kind, their rate, and a strip
 * of their proof of work.
 *
 * @param {object} talent - from talentApi
 */
const TalentCard = ({ talent }) => {
    const { t } = useTranslation();
    const profile = talent.user?.profile || {};
    const name = isPlaceholderName(profile.name) ? t('profileView.newMember') : profile.name;
    const category = talent.category ? t(`talent.categories.${talent.category}`) : '';
    const summary = [category, (talent.skills || []).join(', ')].filter(Boolean).join(' · ');
    const place = [talent.location, talent.remote && t('talent.remote')].filter(Boolean).join(' · ');
    // Pictures only: a video shows its still (one without isn't shown).
    const thumbs = workMedia(talent).filter((item) => pictureOf(item)).slice(0, 3);

    return (
        /* styled-jsx only scopes DOM elements, so link resets are inline; the visual card is the div */
        <Link
            to={`/talents/${talent.id}`}
            className="tal-card-link"
            style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
        >
            <div className="tal-card">
                <div className="tal-card-photo">
                    {profile.avatar ? <img src={getAssetUrl(profile.avatar)} alt="" loading="lazy" decoding="async" /> : <User size={28} />}
                </div>

                <div className="tal-card-info">
                    <h3 className="tal-card-title">{talent.title}</h3>
                    <p className="tal-card-name">{name}</p>
                    {summary && <p className="tal-card-summary">{summary}</p>}
                    {place && (
                        <div className="tal-card-meta">
                            <MapPin size={14} />
                            <span>{place}</span>
                        </div>
                    )}
                    <div className="tal-card-pills">
                        <TalentPills talent={talent} />
                    </div>
                    {thumbs.length > 0 && (
                        <div className="tal-card-thumbs" aria-hidden="true">
                            {thumbs.map((item) => (
                                <span key={item.url} className="tal-card-thumb">
                                    <img src={getAssetUrl(pictureOf(item))} alt="" loading="lazy" />
                                    {isVideo(item.url) && <span className="tal-card-play"><Play size={12} fill="currentColor" /></span>}
                                </span>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            <style jsx>{`
                .tal-card {
                    display: flex;
                    align-items: flex-start;
                    gap: 0.9rem;
                    padding: 1rem;
                    background: var(--color-surface);
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-lg);
                    box-shadow: var(--shadow-sm);
                    transition: transform 0.2s, box-shadow 0.2s, border-color 0.2s;
                }
                .tal-card:hover {
                    transform: translateY(-1px);
                    box-shadow: var(--shadow-md);
                    border-color: var(--color-primary);
                }
                .tal-card-photo {
                    width: 64px;
                    height: 64px;
                    border-radius: 50%;
                    overflow: hidden;
                    flex-shrink: 0;
                    background: var(--color-blue-tint);
                    color: var(--color-primary);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }
                .tal-card-photo img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    display: block;
                }
                .tal-card-info {
                    flex: 1;
                    min-width: 0;
                    display: flex;
                    flex-direction: column;
                    gap: 3px;
                }
                .tal-card-title {
                    font-size: 1.05rem;
                    font-weight: 700;
                    margin: 0;
                    line-height: 1.3;
                    overflow-wrap: anywhere;
                }
                .tal-card-name {
                    margin: 0;
                    font-size: 0.85rem;
                    color: var(--color-gray-600);
                }
                .tal-card-summary {
                    font-size: 0.85rem;
                    font-weight: 500;
                    color: var(--color-primary);
                    margin: 0;
                    display: -webkit-box;
                    -webkit-line-clamp: 2;
                    -webkit-box-orient: vertical;
                    overflow: hidden;
                }
                .tal-card-meta {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    font-size: 0.8rem;
                    color: var(--color-gray-500);
                    min-width: 0;
                }
                .tal-card-meta span {
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .tal-card-pills {
                    margin-top: 4px;
                }
                .tal-card-thumbs {
                    display: flex;
                    gap: 6px;
                    margin-top: 8px;
                }
                .tal-card-thumb {
                    position: relative;
                    width: 56px;
                    height: 56px;
                }
                .tal-card-thumb img {
                    width: 100%;
                    height: 100%;
                    border-radius: 8px;
                    object-fit: cover;
                    background: var(--color-gray-100);
                }
                .tal-card-play {
                    position: absolute;
                    left: 50%;
                    top: 50%;
                    width: 24px;
                    height: 24px;
                    margin: -12px 0 0 -12px;
                    padding-left: 2px;
                    border-radius: 50%;
                    background: rgba(0, 0, 0, 0.55);
                    color: white;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }
            `}</style>
        </Link>
    );
};

export default TalentCard;
