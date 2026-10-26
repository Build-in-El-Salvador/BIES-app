import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
    MapPin, Globe, Mail, Loader2, Edit3, Briefcase, Tag, Languages, Bitcoin, Flag, Ban, Banknote,
    MoreHorizontal, MessageCircle, Share, Check, User, Plus,
} from 'lucide-react';
import { talentApi } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { getAssetUrl } from '../../utils/assets';
import { isPlaceholderName } from '../../utils/profileComplete';
import { openExternal } from '../../utils/openExternal';
import { publicUrl } from '../../utils/publicUrl';
import TranslatableText from '../../components/TranslatableText';
import ProofOfWork from '../../components/talent/ProofOfWork';
import { coverOf } from '../../components/talent/talentOptions';
import { useModerationDialogs } from '../../components/moderation/useModerationDialogs';
import BackButton from '../../components/BackButton';
import '../../components/moderation/Moderation.css';

const sectionTitleStyle = {
    fontSize: '1.15rem',
    fontWeight: 700,
    margin: '0 0 0.85rem',
};

/**
 * A member's talent, laid out like a farm's or a business's page: the cover
 * (or the first photo of their work), their photo over it, what they offer
 * and who they are, whether they're taking on work, then WhatsApp / Email /
 * Website / Profile / Share, what they do, their skills, the work they take
 * on, and their proof of work.
 */
const TalentDetail = () => {
    const { id } = useParams();
    const navigate = useNavigate();
    const { t } = useTranslation();
    const { user } = useAuth();

    const [talent, setTalent] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    // Its member is one this member blocked.
    const [blockedMember, setBlockedMember] = useState(false);
    const [showMenu, setShowMenu] = useState(false);
    const [linkCopied, setLinkCopied] = useState(false);
    // Focus goes back to the menu button when a Report or Block sheet closes.
    const menuButtonRef = useRef(null);

    const fetchTalent = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            setTalent(await talentApi.get(id));
            setBlockedMember(false);
        } catch (err) {
            setTalent(null);
            setBlockedMember(err?.data?.reason === 'blocked');
            setError(err.message || 'Failed to load talent');
        } finally {
            setLoading(false);
        }
    }, [id]);

    useEffect(() => {
        fetchTalent();
    }, [fetchTalent]);

    // After a block the server hides the member's talent.
    const { openReport, openBlock, dialogs } = useModerationDialogs({ onBlocked: () => fetchTalent() });

    if (loading) {
        return (
            <div className="container" style={{ textAlign: 'center', padding: '4rem 0' }}>
                <Loader2 size={32} style={{ animation: 'spin 1s linear infinite', margin: '0 auto', color: 'var(--color-gray-500)' }} />
            </div>
        );
    }

    if (error || !talent) {
        return (
            <div className="container">
                {dialogs}
                <div style={{ textAlign: 'center', padding: '4rem 0' }}>
                    <h2>{blockedMember ? t('talent.blocked.title') : t('talent.notFound')}</h2>
                    <p style={{ color: 'var(--color-gray-500)', margin: '0.5rem 0' }}>
                        {blockedMember ? t('talent.blocked.body') : t('talent.notFoundDesc')}
                    </p>
                    {blockedMember && (
                        <Link to="/settings/blocked" style={{ display: 'block', marginTop: '1rem', fontWeight: 600, color: 'var(--color-primary)' }}>
                            {t('moderation.blockedListing.manage')}
                        </Link>
                    )}
                    <Link to="/talents" style={{ marginTop: '1.5rem', display: 'inline-flex', textDecoration: 'none', fontWeight: 500, color: 'var(--color-primary)' }}>
                        {t('talent.back')}
                    </Link>
                </div>
            </div>
        );
    }

    const isOwn = !!user?.id && talent.userId === user.id;
    const member = talent.user || {};
    const name = isPlaceholderName(member.profile?.name) ? t('profileView.newMember') : member.profile.name;
    const avatar = member.profile?.avatar || '';
    const profilePath = isOwn ? '/profile' : `/builder/${member.nostrPubkey || member.id}`;
    const cover = coverOf(talent);
    const categoryLabel = talent.category ? t(`talent.categories.${talent.category}`) : '';
    const place = [talent.location, talent.remote && t('talent.remote')].filter(Boolean).join(' · ');
    const skills = (talent.skills || []).filter(Boolean);
    const languages = (talent.languages || []).filter(Boolean);
    const workTypes = (talent.workTypes || []).map((w) => t(`talent.workTypes.${w}`));
    const works = Array.isArray(talent.works) ? talent.works : [];

    // WhatsApp opens WhatsApp (wa.me wants digits only).
    const waDigits = (talent.whatsapp || '').replace(/\D/g, '');
    const share = async () => {
        const url = publicUrl(`/talents/${talent.id}`);
        try {
            if (navigator.share) {
                await navigator.share({ title: `${talent.title} · ${name}`, url });
                return;
            }
            await navigator.clipboard.writeText(url);
            setLinkCopied(true);
            setTimeout(() => setLinkCopied(false), 2000);
        } catch { /* cancelled */ }
    };
    // The place-page action row: only what this talent has.
    const actions = [
        waDigits && { key: 'whatsapp', Icon: MessageCircle, label: 'WhatsApp', onClick: () => openExternal(`https://wa.me/${waDigits}`) },
        talent.email && { key: 'email', Icon: Mail, label: t('talent.actions.email'), href: `mailto:${talent.email}` },
        talent.website && { key: 'website', Icon: Globe, label: t('talent.actions.website'), onClick: () => openExternal(talent.website) },
        { key: 'profile', Icon: User, label: t('talent.actions.profile'), to: profilePath },
        { key: 'share', Icon: linkCopied ? Check : Share, label: linkCopied ? t('talent.actions.copied') : t('talent.actions.share'), onClick: share },
    ].filter(Boolean);

    const closeMenu = () => {
        setShowMenu(false);
        menuButtonRef.current?.focus({ preventScroll: true });
    };

    return (
        <div className="talent-detail-page">
            {dialogs}
            {/* Hero — full-bleed on mobile, 760px rounded column on desktop */}
            <div className="tal-hero-wrap">
                <div className={`tal-hero${cover ? '' : ' empty'}`}>
                    {cover && <img src={getAssetUrl(cover)} alt="" className="tal-hero-img" />}
                    <BackButton fallback="/talents" overlay label={t('talent.back')} />
                </div>
                {/* Outside the photo's clipping, so the menu can open below it */}
                <div className="tal-hero-tools">
                    <div style={{ position: 'relative' }}>
                        <button
                            ref={menuButtonRef}
                            type="button"
                            className="tal-more-btn"
                            aria-label={t('moderation.menu.more')}
                            aria-expanded={showMenu}
                            onClick={() => setShowMenu((v) => !v)}
                        >
                            <MoreHorizontal size={20} />
                        </button>
                        {showMenu && (
                            <>
                                <div className="tal-menu-backdrop" onClick={() => setShowMenu(false)} />
                                <div className="tal-menu" role="menu">
                                    {isOwn ? (
                                        <button type="button" role="menuitem" onClick={() => { setShowMenu(false); navigate(`/talents/${talent.id}/edit`); }}>
                                            <Edit3 size={16} /> {t('talent.edit')}
                                        </button>
                                    ) : (<>
                                        <button
                                            type="button"
                                            role="menuitem"
                                            onClick={() => {
                                                closeMenu();
                                                openReport({ type: 'talent', id: talent.id }, { name, blockTarget: { userId: talent.userId } });
                                            }}
                                        >
                                            <Flag size={16} /> {t('moderation.menu.reportTalent')}
                                        </button>
                                        <button
                                            type="button"
                                            role="menuitem"
                                            className="danger"
                                            onClick={() => {
                                                closeMenu();
                                                openBlock({ userId: talent.userId }, { name });
                                            }}
                                        >
                                            <Ban size={16} /> {t('moderation.menu.blockMember')}
                                        </button>
                                    </>)}
                                </div>
                            </>
                        )}
                    </div>
                </div>
            </div>

            <div className="container">
                <div className="tal-content">
                    <div className="tal-head">
                        <Link to={profilePath} className="tal-avatar-link" aria-label={name}>
                            <span className="tal-avatar">
                                {avatar ? <img src={getAssetUrl(avatar)} alt="" /> : <User size={40} />}
                            </span>
                        </Link>

                        <div className="tal-head-row">
                            <h1 className="tal-title">{talent.title}</h1>
                        </div>

                        <p className="tal-by">
                            <Link to={profilePath} className="tal-by-link">{name}</Link>
                        </p>
                        {categoryLabel && (
                            <div className="tal-meta">
                                <Tag size={17} />
                                <span>{categoryLabel}</span>
                            </div>
                        )}
                        {place && (
                            <div className="tal-meta">
                                <MapPin size={17} />
                                <span>{place}</span>
                            </div>
                        )}
                        <p className={`tal-availability${talent.available ? '' : ' busy'}`}>
                            {talent.available ? t('talent.availableLong') : t('talent.busyLong')}
                        </p>
                    </div>

                    <div className="tal-actions" role="group" aria-label={t('talent.actions.label')}>
                        {actions.map(({ key, Icon, label, href, to, onClick }) => {
                            const inner = (
                                <>
                                    <span className="tal-action-icon"><Icon size={20} /></span>
                                    <span className="tal-action-label">{label}</span>
                                </>
                            );
                            if (to) return <Link key={key} to={to} className="tal-action">{inner}</Link>;
                            if (href) return <a key={key} className="tal-action" href={href}>{inner}</a>;
                            return <button key={key} type="button" className="tal-action" onClick={onClick}>{inner}</button>;
                        })}
                    </div>

                    {talent.about && (
                        <section className="tal-section">
                            <TranslatableText
                                title={t('talent.about')}
                                titleTag="h2"
                                titleStyle={sectionTitleStyle}
                                text={talent.about}
                                style={{
                                    fontSize: '0.95rem', lineHeight: 1.7,
                                    color: 'var(--color-gray-700)', whiteSpace: 'pre-wrap',
                                }}
                            />
                        </section>
                    )}

                    {skills.length > 0 && (
                        <section className="tal-section">
                            <h2 style={sectionTitleStyle}>{t('talent.skills')}</h2>
                            <div className="tal-chips">
                                {skills.map((skill) => (
                                    <span key={skill} className="tal-chip">{skill}</span>
                                ))}
                            </div>
                        </section>
                    )}

                    {/* The work they take on: kind, rate, bitcoin, languages */}
                    <section className="tal-section tal-info-rows">
                        <h2 style={sectionTitleStyle}>{t('talent.work')}</h2>
                        {workTypes.length > 0 && (
                            <div className="tal-meta">
                                <Briefcase size={17} />
                                <span><span className="tal-info-label">{t('talent.openTo')}:</span> {workTypes.join(', ')}</span>
                            </div>
                        )}
                        {talent.rate && (
                            <div className="tal-meta">
                                <Banknote size={17} />
                                <span><span className="tal-info-label">{t('talent.rate')}:</span> {talent.rate}</span>
                            </div>
                        )}
                        {languages.length > 0 && (
                            <div className="tal-meta">
                                <Languages size={17} />
                                <span><span className="tal-info-label">{t('talent.languages')}:</span> {languages.join(', ')}</span>
                            </div>
                        )}
                        {talent.btcAccepted && (
                            <div className="tal-meta tal-btc-row">
                                <Bitcoin size={17} />
                                <span className="tal-info-label">{t('talent.btc')}</span>
                            </div>
                        )}
                    </section>

                    <section className="tal-section">
                        <h2 style={sectionTitleStyle}>{t('talent.proofOfWork')}</h2>
                        {works.length > 0 ? (
                            <ProofOfWork works={works} />
                        ) : isOwn ? (
                            <p className="tal-muted">
                                {t('talent.noProofOwn')}{' '}
                                <Link to={`/talents/${talent.id}/edit`} className="tal-inline-link">
                                    <Plus size={14} aria-hidden="true" /> {t('talent.form.addWork')}
                                </Link>
                            </p>
                        ) : (
                            <p className="tal-muted">{t('talent.noProof')}</p>
                        )}
                    </section>
                </div>
            </div>

            <style jsx>{`
                .talent-detail-page {
                    padding-bottom: 4rem;
                }
                .tal-hero-wrap {
                    position: relative;
                    max-width: 760px;
                    margin: 0 auto;
                }
                .tal-hero {
                    position: relative;
                    width: 100%;
                    aspect-ratio: 16 / 9;
                    overflow: hidden;
                    background: linear-gradient(135deg, var(--color-blue-tint), var(--color-orange-tint));
                }
                .tal-hero.empty {
                    aspect-ratio: auto;
                    height: 130px;
                }
                .tal-hero-img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    display: block;
                }
                .tal-content {
                    max-width: 760px;
                    margin: 0 auto;
                }
                .tal-head {
                    position: relative;
                    padding-top: 0.75rem;
                }
                .tal-head :global(.tal-avatar-link) {
                    display: inline-block;
                    margin-top: -60px;
                    margin-bottom: 0.5rem;
                    position: relative;
                    z-index: 2;
                    border-radius: 50%;
                }
                .tal-avatar {
                    width: 96px;
                    height: 96px;
                    border-radius: 50%;
                    border: 4px solid var(--color-surface);
                    background: var(--color-gray-100);
                    color: var(--color-gray-400);
                    overflow: hidden;
                    box-shadow: var(--shadow-sm);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }
                .tal-avatar img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    display: block;
                }
                .tal-head-row {
                    display: flex;
                    align-items: flex-start;
                    justify-content: space-between;
                    gap: 0.75rem;
                    margin-bottom: 0.15rem;
                }
                .tal-title {
                    font-size: 1.75rem;
                    font-weight: 800;
                    margin: 0;
                    line-height: 1.2;
                    min-width: 0;
                    overflow-wrap: break-word;
                }
                .tal-by {
                    margin: 0 0 0.6rem;
                    font-size: 1rem;
                }
                .tal-by :global(.tal-by-link) {
                    color: var(--color-gray-700);
                    font-weight: 600;
                    text-decoration: none;
                }
                /* On the photo's bottom-right corner, as on an opportunity's page:
                   Edit for its member, the ⋯ menu for the rest */
                .tal-hero-tools {
                    position: absolute;
                    right: 16px;
                    bottom: 16px;
                    z-index: 5;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                /* White on any photo, in dark mode too, like the back button */
                .tal-more-btn {
                    height: 40px;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    border: none;
                    border-radius: var(--radius-full);
                    background: rgba(255, 255, 255, 0.94);
                    color: #0f172a;
                    box-shadow: 0 1px 4px rgba(15, 23, 42, 0.2);
                    cursor: pointer;
                    -webkit-tap-highlight-color: transparent;
                }
                .tal-more-btn {
                    width: 40px;
                    padding: 0;
                }
                .tal-more-btn:active {
                    background: #ffffff;
                }
                @media (hover: hover) {
                    .tal-more-btn:hover {
                        background: #ffffff;
                    }
                }
                .tal-more-btn:focus-visible {
                    outline: 2px solid var(--color-primary);
                    outline-offset: 2px;
                }
                .tal-menu-backdrop { position: fixed; inset: 0; z-index: 40; }
                .tal-menu {
                    position: absolute; right: 0; top: calc(100% + 6px); z-index: 50; min-width: 13rem;
                    background: var(--color-surface); border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-lg, 0.75rem); box-shadow: 0 10px 28px rgba(0,0,0,0.14); padding: 0.25rem 0;
                }
                .tal-menu button {
                    width: 100%; display: flex; align-items: center; gap: 0.6rem; padding: 0.6rem 0.9rem;
                    background: none; border: none; cursor: pointer; text-align: left;
                    font-size: 0.875rem; font-weight: 500; color: var(--color-gray-700);
                }
                .tal-menu button.danger { color: var(--color-danger, #dc2626); }
                .tal-meta {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    color: var(--color-gray-600);
                    font-size: 0.95rem;
                    margin-bottom: 0.4rem;
                    min-width: 0;
                }
                .tal-meta span {
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .tal-availability {
                    display: inline-flex;
                    align-items: center;
                    gap: 7px;
                    margin: 0.35rem 0 0;
                    padding: 4px 12px;
                    border-radius: var(--radius-full);
                    background: #ecfdf5;
                    color: var(--color-success-text, #047857);
                    font-size: 0.85rem;
                    font-weight: 700;
                }
                .tal-availability::before {
                    content: '';
                    width: 8px;
                    height: 8px;
                    border-radius: 50%;
                    background: currentColor;
                }
                .tal-availability.busy {
                    background: var(--color-gray-100);
                    color: var(--color-gray-600);
                }

                /* Contact and share (as on a business's page) */
                .tal-actions {
                    display: flex;
                    gap: 6px;
                    margin: 1.1rem 0 0.25rem;
                    overflow-x: auto;
                    scrollbar-width: none;
                }
                .tal-actions::-webkit-scrollbar { display: none; }
                .tal-actions :global(.tal-action) {
                    flex: 1 0 64px;
                    max-width: 96px;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 6px;
                    padding: 2px 0;
                    background: none;
                    border: none;
                    text-decoration: none;
                    font: inherit;
                    cursor: pointer;
                }
                /* Built outside the returned tree, so styled-jsx doesn't scope them: :global under the row */
                .tal-actions :global(.tal-action-icon) {
                    width: 48px;
                    height: 48px;
                    border-radius: 50%;
                    background: var(--color-blue-tint);
                    color: var(--color-primary);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }
                .tal-actions :global(.tal-action:hover .tal-action-icon),
                .tal-actions :global(.tal-action:focus-visible .tal-action-icon) {
                    background: var(--color-primary);
                    color: white;
                }
                .tal-actions :global(.tal-action-label) {
                    font-size: 0.78rem;
                    font-weight: 600;
                    color: var(--color-gray-700);
                    white-space: nowrap;
                }

                .tal-section {
                    margin-top: 1.75rem;
                }
                .tal-chips {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 0.6rem;
                }
                .tal-chip {
                    display: inline-flex;
                    align-items: center;
                    padding: 0.45rem 0.95rem;
                    border-radius: var(--radius-full);
                    background: var(--color-blue-tint);
                    color: var(--color-primary);
                    font-size: 0.87rem;
                    font-weight: 600;
                }
                .tal-info-rows .tal-meta {
                    margin-bottom: 0.55rem;
                }
                .tal-info-rows .tal-meta:last-child {
                    margin-bottom: 0;
                }
                .tal-info-label {
                    font-weight: 600;
                    color: var(--color-gray-700);
                }
                .tal-btc-row {
                    color: #f7931a;
                    font-weight: 600;
                }
                .tal-btc-row .tal-info-label {
                    color: inherit;
                }
                .tal-muted {
                    margin: 0;
                    color: var(--color-gray-500);
                    font-size: 0.92rem;
                }
                .tal-muted :global(.tal-inline-link) {
                    display: inline-flex;
                    align-items: center;
                    gap: 4px;
                    color: var(--color-primary);
                    font-weight: 600;
                    text-decoration: none;
                }

                @media (min-width: 769px) {
                    .tal-hero-wrap {
                        padding-top: 1.5rem;
                    }
                    .tal-hero {
                        border-radius: var(--radius-lg);
                    }
                }
            `}</style>
        </div>
    );
};

export default TalentDetail;
