import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate } from 'react-router-dom';
import { Loader2, Pencil, Trophy, Flame, Award } from 'lucide-react';
import { getAssetUrl } from '../utils/assets';
import { useAuth } from '../context/AuthContext';
import { useFeature } from '../context/FeatureFlagsContext';
import { profilesApi, pointsApi } from '../services/api';
import { nostrService } from '../services/nostrService';
import ProfileView from '../components/profile/ProfileView';

/** Your own profile (/profile): the shared Facebook-style layout, with Edit. */
const Profile = () => {
    const { t } = useTranslation();
    const { user } = useAuth();
    const [profile, setProfile] = useState(null);
    const [loading, setLoading] = useState(true);
    const [nostrProfile, setNostrProfile] = useState(null);
    const [points, setPoints] = useState(null);
    const pointsEnabled = useFeature('points');
    const eventsEnabled = useFeature('events');

    useEffect(() => {
        profilesApi.me()
            .then((res) => setProfile(res.data || res))
            .catch((err) => console.error('Failed to load profile:', err))
            .finally(() => setLoading(false));
    }, []);

    // Community points card — skipped entirely while the `points` feature is
    // toggled off (refetches if the flag flips back on during the session).
    useEffect(() => {
        if (!pointsEnabled) return;
        pointsApi.me().then(setPoints).catch(() => { });
    }, [pointsEnabled]);

    // Their Nostr photo and cover, where BIES has none.
    useEffect(() => {
        const pubkey = profile?.nostrPubkey || user?.nostrPubkey;
        if (pubkey) nostrService.getProfile(pubkey).then(setNostrProfile).catch(() => { });
    }, [profile?.nostrPubkey, user?.nostrPubkey]);

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
            <ProfileView
                profile={{ ...profile, user: profile.user || { id: user?.id, nostrPubkey: user?.nostrPubkey } }}
                nostrProfile={nostrProfile}
                isOwn
                actions={
                    <Link to="/profile/edit" className="pv-btn">
                        <Pencil size={18} /> {t('profileView.editProfile')}
                    </Link>
                }
            >
            {/* Community Points — hidden while the `points` feature is toggled off */}
            {pointsEnabled && points && (
                <div data-testid="points-card">
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '1.25rem' }}>
                        <h3 className="panel-title" style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', margin: 0 }}>
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


            {/* Events Attending Panel */}
            {eventsEnabled && (
                <div>
                    <h3 className="panel-title">{t('publicProfile.eventsAttending', 'Events Attending')}</h3>
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

            </ProfileView>

            <style jsx>{`
                .profile-page {
                    min-height: 100vh;
                    background: var(--color-gray-50);
                }
                .panel-title { margin: 0 0 12px; font-size: 1.15rem; font-weight: 700; color: var(--color-gray-900); }
            `}</style>
        </div>
    );
};

export default Profile;
