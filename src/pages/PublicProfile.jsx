import { useState, useEffect, useRef } from 'react';
import { useParams, useLocation, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MoreHorizontal, Loader2, Copy, Check, UserPlus, UserCheck, Users, Zap, MessageSquare, Calendar, Trophy, Flag, Ban, Pencil } from 'lucide-react';
import { getAssetUrl } from '../utils/assets';
import { nip19 } from 'nostr-tools';
import { profilesApi, eventsApi, pointsApi } from '../services/api';
import { cachedDetail, fetchDetail, forgetDetail, rememberDetail } from '../utils/detailCache';
import { profilePage } from '../utils/detailPages';
import { useAuth } from '../context/AuthContext';
import { useFeature } from '../context/FeatureFlagsContext';
import { nostrService } from '../services/nostrService';
import ZapButton from '../components/ZapButton';
import TranslatableText from '../components/TranslatableText';
import ProfileView from '../components/profile/ProfileView';
import { useModerationDialogs } from '../components/moderation/useModerationDialogs';
import { unblock } from '../services/blockStore';
import '../components/moderation/Moderation.css';

const PublicProfile = ({ type }) => {
    const { id } = useParams();
    const { t } = useTranslation();
    const { user: currentUser } = useAuth();
    const location = useLocation();
    // Opened before this session (detailCache), or tapped in Members (the
    // card's name, photo and lines, marked isPreview until the page arrives):
    // drawn from the first frame, then fetched in place.
    const preview = () => (location.state?.preview?.id === id ? { ...location.state.preview, isPreview: true } : null);
    const shownAtOnce = () => cachedDetail(profilePage(id)[0]) || preview();
    const [profile, setProfile] = useState(shownAtOnce);
    const [loading, setLoading] = useState(() => !shownAtOnce());
    const [error, setError] = useState('');
    const [showMenu, setShowMenu] = useState(false);
    const [isFollowing, setIsFollowing] = useState(() => !!shownAtOnce()?.followedByMe);
    const [followLoading, setFollowLoading] = useState(false);
    const [nostrProfile, setNostrProfile] = useState(null);
    const [lnAddrCopied, setLnAddrCopied] = useState(false);
    const [bolt12Copied, setBolt12Copied] = useState(false);
    const [hostedEvents, setHostedEvents] = useState([]); // upcoming events this user hosts
    const [hostedTotal, setHostedTotal] = useState(0); // all-time hosted event count
    const [points, setPoints] = useState(null);
    const pointsEnabled = useFeature('points');
    const messagesEnabled = useFeature('messages');
    const eventsEnabled = useFeature('events');
    // Bumped after a block or unblock: the server then answers differently.
    const [reloadKey, setReloadKey] = useState(0);
    const [unblocking, setUnblocking] = useState(false);
    // Focus goes back to the menu button when a Report or Block sheet closes.
    const menuButtonRef = useRef(null);
    const { openReport, openBlock, dialogs } = useModerationDialogs({
        // Blocking ends any follow between them.
        onBlocked: () => { setIsFollowing(false); setReloadKey((k) => k + 1); },
    });

    useEffect(() => {
        const [key, load] = profilePage(id);
        // After a block or unblock the server answers differently: not the copy kept.
        if (reloadKey) forgetDetail(key);
        const shown = cachedDetail(key) || preview();
        let current = true;
        const fetchProfile = async () => {
            if (shown) {
                setProfile(shown);
                setIsFollowing(!!shown.followedByMe);
                setError('');
                setLoading(false);
            } else {
                setLoading(true);
            }
            try {
                const data = await fetchDetail(key, load);
                if (!current) return;
                setProfile(data);
                if (typeof data?.followedByMe === 'boolean') setIsFollowing(data.followedByMe);
                setError('');
            } catch (err) {
                if (!current) return;
                forgetDetail(key);
                if (currentUser && id === currentUser.id) {
                    // Create an empty placeholder profile so they can see the "Edit Profile" button
                    setProfile({
                        id: 'new',
                        userId: currentUser.id,
                        user: {
                            id: currentUser.id,
                            role: currentUser.role,
                            name: currentUser.name || '',
                            email: currentUser.email || ''
                        },
                        name: currentUser.name || 'New User',
                        role: currentUser.role || (type === 'investor' ? 'INVESTOR' : 'BUILDER'),
                        bio: '',
                        location: '',
                        company: '',
                        avatar: '',
                        banner: '',
                        skills: [],
                        interests: [],
                        investmentThesis: ''
                    });
                    setError('');
                } else {
                    setError('Profile not found');
                }
            } finally {
                if (current) setLoading(false);
            }
        };
        fetchProfile();
        return () => { current = false; };
    }, [id, currentUser, type, reloadKey]);

    // The copy kept for next time follows what's shown (Follow, Unfollow).
    useEffect(() => {
        const [key] = profilePage(id);
        if (profile && profile.id !== 'new' && cachedDetail(key)) rememberDetail(key, { ...profile, followedByMe: isFollowing });
    }, [profile, isFollowing, id]);

    // The URL :id can be a profileId or userId — the follow API needs the userId
    const targetUserId = profile?.user?.id || profile?.userId;

    // Whether the current user follows them: the profile says (followedByMe);
    // a server from before that is asked for the list of who they follow.
    // (A card's preview doesn't say: the page will, so nothing is asked meanwhile.)
    const followKnown = typeof profile?.followedByMe === 'boolean' || !!profile?.isPreview;
    useEffect(() => {
        if (followKnown || !currentUser?.id || !targetUserId || currentUser.id === targetUserId) return;
        profilesApi.getFollowing(currentUser.id, { limit: 100 })
            .then(res => {
                const list = res?.data || res || [];
                setIsFollowing(list.some(u => u.id === targetUserId));
            })
            .catch(() => { });
    }, [currentUser?.id, targetUserId, followKnown]);

    // The member's Nostr profile. The key is worked out here, not from the
    // `npub` further down: a blocked member's page returns before it.
    useEffect(() => {
        setNostrProfile(null);
        if (!profile || profile.blocked) return undefined;
        const key = profile.user?.nostrPubkey
            ? nip19.npubEncode(profile.user.nostrPubkey)
            : profile.nostrNpub;
        if (!key) return undefined;
        let cancelled = false;
        try {
            const decoded = nip19.decode(key);
            if (decoded.type === 'npub') {
                nostrService.getProfile(decoded.data)
                    .then((p) => { if (!cancelled) setNostrProfile(p); })
                    .catch(() => { });
            }
        } catch {
            // Invalid npub — skip
        }
        return () => { cancelled = true; };
        // Their key, not the whole profile: the card's preview and the page are the same member.
    }, [!!profile, profile?.blocked, profile?.user?.nostrPubkey, profile?.nostrNpub]);

    // Fetch events this user hosts — upcoming for the panel, total for stats.
    // Not while Events is switched off (the API answers 404 then).
    useEffect(() => {
        if (!targetUserId || !eventsEnabled) return undefined;
        let cancelled = false;
        eventsApi.list({ hostId: targetUserId, upcoming: 'true', limit: 6 })
            .then(res => { if (!cancelled) setHostedEvents(Array.isArray(res?.data) ? res.data : []); })
            .catch(() => { });
        eventsApi.list({ hostId: targetUserId, limit: 1 })
            .then(res => { if (!cancelled) setHostedTotal(res?.pagination?.total || 0); })
            .catch(() => { });
        return () => { cancelled = true; };
    }, [targetUserId, eventsEnabled]);

    // Fetch gamification points/badges — silent-fail, unscored profiles render
    // nothing. Skipped while the `points` feature is toggled off.
    useEffect(() => {
        if (!profile || !pointsEnabled) return;
        let pubkey = profile.user?.nostrPubkey;
        if (!pubkey && profile.nostrNpub) {
            try {
                const decoded = nip19.decode(profile.nostrNpub);
                if (decoded.type === 'npub') pubkey = decoded.data;
            } catch {
                // Invalid npub — skip
            }
        }
        if (!pubkey) return;
        pointsApi.user(pubkey).then(setPoints).catch(() => { });
    }, [profile, pointsEnabled]);

    if (loading) {
        return (
            <div className="profile-page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
                <Loader2 size={32} style={{ animation: 'spin 1s linear infinite' }} />
            </div>
        );
    }

    if (error || !profile) {
        return <div className="p-10 text-center text-gray-500">{error || t('publicProfile.profileNotFound', 'Profile not found')}</div>;
    }

    // A member this member blocked: only their name, and the way back.
    if (profile.blocked) {
        const doUnblock = async () => {
            setUnblocking(true);
            try {
                await unblock(currentUser?.id, profile.userId);
                setReloadKey((k) => k + 1);
            } catch {
                // Still blocked; the button stays.
            } finally {
                setUnblocking(false);
            }
        };
        return (
            <div className="container py-8">
                <div className="mod-blocked-card">
                    {profile.avatar && <img src={getAssetUrl(profile.avatar)} alt="" />}
                    <h1 className="mod-title">{t('moderation.blockedProfile.title', { name: profile.name || t('common.unnamed') })}</h1>
                    <p className="mod-muted">{t('moderation.blockedProfile.body')}</p>
                    <button type="button" className="mod-button secondary" onClick={doUnblock} disabled={unblocking}>
                        {unblocking ? <Loader2 size={18} className="mod-spin" /> : null}
                        {t('moderation.unblock')}
                    </button>
                </div>
            </div>
        );
    }

    const npub = profile.user?.nostrPubkey
        ? nip19.npubEncode(profile.user.nostrPubkey)
        : profile.nostrNpub;

    // Points UI renders only for scored users (and only while the `points`
    // feature is enabled); badge strip is deduped by badgeId
    const hasPoints = pointsEnabled && Boolean(points && (points.lifetimePoints > 0 || (points.badges || []).length > 0));
    const profileBadges = hasPoints ? [...new Map(points.badges.map(b => [b.badgeId, b])).values()] : [];
    const MAX_BADGE_CHIPS = 8;

    const isOwn = !!currentUser && !!targetUserId && currentUser.id === targetUserId;

    const toggleFollow = async () => {
        setFollowLoading(true);
        try {
            if (isFollowing) {
                await profilesApi.unfollow(targetUserId);
                setIsFollowing(false);
            } else {
                await profilesApi.follow(targetUserId);
                setIsFollowing(true);
            }
        } catch (err) {
            if (err?.status === 409) setIsFollowing(true);
            else alert(err?.message || 'Failed to update follow');
        } finally {
            setFollowLoading(false);
        }
    };

    // Follow (and Message, once direct messages are on), Zap, and ⋯ for
    // Report and Block; Edit on your own.
    const actions = isOwn ? (
        <Link to="/profile/edit" className="pv-btn">
            <Pencil size={18} /> {t('profileView.editProfile')}
        </Link>
    ) : currentUser && targetUserId ? (
        <>
            <button
                type="button"
                className={`pv-btn${isFollowing ? '' : ' primary'}`}
                onClick={toggleFollow}
                disabled={followLoading || !!profile?.isPreview}
                // Until the page says whether they're followed: its place, not a wrong label.
                style={profile?.isPreview ? { visibility: 'hidden' } : undefined}
                aria-pressed={isFollowing}
            >
                {isFollowing ? <UserCheck size={18} /> : <UserPlus size={18} />}
                {isFollowing ? t('publicProfile.following', 'Following') : t('publicProfile.follow', 'Follow')}
            </button>
            {messagesEnabled && (
                <Link to="/messages" className="pv-btn primary">
                    <MessageSquare size={18} /> {t('profileView.message')}
                </Link>
            )}
            {profile.user?.nostrPubkey && (
                <ZapButton
                    recipients={[{ pubkey: profile.user.nostrPubkey, name: profile.name, avatar: profile.avatar, lud16: profile.lightningAddress, bolt12Offer: profile.bolt12Offer }]}
                    size="md"
                    variant="bitcoin"
                />
            )}
            <div className="pv-menu-wrap">
                <button
                    ref={menuButtonRef}
                    type="button"
                    className="pv-btn icon"
                    onClick={() => setShowMenu(!showMenu)}
                    aria-label={t('moderation.menu.more')}
                    aria-expanded={showMenu}
                >
                    <MoreHorizontal size={20} />
                </button>
                {showMenu && (
                    <>
                        <div className="pp-menu-backdrop" onClick={() => setShowMenu(false)} />
                        <div className="pp-menu" role="menu">
                            <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                    setShowMenu(false);
                                    menuButtonRef.current?.focus({ preventScroll: true });
                                    openReport({ type: 'user', id: targetUserId }, { name: profile.name, blockTarget: { userId: targetUserId } });
                                }}
                            >
                                <Flag size={16} /> {t('moderation.menu.reportProfile')}
                            </button>
                            <button
                                type="button"
                                role="menuitem"
                                className="danger"
                                onClick={() => {
                                    setShowMenu(false);
                                    menuButtonRef.current?.focus({ preventScroll: true });
                                    openBlock({ userId: targetUserId }, { name: profile.name });
                                }}
                            >
                                <Ban size={16} /> {t('moderation.menu.blockMember')}
                            </button>
                        </div>
                    </>
                )}
            </div>
        </>
    ) : null;

    return (
        <div className="profile-page">
            {dialogs}
            <ProfileView
                profile={profile}
                nostrProfile={nostrProfile}
                isOwn={isOwn}
                showBack
                bio={profile.bio ? <TranslatableText text={profile.bio} style={{ margin: 0, fontSize: '0.98rem', lineHeight: 1.5, color: 'var(--color-gray-800)', whiteSpace: 'pre-line' }} /> : null}
                actions={actions}
            >
                {!!(profile.lightningAddress || profile.bolt12Offer) && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                        {/* Lightning Address */}
                        {profile.lightningAddress && (
                            <button
                                onClick={() => {
                                    navigator.clipboard.writeText(profile.lightningAddress);
                                    setLnAddrCopied(true);
                                    setTimeout(() => setLnAddrCopied(false), 2000);
                                }}
                                style={{
                                    display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
                                    background: 'linear-gradient(135deg, rgba(247,147,26,0.08), rgba(247,147,26,0.15))',
                                    border: '1px solid rgba(247,147,26,0.25)',
                                    borderRadius: '999px', padding: '0.35rem 0.85rem', cursor: 'pointer',
                                    fontSize: '0.85rem', color: 'var(--color-gray-700)',
                                    transition: 'all 0.2s',
                                }}
                                title="Click to copy Lightning Address"
                            >
                                <Zap size={14} style={{ color: '#f7931a', flexShrink: 0 }} />
                                <span style={{ color: 'var(--color-gray-500)', fontWeight: 600, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.03em' }}>Lightning Address</span>
                                <span style={{ fontFamily: 'monospace' }}>{profile.lightningAddress}</span>
                                {lnAddrCopied ? <Check size={14} style={{ color: '#15803d' }} /> : <Copy size={14} style={{ color: 'var(--color-gray-400)' }} />}
                            </button>
                        )}

                        {/* Bolt12 Offer */}
                        {profile.bolt12Offer && (
                            <button
                                onClick={() => {
                                    navigator.clipboard.writeText(profile.bolt12Offer);
                                    setBolt12Copied(true);
                                    setTimeout(() => setBolt12Copied(false), 2000);
                                }}
                                style={{
                                    display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
                                    background: 'linear-gradient(135deg, rgba(139,92,246,0.08), rgba(139,92,246,0.15))',
                                    border: '1px solid rgba(139,92,246,0.25)',
                                    borderRadius: '999px', padding: '0.35rem 0.85rem', cursor: 'pointer',
                                    fontSize: '0.85rem', color: 'var(--color-gray-700)',
                                    transition: 'all 0.2s',
                                }}
                                title="Click to copy Bolt12 Offer"
                            >
                                <Zap size={14} style={{ color: '#8b5cf6', flexShrink: 0 }} />
                                <span style={{ color: 'var(--color-gray-500)', fontWeight: 600, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.03em' }}>Bolt12</span>
                                <span style={{ fontFamily: 'monospace', maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{profile.bolt12Offer}</span>
                                {bolt12Copied ? <Check size={14} style={{ color: '#15803d' }} /> : <Copy size={14} style={{ color: 'var(--color-gray-400)' }} />}
                            </button>
                        )}

                    </div>
                )}
                {hasPoints && (
                    <div>
                        {/* Points stats */}
                        {hasPoints && (
                            <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '0.75rem' }} data-testid="profile-points">
                                <span style={{
                                    display: 'inline-flex', alignItems: 'center', background: 'var(--color-blue-tint)',
                                    color: 'var(--color-primary)', fontSize: '0.75rem', fontWeight: 600,
                                    padding: '2px 10px', borderRadius: 'var(--radius-full)', whiteSpace: 'nowrap',
                                }}>
                                    Lv {points.level} · {t(points.titleKey)}
                                </span>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                    <Trophy size={16} style={{ color: 'var(--color-secondary)' }} />
                                    <span style={{ fontWeight: 700, color: 'var(--color-gray-900)', fontFamily: 'var(--font-display)' }}>{points.lifetimePoints}</span>
                                    <span style={{ color: 'var(--color-gray-500)', fontSize: '0.875rem' }}>{t('points.leaderboard.points', 'Points')}</span>
                                </div>
                            </div>
                        )}
                        {/* Badge strip */}
                        {profileBadges.length > 0 && (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }} data-testid="profile-badges">
                                {profileBadges.slice(0, MAX_BADGE_CHIPS).map((b) => (
                                    <span
                                        key={b.badgeId}
                                        title={t(`points.badges.${b.badgeId}.name`)}
                                        style={{
                                            display: 'inline-flex', alignItems: 'center', gap: '6px',
                                            background: 'var(--color-surface)', border: '1px solid var(--color-gray-200)',
                                            borderRadius: 'var(--radius-full)', padding: '4px 10px 4px 6px',
                                            fontSize: '0.78rem', fontWeight: 500, color: 'var(--color-gray-700)', cursor: 'default',
                                        }}
                                    >
                                        <img src={`/badges/${b.badgeId}.png`} alt="" width="20" height="20" style={{ borderRadius: '50%', flexShrink: 0 }} />
                                        {t(`points.badges.${b.badgeId}.name`)}
                                    </span>
                                ))}
                                {profileBadges.length > MAX_BADGE_CHIPS && (
                                    <span style={{
                                        display: 'inline-flex', alignItems: 'center',
                                        background: 'var(--color-gray-100)', border: '1px solid var(--color-gray-200)',
                                        borderRadius: 'var(--radius-full)', padding: '4px 10px',
                                        fontSize: '0.78rem', fontWeight: 600, color: 'var(--color-gray-500)',
                                    }}>
                                        +{profileBadges.length - MAX_BADGE_CHIPS}
                                    </span>
                                )}
                            </div>
                        )}
                    </div>
                )}
                {/* Events Hosting Panel — the Event Host trust surface */}
                {eventsEnabled && (hostedEvents.length > 0 || hostedTotal > 0) && (
                    <div>
                        <h3 style={{ fontSize: '1.25rem', fontWeight: 700, fontFamily: 'var(--font-display)', marginBottom: '0.35rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <Calendar size={20} style={{ color: '#f7931a' }} />
                            {t('publicProfile.eventsHosting', 'Events Hosting')}
                        </h3>
                        <p style={{ fontSize: '0.8rem', color: 'var(--color-gray-500)', marginBottom: '1rem' }}>
                            {hostedTotal} {hostedTotal === 1 ? t('publicProfile.eventHostedStat', 'event hosted on BIES') : t('publicProfile.eventsHostedStat', 'events hosted on BIES')}
                        </p>
                        {hostedEvents.length > 0 ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                                {hostedEvents.map((event) => (
                                    <Link
                                        to={`/events/${event.id}`}
                                        key={event.id}
                                        style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '1rem',
                                            padding: '0.75rem 1rem',
                                            borderRadius: '10px',
                                            border: '1px solid var(--color-gray-200)',
                                            background: 'var(--color-gray-50)',
                                            textDecoration: 'none',
                                            transition: 'border-color 0.2s, box-shadow 0.2s',
                                        }}
                                        onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--color-primary)'; e.currentTarget.style.boxShadow = 'var(--shadow-sm)'; }}
                                        onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--color-gray-200)'; e.currentTarget.style.boxShadow = 'none'; }}
                                    >
                                        {event.thumbnail ? (
                                            <div style={{ width: '56px', height: '42px', borderRadius: '6px', overflow: 'hidden', flexShrink: 0 }}>
                                                <img src={getAssetUrl(event.thumbnail)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                            </div>
                                        ) : (
                                            <div style={{ width: '56px', height: '42px', borderRadius: '6px', background: 'var(--color-gray-200)', flexShrink: 0 }} />
                                        )}
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{ fontWeight: 600, color: 'var(--color-gray-900)', fontSize: '0.95rem', fontFamily: 'var(--font-display)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{event.title}</div>
                                            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.6rem', fontSize: '0.8rem', marginTop: '0.2rem' }}>
                                                <span style={{ color: 'var(--color-primary)', fontWeight: 500 }}>{new Date(event.startDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                                                {event.attendeeCount > 0 && (
                                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--color-gray-500)' }}>
                                                        <Users size={12} /> {event.attendeeCount}
                                                    </span>
                                                )}
                                                {event.priceSats > 0 && (
                                                    <span style={{
                                                        display: 'inline-flex', alignItems: 'center', gap: 3,
                                                        padding: '0.15rem 0.5rem', borderRadius: '999px',
                                                        fontSize: '0.72rem', fontWeight: 700,
                                                        background: 'var(--color-orange-tint)', color: '#b45309',
                                                    }}>
                                                        <Zap size={10} /> {Number(event.priceSats).toLocaleString()} sats
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    </Link>
                                ))}
                            </div>
                        ) : (
                            <p style={{ fontSize: '0.875rem', color: 'var(--color-gray-500)' }}>{t('publicProfile.noUpcomingHostedEvents', 'No upcoming events — check back soon.')}</p>
                        )}
                    </div>
                )}

                {/* Events Attending Panel */}
                {eventsEnabled && (
                    <div>
                        <h3 style={{ fontSize: '1.25rem', fontWeight: 700, fontFamily: 'var(--font-display)', marginBottom: '1rem' }}>{t('publicProfile.eventsAttending', 'Events Attending')}</h3>
                        {profile.user?.eventRSVPs && profile.user.eventRSVPs.length > 0 ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                                {profile.user.eventRSVPs.map((rsvp, idx) => (
                                    <Link
                                        to={`/events/${rsvp.event.id}`}
                                        key={idx}
                                        style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '1rem',
                                            padding: '0.75rem 1rem',
                                            borderRadius: '10px',
                                            border: '1px solid var(--color-gray-200)',
                                            background: 'var(--color-gray-50)',
                                            textDecoration: 'none',
                                            transition: 'border-color 0.2s, box-shadow 0.2s',
                                        }}
                                        onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--color-primary)'; e.currentTarget.style.boxShadow = 'var(--shadow-sm)'; }}
                                        onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--color-gray-200)'; e.currentTarget.style.boxShadow = 'none'; }}
                                    >
                                        {rsvp.event.thumbnail ? (
                                            <div style={{ width: '56px', height: '42px', borderRadius: '6px', overflow: 'hidden', flexShrink: 0 }}>
                                                <img src={getAssetUrl(rsvp.event.thumbnail)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                            </div>
                                        ) : (
                                            <div style={{ width: '56px', height: '42px', borderRadius: '6px', background: 'var(--color-gray-200)', flexShrink: 0 }} />
                                        )}
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{ fontWeight: 600, color: 'var(--color-gray-900)', fontSize: '0.95rem', fontFamily: 'var(--font-display)' }}>{rsvp.event.title}</div>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', fontSize: '0.8rem', marginTop: '0.2rem' }}>
                                                <span style={{ color: 'var(--color-primary)', fontWeight: 500 }}>{new Date(rsvp.event.startDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                                                <span style={{
                                                    padding: '0.15rem 0.5rem',
                                                    borderRadius: '999px',
                                                    fontSize: '0.75rem',
                                                    fontWeight: 600,
                                                    background: rsvp.status === 'GOING' ? 'var(--color-green-tint)' : 'var(--color-amber-tint)',
                                                    color: rsvp.status === 'GOING' ? '#15803d' : '#854d0e',
                                                }}>
                                                    {rsvp.status === 'GOING' ? t('publicProfile.attending', 'Attending') : t('publicProfile.interested', 'Interested')}
                                                </span>
                                            </div>
                                        </div>
                                    </Link>
                                ))}
                            </div>
                        ) : (
                            <p style={{ fontSize: '0.875rem', color: 'var(--color-gray-500)' }}>{t('publicProfile.noUpcomingEvents', 'No upcoming events.')}</p>
                        )}
                    </div>
                )}

            </ProfileView>

            <style jsx>{`
                .profile-page {
                    min-height: 100vh;
                    background: var(--color-gray-50);
                }
                /* The buttons are built outside the returned tree, which
                   styled-jsx doesn't scope: reach them through the page. */
                .profile-page :global(.pp-menu-backdrop) { position: fixed; inset: 0; z-index: 40; }
                .profile-page :global(.pp-menu) {
                    position: absolute; right: 0; top: calc(100% + 6px); z-index: 50;
                    width: 13rem; padding: 0.25rem 0;
                    background: var(--color-surface-overlay); border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-xl); box-shadow: var(--shadow-lg);
                }
                .profile-page :global(.pp-menu button) {
                    width: 100%; display: flex; align-items: center; gap: 0.75rem;
                    min-height: 44px; padding: 0 1rem; border: none; background: none; text-align: left;
                    font-size: 0.9rem; font-weight: 500; color: var(--color-gray-700); cursor: pointer;
                }
                .profile-page :global(.pp-menu button.danger) { color: var(--color-danger, #dc2626); }
            `}</style>
        </div>
    );
};

export default PublicProfile;
