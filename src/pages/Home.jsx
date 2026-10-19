import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import { isNativePlatform } from '../utils/platform';
import heroImage from '../assets/el-salvador-banner.png';
import logo from '../assets/logo-icon.svg';

const ORANGE = 'var(--color-secondary)';

// Two-tone icons from Michael's mockup: BIES blue (currentColor) and orange.
const CommunityIcon = () => (
    <svg viewBox="0 0 48 48" aria-hidden="true">
        <circle cx="10.5" cy="17" r="4.5" fill={ORANGE} />
        <path d="M2.5 35c0-5.2 3.6-8.8 8-8.8 2.2 0 4.2.9 5.6 2.4-1.7 1.9-2.7 4.2-2.8 6.9V36H2.5z" fill={ORANGE} />
        <circle cx="37.5" cy="17" r="4.5" fill={ORANGE} />
        <path d="M45.5 35c0-5.2-3.6-8.8-8-8.8-2.2 0-4.2.9-5.6 2.4 1.7 1.9 2.7 4.2 2.8 6.9V36h10.8z" fill={ORANGE} />
        <circle cx="24" cy="14.5" r="6.5" fill="currentColor" />
        <path d="M12.5 37c0-7 5.1-12 11.5-12s11.5 5 11.5 12v1h-23z" fill="currentColor" />
    </svg>
);

const FarmIcon = () => (
    <svg viewBox="0 0 48 48" aria-hidden="true" fill="none">
        <path d="M22.6 24.5C22.2 15.4 16.4 9.6 7.5 9.4c.3 8.9 6.1 14.7 15.1 15.1z" fill="currentColor" />
        <path d="M25.4 24.5c.4-9.1 6.2-14.9 15.1-15.1-.3 8.9-6.1 14.7-15.1 15.1z" fill="currentColor" />
        <path d="M24 24v9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        <path d="M8 41c3.6-5.6 9.4-8.8 16-8.8S36.4 35.4 40 41" stroke={ORANGE} strokeWidth="3" strokeLinecap="round" />
        <path d="M14.5 43.5c2.5-3 5.8-4.6 9.5-4.6s7 1.6 9.5 4.6" stroke={ORANGE} strokeWidth="3" strokeLinecap="round" />
    </svg>
);

const BusinessIcon = () => (
    <svg viewBox="0 0 48 48" aria-hidden="true">
        <path d="M10 8h28l5 11H5z" fill={ORANGE} />
        <path d="M5 19a4.75 4.75 0 0 0 9.5 0 4.75 4.75 0 0 0 9.5 0 4.75 4.75 0 0 0 9.5 0 4.75 4.75 0 0 0 9.5 0z" fill={ORANGE} />
        <path d="M17 8.5l-2.5 14M24 8.5v14M31 8.5l2.5 14" stroke="#fff" strokeWidth="2.5" />
        <path d="M8 27h32v14H8z" fill="currentColor" />
        <path d="M12 30h9v11h-9zM25 30h11v6H25z" fill="#fff" />
    </svg>
);

// A briefcase with an orange spark: what members can do.
const TalentIcon = () => (
    <svg viewBox="0 0 48 48" aria-hidden="true" fill="none">
        <path d="M18 15v-3.5A2.5 2.5 0 0 1 20.5 9h7a2.5 2.5 0 0 1 2.5 2.5V15" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" />
        <rect x="5" y="15" width="38" height="25" rx="5" fill="currentColor" />
        <path d="M24 19.5l2 5.5 5.5 2-5.5 2-2 5.5-2-5.5-5.5-2 5.5-2z" fill={ORANGE} />
    </svg>
);

const OpportunityIcon = () => (
    <svg viewBox="0 0 48 48" aria-hidden="true" fill="none">
        <path d="M24 13a10.5 10.5 0 0 0-6.4 18.8c1.3 1 2.1 2.5 2.1 4.2h8.6c0-1.7.8-3.2 2.1-4.2A10.5 10.5 0 0 0 24 13z" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" />
        <path d="M20 40.5h8M21.5 44.5h5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        <path d="M24 3.5v4M11.5 8.5l2.6 2.6M36.5 8.5l-2.6 2.6M5.5 21h4M38.5 21h4" stroke={ORANGE} strokeWidth="3" strokeLinecap="round" />
    </svg>
);

/**
 * The app's home page, from Michael's mockup: the BIES logo over a view of
 * El Salvador, "Explore the Ecosystem", and a card for each part of BIES.
 * A card shows only when its page is on. In the phone app, Opportunities says
 * what it has there: no investments (config/appScope.js).
 */
const Home = () => {
    const { t } = useTranslation();
    const { flags } = useFeatureFlags();

    const cards = [
        { key: 'community', to: '/members', Icon: CommunityIcon, tint: 'rgba(255, 91, 0, 0.10)' },
        { key: 'farms', to: '/farms', Icon: FarmIcon, tint: 'rgba(22, 163, 74, 0.10)', flag: 'directories' },
        { key: 'businesses', to: '/trusted', Icon: BusinessIcon, tint: 'rgba(0, 71, 171, 0.09)', flag: 'directories' },
        { key: 'talent', to: '/talents', Icon: TalentIcon, tint: 'rgba(14, 165, 233, 0.11)', flag: 'talent' },
        // Michael's idea: investments, businesses for sale, jobs, partnerships and programs.
        { key: 'opportunities', to: '/opportunities', Icon: OpportunityIcon, tint: 'rgba(245, 158, 11, 0.14)', flag: 'projects', desc: isNativePlatform() ? 'home.cards.opportunities.descApp' : undefined },
    ].filter((card) => !card.flag || flags?.[card.flag]);

    return (
        <div className="home-page">
            <section className="home-hero" style={{ '--home-hero-image': `url(${heroImage})` }}>
                <img className="home-logo" src={logo} alt="BIES" />
                <h1 className="home-title">{t('home.title')}</h1>
                <p className="home-subtitle">{t('home.subtitle')}</p>
            </section>

            <nav className="home-cards" aria-label={t('home.title')}>
                {cards.map(({ key, to, Icon, tint, desc }) => (
                    <Link key={key} to={to} className="home-card">
                        <span className="home-card-icon" style={{ background: tint }}><Icon /></span>
                        <span className="home-card-text">
                            <span className="home-card-title">{t(`home.cards.${key}.title`)}</span>
                            <span className="home-card-desc">{t(desc || `home.cards.${key}.desc`)}</span>
                        </span>
                        <span className="home-card-go" aria-hidden="true"><ChevronRight size={20} strokeWidth={2.75} /></span>
                    </Link>
                ))}
            </nav>

            <style jsx>{`
                .home-page {
                    --home-fade: 249, 245, 244; /* --color-gray-50, the page background */
                    padding-bottom: 1.5rem;
                }
                :global([data-theme="dark"]) .home-page { --home-fade: 15, 23, 42; }
                .home-hero {
                    position: relative;
                    padding: 28px 20px 124px;
                    text-align: center;
                    background-image:
                        linear-gradient(180deg,
                            rgba(var(--home-fade), 0.93) 0%,
                            rgba(var(--home-fade), 0.86) 36%,
                            rgba(var(--home-fade), 0.74) 56%,
                            rgba(var(--home-fade), 0.30) 72%,
                            rgba(var(--home-fade), 0.50) 82%,
                            rgba(var(--home-fade), 0.80) 90%,
                            rgba(var(--home-fade), 1) 97%),
                        var(--home-hero-image);
                    /* The fade is a little taller than the box, so a fractional
                       height can't repeat its top row as a line at the bottom. */
                    background-size: 100% calc(100% + 2px), cover;
                    background-position: top, center 30%;
                    background-repeat: no-repeat;
                }
                .home-logo {
                    width: 112px;
                    height: 112px;
                    border-radius: 50%;
                    background: #ffffff;
                    box-shadow: 0 8px 24px rgba(15, 23, 42, 0.14);
                }
                .home-title {
                    margin: 18px 0 8px;
                    font-family: var(--font-sans);
                    font-size: clamp(1.7rem, 7.4vw, 2.1rem);
                    font-weight: 700;
                    line-height: 1.1;
                    letter-spacing: -0.025em;
                    color: var(--color-primary);
                }
                .home-subtitle {
                    margin: 0 auto;
                    max-width: 21rem;
                    font-size: 1.02rem;
                    font-weight: 500;
                    line-height: 1.45;
                    color: var(--color-gray-700);
                }
                .home-cards {
                    position: relative;
                    max-width: 640px;
                    margin: -100px auto 0;
                    padding: 0 16px;
                    display: flex;
                    flex-direction: column;
                    gap: 14px;
                }
                .home-cards :global(.home-card) {
                    display: flex;
                    align-items: center;
                    gap: 14px;
                    padding: 14px 14px 14px 12px;
                    background: var(--color-surface);
                    border-radius: 20px;
                    box-shadow: 0 6px 22px rgba(15, 23, 42, 0.08);
                    text-decoration: none;
                    color: inherit;
                    transition: transform 0.15s ease, box-shadow 0.15s ease;
                }
                .home-cards :global(.home-card:active) { transform: scale(0.985); }
                @media (hover: hover) {
                    .home-cards :global(.home-card:hover) { box-shadow: 0 10px 28px rgba(15, 23, 42, 0.12); }
                }
                .home-card-icon {
                    width: 66px;
                    height: 66px;
                    flex-shrink: 0;
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: var(--color-primary);
                }
                .home-card-icon :global(svg) { width: 40px; height: 40px; }
                .home-card-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
                .home-card-title {
                    font-family: var(--font-sans);
                    font-size: 1.16rem;
                    font-weight: 700;
                    letter-spacing: -0.015em;
                    line-height: 1.2;
                    color: var(--color-primary);
                }
                .home-card-desc { font-size: 0.86rem; line-height: 1.4; color: var(--color-gray-500); }
                .home-card-go {
                    width: 34px;
                    height: 34px;
                    flex-shrink: 0;
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background: var(--color-secondary);
                    color: #ffffff;
                }
            `}</style>
        </div>
    );
};

export default Home;
