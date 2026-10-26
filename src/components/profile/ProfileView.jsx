import { Children, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { nip19 } from 'nostr-tools';
import {
    Briefcase, Store, Leaf, Rocket, MapPin, Globe, Twitter, Linkedin, User, ImageOff, Plus, CalendarDays,
} from 'lucide-react';
import { profilesApi, directoryApi, talentApi } from '../../services/api';
import { useFeature } from '../../context/FeatureFlagsContext';
import { useLightbox } from '../../context/LightboxContext';
import { parseNoteContent } from '../../utils/noteUtils';
import { getAssetUrl } from '../../utils/assets';
import { isPlaceholderName } from '../../utils/profileComplete';
import { joinedDate } from '../../utils/joinedDate';
import Feed from '../../pages/Feed';
import ZappableTag from '../ZappableTag';
import ProfileSection from '../ProfileSection';
import BackButton from '../BackButton';
import CoverPhoto from '../CoverPhoto';
import AlbumsBlock, { useAlbums } from '../albums/AlbumsBlock';
import TalentSummary from '../talent/TalentSummary';
import { MAX_TALENTS } from '../talent/talentOptions';
import DirectoryListingCard from '../directory/DirectoryListingCard';
import useVisitState from '../../hooks/useVisitState';
import { cachedList, rememberList } from '../../utils/listCache';
import { joinPages, listOf } from '../../utils/listRequests';

// One row: four on a phone, eight on a wide screen (the CSS hides the rest).
const NETWORK_SHOWN = 8;
// Recommendations come a page at a time (the server's most is 50).
const RECOMMENDATIONS_PAGE = 20;

function isSafeUrl(url) {
    try {
        const { protocol } = new URL(url);
        return protocol === 'http:' || protocol === 'https:';
    } catch {
        return false;
    }
}

// The albums heading, as .pv-h2 (styled-jsx doesn't reach another component's h2).
const H2 = { fontFamily: 'var(--font-sans)', fontSize: '1.15rem', fontWeight: 700, color: 'var(--color-gray-900)' };

const listingPath = (l) => `${l.type === 'FARM' ? '/farms' : '/trusted'}/${l.id}`;
const sameName = (a, b) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * A member's profile, laid out like Facebook's: the cover against the top
 * bar, the photo with the name and follower counts beside it, the bio, the
 * buttons, then All / Photos / Talent / Recommendations. All has their
 * details (role, the BIES business they run, projects, place, links, when
 * they joined), their
 * Network, and their posts in the BIES feed, as the Feed shows them (likes,
 * reposts, replies); Photos has the pictures from those posts; Talent has
 * what they offer to do, with their proof of work (BIES Talents), when
 * they've listed any; Recommendations has the businesses and farms they
 * vouch for, their newest first, when they vouch for any.
 * Used by your own profile (Profile) and everyone else's (PublicProfile).
 *
 * @param {object}    profile      GET /profiles/:id or /profiles/me
 * @param {object}    nostrProfile their kind 0, for a missing photo or cover
 * @param {boolean}   isOwn
 * @param {ReactNode} bio          the bio as the page wants it shown (e.g. translatable)
 * @param {ReactNode} actions      the buttons under the bio (.pv-btn)
 * @param {boolean}   showBack     a back arrow on the cover
 * @param {ReactNode} children     page-specific panels, after the Network
 */
const ProfileView = ({ profile, nostrProfile, isOwn, bio, actions, showBack, children }) => {
    const { t, i18n } = useTranslation();
    const lightbox = useLightbox();
    const projectsEnabled = useFeature('projects');
    const talentEnabled = useFeature('talent');
    const directoriesEnabled = useFeature('directories');
    const userId = profile.user?.id || profile.userId;
    // The tab open, as Back brings it back (hooks/useVisitState.js).
    const [tab, setTab] = useVisitState('profile.tab', 'all');
    const [followers, setFollowers] = useState({ list: [], total: 0 });
    const [following, setFollowing] = useState({ list: [], total: 0 });
    const [listings, setListings] = useState([]);
    const [talents, setTalents] = useState([]);
    // As far as "Show more" went, kept for Back (utils/listCache.js).
    const recommendationsKey = `recommended-by:${userId}`;
    const [recommendations, setRecommendations] = useState(() => cachedList(recommendationsKey) || { list: [], total: 0, page: 0, loading: false });
    const [posts, setPosts] = useState({ list: [], loading: true });
    const pubkey = useMemo(() => {
        if (profile.user?.nostrPubkey) return profile.user.nostrPubkey;
        try {
            const decoded = profile.nostrNpub ? nip19.decode(profile.nostrNpub) : null;
            return decoded?.type === 'npub' ? decoded.data : null;
        } catch { return null; }
    }, [profile.user?.nostrPubkey, profile.nostrNpub]);
    // Their posts in the BIES feed, unless they turned them off (Settings → Privacy).
    const showPosts = !!pubkey && profile.nostrFeedMode !== 'off';

    useEffect(() => {
        if (!userId) return undefined;
        let cancelled = false;
        const page = (res) => ({ list: res?.data || [], total: res?.pagination?.total ?? (res?.data || []).length, hidden: !!res?.hidden });
        profilesApi.getFollowers(userId, { limit: 50 }).then((res) => { if (!cancelled) setFollowers(page(res)); }).catch(() => {});
        profilesApi.getFollowing(userId, { limit: 50 }).then((res) => { if (!cancelled) setFollowing(page(res)); }).catch(() => {});
        directoryApi.list({ ownerId: userId, limit: 20 })
            .then((res) => { if (!cancelled) setListings(res?.data || []); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [userId]);

    // What they offer to do (BIES Talents).
    useEffect(() => {
        setTalents([]);
        if (!userId || !talentEnabled) return undefined;
        let cancelled = false;
        talentApi.list({ userId, limit: 20 })
            .then((res) => { if (!cancelled) setTalents(res?.data || []); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [userId, talentEnabled]);

    // The businesses and farms they recommend (vouch for), newest first.
    // Shown before: at once, and as many pages as were shown are asked
    // again, so Back finds its place in them.
    useEffect(() => {
        const kept = cachedList(recommendationsKey);
        setRecommendations(kept || { list: [], total: 0, page: 0, loading: false });
        if (!userId || !directoriesEnabled) return undefined;
        let cancelled = false;
        const upTo = kept?.page || 1;
        Promise.all(Array.from({ length: upTo }, (_, i) => directoryApi.recommendedBy(userId, { page: i + 1, limit: RECOMMENDATIONS_PAGE })))
            .then((answers) => {
                const next = { list: joinPages(answers.map(listOf)), total: answers[0]?.pagination?.total ?? 0, page: upTo, loading: false };
                rememberList(recommendationsKey, next);
                if (!cancelled) setRecommendations(next);
            })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [userId, directoriesEnabled]);

    const moreRecommendations = () => {
        const page = recommendations.page + 1;
        setRecommendations((r) => ({ ...r, loading: true }));
        directoryApi.recommendedBy(userId, { page, limit: RECOMMENDATIONS_PAGE })
            .then((res) => setRecommendations((r) => {
                const next = { list: joinPages([r.list, listOf(res)]), total: res?.pagination?.total ?? r.total, page, loading: false };
                rememberList(recommendationsKey, next);
                return next;
            }))
            .catch(() => setRecommendations((r) => ({ ...r, loading: false })));
    };

    // Their network: everyone they're connected to, either way; people who
    // follow each other first, as close as BIES gets to Facebook friends.
    const network = useMemo(() => {
        const followerIds = new Set(followers.list.map((p) => p.id));
        const people = new Map();
        for (const p of following.list) people.set(p.id, { ...p, mutual: followerIds.has(p.id) });
        for (const p of followers.list) if (!people.has(p.id)) people.set(p.id, { ...p, mutual: false });
        return [...people.values()].sort((a, b) => Number(b.mutual) - Number(a.mutual));
    }, [followers.list, following.list]);

    // Kept to themselves (Settings → Privacy: Network): the counts, no one listed.
    const networkHidden = !isOwn && (followers.hidden || following.hidden);
    const albums = useAlbums({ userId });

    // The businesses and farms they run (theirs, or one staff linked them to).
    const businesses = listings.filter((l) => (l.isOwnBusiness && (l.ownerId === userId || l.owner?.id === userId)) || l.memberUserId === userId);
    const companyListing = businesses.find((l) => sameName(l.name, profile.company));
    const otherBusinesses = businesses.filter((l) => l !== companyListing);

    // Pictures from their own posts (not ones they reposted).
    const photos = useMemo(
        () => posts.list.filter((post) => post.pubkey === pubkey).flatMap((post) => parseNoteContent(post.content).images),
        [posts.list, pubkey],
    );

    // Talent beside Photos: on your own profile (to add yours), or when they listed some.
    const showTalent = talentEnabled && (isOwn || talents.length > 0);
    // Recommendations beside Talent: on your own profile, or when they vouch for any.
    const showRecommendations = directoriesEnabled && (isOwn || recommendations.total > 0);
    const tabs = ['all', 'photos', ...(showTalent ? ['talent'] : []), ...(showRecommendations ? ['recommendations'] : [])];
    // A tab that went away while open (Talents switched off): back to All.
    const openTab = tabs.includes(tab) ? tab : 'all';

    const avatar = profile.avatar || nostrProfile?.picture || '';
    const banner = profile.banner || nostrProfile?.banner || '';
    const name = profile.name || t('common.unnamed', 'Unnamed');
    const projects = projectsEnabled && Array.isArray(profile.biesProjects) ? profile.biesProjects : [];
    // Edit profile → Experience → Show: Off hides it from the profile.
    const experience = profile.showExperience !== false && Array.isArray(profile.experience)
        ? profile.experience.filter((e) => e?.title || e?.company)
        : [];
    const sections = Array.isArray(profile.customSections) ? profile.customSections : [];
    const links = [
        profile.website && isSafeUrl(profile.website) && { key: 'web', Icon: Globe, href: profile.website, label: profile.website.replace(/^https?:\/\//, '').replace(/\/$/, '') },
        profile.twitter && { key: 'x', Icon: Twitter, href: `https://x.com/${profile.twitter.replace('@', '')}`, label: `@${profile.twitter.replace('@', '')}` },
        profile.linkedin && isSafeUrl(profile.linkedin) && { key: 'in', Icon: Linkedin, href: profile.linkedin, label: 'LinkedIn' },
    ].filter(Boolean);
    const role = profile.title && profile.company ? 'both' : profile.title ? 'title' : profile.company ? 'company' : null;
    const filledIn = role || otherBusinesses.length || projects.length || profile.location || links.length || profile.tags?.length;
    const joined = joinedDate(profile.user?.createdAt, i18n.language);

    const companyText = companyListing
        ? <Link to={listingPath(companyListing)} className="pv-link">{profile.company}</Link>
        : <strong>{profile.company}</strong>;

    return (
        <div className="pv">
            {/* A strip of the cover; tap it for the whole picture. */}
            <div
                className={`pv-cover${banner ? ' has-image' : ''}`}
                {...(banner ? {
                    role: 'button',
                    tabIndex: 0,
                    'aria-label': t('profileView.viewCover'),
                    onClick: () => lightbox?.open(getAssetUrl(banner)),
                    onKeyDown: (e) => { if (e.key === 'Enter') lightbox?.open(getAssetUrl(banner)); },
                } : {})}
            >
                {/* The part its member chose, when it's their BIES banner */}
                {banner && <CoverPhoto src={banner} frame={profile.banner ? profile.coverFrame : ''} />}
                {showBack && <BackButton overlay fallback="/members" />}
            </div>

            <div className="pv-sheet">
                <div className="pv-head">
                    <button
                        type="button"
                        className="pv-avatar"
                        onClick={() => avatar && lightbox?.open(getAssetUrl(avatar))}
                        aria-label={name}
                    >
                        {avatar ? <img src={getAssetUrl(avatar)} alt="" /> : <User size={44} />}
                    </button>
                    <div className="pv-title">
                        <h1 className="pv-name">{name}</h1>
                        {userId && (
                            <p className="pv-counts">
                                <Link to={`/members/${userId}/followers`} className="pv-count">
                                    {t('profileView.followers', { count: followers.total })}
                                </Link>
                                <span aria-hidden="true"> · </span>
                                <Link to={`/members/${userId}/following`} className="pv-count">
                                    {t('profileView.following', { count: following.total })}
                                </Link>
                            </p>
                        )}
                    </div>
                </div>

                {(bio || profile.bio) && <div className="pv-bio">{bio || profile.bio}</div>}

                {actions && <div className="pv-actions">{actions}</div>}

                <div className="pv-tabs" role="tablist">
                    {tabs.map((key) => (
                        <button
                            key={key}
                            type="button"
                            role="tab"
                            aria-selected={openTab === key}
                            className={`pv-tab${openTab === key ? ' active' : ''}`}
                            onClick={() => setTab(key)}
                        >
                            {t(`profileView.tabs.${key}`)}
                        </button>
                    ))}
                </div>
            </div>

            {openTab === 'talent' && (talents.length > 0 ? (
                talents.map((talent) => (
                    <section key={talent.id} className="pv-section">
                        <TalentSummary talent={talent} isOwn={!!isOwn} />
                    </section>
                ))
            ) : (
                <section className="pv-section">
                    <h2 className="pv-h2">{t('profileView.tabs.talent')}</h2>
                    <p className="pv-muted">{t('talent.profileEmptyOwn')}</p>
                    <Link to="/talents/new" className="pv-link pv-add-talent">
                        <Plus size={16} aria-hidden="true" /> {t('talent.add')}
                    </Link>
                </section>
            ))}
            {openTab === 'recommendations' && (
                <section className="pv-section">
                    <h2 className="pv-h2">
                        {t('profileView.tabs.recommendations')}
                        {recommendations.total > 0 && <span className="pv-h2-count">{recommendations.total}</span>}
                    </h2>
                    {recommendations.list.length > 0 ? (
                        <>
                            <ul className="pv-recs">
                                {recommendations.list.map((listing) => (
                                    <li key={listing.id}><DirectoryListingCard listing={listing} type={listing.type} /></li>
                                ))}
                            </ul>
                            {recommendations.list.length < recommendations.total && (
                                <button type="button" className="pv-more" onClick={moreRecommendations} disabled={recommendations.loading}>
                                    {t('profileView.showMore')}
                                </button>
                            )}
                        </>
                    ) : (
                        <>
                            <p className="pv-muted">{t('profileView.recommendationsEmptyOwn')}</p>
                            <Link to="/trusted" className="pv-link pv-add-talent">{t('profileView.findBusinesses')}</Link>
                        </>
                    )}
                </section>
            )}
            {openTab === 'talent' && isOwn && talents.length > 0 && talents.length < MAX_TALENTS && (
                <section className="pv-section">
                    <Link to="/talents/new" className="pv-link pv-add-talent">
                        <Plus size={16} aria-hidden="true" /> {t('talent.addAnother')}
                    </Link>
                </section>
            )}
            {openTab === 'photos' && albums.show && (
                <section className="pv-section">
                    <AlbumsBlock albums={albums.albums} canManage={albums.canManage} titleStyle={H2} />
                </section>
            )}
            {openTab === 'photos' && (
                <section className="pv-section">
                    <h2 className="pv-h2">{t(albums.albums.length ? 'profileView.photosFromPosts' : 'profileView.tabs.photos')}</h2>
                    {photos.length > 0 ? (
                        <div className="pv-photos">
                            {photos.map((src, i) => (
                                <button key={`${src}-${i}`} type="button" className="pv-photo" onClick={() => lightbox?.open(src, photos)}>
                                    <img src={src} alt="" loading="lazy" />
                                </button>
                            ))}
                        </div>
                    ) : (
                        <p className="pv-empty">
                            <ImageOff size={20} aria-hidden="true" />
                            {posts.loading && showPosts ? t('common.loading', 'Loading...') : t('profileView.noPhotos')}
                        </p>
                    )}
                </section>
            )}

            {/* Kept mounted on Photos, so the posts stay loaded and as they were. */}
            <div hidden={openTab !== 'all'}>
                {(filledIn || joined || isOwn) && (
                    <section className="pv-section">
                        <h2 className="pv-h2">{t('profileView.details')}</h2>
                        <ul className="pv-details">
                            {role && (
                                <li>
                                    <Briefcase size={20} aria-hidden="true" />
                                    <span>
                                        {role === 'both' && <>{profile.title} {t('profileView.at')} {companyText}</>}
                                        {role === 'title' && profile.title}
                                        {role === 'company' && companyText}
                                    </span>
                                </li>
                            )}
                            {otherBusinesses.map((l) => (
                                <li key={l.id}>
                                    {l.type === 'FARM' ? <Leaf size={20} aria-hidden="true" /> : <Store size={20} aria-hidden="true" />}
                                    <span>{t('profileView.runs')} <Link to={listingPath(l)} className="pv-link">{l.name}</Link></span>
                                </li>
                            ))}
                            {projects.map((p) => (
                                <li key={p.id}>
                                    <Rocket size={20} aria-hidden="true" />
                                    <span>
                                        {p.role ? `${p.role} · ` : `${t('profileView.workingOn')} `}
                                        <Link to={`/opportunities/${p.id}`} className="pv-link">{p.name}</Link>
                                    </span>
                                </li>
                            ))}
                            {profile.location && (
                                <li><MapPin size={20} aria-hidden="true" /><span>{profile.location}</span></li>
                            )}
                            {links.map(({ key, Icon, href, label }) => (
                                <li key={key}>
                                    <Icon size={20} aria-hidden="true" />
                                    <a href={href} target="_blank" rel="noopener noreferrer" className="pv-link">{label}</a>
                                </li>
                            ))}
                            {joined && (
                                <li><CalendarDays size={20} aria-hidden="true" /><span>{t('profileView.joined', { date: joined })}</span></li>
                            )}
                        </ul>
                        {profile.tags?.length > 0 && (
                            <div className="pv-tags">
                                {profile.tags.map((tag, i) => <ZappableTag key={`${tag}-${i}`} tag={tag} />)}
                            </div>
                        )}
                        {isOwn && !filledIn && (
                            <p className="pv-muted pv-add-details">
                                {t('profileView.addDetails')} <Link to="/profile/edit" className="pv-link">{t('profileView.editProfile')}</Link>
                            </p>
                        )}
                    </section>
                )}

                <section className="pv-section">
                    <div className="pv-section-head">
                        <h2 className="pv-h2">
                            {t('profileView.network')}
                            {network.length > 0 && !networkHidden && <span className="pv-h2-count">{network.length}</span>}
                        </h2>
                        {network.length > 0 && userId && !networkHidden && (
                            <Link to={`/members/${userId}/network`} className="pv-link pv-see-all">{t('profileView.seeAll')}</Link>
                        )}
                    </div>
                    {networkHidden ? (
                        <p className="pv-muted">{t('profileView.networkPrivate', { name })}</p>
                    ) : network.length > 0 ? (
                        <ul className="pv-network">
                            {network.slice(0, NETWORK_SHOWN).map((p) => (
                                <li key={p.id}>
                                    <Link to={`/builder/${p.nostrPubkey || p.id}`} className="pv-person">
                                        <span className="pv-person-photo">
                                            {p.profile?.avatar ? <img src={getAssetUrl(p.profile.avatar)} alt="" /> : <User size={26} />}
                                        </span>
                                        <span className="pv-person-name">{isPlaceholderName(p.profile?.name) ? t('profileView.newMember') : p.profile.name}</span>
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="pv-muted">
                            {isOwn
                                ? <>{t('profileView.networkEmptyOwn')} <Link to="/members" className="pv-link">{t('profileView.findMembers')}</Link></>
                                : t('profileView.networkEmpty')}
                        </p>
                    )}
                </section>

                {experience.length > 0 && (
                    <section className="pv-section">
                        <h2 className="pv-h2">{t('publicProfile.experience', 'Experience')}</h2>
                        <ul className="pv-details">
                            {experience.map((e, i) => (
                                <li key={i}>
                                    <Briefcase size={20} aria-hidden="true" />
                                    <span>
                                        <strong>{e.title}</strong>
                                        {e.company && <> · {e.company}</>}
                                        {e.date && <span className="pv-muted pv-block">{e.date}</span>}
                                        {e.description && <span className="pv-block">{e.description}</span>}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </section>
                )}

                {sections.map((section, i) => (
                    <section key={i} className="pv-section pv-custom">
                        <ProfileSection section={section} />
                    </section>
                ))}

                {Children.toArray(children).filter((child) => typeof child !== 'string' || child.trim()).map((child, i) => (
                    <section key={i} className="pv-section">{child}</section>
                ))}

                {showPosts && (
                    <section className="pv-section pv-posts">
                        <h2 className="pv-h2 pv-posts-title">{t('profileView.posts')}</h2>
                        <Feed
                            author={pubkey}
                            showCompose={!!isOwn}
                            emptyText={t(isOwn ? 'profileView.noPostsOwn' : 'profileView.noPosts')}
                            onPosts={(list, loading) => setPosts({ list, loading })}
                        />
                    </section>
                )}
            </div>

            <style jsx>{`
                .pv {
                    max-width: 820px;
                    margin: 0 auto;
                    padding-bottom: 2rem;
                    background: var(--color-surface);
                    min-height: 100%;
                }
                .pv-cover {
                    position: relative;
                    height: 150px;
                    background: linear-gradient(120deg, #0047AB, #0a192f);
                    overflow: hidden;
                }
                .pv-cover.has-image { cursor: zoom-in; }
                .pv-sheet {
                    position: relative;
                    margin-top: -18px;
                    padding: 0 16px 4px;
                    background: var(--color-surface);
                    border-radius: 18px 18px 0 0;
                }
                .pv-head { display: flex; align-items: flex-start; gap: 14px; }
                .pv-avatar {
                    flex-shrink: 0;
                    width: 104px; height: 104px;
                    margin-top: -52px;
                    padding: 0;
                    border-radius: 50%;
                    border: 4px solid var(--color-surface);
                    background: var(--color-gray-100);
                    color: var(--color-gray-400);
                    display: flex; align-items: center; justify-content: center;
                    overflow: hidden;
                    cursor: zoom-in;
                }
                .pv-avatar img { width: 100%; height: 100%; object-fit: cover; }
                .pv-title { min-width: 0; padding-top: 12px; }
                .pv-name {
                    margin: 0;
                    font-family: var(--font-sans);
                    font-size: 1.45rem;
                    font-weight: 700;
                    line-height: 1.2;
                    letter-spacing: -0.01em;
                    color: var(--color-gray-900);
                    overflow-wrap: anywhere;
                }
                .pv-counts { margin: 4px 0 0; font-size: 0.92rem; color: var(--color-gray-600); }
                .pv-counts :global(.pv-count) { color: inherit; text-decoration: none; font-weight: 600; }
                .pv-bio {
                    margin: 14px 0 0;
                    font-size: 0.98rem;
                    line-height: 1.5;
                    color: var(--color-gray-800);
                    white-space: pre-line;
                }
                .pv-actions { display: flex; gap: 8px; margin-top: 16px; }
                .pv-actions :global(.pv-btn) {
                    flex: 1;
                    min-height: 42px;
                    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
                    padding: 0 14px;
                    border-radius: 10px;
                    border: none;
                    background: var(--color-gray-100);
                    color: var(--color-gray-900);
                    font-weight: 600;
                    font-size: 0.95rem;
                    text-decoration: none;
                    cursor: pointer;
                    white-space: nowrap;
                }
                .pv-actions :global(.pv-btn.primary) { background: var(--color-primary); color: #fff; }
                /* An explicit width: Safari sizes the menu's wrapper by the icon, not the flex basis. */
                .pv-actions :global(.pv-btn.icon) { flex: 0 0 48px; width: 48px; min-width: 48px; padding: 0; }
                .pv-actions :global(.pv-btn:disabled) { opacity: 0.6; cursor: wait; }
                .pv-actions :global(.pv-menu-wrap) { position: relative; display: flex; flex: 0 0 auto; }
                /* Four tabs can be wider than a phone: they scroll sideways, not the page. */
                .pv-tabs {
                    display: flex; gap: 6px; margin-top: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--color-gray-200);
                    overflow-x: auto; scrollbar-width: none;
                }
                .pv-tabs::-webkit-scrollbar { display: none; }
                .pv-tab {
                    flex-shrink: 0;
                    min-height: 38px;
                    padding: 0 16px;
                    border: none;
                    border-radius: 999px;
                    background: none;
                    color: var(--color-gray-700);
                    font-weight: 600;
                    font-size: 0.95rem;
                    cursor: pointer;
                }
                .pv-tab.active { background: var(--color-blue-tint, #e8effb); color: var(--color-primary); }
                @media (max-width: 768px) {
                    /* All four (with Recommendations) fit a 390px phone, in Spanish too. */
                    .pv-tabs { gap: 4px; }
                    .pv-tab { padding: 0 10px; font-size: 0.9rem; }
                }

                .pv-section { padding: 18px 16px; border-bottom: 8px solid var(--color-gray-100); }
                .pv-section:last-child { border-bottom: none; }
                .pv-section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
                .pv-section-head .pv-h2 { margin-bottom: 0; }
                .pv-h2-count { margin-left: 8px; font-weight: 500; color: var(--color-gray-500); }
                .pv-h2 { margin: 0 0 12px; font-family: var(--font-sans); font-size: 1.15rem; font-weight: 700; color: var(--color-gray-900); }
                .pv-muted { margin: 0; color: var(--color-gray-500); font-size: 0.9rem; }
                .pv-block { display: block; margin-top: 2px; }
                .pv-section :global(.pv-link) { color: var(--color-primary); font-weight: 600; text-decoration: none; }
                .pv-section :global(.pv-see-all) { font-size: 0.95rem; padding: 4px 0; }
                .pv-section :global(.pv-add-talent) { display: inline-flex; align-items: center; gap: 6px; margin-top: 10px; padding: 4px 0; font-size: 0.95rem; }
                .pv-details { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 14px; }
                .pv-details li { display: flex; align-items: flex-start; gap: 12px; font-size: 0.98rem; line-height: 1.4; color: var(--color-gray-800); }
                .pv-details li :global(svg) { flex-shrink: 0; color: var(--color-gray-500); margin-top: 1px; }
                .pv-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; }
                /* A link keeps the phone's 36px tap height without spacing out the line under it. */
                .pv-details li > a { min-height: 0; padding: 7px 0; margin: -7px 0; }
                .pv-add-details { margin-top: 14px; }

                .pv-network { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
                .pv-network li:nth-child(n + 5) { display: none; }
                .pv-network :global(.pv-person) { display: flex; flex-direction: column; align-items: center; gap: 6px; text-decoration: none; color: var(--color-gray-900); text-align: center; }
                .pv-person-photo {
                    width: 72px; height: 72px; border-radius: 50%; overflow: hidden;
                    display: flex; align-items: center; justify-content: center;
                    background: var(--color-gray-100); color: var(--color-gray-400);
                }
                .pv-person-photo img { width: 100%; height: 100%; object-fit: cover; }
                .pv-person-name {
                    font-size: 0.86rem; font-weight: 600; line-height: 1.25;
                    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
                }

                .pv-recs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
                .pv-more {
                    width: 100%; min-height: 44px; margin-top: 14px;
                    border: none; border-radius: 10px;
                    background: var(--color-gray-100); color: var(--color-gray-900);
                    font-weight: 600; font-size: 0.95rem; cursor: pointer;
                }
                .pv-more:disabled { opacity: 0.6; cursor: wait; }

                .pv-photos { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 3px; }
                .pv-photo { padding: 0; border: none; aspect-ratio: 1; overflow: hidden; background: var(--color-gray-100); cursor: zoom-in; }
                .pv-photo img { width: 100%; height: 100%; object-fit: cover; display: block; }
                .pv-empty { display: flex; align-items: center; gap: 8px; margin: 0; color: var(--color-gray-500); font-size: 0.92rem; }

                .pv-posts { padding-left: 0; padding-right: 0; padding-bottom: 0; }
                .pv-posts-title { padding: 0 16px; }

                @media (min-width: 769px) {
                    .pv { margin-top: 1rem; border-radius: 16px; overflow: hidden; box-shadow: 0 1px 3px rgba(15, 23, 42, 0.08); }
                    .pv-cover { height: 220px; }
                    .pv-sheet { padding: 0 24px 4px; }
                    .pv-avatar { width: 148px; height: 148px; margin-top: -74px; }
                    .pv-title { padding-top: 18px; }
                    .pv-name { font-size: 1.9rem; }
                    .pv-section { padding: 22px 24px; }
                    .pv-network { grid-template-columns: repeat(8, minmax(0, 1fr)); }
                    .pv-network li:nth-child(n + 5) { display: list-item; }
                    .pv-posts-title { padding: 0 24px; }
                    .pv-actions :global(.pv-btn) { flex: 0 1 auto; padding: 0 22px; }
                }
            `}</style>
        </div>
    );
};

export default ProfileView;
