import React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Edit3, MapPin } from 'lucide-react';
import TalentPills from './TalentPills';
import ProofOfWork from './ProofOfWork';

/**
 * One of a member's talents on their profile (the Talents tab, beside
 * Photos): what they offer, whether they're taking work and what kind, their
 * skills, a few lines about it, and their proof of work, with the way to its
 * full page. On your own profile, Edit.
 *
 * @param {object}  talent - from talentApi
 * @param {boolean} isOwn
 */
const TalentSummary = ({ talent, isOwn }) => {
    const { t } = useTranslation();
    const category = talent.category ? t(`talent.categories.${talent.category}`) : '';
    const place = [talent.location, talent.remote && t('talent.remote')].filter(Boolean).join(' · ');
    const skills = (talent.skills || []).filter(Boolean);
    const works = Array.isArray(talent.works) ? talent.works : [];

    return (
        <div className="ts">
            <div className="ts-head">
                <h2 className="ts-title">
                    <Link to={`/talents/${talent.id}`} className="ts-title-link">{talent.title}</Link>
                </h2>
                {isOwn && (
                    <Link to={`/talents/${talent.id}/edit`} className="ts-edit">
                        <Edit3 size={14} aria-hidden="true" /> {t('talent.edit')}
                    </Link>
                )}
            </div>
            {(category || place) && (
                <p className="ts-meta">
                    {category}
                    {category && place && <span aria-hidden="true"> · </span>}
                    {place && <span className="ts-place"><MapPin size={14} className="ts-pin" aria-hidden="true" /> {place}</span>}
                </p>
            )}
            <TalentPills talent={talent} />

            {skills.length > 0 && (
                <div className="ts-skills">
                    {skills.map((skill) => <span key={skill} className="ts-skill">{skill}</span>)}
                </div>
            )}
            {talent.about && <p className="ts-about">{talent.about}</p>}

            {works.length > 0 && (
                <>
                    <h3 className="ts-sub">{t('talent.proofOfWork')}</h3>
                    <ProofOfWork works={works} />
                </>
            )}

            <Link to={`/talents/${talent.id}`} className="ts-more">
                {t('talent.seeTalent')} <ChevronRight size={16} aria-hidden="true" />
            </Link>

            <style jsx>{`
                .ts {
                    display: flex;
                    flex-direction: column;
                    gap: 10px;
                }
                .ts-head {
                    display: flex;
                    align-items: flex-start;
                    justify-content: space-between;
                    gap: 12px;
                }
                .ts-title {
                    margin: 0;
                    font-family: var(--font-sans);
                    font-size: 1.15rem;
                    font-weight: 700;
                    line-height: 1.3;
                    min-width: 0;
                    overflow-wrap: anywhere;
                }
                .ts :global(.ts-title-link) {
                    color: var(--color-gray-900);
                    text-decoration: none;
                }
                .ts :global(.ts-edit) {
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                    flex-shrink: 0;
                    padding: 0.35rem 0.85rem;
                    border-radius: var(--radius-full);
                    border: 1px solid var(--color-gray-300);
                    color: var(--color-gray-700);
                    text-decoration: none;
                    font-size: 0.82rem;
                    font-weight: 600;
                }
                .ts-meta {
                    margin: -4px 0 0;
                    display: flex;
                    align-items: center;
                    flex-wrap: wrap;
                    gap: 4px;
                    font-size: 0.9rem;
                    color: var(--color-gray-600);
                }
                .ts-place {
                    display: inline-flex;
                    align-items: center;
                    gap: 4px;
                }
                .ts-meta :global(.ts-pin) {
                    color: var(--color-gray-500);
                    flex-shrink: 0;
                }
                .ts-skills {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 6px;
                }
                .ts-skill {
                    padding: 0.3rem 0.75rem;
                    border-radius: var(--radius-full);
                    background: var(--color-blue-tint);
                    color: var(--color-primary);
                    font-size: 0.82rem;
                    font-weight: 600;
                }
                .ts-about {
                    margin: 0;
                    font-size: 0.95rem;
                    line-height: 1.55;
                    color: var(--color-gray-800);
                    white-space: pre-line;
                    display: -webkit-box;
                    -webkit-line-clamp: 4;
                    -webkit-box-orient: vertical;
                    overflow: hidden;
                }
                .ts-sub {
                    margin: 6px 0 2px;
                    font-family: var(--font-sans);
                    font-size: 1rem;
                    font-weight: 700;
                    color: var(--color-gray-900);
                }
                .ts :global(.ts-more) {
                    align-self: flex-start;
                    display: inline-flex;
                    align-items: center;
                    gap: 2px;
                    padding: 4px 0;
                    color: var(--color-primary);
                    font-weight: 600;
                    font-size: 0.95rem;
                    text-decoration: none;
                }
            `}</style>
        </div>
    );
};

export default TalentSummary;
