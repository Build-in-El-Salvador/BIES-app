import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate } from 'react-router-dom';
import { MapPin, Briefcase, Globe, Twitter, Linkedin, MoreHorizontal, Share, Loader2, ArrowLeft, Pencil, Users, Trophy, Flame, Award } from 'lucide-react';
import { getAssetUrl } from '../utils/assets';
import { nip19 } from 'nostr-tools';
import { useAuth } from '../context/AuthContext';
import { useFeature } from '../context/FeatureFlagsContext';
import { profilesApi, pointsApi } from '../services/api';
import { nostrService } from '../services/nostrService';
import NostrFeed from '../components/NostrFeed';
import NostrIcon from '../components/NostrIcon';
import ZapButton from '../components/ZapButton';
import ZappableTag from '../components/ZappableTag';
import ProfileSection from '../components/ProfileSection';

function isSafeUrl(url) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}

const Profile = () => {
    const { t } = useTranslation();
    const { user } = useAuth();
    const [profile, setProfile] = useState(null);
    const [loading, setLoading] = useState(true);
    const [nostrProfile, setNostrProfile] = useState(null);
    const [biesFollowers, setBiesFollowers] = useState(0);
    const [biesFollowing, setBiesFollowing] = useState(0);
    const [nostrFollowers, setNostrFollowers] = useState(null);
    const [nostrFollowing, setNostrFollowing] = useState(null);
    const [points, setPoints] = useState(null);
    const pointsEnabled = useFeature('points');
    const projectsEnabled = useFeature('projects');
    const eventsEnabled = useFeature('events');

    useEffect(() => {
        loadProfile();
    }, []);

    // Community points card — skipped entirely while the `points` feature is
    // toggled off (refetches if the flag flips back on during the session).
    useEffect(() => {
        if (!pointsEnabled) return;
        pointsApi.me().then(setPoints).catch(() => { });
    }, [pointsEnabled]);

    const loadProfile = async () => {
        try {
            const res = await profilesApi.me();
            setProfile(res.data || res);
        } catch (err) {
            console.error('Failed to load profile:', err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        const pubkey = profile?.nostrPubkey || user?.nostrPubkey;
        if (pubkey) {
            nostrService.getProfile(pubkey).then(setNostrProfile).catch(() => { });
            nostrService.getFollowerCount(pubkey).then(setNostrFollowers).catch(() => { });
            nostrService.getFollowingCount(pubkey).then(setNostrFollowing).catch(() => { });
        }
    }, [profile?.nostrPubkey, user?.nostrPubkey]);

    // Fetch BIES followers/following counts
    useEffect(() => {
        const userId = profile?.user?.id || user?.id;
        if (!userId) return;
        profilesApi.getFollowers(userId).then(res => {
            const list = res?.data || res || [];
            setBiesFollowers(list.length);
        }).catch(() => { });
        profilesApi.getFollowing(userId).then(res => {
            const list = res?.data || res || [];
            setBiesFollowing(list.length);
        }).catch(() => { });
    }, [profile?.user?.id, user?.id]);

    if (loading) {
        return (
            <div className="profile-page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
                <Loader2 size={32} style={{ animation: 'spin 1s linear infinite' }} />
            </div>
        );
    }

    // First-time user with no profile yet — send straight to edit page
    if (!profile || (!profile.name && !profile.bio && !profile.title)) {
        return <Navigate to="/profile/edit" replace />;
    }

    const npub = user?.nostrPubkey ? nip19.npubEncode(user.nostrPubkey) : profile?.nostrNpub;
    const role = user?.role || 'BUILDER';
    const projectsTitle = role === 'INVESTOR' ? 'Invested In' : 'Working On';

    // Progress toward the next level: level N spans 10·N² → 10·(N+1)² lifetime points
    const RARITY_COLORS = { legendary: '#D97706', rare: '#7C3AED', uncommon: '#2563EB', common: '#64748B' };
    let levelProgress = 0;
    if (points) {
        const levelFloor = 10 * points.level * points.level;
        const span = points.nextLevelAt - levelFloor;
        levelProgress = span > 0
            ? Math.max(0, Math.min(100, Math.round(((points.lifetimePoints - levelFloor) / span) * 100)))
            : 0;
    }

    return (
        <div className="profile-page">
            <div className="container py-8">
                {/* Header Card */}
                <div className="profile-card mb-8" style={{ padding: 0, overflow: 'hidden' }}>
                    {/* Cover Banner */}
                    <div className="profile-cover" style={{
                        position: 'relative',
                        background: (profile.banner || nostrProfile?.banner)
                            ? `url(${profile.banner || nostrProfile?.banner}) center/cover no-repeat`
                            : 'linear-gradient(to right, #0052cc, #0a192f)'
                    }}>
                        {/* Action Buttons */}
                        <div style={{ position: 'absolute', bottom: '24px', right: '24px', zIndex: 20, display: 'flex', gap: '1rem' }}>
                            <Link
                                to="/profile/edit"
                                style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '0.5rem',
                                    background: 'var(--color-primary, #0052cc)',
                                    color: 'white',
                                    borderRadius: 'var(--radius-md, 8px)',
                                    height: '44px',
                                    padding: '0 24px',
                                    fontWeight: 700,
                                    fontFamily: 'var(--font-display)',
                                    fontSize: '1rem',
                                    letterSpacing: '0.02em',
                                    textDecoration: 'none',
                                    boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
                                    cursor: 'pointer',
                                }}
                                className="primary-action-btn"
                            >
                                <Pencil size={18} />
                                Edit Profile
                            </Link>
                        </div>
                    </div>

                    {/* Profile Info Section */}
                    <div className="pb-8" style={{ paddingLeft: '24px', paddingRight: '24px', position: 'relative', zIndex: 5 }}>
                        {/* Avatar */}
                        <div className="profile-avatar-wrap" style={{ position: 'relative', zIndex: 5 }}>
                            {(profile.avatar || nostrProfile?.picture) ? (
                                <img src={profile.avatar || nostrProfile?.picture} alt={profile.name} className="shadow-md flex-shrink-0 profile-avatar" style={{ borderRadius: '50%', objectFit: 'cover', border: '5px solid var(--color-surface)', background: 'var(--color-surface-raised)' }} />
                            ) : (
                                <div className="shadow-md flex-shrink-0 flex items-center justify-center profile-avatar" style={{ borderRadius: '50%', border: '5px solid var(--color-surface)', background: 'var(--color-surface-raised)', fontSize: '3rem', fontWeight: 700, color: 'var(--color-gray-400)' }}>
                                    {(profile.name || user?.email || '?').charAt(0).toUpperCase()}
                                </div>
                            )}
                        </div>

                        {/* Name & Title */}
                        <div style={{ marginTop: '16px' }}>
                            <h1 className="h1-title mb-1 profile-name">
                                {profile.name || profile.biesDisplayName || user?.email || 'Unnamed'}
                            </h1>
                            {/* The Nostr key lives in the Nostr Identity card below */}
                            {(profile.title || profile.company) && (
                                <p className="role-text mb-3 text-xl text-gray-600">
                                    {profile.title}{profile.title && profile.company && ' at '}
                                    {profile.company && <span className="text-primary font-semibold">{profile.company}</span>}
                                </p>
                            )}

                            <div className="flex items-center flex-wrap gap-4 text-gray-500 text-sm mb-6">
                                {profile.location && (
                                    <span className="flex items-center gap-2"><MapPin size={16} /> {profile.location}</span>
                                )}
                                {profile.tags && profile.tags.length > 0 && (
                                    <div className="flex flex-wrap gap-2">
                                        {profile.tags.map((tag, index) => (
                                            <ZappableTag key={index} tag={tag} />
                                        ))}
                                    </div>
                                )}
                            </div>

                            {/* Follower Stats */}
                            <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap', marginBottom: '1.5rem' }}>
                                {/* BIES stats */}
                                <div style={{ display: 'flex', gap: '1.5rem' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                        <Users size={16} style={{ color: 'var(--color-primary)' }} />
                                        <span style={{ fontWeight: 700, color: 'var(--color-gray-900)', fontFamily: 'var(--font-display)' }}>{biesFollowers}</span>
                                        <span style={{ color: 'var(--color-gray-500)', fontSize: '0.875rem' }}>Followers</span>
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                        <span style={{ fontWeight: 700, color: 'var(--color-gray-900)', fontFamily: 'var(--font-display)' }}>{biesFollowing}</span>
                                        <span style={{ color: 'var(--color-gray-500)', fontSize: '0.875rem' }}>Following</span>
                                    </div>
                                </div>
                                {/* Nostr stats */}
                                {nostrFollowers !== null && (
                                    <div style={{ display: 'flex', gap: '1.5rem', paddingLeft: '1.5rem', borderLeft: '1px solid var(--color-gray-200)' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                            <NostrIcon size={14} className="text-purple-500" />
                                            <span style={{ fontWeight: 700, color: 'var(--color-gray-900)', fontFamily: 'var(--font-display)' }}>{nostrFollowers}</span>
                                            <span style={{ color: 'var(--color-gray-500)', fontSize: '0.875rem' }}>Nostr Followers</span>
                                        </div>
                                        {nostrFollowing !== null && (
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                                <span style={{ fontWeight: 700, color: 'var(--color-gray-900)', fontFamily: 'var(--font-display)' }}>{nostrFollowing}</span>
                                                <span style={{ color: 'var(--color-gray-500)', fontSize: '0.875rem' }}>Following</span>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* About/Bio */}
                        {profile.bio && (
                            <div className="pt-8 pb-6 border-t border-gray-100">
                                <h3 className="h3-title mb-2">About</h3>
                                <p className="text-gray-600 leading-relaxed max-w-4xl" style={{ fontSize: '1.125rem' }}>
                                    {profile.bio}
                                </p>
                            </div>
                        )}
                    </div>
                </div>

                <div className="profile-grid">
                    {/* Left Column - Main Content */}
                    <div className="profile-main space-y-6">
                        {/* Community Points — hidden while the `points` feature is toggled off */}
                        {pointsEnabled && points && (
                            <div className="profile-card" data-testid="points-card">
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '1.25rem' }}>
                                    <h3 className="h3-title" style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', margin: 0 }}>
                                        <Trophy size={20} style={{ color: 'var(--color-secondary)' }} />
                                        {t('points.profile.title', 'Community Points')}
                                    </h3>
                                    <span style={{
                                        display: 'inline-flex', alignItems: 'center', background: 'var(--color-blue-tint)',
                                        color: 'var(--color-primary)', fontSize: '0.8rem', fontWeight: 600,
                                        padding: '3px 12px', borderRadius: 'var(--radius-full)', whiteSpace: 'nowrap',
                                    }}>
                                        Lv {points.level} · {t(points.titleKey)}
                                    </span>
                                </div>

                                {/* Progress to next level */}
                                <div style={{ marginBottom: '1.25rem' }}>
                                    <div style={{ height: '8px', background: 'var(--color-gray-100)', borderRadius: 'var(--radius-full)', overflow: 'hidden' }}>
                                        <div style={{
                                            height: '100%', width: `${levelProgress}%`, background: 'var(--color-primary)',
                                            borderRadius: 'var(--radius-full)', transition: 'width 0.4s ease',
                                        }} />
                                    </div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.35rem', fontSize: '0.75rem', color: 'var(--color-gray-500)' }}>
                                        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{points.lifetimePoints} pts</span>
                                        <span>{t('points.nextLevel', { points: points.nextLevelAt })}</span>
                                    </div>
                                </div>

                                {/* Totals */}
                                <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap', marginBottom: '1.25rem' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                        <span style={{ fontWeight: 700, color: 'var(--color-gray-900)', fontFamily: 'var(--font-display)', fontVariantNumeric: 'tabular-nums' }}>{points.monthlyPoints}</span>
                                        <span style={{ color: 'var(--color-gray-500)', fontSize: '0.875rem' }}>{t('points.profile.monthly', 'This month')}</span>
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                        <span style={{ fontWeight: 700, color: 'var(--color-gray-900)', fontFamily: 'var(--font-display)', fontVariantNumeric: 'tabular-nums' }}>{points.lifetimePoints}</span>
                                        <span style={{ color: 'var(--color-gray-500)', fontSize: '0.875rem' }}>{t('points.profile.lifetime', 'All-time')}</span>
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                        <Flame size={16} style={{ color: 'var(--color-secondary)' }} />
                                        <span style={{ fontWeight: 700, color: 'var(--color-gray-900)', fontFamily: 'var(--font-display)', fontVariantNumeric: 'tabular-nums' }}>{points.streakDays}</span>
                                        <span style={{ color: 'var(--color-gray-500)', fontSize: '0.875rem' }}>{t('points.profile.streak', 'Day streak')}</span>
                                    </div>
                                </div>

                                {/* Badge gallery */}
                                <div style={{ borderTop: '1px solid var(--color-gray-100)', paddingTop: '1rem' }}>
                                    <h4 style={{
                                        display: 'flex', alignItems: 'center', gap: '0.5rem', margin: '0 0 0.75rem',
                                        fontSize: '0.8rem', fontWeight: 700, textTransform: 'uppercase',
                                        letterSpacing: '0.04em', color: 'var(--color-gray-500)',
                                    }}>
                                        <Award size={15} />
                                        {t('points.profile.badges', 'Badges')}
                                    </h4>
                                    {(points.badges || []).length > 0 ? (
                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }} data-testid="badge-gallery">
                                            {points.badges.map((b) => (
                                                <span
                                                    key={`${b.badgeId}-${b.month || 'permanent'}`}
                                                    title={t(`points.badges.${b.badgeId}.desc`)}
                                                    style={{
                                                        display: 'inline-flex', alignItems: 'center', gap: '6px',
                                                        background: 'var(--color-surface)',
                                                        border: `1px solid ${RARITY_COLORS[b.rarity] || 'var(--color-gray-200)'}`,
                                                        borderRadius: 'var(--radius-full)', padding: '4px 10px 4px 6px',
                                                        fontSize: '0.78rem', fontWeight: 500, color: 'var(--color-gray-700)', cursor: 'default',
                                                    }}
                                                >
                                                    <img src={`/badges/${b.badgeId}.png`} alt="" width="20" height="20" style={{ borderRadius: '50%', flexShrink: 0 }} />
                                                    {t(`points.badges.${b.badgeId}.name`)}
                                                </span>
                                            ))}
                                        </div>
                                    ) : (
                                        <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--color-gray-500)' }}>
                                            {t('points.profile.noBadges', 'No badges yet — post, reply, and react in the feed to earn your first one!')}
                                        </p>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* Experience */}
                        {profile.experience && profile.experience.length > 0 && (
                            <div className="profile-card">
                                <h3 className="h3-title mb-6 flex items-center gap-4">
                                    <Briefcase size={20} style={{ color: 'var(--color-gray-400)' }} />
                                    Experience
                                </h3>
                                <div className="space-y-6" style={{ marginLeft: '10px' }}>
                                    {profile.experience.map((exp, idx) => (
                                        <div key={idx} className="experience-item relative pl-6 border-l-2 border-gray-100 pb-2">
                                            <div className="experience-dot"></div>
                                            <h4 className="font-semibold" style={{ fontSize: '1.125rem', color: 'var(--color-gray-900)' }}>{exp.title}</h4>
                                            <p className="text-primary font-medium mb-1">{exp.company}</p>
                                            <p className="text-sm text-gray-400 mb-2">{exp.date}</p>
                                            {exp.description && <p className="text-gray-600 text-sm leading-relaxed">{exp.description}</p>}
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

                        {/* Nostr Notes Feed */}
                        {npub && (profile?.nostrFeedMode || 'combined') !== 'off' && (
                            <NostrFeed npub={npub} mode={profile?.nostrFeedMode || 'combined'} />
                        )}
                    </div>

                    {/* Right Column - Side Panels */}
                    <div className="profile-sidebar space-y-6">
                        {/* Projects Panel */}
                        {projectsEnabled && (
                            <div className="profile-card bg-gray-50 border border-gray-200">
                                <h3 className="h3-title mb-4">{projectsTitle}</h3>
                                {profile.biesProjects && profile.biesProjects.length > 0 ? (
                                    <div>
                                        {profile.biesProjects.map((proj, idx) => (
                                            <div
                                                key={idx}
                                                style={{
                                                    marginBottom: idx !== profile.biesProjects.length - 1 ? '24px' : '0',
                                                    position: 'relative',
                                                }}
                                            >
                                                <Link
                                                    to={`/project/${proj.id}`}
                                                    className="project-link flex items-stretch justify-between gap-4 p-4 border rounded-xl transition-all hover:border-primary"
                                                    style={{
                                                        background: 'var(--color-surface)',
                                                        borderColor: 'var(--color-gray-200)',
                                                    }}
                                                >
                                                    <div className="flex-1 min-w-0 flex flex-col justify-between py-1">
                                                        <div className="flex items-center gap-2">
                                                            <h4 className="font-semibold text-gray-900 text-lg truncate">{proj.name}</h4>
                                                        </div>
                                                        <div className="flex items-center gap-3 text-sm mt-2">
                                                            <span className="text-primary font-medium truncate">{proj.role}</span>
                                                            <span className="text-gray-300">•</span>
                                                            <span className="status-badge flex-shrink-0">{proj.status}</span>
                                                        </div>
                                                    </div>
                                                    <div className="rounded-lg flex-shrink-0 flex items-center justify-center overflow-hidden border border-gray-200" style={{ width: '120px', height: '68px', minWidth: '120px', minHeight: '68px', background: 'var(--color-surface-raised)' }}>
                                                        {proj.image ? (
                                                            <img src={proj.image} alt={proj.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                                        ) : (
                                                            <span className="text-gray-400 font-bold text-xl">{proj.name.charAt(0)}</span>
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
                                    <p className="text-sm text-gray-500">No active network projects listed.</p>
                                )}
                            </div>
                        )}

                        {/* Events Attending Panel */}
                        {eventsEnabled && (
                            <div className="profile-card">
                                <h3 className="h3-title mb-4">Events Attending</h3>
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
                                                        <span style={{ padding: '0.15rem 0.5rem', borderRadius: '999px', fontSize: '0.75rem', fontWeight: 600, background: rsvp.status === 'GOING' ? 'var(--color-green-tint)' : 'var(--color-amber-tint)', color: rsvp.status === 'GOING' ? '#15803d' : '#854d0e' }}>
                                                            {rsvp.status === 'GOING' ? 'Attending' : 'Interested'}
                                                        </span>
                                                    </div>
                                                </div>
                                            </Link>
                                        ))}
                                    </div>
                                ) : (
                                    <p style={{ fontSize: '0.875rem', color: 'var(--color-gray-500)' }}>Not RSVP'd to any upcoming events.</p>
                                )}
                            </div>
                        )}

                        {/* Custom Sections (Right / Sidebar) */}
                        {Array.isArray(profile.customSections) && profile.customSections
                            .filter(s => s.placement === 'RIGHT')
                            .map((section, idx) => (
                                <ProfileSection key={`right-${idx}`} section={section} isSidebar />
                            ))
                        }

                        {/* Links Panel */}
                        {(profile.website || profile.twitter || profile.linkedin) && (
                            <div className="profile-card">
                                <h3 className="h3-title mb-4">Links</h3>
                                <div className="flex flex-col gap-3">
                                    {profile.website && isSafeUrl(profile.website) && (
                                        <a href={profile.website} target="_blank" rel="noopener noreferrer" className="social-link">
                                            <Globe size={18} /> {profile.website.replace(/^https?:\/\//, '')}
                                        </a>
                                    )}
                                    {profile.twitter && (
                                        <a href={`https://x.com/${profile.twitter.replace('@', '')}`} target="_blank" rel="noopener noreferrer" className="social-link">
                                            <Twitter size={18} /> @{profile.twitter.replace('@', '')}
                                        </a >
                                    )}
                                    {
                                        profile.linkedin && isSafeUrl(profile.linkedin) && (
                                            <a href={profile.linkedin} target="_blank" rel="noopener noreferrer" className="social-link">
                                                <Linkedin size={18} /> LinkedIn Profile
                                            </a>
                                        )
                                    }
                                </div >
                            </div >
                        )}

                        {/* Nostr Identity Card */}
                        {
                            (npub || nostrProfile) && (
                                <div className="profile-card">
                                    <h3 className="h3-title mb-4" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                        <NostrIcon size={20} className="text-purple-500" />
                                        Nostr Identity
                                    </h3>
                                    {nostrProfile ? (
                                        <div>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
                                                {nostrProfile.picture && (
                                                    <img src={nostrProfile.picture} alt="" style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover' }} />
                                                )}
                                                <span className="font-medium text-gray-900">{nostrProfile.name || 'Unnamed'}</span>
                                            </div>
                                            {nostrProfile.about && (
                                                <p className="text-sm text-gray-600 leading-relaxed" style={{ marginBottom: '0.75rem' }}>
                                                    {nostrProfile.about.length > 140
                                                        ? nostrProfile.about.substring(0, 140) + '...'
                                                        : nostrProfile.about}
                                                </p>
                                            )}
                                        </div>
                                    ) : (
                                        <p className="text-sm text-gray-400">Loading Nostr profile...</p>
                                    )}
                                    {npub && (
                                        <p className="text-xs text-gray-400" style={{ fontFamily: 'monospace', marginTop: '0.5rem' }}>
                                            {npub.substring(0, 24)}...
                                        </p>
                                    )}
                                </div>
                            )
                        }
                    </div >
                </div >
            </div >

            <style jsx>{`
        /* Compact header on phones (as Instagram/LinkedIn): the cover and
           avatar don't take the whole first screen */
        .profile-cover { height: 240px; }
        .profile-avatar-wrap { margin-top: -80px; }
        .profile-avatar { width: 168px; height: 168px; }
        .profile-name { font-size: 2rem; }
        @media (max-width: 768px) {
            .profile-cover { height: 140px; }
            .profile-avatar-wrap { margin-top: -48px; }
            .profile-avatar { width: 96px; height: 96px; font-size: 2rem !important; border-width: 4px !important; }
            .profile-name { font-size: 1.5rem; }
        }

                .profile-page {
                    min-height: 100vh;
                    background: var(--color-gray-50);
                    padding-bottom: 4rem;
                }

                .py-8 { padding-top: 2rem; padding-bottom: 2rem; }
                .mb-8 { margin-bottom: 2rem; }
                .mb-6 { margin-bottom: 1.5rem; }
                .mb-4 { margin-bottom: 1rem; }
                .mb-3 { margin-bottom: 0.75rem; }
                .mb-2 { margin-bottom: 0.5rem; }
                .mb-1 { margin-bottom: 0.25rem; }
                .pb-6 { padding-bottom: 1.5rem; }
                .pt-8 { padding-top: 2rem; }

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

                .bg-gray-50 { background-color: var(--color-surface-overlay); }

                .h1-title { font-size: 1.875rem; line-height: 2.25rem; font-weight: 700; font-family: var(--font-display); margin-bottom: 0.25rem; }
                .h3-title { font-size: 1.25rem; font-weight: 700; font-family: var(--font-display); }
                .role-text { font-size: 1.25rem; color: var(--color-gray-700); }
                .text-gray-400 { color: var(--color-gray-400); }
                .text-gray-500 { color: var(--color-gray-500); }
                .text-gray-600 { color: var(--color-gray-600); }
                .text-gray-700 { color: var(--color-gray-700); }
                .text-gray-900 { color: var(--color-gray-900); }
                .text-sm { font-size: 0.875rem; }
                .text-xs { font-size: 0.75rem; }
                .font-semibold { font-weight: 600; font-family: var(--font-display); }
                .font-medium { font-weight: 500; }
                .font-bold { font-weight: 700; font-family: var(--font-display); }
                .leading-relaxed { line-height: 1.625; }

                .space-y-6 > * + * { margin-top: 1.5rem; }
                .flex-wrap { flex-wrap: wrap; }
                .gap-4 { gap: 1rem; }

                .experience-item {
                    padding-left: 1.5rem;
                    border-left: 2px solid var(--color-gray-200);
                    position: relative;
                    padding-bottom: 0.5rem;
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

                .project-link { text-decoration: none; color: inherit; display: block; }
                .project-link:hover { border-color: var(--color-primary); box-shadow: var(--shadow-sm); }

                .status-badge {
                    background: var(--color-green-tint);
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

                @media (max-width: 768px) {
                    .flex.justify-between { flex-direction: column; align-items: flex-start; gap: 1rem; }
                }

                @keyframes spin {
                    to { transform: rotate(360deg); }
                }
            `}</style>
        </div >
    );
};

export default Profile;
