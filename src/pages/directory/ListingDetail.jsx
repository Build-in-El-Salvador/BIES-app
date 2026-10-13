import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useLocation, useSearchParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
    MapPin, Phone, Instagram, Globe, Mail, ChevronRight,
    Loader2, Leaf, Edit3, AlertCircle,
    Sprout, RefreshCw, WheatOff, HeartHandshake,
    Languages, Target, Tag, Bitcoin, Flag, Ban, MoreHorizontal, Clock, Store,
    Building2, MessageCircle, Navigation, Share2, Check, Bookmark, BookmarkCheck,
    UserCheck, ArrowRightLeft,
} from 'lucide-react';
import { directoryApi } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { getAssetUrl } from '../../utils/assets';
import TranslatableText from '../../components/TranslatableText';
import ZapButton from '../../components/ZapButton';
import ListingReviews, { TrustPanel, reviewState } from '../../components/directory/ListingReviews';
import { OwnershipBanner, OwnershipSheet } from '../../components/directory/ListingOwnership';
import { openExternal } from '../../utils/openExternal';
import { isAppleDevice } from '../../utils/mapApps';
import { publicUrl } from '../../utils/publicUrl';
import { useLightbox } from '../../context/LightboxContext';
import { getProduceIcon } from './produceIcons';
import { useModerationDialogs } from '../../components/moderation/useModerationDialogs';
import BackButton from '../../components/BackButton';
import AlbumsBlock, { useAlbums } from '../../components/albums/AlbumsBlock';
import '../../components/moderation/Moderation.css';

const PRACTICE_META = {
    'regenerative': { Icon: Sprout, tKey: 'directory.practices.regenerative' },
    'rotational-grazing': { Icon: RefreshCw, tKey: 'directory.practices.rotationalGrazing' },
    'no-gmo-feed': { Icon: WheatOff, tKey: 'directory.practices.noGmoFeed' },
    'animal-welfare': { Icon: HeartHandshake, tKey: 'directory.practices.animalWelfare' },
};

const sectionTitleStyle = {
    fontSize: '1.15rem',
    fontWeight: 700,
    margin: '0 0 0.85rem',
};

/**
 * Directory listing detail page per the mockup: full-width hero photo,
 * overlapping circular logo, name + location + WhatsApp rows, produce chips,
 * about text, practices row, and "Learn More" link rows.
 */
const ListingDetail = () => {
    const { id } = useParams();
    const location = useLocation();
    const { t } = useTranslation();
    const { user, isStaff } = useAuth();

    const [listing, setListing] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    // The member who runs it is one this member blocked.
    const [blockedOwner, setBlockedOwner] = useState(false);
    const [showMenu, setShowMenu] = useState(false);
    const [reviewRequest, setReviewRequest] = useState(null); // { vote, n }: open the review form
    const [linkCopied, setLinkCopied] = useState(false);
    const [searchParams] = useSearchParams();
    const [saved, setSaved] = useState(null); // null until the listing says
    const [ownershipSheet, setOwnershipSheet] = useState(null); // 'claim' | 'offer' | 'staff'
    const albums = useAlbums({ listingId: id });
    const [ownershipNotice, setOwnershipNotice] = useState('');
    useEffect(() => { setSaved(null); }, [id]);
    // From "Recommend this one" in the add form (?recommend=1): open the
    // vouch form once the listing is here, if this member can vouch.
    useEffect(() => {
        if (!listing || searchParams.get('recommend') !== '1') return;
        const { mine, canReview: can } = reviewState(listing, user);
        if (can && !mine) setReviewRequest((r) => r || { vote: 1, n: 1 });
    }, [listing, user, searchParams]);
    // Focus goes back to the menu button when a Report or Block sheet closes.
    const menuButtonRef = useRef(null);

    const lightbox = useLightbox();

    // silent=true refreshes in place (after a review changes) without the full-page loader
    const fetchListing = useCallback(async ({ silent = false } = {}) => {
        if (!silent) {
            setLoading(true);
            setError(null);
        }
        try {
            const result = await directoryApi.get(id);
            setListing(result?.data || result);
            setBlockedOwner(false);
        } catch (err) {
            if (err?.data?.reason === 'blocked') {
                setListing(null);
                setBlockedOwner(true);
            }
            if (!silent) setError(err.message || 'Failed to load listing');
        } finally {
            if (!silent) setLoading(false);
        }
    }, [id]);

    useEffect(() => {
        fetchListing();
    }, [fetchListing]);

    // After a block the server hides the member's listing or recommendation.
    const { openReport, openBlock, dialogs } = useModerationDialogs({ onBlocked: () => fetchListing() });

    const isProviderPath = location.pathname.startsWith('/trusted');
    const isFarm = listing ? listing.type === 'FARM' : !isProviderPath;
    const backPath = isFarm ? '/farms' : '/trusted';

    if (loading) {
        return (
            <div className="listing-detail-page">
                <div className="container" style={{ textAlign: 'center', padding: '4rem 0' }}>
                    <Loader2 size={32} style={{ animation: 'spin 1s linear infinite', margin: '0 auto', color: 'var(--color-gray-500)' }} />
                </div>
            </div>
        );
    }

    if (error || !listing) {
        return (
            <div className="listing-detail-page">
                {dialogs}
                <div className="container">
                    <div style={{ textAlign: 'center', padding: '4rem 0' }}>
                        <h2>{blockedOwner ? t('moderation.blockedListing.title') : t('directory.notFound')}</h2>
                        <p style={{ color: 'var(--color-gray-500)', margin: '0.5rem 0' }}>
                            {blockedOwner ? t('moderation.blockedListing.body') : t('directory.notFoundDesc')}
                        </p>
                        {blockedOwner && (
                            <Link to="/settings/blocked" style={{ display: 'block', marginTop: '1rem', fontWeight: 600, color: 'var(--color-primary)' }}>
                                {t('moderation.blockedListing.manage')}
                            </Link>
                        )}
                        <Link
                            to={backPath}
                            style={{
                                marginTop: '1.5rem', display: 'inline-flex', alignItems: 'center', gap: 8,
                                textDecoration: 'none', fontWeight: 500, color: 'var(--color-primary)',
                            }}
                        >
                            {t('directory.backToDirectory')}
                        </Link>
                    </div>
                </div>
            </div>
        );
    }

    const isOwner = !!user?.id && listing.ownerId === user.id;
    const canEdit = isOwner || isStaff;
    // Who answers for the listing: its linked member when staff entered it,
    // otherwise its creator (server: directory.controller.ts listingMember).
    const listingMemberId = listing.memberUserId || listing.ownerId;
    const listingMemberName = listing.memberUser?.profile?.name || listing.owner?.profile?.name || listing.name;
    const canModerate = !!user?.id && listingMemberId !== user.id && !isOwner;
    const isPending = listing.status === 'pending-review';

    // Handing it to the member who runs it: they claim it ("This is my
    // business"), the owner offers it, or staff move it.
    const transfers = Array.isArray(listing.transfers) ? listing.transfers : [];
    const canClaim = !!user?.id && !isOwner && listing.status === 'active'
        && !transfers.some((tr) => tr.kind === 'claim' && tr.toUserId === user.id);
    const canMove = isStaff && !isOwner;
    const hasMenu = canClaim || isOwner || canMove || canModerate;
    const openOwnership = (mode) => {
        setShowMenu(false);
        menuButtonRef.current?.focus({ preventScroll: true });
        setOwnershipSheet(mode);
    };
    const ownershipChanged = (notice) => {
        setOwnershipSheet(null);
        setOwnershipNotice(notice || '');
        fetchListing({ silent: true });
    };

    // Phone calls; WhatsApp opens WhatsApp (wa.me wants digits only).
    const telNumber = (listing.phone || '').replace(/[^\d+]/g, '');
    const waDigits = (listing.whatsapp || '').replace(/\D/g, '');

    const products = Array.isArray(listing.products) ? listing.products.filter((p) => p?.label) : [];
    const practices = (Array.isArray(listing.practices) ? listing.practices : []).filter((p) => PRACTICE_META[p]);
    const skills = Array.isArray(listing.skills) ? listing.skills.filter(Boolean) : [];
    const languages = Array.isArray(listing.languages) ? listing.languages.filter(Boolean) : [];

    const photos = (Array.isArray(listing.photos) ? listing.photos : []).filter(Boolean);
    const photoUrls = photos.map((p) => getAssetUrl(p));
    const categoryLabel = listing.category ? t(`directory.categories.${listing.category}`) : '';

    // Zap recipient — same shape as Discover's member/project cards
    const memberProfile = listing.memberUser?.profile || {};
    const zapRecipients = listing.memberUser?.nostrPubkey
        ? [{
            pubkey: listing.memberUser.nostrPubkey,
            name: memberProfile.name || listing.name,
            avatar: memberProfile.avatar || '',
            lud16: memberProfile.lightningAddress || '',
            bolt12Offer: memberProfile.bolt12Offer || '',
        }]
        : [];

    // Learn More rows — only render entries with values
    const instagramValue = (listing.instagram || '').trim();
    const websiteValue = (listing.website || '').trim();
    const emailValue = (listing.email || '').trim();
    const learnMoreRows = [
        telNumber && {
            key: 'phone',
            Icon: Phone,
            label: listing.phone,
            href: `tel:${telNumber}`,
            external: false,
        },
        waDigits && {
            key: 'whatsapp',
            Icon: MessageCircle,
            label: t('directory.whatsappRow', { number: listing.whatsapp }),
            href: `https://wa.me/${waDigits}`,
            external: true,
        },
        instagramValue && {
            key: 'instagram',
            Icon: Instagram,
            label: instagramValue.startsWith('http')
                ? instagramValue.replace(/^https?:\/\/(www\.)?/, '')
                : `@${instagramValue.replace(/^@/, '')}`,
            href: instagramValue.startsWith('http')
                ? instagramValue
                : `https://instagram.com/${encodeURIComponent(instagramValue.replace(/^@/, ''))}`,
            external: true,
        },
        websiteValue && {
            key: 'website',
            Icon: Globe,
            label: websiteValue.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''),
            href: /^https?:\/\//i.test(websiteValue) ? websiteValue : `https://${websiteValue}`,
            external: true,
        },
        emailValue && {
            key: 'email',
            Icon: Mail,
            label: emailValue,
            href: `mailto:${emailValue}`,
            external: false,
        },
    ].filter(Boolean);

    // The place-page action row (as on Google Maps): only what this listing has.
    const share = async () => {
        const url = publicUrl(`${backPath}/${listing.id}`);
        try {
            if (navigator.share) {
                await navigator.share({ title: listing.name, url });
                return;
            }
            await navigator.clipboard.writeText(url);
            setLinkCopied(true);
            setTimeout(() => setLinkCopied(false), 2000);
        } catch { /* cancelled */ }
    };
    const mapsQuery = encodeURIComponent(`${listing.name}, ${listing.location || ''}`);
    const isSaved = saved ?? !!listing.savedByMe;
    const toggleSave = async () => {
        const next = !isSaved;
        setSaved(next);
        try {
            await (next ? directoryApi.save(listing.id) : directoryApi.unsave(listing.id));
        } catch {
            setSaved(!next);
        }
    };
    const actions = [
        telNumber && { key: 'call', Icon: Phone, label: t('directory.actions.call'), href: `tel:${telNumber}` },
        waDigits && { key: 'whatsapp', Icon: MessageCircle, label: 'WhatsApp', onClick: () => openExternal(`https://wa.me/${waDigits}`) },
        (listing.mapUrl || listing.location) && {
            key: 'directions', Icon: Navigation, label: t('directory.actions.directions'),
            // The exact place when the listing has a map link; else a search
            onClick: () => openExternal(listing.mapUrl || (isAppleDevice()
                ? `https://maps.apple.com/?q=${mapsQuery}`
                : `https://www.google.com/maps/search/?api=1&query=${mapsQuery}`)),
        },
        websiteValue && {
            key: 'website', Icon: Globe, label: t('directory.actions.website'),
            onClick: () => openExternal(/^https?:\/\//i.test(websiteValue) ? websiteValue : `https://${websiteValue}`),
        },
        user && {
            key: 'save', Icon: isSaved ? BookmarkCheck : Bookmark,
            label: isSaved ? t('directory.actions.saved') : t('directory.actions.save'),
            onClick: toggleSave, pressed: isSaved,
        },
        { key: 'share', Icon: linkCopied ? Check : Share2, label: linkCopied ? t('directory.actions.copied') : t('directory.actions.share'), onClick: share },
    ].filter(Boolean);

    const { mine: myReview, canReview } = reviewState(listing, user);

    return (
        <div className="listing-detail-page">
            {dialogs}
            {ownershipSheet && (
                <OwnershipSheet
                    mode={ownershipSheet}
                    listing={listing}
                    user={user}
                    isFarm={isFarm}
                    onClose={() => setOwnershipSheet(null)}
                    onDone={ownershipChanged}
                />
            )}
            {/* Hero — full-bleed on mobile, 760px rounded column on desktop */}
            <div className="dir-hero-wrap">
                <div className="dir-hero">
                    {listing.photo || photos[0] ? (
                        <img src={getAssetUrl(listing.photo || photos[0])} alt={listing.name} className="dir-hero-img" />
                    ) : (
                        <div className="dir-hero-fallback">
                            {isFarm ? <Leaf size={56} /> : <Building2 size={56} />}
                        </div>
                    )}
                    <BackButton to={backPath} overlay label={t('directory.backToDirectory')} />
                </div>
            </div>

            <div className="container">
                <div className="dir-content">
                    {/* Header — overlapping logo, name, location, WhatsApp */}
                    <div className="dir-detail-head">
                        {listing.logo && (
                            <div className="dir-detail-logo">
                                <img src={getAssetUrl(listing.logo)} alt={`${listing.name} logo`} />
                            </div>
                        )}

                        {isPending && (
                            <div className="dir-pending-banner">
                                <AlertCircle size={16} />
                                <span>{t('directory.pendingBanner')}</span>
                            </div>
                        )}

                        <div className="dir-head-row">
                            <h1 className="dir-detail-name">{listing.name}</h1>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                                {zapRecipients.length > 0 && (
                                    <ZapButton recipients={zapRecipients} size="sm" />
                                )}
                                {canEdit && (
                                    <Link
                                        to={`${backPath}/${listing.id}/edit`}
                                        style={{
                                            display: 'inline-flex', alignItems: 'center', gap: 6,
                                            padding: '0.4rem 0.9rem', borderRadius: 'var(--radius-full)',
                                            border: '1px solid var(--color-gray-300)', background: 'var(--color-surface)',
                                            color: 'var(--color-gray-700)', textDecoration: 'none',
                                            fontSize: '0.82rem', fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0,
                                        }}
                                    >
                                        <Edit3 size={14} /> {t('directory.editListing')}
                                    </Link>
                                )}
                                {hasMenu && (
                                    <div style={{ position: 'relative' }}>
                                        <button
                                            ref={menuButtonRef}
                                            type="button"
                                            className="dir-more-btn"
                                            aria-label={t('moderation.menu.more')}
                                            aria-expanded={showMenu}
                                            onClick={() => setShowMenu((v) => !v)}
                                        >
                                            <MoreHorizontal size={18} />
                                        </button>
                                        {showMenu && (
                                            <>
                                                <div className="dir-menu-backdrop" onClick={() => setShowMenu(false)} />
                                                <div className="dir-menu" role="menu">
                                                    {canClaim && (
                                                        <button type="button" role="menuitem" onClick={() => openOwnership('claim')}>
                                                            <UserCheck size={16} /> {t('directory.ownership.claimMenu', { context: isFarm ? 'farm' : undefined })}
                                                        </button>
                                                    )}
                                                    {isOwner && (
                                                        <button type="button" role="menuitem" onClick={() => openOwnership('offer')}>
                                                            <ArrowRightLeft size={16} /> {t('directory.ownership.offerMenu')}
                                                        </button>
                                                    )}
                                                    {canMove && (
                                                        <button type="button" role="menuitem" onClick={() => openOwnership('staff')}>
                                                            <ArrowRightLeft size={16} /> {t('directory.ownership.staffMenu')}
                                                        </button>
                                                    )}
                                                    {canModerate && (<>
                                                    <button
                                                        type="button"
                                                        role="menuitem"
                                                        onClick={() => {
                                                            setShowMenu(false);
                                                            menuButtonRef.current?.focus({ preventScroll: true });
                                                            openReport({ type: 'listing', id: listing.id }, { name: listingMemberName, blockTarget: { userId: listingMemberId } });
                                                        }}
                                                    >
                                                        <Flag size={16} /> {t('moderation.menu.reportListing')}
                                                    </button>
                                                    <button
                                                        type="button"
                                                        role="menuitem"
                                                        className="danger"
                                                        onClick={() => {
                                                            setShowMenu(false);
                                                            menuButtonRef.current?.focus({ preventScroll: true });
                                                            openBlock({ userId: listingMemberId }, { name: listingMemberName });
                                                        }}
                                                    >
                                                        <Ban size={16} /> {t('moderation.menu.blockMember')}
                                                    </button>
                                                    </>)}
                                                </div>
                                            </>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>

                        {categoryLabel && (
                            <div className="dir-detail-meta">
                                <Store size={17} />
                                <span>{categoryLabel}</span>
                            </div>
                        )}
                        {listing.location && (
                            <div className="dir-detail-meta">
                                <MapPin size={17} />
                                <span>{listing.location}</span>
                            </div>
                        )}
                        {listing.hours && (
                            <div className="dir-detail-meta">
                                <Clock size={17} />
                                <span>{listing.hours}</span>
                            </div>
                        )}
                        {listing.isOwnBusiness && (
                            <p className="dir-own-note">{t('directory.review.ownBusinessNote', { context: isFarm ? 'farm' : undefined })}</p>
                        )}
                    </div>

                    {ownershipNotice && (
                        <p className="dir-own-notice" role="status"><Check size={16} /> {ownershipNotice}</p>
                    )}
                    <OwnershipBanner listing={listing} user={user} isStaff={isStaff} isFarm={isFarm} onChanged={ownershipChanged} />

                    <div className="dir-actions" role="group" aria-label={t('directory.actions.label')}>
                        {actions.map(({ key, Icon, label, href, onClick, pressed }) => (
                            href ? (
                                <a key={key} className="dir-action" href={href}>
                                    <span className="dir-action-icon"><Icon size={20} /></span>
                                    <span className="dir-action-label">{label}</span>
                                </a>
                            ) : (
                                <button key={key} type="button" className="dir-action" onClick={onClick} aria-pressed={pressed}>
                                    <span className="dir-action-icon"><Icon size={20} /></span>
                                    <span className="dir-action-label">{label}</span>
                                </button>
                            )
                        ))}
                    </div>

                    <TrustPanel
                        listing={listing}
                        onRecommend={canReview && !myReview ? (vote) => setReviewRequest((r) => ({ vote, n: (r?.n || 0) + 1 })) : undefined}
                    />

                    {photos.length > 0 && (
                        <section className="dir-detail-section">
                            <h2 style={sectionTitleStyle}>{t('directory.photosLabel')}</h2>
                            <div className="dir-gallery">
                                {photoUrls.map((url, i) => (
                                    <button
                                        key={url}
                                        type="button"
                                        className="dir-gallery-item"
                                        onClick={() => lightbox.open(url, photoUrls)}
                                        aria-label={`${t('directory.photosLabel')} ${i + 1}`}
                                    >
                                        <img src={url} alt="" loading="lazy" />
                                    </button>
                                ))}
                            </div>
                        </section>
                    )}

                    {isFarm ? (
                        <>
                            {/* What They Produce */}
                            {products.length > 0 && (
                                <section className="dir-detail-section">
                                    <h2 style={sectionTitleStyle}>{t('directory.whatTheyProduce')}</h2>
                                    <div className="dir-produce-chips">
                                        {products.map((product, i) => {
                                            const ProduceIcon = getProduceIcon(product);
                                            return (
                                                <span key={`${product.label}-${i}`} className="dir-produce-chip">
                                                    <ProduceIcon size={16} />
                                                    {product.label}
                                                </span>
                                            );
                                        })}
                                    </div>
                                </section>
                            )}

                            {/* About the Farm */}
                            {listing.about && (
                                <section className="dir-detail-section">
                                    <TranslatableText
                                        title={t('directory.aboutFarm')}
                                        titleTag="h2"
                                        titleStyle={sectionTitleStyle}
                                        text={listing.about}
                                        style={{
                                            fontSize: '0.95rem', lineHeight: 1.7,
                                            color: 'var(--color-gray-700)', whiteSpace: 'pre-wrap',
                                        }}
                                    />
                                </section>
                            )}

                            {/* Practices row — icon above label, evenly spaced */}
                            {practices.length > 0 && (
                                <section className="dir-detail-section">
                                    <div className="dir-practices-row">
                                        {practices.map((p) => {
                                            const { Icon, tKey } = PRACTICE_META[p];
                                            return (
                                                <div key={p} className="dir-practice-item">
                                                    <div className="dir-practice-icon">
                                                        <Icon size={22} />
                                                    </div>
                                                    <span className="dir-practice-label">{t(tKey)}</span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </section>
                            )}
                        </>
                    ) : (
                        <>
                            {/* PROVIDER branch */}
                            {skills.length > 0 && (
                                <section className="dir-detail-section">
                                    <h2 style={sectionTitleStyle}>{t('directory.skillsLabel')}</h2>
                                    <div className="dir-produce-chips">
                                        {skills.map((skill) => (
                                            <span key={skill} className="dir-produce-chip">{skill}</span>
                                        ))}
                                    </div>
                                </section>
                            )}

                            {/* Info rows: languages / best-for / pricing / BTC */}
                            {(languages.length > 0 || listing.bestFor || listing.pricing || listing.btcAccepted) && (
                                <section className="dir-detail-section dir-info-rows">
                                    {languages.length > 0 && (
                                        <div className="dir-detail-meta">
                                            <Languages size={17} />
                                            <span><span className="dir-info-label">{t('directory.languages')}:</span> {languages.join(', ')}</span>
                                        </div>
                                    )}
                                    {listing.bestFor && (
                                        <div className="dir-detail-meta">
                                            <Target size={17} />
                                            <span><span className="dir-info-label">{t('directory.bestFor')}:</span> {listing.bestFor}</span>
                                        </div>
                                    )}
                                    {listing.pricing && (
                                        <div className="dir-detail-meta">
                                            <Tag size={17} />
                                            <span><span className="dir-info-label">{t('directory.pricing')}:</span> {listing.pricing}</span>
                                        </div>
                                    )}
                                    {listing.btcAccepted && (
                                        <div className="dir-detail-meta dir-btc-row">
                                            <Bitcoin size={17} />
                                            <span className="dir-info-label">{t('directory.btcAccepted')}</span>
                                        </div>
                                    )}
                                </section>
                            )}

                            {listing.about && (
                                <section className="dir-detail-section">
                                    <TranslatableText
                                        title={t('directory.about')}
                                        titleTag="h2"
                                        titleStyle={sectionTitleStyle}
                                        text={listing.about}
                                        style={{
                                            fontSize: '0.95rem', lineHeight: 1.7,
                                            color: 'var(--color-gray-700)', whiteSpace: 'pre-wrap',
                                        }}
                                    />
                                </section>
                            )}

                            {listing.comment && (
                                <section className="dir-detail-section">
                                    <blockquote className="dir-comment-quote">{listing.comment}</blockquote>
                                </section>
                            )}

                        </>
                    )}

                    {/* Its albums: the place's parts, its growth, its team (whoever runs it adds them). */}
                    {albums.show && (
                        <section className="dir-detail-section">
                            <AlbumsBlock albums={albums.albums} canManage={albums.canManage} listingId={listing.id} titleStyle={sectionTitleStyle} />
                        </section>
                    )}

                    <ListingReviews
                        listing={listing}
                        user={user}
                        onChanged={() => fetchListing({ silent: true })}
                        openReport={openReport}
                        titleStyle={sectionTitleStyle}
                        request={reviewRequest}
                    />

                    {/* Learn More */}
                    {learnMoreRows.length > 0 && (
                        <section className="dir-detail-section">
                            <h2 style={sectionTitleStyle}>{t('directory.learnMore')}</h2>
                            <div className="dir-learn-list">
                                {learnMoreRows.map(({ key, Icon, label, href, external }) => (
                                    <a
                                        key={key}
                                        className="dir-learn-row"
                                        href={href}
                                        {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                                    >
                                        <span className="dir-learn-icon"><Icon size={18} /></span>
                                        <span className="dir-learn-label">{label}</span>
                                        <ChevronRight size={18} className="dir-learn-chevron" />
                                    </a>
                                ))}
                            </div>
                        </section>
                    )}
                </div>
            </div>

            <style jsx>{`
                .listing-detail-page {
                    padding-bottom: 4rem;
                }

                .dir-hero-wrap {
                    max-width: 760px;
                    margin: 0 auto;
                }

                .dir-hero {
                    position: relative;
                    width: 100%;
                    aspect-ratio: 16 / 9;
                    overflow: hidden;
                    background: var(--color-blue-tint);
                }

                .dir-hero-img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    display: block;
                }

                .dir-hero-fallback {
                    width: 100%;
                    height: 100%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: var(--color-primary);
                    opacity: 0.55;
                    background: linear-gradient(135deg, var(--color-blue-tint), var(--color-green-tint));
                }

                .dir-content {
                    max-width: 760px;
                    margin: 0 auto;
                }

                .dir-detail-head {
                    position: relative;
                    padding-top: 0.75rem;
                }

                .dir-detail-logo {
                    width: 88px;
                    height: 88px;
                    border-radius: 50%;
                    border: 4px solid var(--color-surface);
                    background: var(--color-surface);
                    overflow: hidden;
                    margin-top: -56px;
                    margin-bottom: 0.5rem;
                    position: relative;
                    z-index: 2;
                    box-shadow: var(--shadow-sm);
                }
                .dir-detail-logo img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    display: block;
                }

                .dir-pending-banner {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    padding: 0.65rem 0.9rem;
                    border-radius: var(--radius-md);
                    background: var(--color-orange-tint);
                    color: var(--badge-warning-text, #9a3412);
                    font-size: 0.85rem;
                    font-weight: 500;
                    margin-bottom: 0.85rem;
                }

                .dir-head-row {
                    display: flex;
                    align-items: flex-start;
                    justify-content: space-between;
                    gap: 0.75rem;
                    margin-bottom: 0.5rem;
                }

                .dir-more-btn {
                    width: 44px; height: 44px; border-radius: 50%;
                    display: inline-flex; align-items: center; justify-content: center;
                    border: 1px solid var(--color-gray-300); background: var(--color-surface);
                    color: var(--color-gray-700); cursor: pointer; padding: 0;
                }
                .dir-menu-backdrop { position: fixed; inset: 0; z-index: 40; }
                .dir-menu {
                    position: absolute; right: 0; top: calc(100% + 6px); z-index: 50; min-width: 13rem;
                    background: var(--color-surface); border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-lg, 0.75rem); box-shadow: 0 10px 28px rgba(0,0,0,0.14); padding: 0.25rem 0;
                }
                .dir-menu button {
                    width: 100%; display: flex; align-items: center; gap: 0.6rem; padding: 0.6rem 0.9rem;
                    background: none; border: none; cursor: pointer; text-align: left;
                    font-size: 0.875rem; font-weight: 500; color: var(--color-gray-700);
                }
                .dir-menu button.danger { color: var(--color-danger, #dc2626); }

                .dir-detail-name {
                    font-size: 1.75rem;
                    font-weight: 800;
                    margin: 0;
                    line-height: 1.2;
                    min-width: 0;
                    overflow-wrap: break-word;
                }

                .dir-detail-meta {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    color: var(--color-gray-600);
                    font-size: 0.95rem;
                    margin-bottom: 0.4rem;
                    min-width: 0;
                }
                .dir-detail-meta span {
                    overflow: hidden;
                    text-overflow: ellipsis;
                }

                /* Place-page actions (Call, WhatsApp, Directions, Website, Share) */
                .dir-actions {
                    display: flex;
                    gap: 6px;
                    margin: 1.1rem 0 0.25rem;
                    overflow-x: auto;
                    scrollbar-width: none;
                }
                .dir-actions::-webkit-scrollbar { display: none; }
                .dir-action {
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
                .dir-action-icon {
                    width: 48px;
                    height: 48px;
                    border-radius: 50%;
                    background: var(--color-blue-tint);
                    color: var(--color-primary);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }
                .dir-action:hover .dir-action-icon,
                .dir-action:focus-visible .dir-action-icon {
                    background: var(--color-primary);
                    color: white;
                }
                .dir-action-label {
                    font-size: 0.78rem;
                    font-weight: 600;
                    color: var(--color-gray-700);
                    white-space: nowrap;
                }

                .dir-detail-section {
                    margin-top: 1.75rem;
                }

                .dir-produce-chips {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 0.6rem;
                }

                .dir-produce-chip {
                    display: inline-flex;
                    align-items: center;
                    gap: 7px;
                    padding: 0.45rem 0.95rem;
                    border-radius: var(--radius-full);
                    background: var(--color-blue-tint);
                    color: var(--color-primary);
                    font-size: 0.87rem;
                    font-weight: 600;
                }

                .dir-practices-row {
                    display: flex;
                    align-items: flex-start;
                    gap: 0.5rem;
                }

                .dir-practice-item {
                    flex: 1;
                    min-width: 0;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    text-align: center;
                    gap: 0.5rem;
                }

                .dir-practice-icon {
                    width: 50px;
                    height: 50px;
                    border-radius: 50%;
                    background: var(--color-green-tint);
                    color: var(--color-success, #16a34a);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }

                .dir-practice-label {
                    font-size: 0.78rem;
                    font-weight: 600;
                    color: var(--color-gray-700);
                    line-height: 1.3;
                }

                .dir-info-rows .dir-detail-meta {
                    margin-bottom: 0.55rem;
                }
                .dir-info-rows .dir-detail-meta:last-child {
                    margin-bottom: 0;
                }
                .dir-info-label {
                    font-weight: 600;
                    color: var(--color-gray-700);
                }
                .dir-btc-row {
                    color: #f7931a;
                    font-weight: 600;
                }
                .dir-btc-row .dir-info-label {
                    color: inherit;
                }

                .dir-comment-quote {
                    margin: 0;
                    padding: 0.65rem 1rem;
                    border-left: 3px solid var(--color-secondary);
                    background: var(--color-orange-tint);
                    border-radius: 0 var(--radius-md) var(--radius-md) 0;
                    font-size: 0.95rem;
                    font-style: italic;
                    line-height: 1.6;
                    color: var(--color-gray-700);
                    white-space: pre-wrap;
                }

                .dir-own-note {
                    margin: 0.4rem 0 0;
                    font-size: 0.82rem;
                    color: var(--color-gray-500);
                }
                .dir-own-notice {
                    display: flex; align-items: center; gap: 6px;
                    margin: 0 0 1rem; padding: 0.6rem 0.85rem;
                    border-radius: 0.75rem; background: #ecfdf5; color: var(--color-success-text, #047857);
                    font-size: 0.9rem; font-weight: 600;
                }

                .dir-gallery {
                    display: flex;
                    gap: 0.6rem;
                    overflow-x: auto;
                    padding-bottom: 4px;
                    scroll-snap-type: x mandatory;
                }
                .dir-gallery-item {
                    flex: 0 0 auto;
                    width: 150px;
                    height: 110px;
                    padding: 0;
                    border: none;
                    border-radius: 12px;
                    overflow: hidden;
                    cursor: zoom-in;
                    background: var(--color-gray-100);
                    scroll-snap-align: start;
                }
                .dir-gallery-item img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    display: block;
                }

                .dir-learn-list {
                    display: flex;
                    flex-direction: column;
                }

                .dir-learn-row {
                    display: flex;
                    align-items: center;
                    gap: 0.85rem;
                    padding: 0.9rem 0.25rem;
                    text-decoration: none;
                    color: inherit;
                }
                .dir-learn-row + .dir-learn-row {
                    border-top: 1px solid var(--color-gray-200);
                }
                .dir-learn-row:hover .dir-learn-label {
                    color: var(--color-primary);
                }

                .dir-learn-icon {
                    width: 38px;
                    height: 38px;
                    border-radius: 50%;
                    background: var(--color-blue-tint);
                    color: var(--color-primary);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    flex-shrink: 0;
                }

                .dir-learn-label {
                    flex: 1;
                    min-width: 0;
                    font-size: 0.92rem;
                    font-weight: 500;
                    color: var(--color-gray-700);
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    transition: color 0.15s;
                }

                .dir-learn-chevron {
                    color: var(--color-gray-400);
                    flex-shrink: 0;
                }

                @media (min-width: 769px) {
                    .dir-hero-wrap {
                        padding-top: 1.5rem;
                    }
                    .dir-hero {
                        border-radius: var(--radius-lg);
                    }
                }

                @media (max-width: 360px) {
                    .dir-practices-row {
                        flex-wrap: wrap;
                    }
                    .dir-practice-item {
                        flex: 1 1 40%;
                        margin-bottom: 0.75rem;
                    }
                }
            `}</style>
        </div>
    );
};

export default ListingDetail;
