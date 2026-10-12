import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MapPin, Briefcase, Globe, Twitter, Linkedin, MoreHorizontal, Share, Loader2, ArrowLeft, Users, Copy, Check, UserPlus, UserCheck, Zap, MessageSquare, Calendar, Trophy, Flag, Ban } from 'lucide-react';
import { getAssetUrl } from '../utils/assets';
import { nip19 } from 'nostr-tools';
import { profilesApi, eventsApi, pointsApi } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useLightbox } from '../context/LightboxContext';
import { useFeature } from '../context/FeatureFlagsContext';
import { nostrService } from '../services/nostrService';
import NostrFeed from '../components/NostrFeed';
import NostrIcon from '../components/NostrIcon';
import ZapButton from '../components/ZapButton';
import ZappableTag from '../components/ZappableTag';
import ProfileSection from '../components/ProfileSection';
import TranslatableText from '../components/TranslatableText';
import { useModerationDialogs } from '../components/moderation/useModerationDialogs';
import { unblock } from '../services/blockStore';
import '../components/moderation/Moderation.css';

function isSafeUrl(url) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}

const PublicProfile = ({ type }) => {
    const { id } = useParams();
    const { t } = useTranslation();
    const { user: currentUser } = useAuth();
    const { theme } = useTheme();
    const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const isMobile = window.innerWidth <= 768;
    const [profile, setProfile] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [showMenu, setShowMenu] = useState(false);
    const [isFollowing, setIsFollowing] = useState(false);
    const [followLoading, setFollowLoading] = useState(false);
    const [nostrProfile, setNostrProfile] = useState(null);
    const [biesFollowers, setBiesFollowers] = useState(0);
    const [biesFollowing, setBiesFollowing] = useState(0);
    const [nostrFollowers, setNostrFollowers] = useState(null);
    const [nostrFollowing, setNostrFollowing] = useState(null);
    const [npubCopied, setNpubCopied] = useState(false);
    const [lnAddrCopied, setLnAddrCopied] = useState(false);
    const [bolt12Copied, setBolt12Copied] = useState(false);
    const [hostedEvents, setHostedEvents] = useState([]); // upcoming events this user hosts
    const [hostedTotal, setHostedTotal] = useState(0); // all-time hosted event count
    const [points, setPoints] = useState(null);
    const lightbox = useLightbox();
    const pointsEnabled = useFeature('points');
    const messagesEnabled = useFeature('messages');
    // Bumped after a block or unblock: the server then answers differently.
    const [reloadKey, setReloadKey] = useState(0);
    const [unblocking, setUnblocking] = useState(false);
    const { openReport, openBlock, dialogs } = useModerationDialogs({
        // Blocking ends any follow between them.
        onBlocked: () => { setIsFollowing(false); setReloadKey((k) => k + 1); },
    });

    useEffect(() => {
        const fetchProfile = async () => {
            setLoading(true);
            try {
                const data = await profilesApi.get(id);
                setProfile(data);
                setError('');
            } catch (err) {
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
                setLoading(false);
            }
        };
        fetchProfile();
    }, [id, currentUser, type, reloadKey]);

    // The URL :id can be a profileId or userId — the follow API needs the userId
    const targetUserId = profile?.user?.id || profile?.userId;

    // Check if current user is following this profile
    useEffect(() => {
        if (!currentUser?.id || !targetUserId || currentUser.id === targetUserId) return;
        profilesApi.getFollowing(currentUser.id, { limit: 100 })
            .then(res => {
                const list = res?.data || res || [];
                setIsFollowing(list.some(u => u.id === targetUserId));
            })
            .catch(() => { });
    }, [currentUser?.id, targetUserId]);

    useEffect(() => {
        if (!profile) return;
        const npub = profile.user?.nostrPubkey
            ? nip19.npubEncode(profile.user.nostrPubkey)
            : profile.nostrNpub;
        if (npub) {
            try {
                const decoded = nip19.decode(npub);
                if (decoded.type === 'npub') {
                    nostrService.getProfile(decoded.data).then(setNostrProfile).catch(() => { });
                    nostrService.getFollowerCount(decoded.data).then(setNostrFollowers).catch(() => { });
                    nostrService.getFollowingCount(decoded.data).then(setNostrFollowing).catch(() => { });
                }
            } catch {
                // Invalid npub — skip
            }
        }
    }, [profile]);

    // Fetch BIES followers/following counts
    useEffect(() => {
        const userId = profile?.user?.id || profile?.userId;
        if (!userId) return;
        profilesApi.getFollowers(userId).then(res => {
            const list = res?.data || res || [];
            setBiesFollowers(list.length);
        }).catch(() => { });
        profilesApi.getFollowing(userId).then(res => {
            const list = res?.data || res || [];
            setBiesFollowing(list.length);
        }).catch(() => { });
    }, [profile?.user?.id, profile?.userId]);

    // Fetch events this user hosts — upcoming for the panel, total for stats
    useEffect(() => {
        if (!targetUserId) return undefined;
        let cancelled = false;
        eventsApi.list({ hostId: targetUserId, upcoming: 'true', limit: 6 })
            .then(res => { if (!cancelled) setHostedEvents(Array.isArray(res?.data) ? res.data : []); })
            .catch(() => { });
        eventsApi.list({ hostId: targetUserId, limit: 1 })
            .then(res => { if (!cancelled) setHostedTotal(res?.pagination?.total || 0); })
            .catch(() => { });
        return () => { cancelled = true; };
    }, [targetUserId]);

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
                    {profile.avatar && <img src={profile.avatar} alt="" />}
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

    const role = profile.user?.role || (type === 'investor' ? 'INVESTOR' : 'BUILDER');
    const projectsTitle = role === 'INVESTOR' ? t('publicProfile.investedIn', 'Invested In') : t('publicProfile.workingOn', 'Working On');
    const isEventHost = profile.user?.role === 'EVENT_HOST' || hostedTotal > 0 || hostedEvents.length > 0;
    const npub = profile.user?.nostrPubkey
        ? nip19.npubEncode(profile.user.nostrPubkey)
        : profile.nostrNpub;

    // Points UI renders only for scored users (and only while the `points`
    // feature is enabled); badge strip is deduped by badgeId
    const hasPoints = pointsEnabled && Boolean(points && (points.lifetimePoints > 0 || (points.badges || []).length > 0));
    const profileBadges = hasPoints ? [...new Map(points.badges.map(b => [b.badgeId, b])).values()] : [];
    const MAX_BADGE_CHIPS = 8;

    return (
        <div className="profile-page">
            {dialogs}
            <div className="container py-8">
                {/* Header Card */}
                <div className="profile-card mb-8" style={{ padding: 0, overflow: 'hidden' }}>
                    {/* Cover Banner */}
                    <div
                        onClick={() => (profile.banner || nostrProfile?.banner) && lightbox.open(profile.banner || nostrProfile?.banner)}
                        style={{
                            position: 'relative',
                            height: '240px',
                            background: (profile.banner || nostrProfile?.banner)
                                ? `url(${profile.banner || nostrProfile?.banner}) center/cover no-repeat`
                                : 'linear-gradient(to right, #0052cc, #0a192f)',
                            cursor: (profile.banner || nostrProfile?.banner) ? 'pointer' : 'default',
                        }}
                    >
                        <Link to={type === 'builder' ? '/builders' : '/investors'} style={{
                            position: 'absolute', top: '24px', left: '24px',
                            borderRadius: '50%', background: 'var(--color-surface-raised)', border: '1px solid var(--color-gray-200)',
                            width: '42px', height: '42px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                            textDecoration: 'none', color: 'var(--color-gray-700)', boxShadow: 'var(--shadow-sm)',
                        }}>
                            <ArrowLeft size={20} />
                        </Link>

                        {/* Action Buttons */}
                        <div style={{ position: 'absolute', bottom: '24px', right: '24px', zIndex: 20, display: 'flex', gap: '1rem' }}>
                            {currentUser && targetUserId && currentUser.id === targetUserId ? (
                                <Link to="/profile/edit" style={{
                                    borderRadius: 'var(--radius-md)', background: 'var(--color-surface-raised)', color: 'var(--color-gray-900)',
                                    border: '1px solid var(--color-gray-200)', height: '42px', padding: '0 24px',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none',
                                    fontWeight: 600, boxShadow: 'var(--shadow-sm)'
                                }}>
                                    {t('publicProfile.editProfile', 'Edit Profile')}
                                </Link>
                            ) : currentUser && targetUserId && currentUser.id !== targetUserId ? (
                                <>
                                    {/* Follow button — icon-only on mobile */}
                                    <button
                                        onClick={async () => {
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
                                        }}
                                        disabled={followLoading}
                                        className={isFollowing ? 'primary-action-btn' : ''}
                                        style={{
                                            borderRadius: 'var(--radius-md)',
                                            background: isFollowing ? 'var(--color-primary)' : 'var(--color-surface-raised)',
                                            color: isFollowing ? 'white' : 'var(--color-gray-900)',
                                            border: isFollowing ? 'none' : '1px solid var(--color-gray-200)',
                                            height: '42px',
                                            padding: isMobile ? '0 14px' : '0 24px',
                                            whiteSpace: 'nowrap', fontWeight: 600,
                                            cursor: followLoading ? 'wait' : 'pointer',
                                            boxShadow: 'var(--shadow-sm)',
                                            opacity: followLoading ? 0.7 : 1,
                                            display: 'flex', alignItems: 'center', gap: '6px',
                                        }}>
                                        {isFollowing ? <UserCheck size={18} /> : <UserPlus size={18} />}
                                        {!isMobile && (followLoading ? t('publicProfile.loading', 'Loading...') : isFollowing ? t('publicProfile.following', 'Following') : t('publicProfile.follow', 'Follow'))}
                                    </button>

                                    {/* Connect button — desktop only; on mobile it moves to ... menu.
                                        Hidden while the `messages` feature is toggled off. */}
                                    {!isMobile && messagesEnabled && (
                                        <Link to="/messages" className="primary-action-btn" style={{
                                            borderRadius: 'var(--radius-md)', background: 'var(--color-primary)', color: 'white',
                                            height: '42px', padding: '0 24px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                            textDecoration: 'none', fontWeight: 600, boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
                                        }}>
                                            {t('publicProfile.connect', 'Connect')}
                                        </Link>
                                    )}
                                </>
                            ) : null}

                            {/* Zap — only on other people's profiles */}
                            {profile.user?.nostrPubkey && currentUser?.id !== targetUserId && (
                                <ZapButton
                                    recipients={[{ pubkey: profile.user.nostrPubkey, name: profile.name, avatar: profile.avatar, lud16: profile.lightningAddress, bolt12Offer: profile.bolt12Offer }]}
                                    size={isMobile ? 'sm' : 'md'}
                                    variant="bitcoin"
                                />
                            )}

                            <div style={{ position: 'relative' }}>
                                <button onClick={() => setShowMenu(!showMenu)} aria-label={t('moderation.menu.more')} aria-expanded={showMenu} style={{
                                    borderRadius: 'var(--radius-md)', background: 'var(--color-surface-raised)', color: 'var(--color-gray-900)',
                                    border: '1px solid var(--color-gray-200)', height: '42px', width: '42px', padding: 0,
                                    display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                                    boxShadow: 'var(--shadow-sm)',
                                }}>
                                    <MoreHorizontal size={20} />
                                </button>
                                {showMenu && (
                                    <div style={{
                                        position: 'absolute', right: 0, marginTop: '0.5rem', width: '12rem',
                                        background: 'var(--color-surface-overlay)', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-lg)',
                                        border: '1px solid var(--color-gray-200)', padding: '0.25rem 0', zIndex: 50,
                                    }}>
                                        {/* Connect option in ... menu on mobile */}
                                        {isMobile && messagesEnabled && currentUser && targetUserId && currentUser.id !== targetUserId && (
                                            <Link to="/messages" onClick={() => setShowMenu(false)} style={{
                                                width: '100%', textAlign: 'left', padding: '0.625rem 1rem',
                                                display: 'flex', alignItems: 'center', gap: '0.75rem', fontSize: '0.875rem',
                                                fontWeight: 500, color: 'var(--color-gray-700)', textDecoration: 'none',
                                            }}>
                                                <MessageSquare size={16} /> {t('publicProfile.connect', 'Connect')}
                                            </Link>
                                        )}
                                        <button onClick={() => setShowMenu(false)} style={{
                                            width: '100%', textAlign: 'left', padding: '0.625rem 1rem',
                                            display: 'flex', alignItems: 'center', gap: '0.75rem', fontSize: '0.875rem',
                                            fontWeight: 500, color: 'var(--color-gray-700)', background: 'none', border: 'none', cursor: 'pointer',
                                        }}>
                                            <Share size={16} /> {t('publicProfile.shareProfile', 'Share Profile')}
                                        </button>
                                        {currentUser && targetUserId && currentUser.id !== targetUserId && (
                                            <>
                                                <button
                                                    onClick={() => {
                                                        setShowMenu(false);
                                                        openReport({ type: 'user', id: targetUserId }, { name: profile.name, blockTarget: { userId: targetUserId } });
                                                    }}
                                                    style={{
                                                        width: '100%', textAlign: 'left', padding: '0.625rem 1rem',
                                                        display: 'flex', alignItems: 'center', gap: '0.75rem', fontSize: '0.875rem',
                                                        fontWeight: 500, color: 'var(--color-gray-700)', background: 'none', border: 'none', cursor: 'pointer',
                                                    }}
                                                >
                                                    <Flag size={16} /> {t('moderation.menu.reportProfile')}
                                                </button>
                                                <button
                                                    onClick={() => {
                                                        setShowMenu(false);
                                                        openBlock({ userId: targetUserId }, { name: profile.name });
                                                    }}
                                                    style={{
                                                        width: '100%', textAlign: 'left', padding: '0.625rem 1rem',
                                                        display: 'flex', alignItems: 'center', gap: '0.75rem', fontSize: '0.875rem',
                                                        fontWeight: 500, color: 'var(--color-danger, #dc2626)', background: 'none', border: 'none', cursor: 'pointer',
                                                    }}
                                                >
                                                    <Ban size={16} /> {t('moderation.menu.blockMember')}
                                                </button>
                                            </>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Profile Info Section */}
                    <div className="pb-8" style={{ paddingLeft: '24px', paddingRight: '24px', position: 'relative', zIndex: 5 }}>
                        {/* Avatar */}
                        <div style={{ marginTop: '-80px', position: 'relative', zIndex: 5 }}>
                            {(profile.avatar || nostrProfile?.picture) ? (
                                <img
                                    src={profile.avatar || nostrProfile?.picture}
                                    alt={profile.name}
                                    onClick={() => lightbox.open(profile.avatar || nostrProfile?.picture)}
                                    style={{
                                        width: '168px', height: '168px', borderRadius: '50%', objectFit: 'cover',
                                        border: '5px solid var(--color-surface)', boxShadow: 'var(--shadow-md)', background: 'var(--color-surface)',
                                        cursor: 'pointer',
                                    }}
                                />
                            ) : (
                                <div style={{
                                    width: '168px', height: '168px', borderRadius: '50%', border: '5px solid var(--color-surface)',
                                    background: 'var(--color-surface-raised)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    fontSize: '3rem', fontWeight: 700, color: 'var(--color-gray-400)',
                                    boxShadow: 'var(--shadow-md)',
                                }}>
                                    {(profile.name || '?').charAt(0).toUpperCase()}
                                </div>
                            )}
                        </div>


                        {/* Name & Title */}
                        <div style={{ marginTop: '16px' }}>
                            <h1 style={{ fontSize: '2rem', fontWeight: 700, fontFamily: 'var(--font-display)', marginBottom: '0.25rem' }}>
                                {profile.name}
                            </h1>
                            {isEventHost && (
                                <span
                                    title={hostedTotal > 0 ? `${hostedTotal} event${hostedTotal === 1 ? '' : 's'} hosted on BIES` : 'Event Host'}
                                    style={{
                                        display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
                                        background: 'var(--color-orange-tint)', color: '#b45309',
                                        border: '1px solid rgba(247,147,26,0.35)',
                                        borderRadius: '999px', padding: '0.25rem 0.75rem',
                                        fontSize: '0.78rem', fontWeight: 700,
                                        marginBottom: '0.5rem', marginRight: '0.5rem',
                                    }}
                                >
                                    <Calendar size={13} /> {t('publicProfile.eventHost', 'Event Host')}
                                    {hostedTotal > 0 && <span style={{ fontWeight: 500 }}>· {hostedTotal} {hostedTotal === 1 ? t('publicProfile.eventHosted', 'event hosted') : t('publicProfile.eventsHosted', 'events hosted')}</span>}
                                </span>
                            )}
                            {npub && (
                                <button
                                    onClick={() => {
                                        navigator.clipboard.writeText(npub);
                                        setNpubCopied(true);
                                        setTimeout(() => setNpubCopied(false), 2000);
                                    }}
                                    style={{
                                        display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
                                        background: 'var(--color-gray-100)', border: '1px solid var(--color-gray-200)',
                                        borderRadius: '999px', padding: '0.3rem 0.75rem', cursor: 'pointer',
                                        fontSize: '0.8rem', color: 'var(--color-gray-500)', fontFamily: 'monospace',
                                        marginBottom: '0.5rem', transition: 'all 0.2s',
                                    }}
                                    title="Click to copy full npub"
                                >
                                    <NostrIcon size={14} style={{ flexShrink: 0 }} />
                                    <span>{npub.substring(0, 16)}...{npub.substring(npub.length - 6)}</span>
                                    {npubCopied ? <Check size={14} style={{ color: '#15803d' }} /> : <Copy size={14} />}
                                </button>
                            )}
                            {(profile.title || profile.company) && (
                                <p style={{ fontSize: '1.25rem', color: 'var(--color-gray-700)', marginBottom: '0.75rem' }}>
                                    {profile.title}{profile.title && profile.company ? ' at ' : ''}
                                    {profile.company && <span style={{ color: 'var(--color-primary)', fontWeight: 600 }}>{profile.company}</span>}
                                </p>
                            )}

                            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '1rem', color: 'var(--color-gray-500)', fontSize: '0.875rem', marginBottom: '1.5rem' }}>
                                {profile.location && (
                                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                        <MapPin size={16} /> {profile.location}
                                    </span>
                                )}
                                {(profile.tags || []).length > 0 && (
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                                        {profile.tags.map((tag, index) => (
                                            <ZappableTag key={index} tag={tag} />
                                        ))}
                                    </div>
                                )}
                            </div>

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
                                        marginBottom: '1.5rem', transition: 'all 0.2s',
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
                                        marginBottom: '1.5rem', transition: 'all 0.2s',
                                    }}
                                    title="Click to copy Bolt12 Offer"
                                >
                                    <Zap size={14} style={{ color: '#8b5cf6', flexShrink: 0 }} />
                                    <span style={{ color: 'var(--color-gray-500)', fontWeight: 600, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.03em' }}>Bolt12</span>
                                    <span style={{ fontFamily: 'monospace', maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{profile.bolt12Offer}</span>
                                    {bolt12Copied ? <Check size={14} style={{ color: '#15803d' }} /> : <Copy size={14} style={{ color: 'var(--color-gray-400)' }} />}
                                </button>
                            )}

                            {/* Follower Stats */}
                            <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap', marginBottom: '1.5rem' }}>
                                {/* BIES stats */}
                                <div style={{ display: 'flex', gap: '1.5rem' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                        <Users size={16} style={{ color: 'var(--color-primary)' }} />
                                        <span style={{ fontWeight: 700, color: 'var(--color-gray-900)', fontFamily: 'var(--font-display)' }}>{biesFollowers}</span>
                                        <span style={{ color: 'var(--color-gray-500)', fontSize: '0.875rem' }}>{t('publicProfile.followers', 'Followers')}</span>
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                        <span style={{ fontWeight: 700, color: 'var(--color-gray-900)', fontFamily: 'var(--font-display)' }}>{biesFollowing}</span>
                                        <span style={{ color: 'var(--color-gray-500)', fontSize: '0.875rem' }}>{t('publicProfile.following', 'Following')}</span>
                                    </div>
                                </div>
                                {/* Nostr stats */}
                                {nostrFollowers !== null && (
                                    <div style={{ display: 'flex', gap: '1.5rem', paddingLeft: '1.5rem', borderLeft: '1px solid var(--color-gray-200)' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                            <NostrIcon size={14} className="text-purple-500" />
                                            <span style={{ fontWeight: 700, color: 'var(--color-gray-900)', fontFamily: 'var(--font-display)' }}>{nostrFollowers}</span>
                                            <span style={{ color: 'var(--color-gray-500)', fontSize: '0.875rem' }}>{t('publicProfile.nostrFollowers', 'Nostr Followers')}</span>
                                        </div>
                                        {nostrFollowing !== null && (
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                                <span style={{ fontWeight: 700, color: 'var(--color-gray-900)', fontFamily: 'var(--font-display)' }}>{nostrFollowing}</span>
                                                <span style={{ color: 'var(--color-gray-500)', fontSize: '0.875rem' }}>{t('publicProfile.following', 'Following')}</span>
                                            </div>
                                        )}
                                    </div>
                                )}
                                {/* Points stats */}
                                {hasPoints && (
                                    <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'center', paddingLeft: '1.5rem', borderLeft: '1px solid var(--color-gray-200)' }} data-testid="profile-points">
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
                            </div>

                            {/* Badge strip */}
                            {profileBadges.length > 0 && (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '1.5rem' }} data-testid="profile-badges">
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

                        {/* About/Bio */}
                        {profile.bio && (
                            <div style={{ paddingTop: '2rem', paddingBottom: '1.5rem', borderTop: '1px solid var(--color-gray-100)' }}>
                                <TranslatableText
                                    title={t('publicProfile.about', 'About')}
                                    titleTag="h3"
                                    titleStyle={{ fontSize: '1.25rem', fontWeight: 700, fontFamily: 'var(--font-display)' }}
                                    text={profile.bio}
                                    style={{ color: 'var(--color-gray-600)', lineHeight: 1.625, fontSize: '1.125rem', maxWidth: '64rem' }}
                                />
                            </div>
                        )}
                    </div>
                </div>

                <div className="profile-grid">
                    {/* Left Column - Main Content */}
                    <div className="profile-main">

                        {/* Experience */}
                        {profile.showExperience !== false && (profile.experience || []).length > 0 && (
                            <div className="profile-card" style={{ marginBottom: '1.5rem' }}>
                                <h3 style={{ fontSize: '1.25rem', fontWeight: 700, fontFamily: 'var(--font-display)', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
                                    <Briefcase size={20} style={{ color: 'var(--color-gray-400)' }} />
                                    {t('publicProfile.experience', 'Experience')}
                                </h3>
                                <div style={{ marginLeft: '10px' }}>
                                    {profile.experience.map((exp, idx) => (
                                        <div key={idx} className="experience-item" style={{ paddingLeft: '1.5rem', borderLeft: '2px solid var(--color-gray-200)', position: 'relative', paddingBottom: '0.5rem', marginBottom: '1.5rem' }}>
                                            <div className="experience-dot"></div>
                                            <h4 style={{ fontWeight: 600, fontSize: '1.125rem', color: 'var(--color-gray-900)', fontFamily: 'var(--font-display)' }}>{exp.title}</h4>
                                            {exp.company && <p style={{ color: 'var(--color-primary)', fontWeight: 500, marginBottom: '0.25rem' }}>{exp.company}</p>}
                                            {exp.date && <p style={{ fontSize: '0.875rem', color: 'var(--color-gray-400)', marginBottom: '0.5rem' }}>{exp.date}</p>}
                                            {exp.description && <p style={{ color: 'var(--color-gray-600)', fontSize: '0.875rem', lineHeight: 1.625 }}>{exp.description}</p>}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Custom Sections (Left / Main) */}
                        {Array.isArray(profile.customSections) && profile.customSections
                            .filter(s => s.placement === 'LEFT' || !s.placement)
                            .map((section, idx) => (
                                <ProfileSection key={`left-${idx}`} section={section} />
                            ))
                        }

                        {/* Nostr Feed */}
                        {(profile.nostrFeedMode || 'combined') !== 'off' && npub && (
                            <NostrFeed npub={npub} mode={profile.nostrFeedMode || 'combined'} />
                        )}
                    </div>

                    {/* Right Column - Side Panels */}
                    <div className="profile-sidebar">

                        {/* Projects Panel */}
                        <div className="profile-card" style={{ marginBottom: '1.5rem', background: 'var(--color-surface-overlay)', border: '1px solid var(--color-gray-200)' }}>
                            <h3 style={{ fontSize: '1.25rem', fontWeight: 700, fontFamily: 'var(--font-display)', marginBottom: '1rem' }}>{projectsTitle}</h3>

                            {(profile.biesProjects || []).length > 0 ? (
                                <div>
                                    {profile.biesProjects.map((proj, idx) => (
                                        <div
                                            key={idx}
                                            style={{
                                                marginBottom: idx !== profile.biesProjects.length - 1 ? '1.5rem' : '0',
                                                position: 'relative',
                                            }}
                                        >
                                            <Link
                                                to={`/project/${proj.id}`}
                                                className="project-link"
                                            >
                                                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', paddingTop: '0.25rem', paddingBottom: '0.25rem' }}>
                                                    <h4 style={{ fontWeight: 600, color: 'var(--color-gray-900)', fontSize: '1.125rem', fontFamily: 'var(--font-display)' }}>{proj.name}</h4>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', fontSize: '0.875rem', marginTop: '0.5rem' }}>
                                                        {proj.role && <span style={{ color: 'var(--color-primary)', fontWeight: 500 }}>{proj.role}</span>}
                                                        {proj.role && proj.status && <span style={{ color: 'var(--color-gray-300)' }}>•</span>}
                                                        {proj.status && <span className="status-badge">{proj.status}</span>}
                                                    </div>
                                                </div>
                                                <div style={{
                                                    width: '120px', height: '68px', minWidth: '120px', minHeight: '68px',
                                                    background: 'var(--color-surface-raised)', borderRadius: '0.5rem', flexShrink: 0,
                                                    display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
                                                    border: '1px solid var(--color-gray-200)',
                                                }}>
                                                    {proj.image ? (
                                                        <img src={proj.image} alt={proj.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                                    ) : (
                                                        <span style={{ color: 'var(--color-gray-400)', fontWeight: 700, fontSize: '1.25rem' }}>{proj.name.charAt(0)}</span>
                                                    )}
                                                </div>
                                            </Link>
                                            <div style={{ position: 'absolute', top: '8px', right: '8px', zIndex: 10 }}>
                                                <ZappableTag tag={proj.name} mode="project" projectId={proj.id} />
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                // Show user's actual projects from the API if available
                                (profile.user?.projects || []).length > 0 ? (
                                    <div>
                                        {profile.user.projects.map((proj, idx) => (
                                            <Link
                                                to={`/project/${proj.id}`}
                                                key={idx}
                                                className="project-link"
                                                style={{ marginBottom: idx !== profile.user.projects.length - 1 ? '1.5rem' : '0' }}
                                            >
                                                <div style={{ flex: 1, minWidth: 0 }}>
                                                    <h4 style={{ fontWeight: 600, color: 'var(--color-gray-900)', fontSize: '1rem', fontFamily: 'var(--font-display)' }}>{proj.title}</h4>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', fontSize: '0.875rem', marginTop: '0.25rem' }}>
                                                        {proj.category && <span style={{ color: 'var(--color-primary)', fontWeight: 500 }}>{proj.category}</span>}
                                                        {proj.stage && <span className="status-badge">{proj.stage}</span>}
                                                    </div>
                                                </div>
                                            </Link>
                                        ))}
                                    </div>
                                ) : (
                                    <p style={{ fontSize: '0.875rem', color: 'var(--color-gray-500)' }}>{t('publicProfile.noProjectsListed', 'No projects listed.')}</p>
                                )
                            )}
                        </div>

                        {/* Events Hosting Panel — the Event Host trust surface */}
                        {(hostedEvents.length > 0 || hostedTotal > 0) && (
                            <div className="profile-card" style={{ marginBottom: '1.5rem' }}>
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
                        <div className="profile-card" style={{ marginBottom: '1.5rem' }}>
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

                        {/* Custom Sections (Right / Sidebar) */}
                        {Array.isArray(profile.customSections) && profile.customSections
                            .filter(s => s.placement === 'RIGHT')
                            .map((section, idx) => (
                                <ProfileSection key={`right-${idx}`} section={section} isSidebar />
                            ))
                        }

                        {/* Links/Socials Panel */}
                        {(profile.website || profile.twitter || profile.linkedin) && (
                            <div className="profile-card" style={{ marginBottom: '1.5rem' }}>
                                <h3 style={{ fontSize: '1.25rem', fontWeight: 700, fontFamily: 'var(--font-display)', marginBottom: '1rem' }}>{t('publicProfile.links', 'Links')}</h3>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                                    {profile.website && isSafeUrl(profile.website) && (
                                        <a href={profile.website} target="_blank" rel="noopener noreferrer" className="social-link">
                                            <Globe size={18} /> {profile.website.replace(/^https?:\/\//, '')}
                                        </a>
                                    )}
                                    {profile.twitter && (
                                        <a href={`https://x.com/${profile.twitter.replace('@', '')}`} target="_blank" rel="noopener noreferrer" className="social-link">
                                            <Twitter size={18} /> {profile.twitter}
                                        </a>
                                    )}
                                    {profile.linkedin && (() => {
                                        const url = profile.linkedin.startsWith('https://') ? profile.linkedin : `https://linkedin.com/in/${encodeURIComponent(profile.linkedin)}`;
                                        return isSafeUrl(url) ? (
                                            <a href={url} target="_blank" rel="noopener noreferrer" className="social-link">
                                                <Linkedin size={18} /> LinkedIn
                                            </a>
                                        ) : null;
                                    })()}
                                </div>
                            </div>
                        )}

                        {/* Nostr Identity Card */}
                        {(npub || nostrProfile) && (
                            <div className="profile-card">
                                <h3 style={{ fontSize: '1.25rem', fontWeight: 700, fontFamily: 'var(--font-display)', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                    <NostrIcon size={20} className="text-purple-500" />
                                    {t('publicProfile.nostrIdentity', 'Nostr Identity')}
                                </h3>
                                {nostrProfile ? (
                                    <div>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
                                            {nostrProfile.picture && (
                                                <img src={nostrProfile.picture} alt="" style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover' }} />
                                            )}
                                            <span style={{ fontWeight: 500, color: 'var(--color-gray-900)' }}>{nostrProfile.name || t('publicProfile.unnamed', 'Unnamed')}</span>
                                        </div>
                                        {nostrProfile.about && (
                                            <p style={{ fontSize: '0.875rem', color: 'var(--color-gray-600)', lineHeight: 1.625, marginBottom: '0.75rem' }}>
                                                {nostrProfile.about.length > 140 ? nostrProfile.about.substring(0, 140) + '...' : nostrProfile.about}
                                            </p>
                                        )}
                                    </div>
                                ) : (
                                    <p style={{ fontSize: '0.875rem', color: 'var(--color-gray-400)' }}>{t('publicProfile.loadingNostrProfile', 'Loading Nostr profile...')}</p>
                                )}
                                {npub && (
                                    <p style={{ fontSize: '0.75rem', color: 'var(--color-gray-400)', fontFamily: 'monospace', marginTop: '0.5rem' }}>
                                        {npub.substring(0, 24)}...
                                    </p>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            <style jsx>{`
                .profile-page {
                    min-height: 100vh;
                    background: var(--color-gray-50);
                    padding-bottom: 4rem;
                }

                .py-8 { padding-top: 2rem; padding-bottom: 2rem; }
                .mb-8 { margin-bottom: 2rem; }
                .pb-8 { padding-bottom: 2rem; }

                .profile-grid {
                    display: grid;
                    grid-template-columns: 1fr;
                    gap: 2rem;
                }
                @media (min-width: 768px) {
                    .profile-grid {
                        grid-template-columns: 2fr 1fr;
                    }
                }

                .profile-card {
                    background: var(--color-surface);
                    padding: 2rem;
                    border-radius: var(--radius-xl);
                    box-shadow: var(--shadow-sm);
                    border: 1px solid var(--color-gray-200);
                }

                .experience-dot {
                    position: absolute;
                    width: 12px;
                    height: 12px;
                    background: var(--color-primary);
                    border-radius: 50%;
                    left: -7px;
                    top: 6px;
                }

                .project-link {
                    text-decoration: none;
                    color: inherit;
                    display: flex;
                    align-items: stretch;
                    justify-content: space-between;
                    gap: 1rem;
                    padding: 1rem;
                    background: var(--color-surface);
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-xl);
                    transition: border-color 0.2s, box-shadow 0.2s;
                }
                .project-link:hover {
                    border-color: var(--color-primary);
                    box-shadow: var(--shadow-sm);
                }

                .status-badge {
                    background: #dcfce7;
                    color: #15803d;
                    padding: 0.25rem 0.5rem;
                    border-radius: 9999px;
                    font-size: 0.75rem;
                }

                .social-link {
                    display: flex;
                    align-items: center;
                    gap: 0.75rem;
                    color: var(--color-gray-600);
                    text-decoration: none;
                    padding: 0.5rem;
                    border-radius: 0.375rem;
                    transition: background 0.2s, color 0.2s;
                }
                .social-link:hover {
                    color: var(--color-primary);
                    background: var(--color-gray-100);
                }

                @keyframes spin { to { transform: rotate(360deg); } }

                @media (max-width: 768px) {
                    .profile-grid { grid-template-columns: 1fr; }
                }
            `}</style>
        </div>
    );
};

export default PublicProfile;
