import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useLocation, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
    MapPin, Globe, Mail, Loader2, Edit3, Tag, Bitcoin, Flag, Ban, Banknote, MoreHorizontal, MessageCircle,
    Share2, Check, User, Clock, Bookmark, BookmarkCheck, TrendingUp, Layers, CircleDollarSign, Briefcase,
    Users, Award, ShieldAlert, Lock, RotateCcw, Laptop,
} from 'lucide-react';
import { projectsApi, watchlistApi } from '../../services/api';
import { cachedDetail, fetchDetail, forgetDetail, rememberDetail } from '../../utils/detailCache';
import { opportunityPage } from '../../utils/detailPages';
import { useAuth } from '../../context/AuthContext';
import { useLightbox } from '../../context/LightboxContext';
import { getAssetUrl } from '../../utils/assets';
import { isPlaceholderName } from '../../utils/profileComplete';
import { openExternal } from '../../utils/openExternal';
import { publicUrl } from '../../utils/publicUrl';
import TranslatableText from '../../components/TranslatableText';
import { useModerationDialogs } from '../../components/moderation/useModerationDialogs';
import BackButton from '../../components/BackButton';
import Avatar from '../../components/Avatar';
import TypeBadge, { styleOf } from '../../components/opportunities/TypeBadge';
import DeckPanel from '../../components/opportunities/DeckPanel';
import { daysLeft, formatDay, fullDollars, hasField, industryOf, isOpen, isTypeShown, plainText } from '../../components/opportunities/opportunityOptions';
import { isNativePlatform } from '../../utils/platform';
import '../../components/moderation/Moderation.css';

const sectionTitleStyle = {
    fontSize: '1.15rem',
    fontWeight: 700,
    margin: '0 0 0.85rem',
};

/**
 * One opportunity, laid out like a talent's or a business's page: its cover
 * (or its type's colours), what it is and who posted it, whether it's open,
 * then Apply or Website / WhatsApp / Email / Profile / Save / Share, the
 * facts its type has (a raise's size and stage, a business's price, a job's
 * pay and hours), what it says, an investment's pitch deck, its other
 * photos, and a reminder that BIES doesn't check opportunities. Its member
 * edits it and closes it here once it's taken.
 */
const OpportunityDetail = () => {
    const { id } = useParams();
    const location = useLocation();
    const { t, i18n } = useTranslation();
    const { user } = useAuth();
    const lightbox = useLightbox();

    // Opened before (detailCache), or tapped in a list (the card's copy): drawn
    // from the first frame, no loader, then fetched again in place.
    const shownAtOnce = () => cachedDetail(opportunityPage(id)[0])
        || (location.state?.preview?.id === id ? location.state.preview : null);
    const [opportunity, setOpportunity] = useState(shownAtOnce);
    const [loading, setLoading] = useState(() => !shownAtOnce());
    const [error, setError] = useState(null);
    const [blockedMember, setBlockedMember] = useState(false);
    const [showMenu, setShowMenu] = useState(false);
    const [linkCopied, setLinkCopied] = useState(false);
    const [saved, setSaved] = useState(() => !!shownAtOnce()?.saved);
    const [closing, setClosing] = useState(false);
    const [problem, setProblem] = useState('');
    // Focus goes back to the menu button when a Report or Block sheet closes.
    const menuButtonRef = useRef(null);

    // silent: fetched again behind what's shown; only its being gone (or
    // blocked, or a type the app leaves out) replaces it.
    const fetchOpportunity = useCallback(async ({ silent = false } = {}) => {
        const [key, load] = opportunityPage(id);
        if (!silent) {
            setLoading(true);
            setError(null);
        }
        try {
            const result = await fetchDetail(key, load);
            // A type the phone app leaves out (an investment): not found here.
            if (!isTypeShown(result?.type, isNativePlatform())) {
                const gone = new Error('Not found');
                gone.status = 404;
                throw gone;
            }
            setOpportunity(result);
            setSaved(!!result?.saved);
            setBlockedMember(false);
        } catch (err) {
            const gone = err?.status === 404 || err?.data?.reason === 'blocked';
            if (gone) forgetDetail(key);
            if (!silent || gone) {
                setOpportunity(null);
                setBlockedMember(err?.data?.reason === 'blocked');
                setError(err.message || 'Failed to load opportunity');
            }
        } finally {
            if (!silent) setLoading(false);
        }
    }, [id]);

    useEffect(() => {
        const shown = shownAtOnce();
        if (!shown) {
            fetchOpportunity();
            return;
        }
        setOpportunity(shown);
        setSaved(!!shown.saved);
        setError(null);
        setLoading(false);
        fetchOpportunity({ silent: true });
    }, [fetchOpportunity, location.state]);

    // The copy kept for next time is what's shown (after Save or Close too).
    useEffect(() => {
        if (opportunity?.id === id) rememberDetail(opportunityPage(id)[0], { ...opportunity, saved });
    }, [opportunity, saved, id]);

    // After a block the server hides the member's opportunities.
    const { openReport, openBlock, dialogs } = useModerationDialogs({ onBlocked: () => fetchOpportunity() });

    // Escape closes the ⋯ menu, and the focus goes back to its button.
    useEffect(() => {
        if (!showMenu) return undefined;
        const onKey = (e) => {
            if (e.key !== 'Escape') return;
            setShowMenu(false);
            menuButtonRef.current?.focus({ preventScroll: true });
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [showMenu]);

    if (loading) {
        return (
            <div className="container" style={{ textAlign: 'center', padding: '4rem 0' }}>
                <Loader2 size={32} style={{ animation: 'spin 1s linear infinite', margin: '0 auto', color: 'var(--color-gray-500)' }} />
            </div>
        );
    }

    if (error || !opportunity) {
        return (
            <div className="container">
                {dialogs}
                <div style={{ textAlign: 'center', padding: '4rem 0' }}>
                    <h2>{blockedMember ? t('opportunities.blocked.title') : t('opportunities.notFound')}</h2>
                    <p style={{ color: 'var(--color-gray-500)', margin: '0.5rem 0' }}>
                        {blockedMember ? t('opportunities.blocked.body') : t('opportunities.notFoundDesc')}
                    </p>
                    {blockedMember && (
                        <Link to="/settings/blocked" style={{ display: 'block', marginTop: '1rem', fontWeight: 600, color: 'var(--color-primary)' }}>
                            {t('moderation.blockedListing.manage')}
                        </Link>
                    )}
                    <Link to="/opportunities" style={{ marginTop: '1.5rem', display: 'inline-flex', textDecoration: 'none', fontWeight: 500, color: 'var(--color-primary)' }}>
                        {t('opportunities.back')}
                    </Link>
                </div>
            </div>
        );
    }

    const o = opportunity;
    const isOwn = !!user?.id && o.ownerId === user.id;
    const owner = o.owner || {};
    const name = isPlaceholderName(owner.profile?.name) ? t('profileView.newMember') : owner.profile.name;
    const avatar = owner.profile?.avatar || '';
    const profilePath = isOwn ? '/profile' : `/builder/${owner.nostrPubkey || owner.id}`;
    const photos = (Array.isArray(o.photos) && o.photos.length ? o.photos : [o.thumbnail]).filter(Boolean);
    const cover = photos[0] || '';
    const { color, tint } = styleOf(o.type);
    const open = isOpen(o);
    const days = daysLeft(o);
    const locale = i18n.language?.split('-')[0];
    const industry = industryOf(o.category);
    const place = [o.location, o.remote && t('opportunities.remote')].filter(Boolean).join(' · ');
    const description = plainText(o.description);

    const status = !open ? (o.closedAt ? t('opportunities.closedLong') : t('opportunities.closedOn', { day: formatDay(o.closesOn, locale) }))
        : days === 0 ? t('opportunities.closesToday')
            : days !== null ? t('opportunities.openUntil', { day: formatDay(o.closesOn, locale) })
                : t('opportunities.openLong');

    // The facts its type has, as rows: [icon, label, value]. A project shows no
    // amounts, even an older one that had a raise.
    const kindLabel = o.kind ? t(`opportunities.kinds.${o.type}.${o.kind}`, { defaultValue: '' }) : '';
    const facts = [];
    if (o.type === 'investment') {
        if (kindLabel) facts.push([Users, t('opportunities.facts.lookingFor'), kindLabel]);
        if (o.stage) facts.push([Layers, t('opportunities.stage'), t(`opportunities.stages.${o.stage}`)]);
    } else if (o.type === 'business-for-sale') {
        facts.push([CircleDollarSign, t('opportunities.facts.asking'), o.price ? fullDollars(o.price) : t('opportunities.card.priceOnRequest')]);
        if (o.revenue) facts.push([TrendingUp, t('opportunities.facts.revenue'), fullDollars(o.revenue)]);
    } else if (o.type === 'job') {
        if (kindLabel) facts.push([Briefcase, t('opportunities.facts.jobType'), kindLabel]);
        if (o.pay) facts.push([Banknote, t('opportunities.facts.pay'), o.pay]);
    } else if (o.type === 'partnership') {
        if (kindLabel) facts.push([Users, t('opportunities.facts.lookingFor'), kindLabel]);
    } else if (o.type === 'program') {
        if (kindLabel) facts.push([Award, t('opportunities.facts.programKind'), kindLabel]);
        if (o.price) facts.push([CircleDollarSign, t('opportunities.facts.upTo'), fullDollars(o.price)]);
    }
    if (industry && industry !== 'OTHER') facts.push([Tag, t('opportunities.industry'), t(`opportunities.industries.${industry}`)]);
    if (o.remote) facts.push([Laptop, t('opportunities.facts.where'), t('opportunities.remoteLong')]);

    // WhatsApp opens WhatsApp (wa.me wants digits only).
    const waDigits = (o.whatsapp || '').replace(/\D/g, '');
    const share = async () => {
        const url = publicUrl(`/opportunities/${o.id}`);
        try {
            if (navigator.share) {
                await navigator.share({ title: o.title, url });
                return;
            }
            await navigator.clipboard.writeText(url);
            setLinkCopied(true);
            setTimeout(() => setLinkCopied(false), 2000);
        } catch { /* cancelled */ }
    };
    const toggleSave = async () => {
        const next = !saved;
        setSaved(next);
        try {
            if (next) await watchlistApi.add(o.id);
            else await watchlistApi.remove(o.id);
        } catch (err) {
            // Already saved counts as saved.
            if (!(next && err?.status === 409)) setSaved(!next);
        }
    };
    const applies = o.type === 'job' || o.type === 'program';
    // The place-page action row: only what this one has.
    const actions = [
        o.websiteUrl && { key: 'website', Icon: Globe, label: applies ? t('opportunities.actions.apply') : t('opportunities.actions.website'), onClick: () => openExternal(o.websiteUrl) },
        waDigits && { key: 'whatsapp', Icon: MessageCircle, label: 'WhatsApp', onClick: () => openExternal(`https://wa.me/${waDigits}`) },
        o.email && { key: 'email', Icon: Mail, label: t('opportunities.actions.email'), href: `mailto:${o.email}?subject=${encodeURIComponent(o.title)}` },
        { key: 'profile', Icon: User, label: t('opportunities.actions.profile'), to: profilePath },
        !isOwn && { key: 'save', Icon: saved ? BookmarkCheck : Bookmark, label: saved ? t('opportunities.actions.saved') : t('opportunities.actions.save'), onClick: toggleSave, pressed: saved },
        { key: 'share', Icon: linkCopied ? Check : Share2, label: linkCopied ? t('opportunities.actions.copied') : t('opportunities.actions.share'), onClick: share },
    ].filter(Boolean);

    const setClosed = async (closed) => {
        setClosing(true);
        setProblem('');
        try {
            setOpportunity({ ...(await projectsApi.update(o.id, { closed })), saved, deckAccess: o.deckAccess });
        } catch (err) {
            setProblem(err?.data?.reason === 'too_many' ? t('opportunities.form.tooMany', { max: err.data.max }) : err.message || t('opportunities.form.saveFailed'));
        } finally {
            setClosing(false);
        }
    };

    const closeMenu = () => {
        setShowMenu(false);
        menuButtonRef.current?.focus({ preventScroll: true });
    };

    return (
        <div className="opportunity-detail-page">
            {dialogs}
            {/* Hero — full-bleed on mobile, 760px rounded column on desktop.
                Its type and the ⋯ menu (Edit, for its member) sit on its
                bottom edge, so the title comes straight after it. */}
            <div className="od-hero-wrap">
                <div
                    className={`od-hero${cover ? '' : ' empty'}`}
                    style={cover ? undefined : { background: `linear-gradient(135deg, ${tint}, var(--color-surface))` }}
                >
                    {cover && (
                        <button type="button" className="od-hero-btn" onClick={() => lightbox.open(getAssetUrl(cover), photos.map(getAssetUrl))} aria-label={t('opportunities.photos')}>
                            <img src={getAssetUrl(cover)} alt="" className="od-hero-img" />
                        </button>
                    )}
                    <BackButton fallback="/opportunities" overlay label={t('opportunities.back')} />
                </div>
                {/* Outside the photo's clipping, so the menu can open below it */}
                <div className="od-hero-bar">
                    <div className="od-hero-type">
                        <TypeBadge opportunity={o} size="md" withKind />
                    </div>
                    <div className="od-hero-tools">
                        {isOwn && (
                            <Link to={`/opportunities/${o.id}/edit`} className="od-edit-btn">
                                <Edit3 size={15} /> {t('opportunities.edit')}
                            </Link>
                        )}
                        {!isOwn && (
                            <>
                                <button
                                    ref={menuButtonRef}
                                    type="button"
                                    className="od-more-btn"
                                    aria-label={t('moderation.menu.more')}
                                    aria-expanded={showMenu}
                                    onClick={() => setShowMenu((v) => !v)}
                                >
                                    <MoreHorizontal size={20} />
                                </button>
                                {showMenu && (
                                    <>
                                        <div className="od-menu-backdrop" onClick={() => setShowMenu(false)} />
                                        <div className="od-menu" role="menu">
                                            <button
                                                type="button"
                                                role="menuitem"
                                                onClick={() => {
                                                    closeMenu();
                                                    openReport({ type: 'opportunity', id: o.id }, { name, blockTarget: { userId: o.ownerId } });
                                                }}
                                            >
                                                <Flag size={16} /> {t('moderation.menu.reportOpportunity')}
                                            </button>
                                            <button
                                                type="button"
                                                role="menuitem"
                                                className="danger"
                                                onClick={() => {
                                                    closeMenu();
                                                    openBlock({ userId: o.ownerId }, { name });
                                                }}
                                            >
                                                <Ban size={16} /> {t('moderation.menu.blockMember')}
                                            </button>
                                        </div>
                                    </>
                                )}
                            </>
                        )}
                    </div>
                </div>
            </div>

            <div className="container">
                <div className="od-content">
                    <div className="od-head">
                        <h1 className="od-title">{o.title}</h1>

                        <Link to={profilePath} className="od-by">
                            <span className="od-avatar" style={{ background: tint, color }}>
                                <Avatar src={avatar} size={32} fallback={<User size={18} />} />
                            </span>
                            <span>{t('opportunities.postedBy', { name })}</span>
                        </Link>

                        {place && (
                            <div className="od-meta">
                                <MapPin size={17} aria-hidden="true" />
                                <span>{place}</span>
                            </div>
                        )}
                        <p className={`od-status${open ? (days !== null && days <= 7 ? ' soon' : '') : ' closed'}`}>
                            <Clock size={15} aria-hidden="true" /> {status}
                        </p>
                    </div>

                    <div className="od-actions" role="group" aria-label={t('opportunities.actions.label')}>
                        {actions.map(({ key, Icon, label, href, to, onClick, pressed }) => {
                            const inner = (
                                <>
                                    <span className="od-action-icon"><Icon size={20} /></span>
                                    <span className="od-action-label">{label}</span>
                                </>
                            );
                            if (to) return <Link key={key} to={to} className="od-action">{inner}</Link>;
                            if (href) return <a key={key} className="od-action" href={href}>{inner}</a>;
                            return (
                                <button key={key} type="button" className="od-action" onClick={onClick} aria-pressed={pressed}>
                                    {inner}
                                </button>
                            );
                        })}
                    </div>

                    {isOwn && (
                        <div className="od-owner">
                            <p className="od-owner-text">{open ? t('opportunities.ownOpen') : t('opportunities.ownClosed')}</p>
                            <button type="button" className="od-owner-btn" onClick={() => setClosed(open)} disabled={closing}>
                                {closing ? <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> : open ? <Lock size={15} /> : <RotateCcw size={15} />}
                                {open ? t('opportunities.close') : t('opportunities.reopen')}
                            </button>
                            {problem && <p className="od-problem" role="alert">{problem}</p>}
                        </div>
                    )}

                    {facts.length > 0 && (
                        <section className="od-section od-facts">
                            <h2 style={sectionTitleStyle}>{t(`opportunities.factsTitle.${o.type}`, { defaultValue: t('opportunities.factsTitle.default') })}</h2>
                            {facts.map(([Icon, label, value]) => (
                                <div key={label} className="od-fact">
                                    <Icon size={17} aria-hidden="true" />
                                    <span><span className="od-fact-label">{label}:</span> {value}</span>
                                </div>
                            ))}
                            {o.btcAccepted && hasField(o.type, 'btcAccepted') && (
                                <div className="od-fact od-btc">
                                    <Bitcoin size={17} aria-hidden="true" />
                                    <span>{t(`opportunities.btc.${o.type}`, { defaultValue: t('opportunities.btc.default') })}</span>
                                </div>
                            )}
                        </section>
                    )}

                    {description && (
                        <section className="od-section">
                            <TranslatableText
                                title={t('opportunities.about')}
                                titleTag="h2"
                                titleStyle={sectionTitleStyle}
                                text={description}
                                style={{
                                    fontSize: '0.95rem', lineHeight: 1.7,
                                    color: 'var(--color-gray-700)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
                                }}
                            />
                        </section>
                    )}

                    {o.type === 'investment' && o.hasDeck && o.deckAccess && (
                        <DeckPanel opportunity={o} ownerName={name} />
                    )}

                    {photos.length > 1 && (
                        <section className="od-section">
                            <h2 style={sectionTitleStyle}>{t('opportunities.photos')}</h2>
                            <div className="od-photos">
                                {photos.map((photo) => (
                                    <button
                                        key={photo}
                                        type="button"
                                        className="od-photo"
                                        onClick={() => lightbox.open(getAssetUrl(photo), photos.map(getAssetUrl))}
                                        aria-label={t('opportunities.photos')}
                                    >
                                        <img src={getAssetUrl(photo)} alt="" loading="lazy" />
                                    </button>
                                ))}
                            </div>
                        </section>
                    )}

                    <p className="od-safety">
                        <ShieldAlert size={16} aria-hidden="true" />
                        <span>{t(`opportunities.safety.${o.type}`, { defaultValue: t('opportunities.safety.default') })}</span>
                    </p>
                </div>
            </div>

            <style jsx>{`
                .opportunity-detail-page {
                    padding-bottom: 4rem;
                }
                .od-hero-wrap {
                    position: relative;
                    max-width: 760px;
                    margin: 0 auto;
                }
                .od-hero {
                    position: relative;
                    width: 100%;
                    aspect-ratio: 16 / 9;
                    overflow: hidden;
                    background: var(--color-gray-100);
                }
                /* Room for the back button above the type */
                .od-hero.empty {
                    aspect-ratio: auto;
                    height: 136px;
                }
                /* The photo's bottom edge: its type on the left, the ⋯ menu on the right */
                .od-hero-bar {
                    position: absolute;
                    left: 16px;
                    right: 16px;
                    bottom: 16px;
                    z-index: 5;
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 12px;
                    /* Taps beside them still open the photo */
                    pointer-events: none;
                }
                .od-hero-type {
                    display: flex;
                    min-width: 0;
                }
                .od-hero-type :global(.opp-type-badge) {
                    box-shadow: 0 1px 4px rgba(15, 23, 42, 0.2);
                }
                .od-hero-tools {
                    position: relative;
                    flex-shrink: 0;
                    pointer-events: auto;
                }
                /* White on any photo, in dark mode too, like the back button */
                .od-more-btn,
                .od-hero-tools :global(.od-edit-btn) {
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
                .od-more-btn {
                    width: 40px;
                    padding: 0;
                }
                .od-hero-tools :global(.od-edit-btn) {
                    gap: 6px;
                    padding: 0 14px;
                    font-size: 0.85rem;
                    font-weight: 600;
                    white-space: nowrap;
                    text-decoration: none;
                }
                .od-more-btn:active,
                .od-hero-tools :global(.od-edit-btn:active) {
                    background: #ffffff;
                }
                @media (hover: hover) {
                    .od-more-btn:hover,
                    .od-hero-tools :global(.od-edit-btn:hover) {
                        background: #ffffff;
                    }
                }
                .od-more-btn:focus-visible,
                .od-hero-tools :global(.od-edit-btn:focus-visible) {
                    outline: 2px solid var(--color-primary);
                    outline-offset: 2px;
                }
                .od-hero-btn {
                    display: block;
                    width: 100%;
                    height: 100%;
                    padding: 0;
                    border: none;
                    background: none;
                    cursor: zoom-in;
                }
                .od-hero-img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    display: block;
                }
                .od-content {
                    max-width: 760px;
                    margin: 0 auto;
                }
                /* One wrapping row: the poster and the status pill sit side by side
                   with a gap; the title and the place take a line each. */
                .od-head {
                    padding-top: 1rem;
                    display: flex;
                    flex-wrap: wrap;
                    align-items: center;
                    gap: 0.6rem 12px;
                }
                .od-title {
                    flex-basis: 100%;
                    font-size: 1.75rem;
                    font-weight: 800;
                    margin: 0;
                    line-height: 1.2;
                    overflow-wrap: break-word;
                }
                .od-head :global(.od-by) {
                    display: inline-flex;
                    align-items: center;
                    gap: 8px;
                    min-width: 0;
                    color: var(--color-gray-700);
                    font-weight: 600;
                    text-decoration: none;
                }
                .od-avatar {
                    width: 32px;
                    height: 32px;
                    border-radius: 50%;
                    overflow: hidden;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    flex-shrink: 0;
                }
                .od-avatar :global(img) {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    display: block;
                }
                .od-menu-backdrop { position: fixed; inset: 0; z-index: 40; }
                .od-menu {
                    position: absolute; right: 0; top: calc(100% + 6px); z-index: 50; min-width: 13rem;
                    background: var(--color-surface); border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-lg, 0.75rem); box-shadow: 0 10px 28px rgba(0,0,0,0.14); padding: 0.25rem 0;
                }
                .od-menu button {
                    width: 100%; display: flex; align-items: center; gap: 0.6rem; padding: 0.6rem 0.9rem;
                    background: none; border: none; cursor: pointer; text-align: left;
                    font-size: 0.875rem; font-weight: 500; color: var(--color-gray-700);
                }
                .od-menu button.danger { color: var(--color-danger, #dc2626); }
                .od-meta {
                    flex-basis: 100%;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    color: var(--color-gray-600);
                    font-size: 0.95rem;
                    min-width: 0;
                }
                .od-meta span {
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .od-status {
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                    margin: 0;
                    padding: 4px 12px;
                    border-radius: var(--radius-full);
                    background: #ecfdf5;
                    color: var(--color-success-text, #047857);
                    font-size: 0.85rem;
                    font-weight: 700;
                }
                .od-status.soon {
                    background: #fff7ed;
                    color: var(--color-orange-text, #b45309);
                }
                .od-status.closed {
                    background: var(--color-gray-100);
                    color: var(--color-gray-600);
                }

                /* Contact, save and share (as on a business's page) */
                .od-actions {
                    display: flex;
                    gap: 6px;
                    margin: 1.1rem 0 0.25rem;
                    overflow-x: auto;
                    scrollbar-width: none;
                }
                .od-actions::-webkit-scrollbar { display: none; }
                .od-actions :global(.od-action) {
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
                .od-actions :global(.od-action-icon) {
                    width: 48px;
                    height: 48px;
                    border-radius: 50%;
                    background: var(--color-blue-tint);
                    color: var(--color-primary);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }
                .od-actions :global(.od-action:hover .od-action-icon),
                .od-actions :global(.od-action:focus-visible .od-action-icon),
                .od-actions :global(.od-action[aria-pressed='true'] .od-action-icon) {
                    background: var(--color-primary);
                    color: white;
                }
                .od-actions :global(.od-action-label) {
                    font-size: 0.78rem;
                    font-weight: 600;
                    color: var(--color-gray-700);
                    white-space: nowrap;
                }

                .od-owner {
                    margin-top: 1.25rem;
                    padding: 0.9rem 1rem;
                    border-radius: var(--radius-lg);
                    background: var(--color-gray-50, #f9fafb);
                    border: 1px solid var(--color-gray-200);
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    flex-wrap: wrap;
                    gap: 0.6rem;
                }
                .od-owner-text {
                    margin: 0;
                    font-size: 0.9rem;
                    color: var(--color-gray-600);
                    flex: 1 1 14rem;
                }
                .od-owner-btn {
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                    padding: 0.5rem 1rem;
                    border-radius: var(--radius-full);
                    border: 1px solid var(--color-gray-300);
                    background: var(--color-surface);
                    color: var(--color-gray-700);
                    font-weight: 600;
                    font-size: 0.88rem;
                    cursor: pointer;
                }
                .od-owner-btn:disabled { opacity: 0.6; cursor: not-allowed; }
                .od-problem {
                    flex-basis: 100%;
                    margin: 0;
                    color: #b91c1c;
                    font-size: 0.85rem;
                    font-weight: 600;
                }

                .od-section {
                    margin-top: 1.75rem;
                }
                .od-fact {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    color: var(--color-gray-600);
                    font-size: 0.95rem;
                    margin-bottom: 0.55rem;
                }
                .od-fact-label {
                    font-weight: 600;
                    color: var(--color-gray-700);
                }
                .od-btc {
                    color: #b45309;
                    font-weight: 600;
                }
                .od-photos {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
                    gap: 0.5rem;
                }
                .od-photo {
                    aspect-ratio: 4 / 3;
                    border-radius: 10px;
                    overflow: hidden;
                    padding: 0;
                    border: none;
                    background: var(--color-gray-100);
                    cursor: zoom-in;
                }
                .od-photo img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    display: block;
                }
                .od-safety {
                    display: flex;
                    align-items: flex-start;
                    gap: 8px;
                    margin: 2rem 0 0;
                    padding: 0.85rem 1rem;
                    border-radius: var(--radius-lg);
                    background: var(--color-gray-50, #f9fafb);
                    color: var(--color-gray-600);
                    font-size: 0.85rem;
                    line-height: 1.5;
                }
                .od-safety :global(svg) {
                    flex-shrink: 0;
                    margin-top: 2px;
                }

                @media (min-width: 769px) {
                    .od-hero-wrap {
                        padding-top: 1.5rem;
                    }
                    .od-hero {
                        border-radius: var(--radius-lg);
                    }
                }
            `}</style>
        </div>
    );
};

export default OpportunityDetail;
