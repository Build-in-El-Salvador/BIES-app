import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MapPin, Globe, ThumbsUp, Bitcoin, Lock, CalendarClock, CheckCircle, XCircle, Building2, Leaf, Briefcase, Sparkles, Banknote } from 'lucide-react';
import { previewApi } from '../services/api';
import { getAssetUrl } from '../utils/assets';
import CertifiedBadge from '../components/directory/CertifiedBadge';
import logoIcon from '../assets/logo-icon-dark.svg';

const FALLBACK_ICON = { trusted: Building2, farms: Leaf, opportunities: Briefcase, talents: Sparkles };

/**
 * A shared business, farm, opportunity or talent, for someone not signed in
 * (the web app, from a link a member shared): its photo, name, what and
 * where, its own words in short, and what members also see, then "See all
 * details" to sign in, which comes back here as the full page. Nothing that
 * isn't in the preview (server: preview.controller.ts) is fetched.
 *
 * @param {'trusted'|'farms'|'opportunities'|'talents'} section
 */
export default function SharePreview({ section }) {
    const { id } = useParams();
    const { t, i18n } = useTranslation();
    const location = useLocation();
    const navigate = useNavigate();
    const [state, setState] = useState({ loading: true, found: null });

    useEffect(() => {
        let cancelled = false;
        setState({ loading: true, found: null });
        previewApi.get(section, id)
            .then((found) => { if (!cancelled) setState({ loading: false, found }); })
            .catch(() => { if (!cancelled) setState({ loading: false, found: null }); });
        return () => { cancelled = true; };
    }, [section, id]);

    const found = state.found;
    useEffect(() => {
        if (found?.name) document.title = `${found.name} | BIES`;
    }, [found?.name]);

    const signIn = () => navigate('/login', { state: { from: location } });

    const kicker = () => {
        if (!found) return '';
        if (found.section === 'opportunities') {
            const kind = found.kind && t(`opportunities.kinds.${found.type}.${found.kind}`, { defaultValue: '' });
            return [t(`opportunities.types.${found.type}`, { defaultValue: '' }), kind].filter(Boolean).join(' · ');
        }
        if (found.section === 'talents') return t(`talent.categories.${found.category}`, { defaultValue: t('sharePreview.talent') });
        if (found.section === 'farms') return [t('sharePreview.farm'), ...(found.products || []).slice(0, 3)].join(' · ');
        return found.category ? t(`directory.categories.${found.category}`, { defaultValue: t('sharePreview.business') }) : t('sharePreview.business');
    };

    const day = (value) => new Date(`${value}T12:00:00`).toLocaleDateString(i18n.language, { day: 'numeric', month: 'long', year: 'numeric' });

    // What members see beyond this, as the listing has it.
    const behindSignIn = () => {
        const m = found?.members || {};
        return [
            m.fullText && t('sharePreview.members.fullText'),
            m.contact && t('sharePreview.members.contact'),
            m.links && t('sharePreview.members.links'),
            m.hours && t('sharePreview.members.hours'),
            m.map && t('sharePreview.members.map'),
            m.rate && t('sharePreview.members.rate'),
            m.deck && t('sharePreview.members.deck'),
            m.works > 0 && t('sharePreview.members.works', { count: m.works }),
            m.morePhotos > 0 && t('sharePreview.members.morePhotos', { count: m.morePhotos }),
            found?.vouchCount > 0 && t('sharePreview.members.whoRecommends'),
            m.reviews > 0 && t('sharePreview.members.reviews', { count: m.reviews }),
        ].filter(Boolean);
    };

    const Fallback = FALLBACK_ICON[section] || Building2;
    const locked = found ? behindSignIn() : [];

    return (
        <div className="sp">
            <header className="sp-bar">
                <Link to="/login" className="sp-logo" aria-label="BIES">
                    <img src={logoIcon} alt="BIES" style={{ height: 36, width: 'auto', display: 'block' }} />
                </Link>
                <button type="button" className="sp-signin" onClick={signIn}>{t('sharePreview.signIn')}</button>
            </header>
            <div className="sp-line" />

            <main className="sp-main">
                {state.loading ? (
                    <p className="sp-muted sp-loading">{t('common.loading', 'Loading...')}</p>
                ) : !found ? (
                    <section className="sp-card sp-missing">
                        <h1 className="sp-title">{t('sharePreview.missing')}</h1>
                        <p className="sp-muted">{t('sharePreview.missingHint')}</p>
                        <button type="button" className="sp-cta" onClick={signIn}>{t('sharePreview.explore')}</button>
                    </section>
                ) : (
                    <>
                        <div className="sp-cover">
                            {found.photo
                                ? <img src={getAssetUrl(found.photo)} alt="" />
                                : <Fallback size={44} aria-hidden="true" />}
                        </div>
                        <section className="sp-card">
                            {kicker() && <p className="sp-kicker">{kicker()}</p>}
                            <h1 className="sp-title">{found.name}</h1>

                            <ul className="sp-facts">
                                {found.location && <li><MapPin size={18} aria-hidden="true" /><span>{found.location}</span></li>}
                                {found.remote && <li><Globe size={18} aria-hidden="true" /><span>{t('opportunities.remote')}</span></li>}
                                {(found.vouchCount > 0 || found.isCertified) && (
                                    <li>
                                        <ThumbsUp size={18} aria-hidden="true" />
                                        <span className="sp-trust">
                                            {found.vouchCount > 0 && t('sharePreview.recommendedBy', { count: found.vouchCount })}
                                            {found.isCertified && <CertifiedBadge size="md" />}
                                        </span>
                                    </li>
                                )}
                                {found.btcAccepted && <li><Bitcoin size={18} aria-hidden="true" /><span>{t('directory.btcAccepted')}</span></li>}
                                {found.pricing && <li><Banknote size={18} aria-hidden="true" /><span className="sp-price">{found.pricing}</span></li>}
                                {found.available && <li className="sp-good"><CheckCircle size={18} aria-hidden="true" /><span>{t('talent.available')}</span></li>}
                                {found.section === 'opportunities' && !found.isOpen && (
                                    <li className="sp-closed"><XCircle size={18} aria-hidden="true" /><span>{t('sharePreview.closed')}</span></li>
                                )}
                                {found.section === 'opportunities' && found.isOpen && found.closesOn && (
                                    <li><CalendarClock size={18} aria-hidden="true" /><span>{t('sharePreview.openUntil', { date: day(found.closesOn) })}</span></li>
                                )}
                            </ul>

                            {found.about && <p className="sp-about">{found.about}</p>}

                            {locked.length > 0 && (
                                <div className="sp-locked">
                                    <p className="sp-locked-title">{t('sharePreview.membersSee')}</p>
                                    <ul>
                                        {locked.map((line) => <li key={line}><Lock size={15} aria-hidden="true" /><span>{line}</span></li>)}
                                    </ul>
                                </div>
                            )}

                            <button type="button" className="sp-cta" onClick={signIn}>{t('sharePreview.seeAll')}</button>
                            <p className="sp-note">{t('sharePreview.note')}</p>
                        </section>
                    </>
                )}
                <p className="sp-about-bies">{t('sharePreview.aboutBies')}</p>
            </main>

            <style jsx>{`
                /* Over .app-content's room for the member top and bottom bars (index.css), which aren't here. */
                .sp { margin-top: calc(-70px - env(safe-area-inset-top, 0px)); min-height: 100vh; background: var(--color-gray-50); color: var(--color-gray-900); }
                @media (max-width: 768px) {
                    .sp { margin-top: calc(-73px - env(safe-area-inset-top, 0px)); margin-bottom: calc(-72px - env(safe-area-inset-bottom, 0px)); }
                }
                .sp-bar {
                    display: flex; align-items: center; justify-content: space-between;
                    padding: calc(env(safe-area-inset-top, 0px) + 10px) 16px 10px;
                    background: var(--color-primary-nav, var(--color-primary));
                }
                .sp-line { height: 3px; background: var(--color-secondary); }
                .sp-signin {
                    background: none; border: 1px solid rgba(255, 255, 255, 0.6); color: #fff;
                    border-radius: 999px; padding: 6px 16px; font: inherit; font-weight: 600; cursor: pointer;
                }
                .sp-main { max-width: 560px; margin: 0 auto; padding: 16px 16px calc(env(safe-area-inset-bottom, 0px) + 32px); }
                .sp-cover {
                    aspect-ratio: 16 / 10; border-radius: var(--radius-lg) var(--radius-lg) 0 0; overflow: hidden;
                    background: var(--color-gray-100); display: flex; align-items: center; justify-content: center;
                    color: var(--color-gray-400);
                }
                .sp-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
                .sp-card {
                    background: var(--color-surface); border: 1px solid var(--color-gray-200); border-top: none;
                    border-radius: 0 0 var(--radius-lg) var(--radius-lg); padding: 18px 18px 20px;
                }
                .sp-missing { border-top: 1px solid var(--color-gray-200); border-radius: var(--radius-lg); text-align: center; padding: 32px 20px; }
                .sp-kicker { margin: 0 0 4px; font-size: 0.85rem; font-weight: 600; color: var(--color-primary); }
                .sp-title { margin: 0 0 12px; font-size: 1.5rem; line-height: 1.25; font-weight: 700; }
                .sp-facts { list-style: none; margin: 0 0 14px; padding: 0; display: flex; flex-direction: column; gap: 10px; }
                .sp-facts li { display: flex; align-items: center; gap: 10px; font-size: 0.95rem; color: var(--color-gray-700); }
                .sp-facts li :global(svg) { flex-shrink: 0; color: var(--color-gray-500); }
                .sp-trust { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
                .sp-price { font-weight: 700; color: var(--color-gray-700); }
                .sp-good, .sp-good :global(svg) { color: var(--color-success-text) !important; }
                .sp-closed, .sp-closed :global(svg) { color: var(--color-error) !important; }
                .sp-about { margin: 0 0 16px; font-size: 0.98rem; line-height: 1.5; color: var(--color-gray-800); white-space: pre-line; }
                .sp-locked { background: var(--color-gray-50); border: 1px dashed var(--color-gray-300); border-radius: var(--radius-md, 10px); padding: 12px 14px; margin-bottom: 16px; }
                .sp-locked-title { margin: 0 0 8px; font-size: 0.85rem; font-weight: 700; color: var(--color-gray-600); }
                .sp-locked ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
                .sp-locked li { display: flex; align-items: center; gap: 8px; font-size: 0.92rem; color: var(--color-gray-700); }
                .sp-locked li :global(svg) { flex-shrink: 0; color: var(--color-gray-400); }
                .sp-cta {
                    width: 100%; min-height: 48px; border: none; border-radius: 999px; cursor: pointer;
                    background: var(--color-primary-nav, var(--color-primary)); color: #fff; font: inherit; font-size: 1.02rem; font-weight: 700;
                }
                :global([data-theme="dark"]) .sp-cta { box-shadow: 0 0 0 1px rgba(100, 149, 237, 0.35); }
                .sp-note { margin: 10px 0 0; text-align: center; font-size: 0.85rem; color: var(--color-gray-500); }
                .sp-muted { color: var(--color-gray-500); }
                .sp-missing .sp-muted { margin: 0 0 20px; }
                .sp-loading { text-align: center; padding: 48px 0; }
                .sp-about-bies { margin: 20px 4px 0; font-size: 0.85rem; line-height: 1.5; color: var(--color-gray-500); text-align: center; }
            `}</style>
        </div>
    );
}
