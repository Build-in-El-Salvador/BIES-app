import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Loader2, User } from 'lucide-react';
import { profilesApi } from '../services/api';
import { useAuth } from '../context/AuthContext';
import FollowIconButton from '../components/FollowIconButton';
import { isPlaceholderName } from '../utils/profileComplete';
import BackButton from '../components/BackButton';
import { getAssetUrl } from '../utils/assets';

/**
 * A member's followers, who they follow, or their whole network (both,
 * people who follow each other first) — /members/:userId/followers,
 * /following and /network: the lists a profile's counts and its Network
 * "See all" open, as on Facebook and Instagram. Each row links to the
 * member and has Follow.
 *
 * @param {'followers'|'following'|'network'} kind
 */
const FollowList = ({ kind }) => {
    const { t } = useTranslation();
    const { userId } = useParams();
    const { user } = useAuth();
    const [people, setPeople] = useState(null); // null while loading
    const [hidden, setHidden] = useState(false); // kept to themselves (Settings → Privacy)
    const [myFollowing, setMyFollowing] = useState(new Set());

    useEffect(() => {
        let cancelled = false;
        setPeople(null);
        setHidden(false);
        const load = kind === 'network'
            ? Promise.all([profilesApi.getFollowing(userId, { limit: 100 }), profilesApi.getFollowers(userId, { limit: 100 })])
                .then(([out, inc]) => {
                    if (out?.hidden || inc?.hidden) return { data: [], hidden: true };
                    const followerIds = new Set((inc?.data || []).map((p) => p.id));
                    const people = new Map();
                    for (const p of out?.data || []) people.set(p.id, { ...p, mutual: followerIds.has(p.id) });
                    for (const p of inc?.data || []) if (!people.has(p.id)) people.set(p.id, p);
                    return { data: [...people.values()].sort((a, b) => Number(!!b.mutual) - Number(!!a.mutual)) };
                })
            : (kind === 'followers' ? profilesApi.getFollowers : profilesApi.getFollowing)(userId, { limit: 50 });
        load
            .then((res) => { if (!cancelled) { setPeople(res?.data || []); setHidden(!!res?.hidden); } })
            .catch(() => { if (!cancelled) setPeople([]); });
        return () => { cancelled = true; };
    }, [kind, userId]);

    // Whom the viewer follows, for the Follow / Following buttons.
    useEffect(() => {
        if (!user?.id) return;
        profilesApi.getFollowing(user.id, { limit: 50 })
            .then((res) => setMyFollowing(new Set((res?.data || []).map((p) => p.id))))
            .catch(() => {});
    }, [user?.id]);

    const title = kind === 'network' ? t('profileView.network')
        : kind === 'followers' ? t('publicProfile.followers', 'Followers') : t('publicProfile.following', 'Following');

    return (
        <div className="follow-list-page container">
            <div className="follow-list">
                <div className="back-head">
                    <BackButton fallback={userId ? `/builder/${userId}` : '/members'} />
                    <h1 className="follow-title">{title}</h1>
                </div>

                {people === null ? (
                    <div className="follow-empty"><Loader2 size={24} style={{ animation: 'spin 1s linear infinite' }} /></div>
                ) : people.length === 0 ? (
                    <p className="follow-empty">
                        {hidden ? t('profileView.networkPrivateList')
                            : kind === 'network' ? t('profileView.networkEmpty')
                            : kind === 'followers' ? t('follow.noFollowers', 'No followers yet.') : t('follow.noFollowing', 'Not following anyone yet.')}
                    </p>
                ) : (
                    <ul className="follow-rows">
                        {people.map((p) => (
                            <li key={p.id} className="follow-row">
                                <Link to={`/builder/${p.nostrPubkey}`} className="follow-person">
                                    <span className="follow-avatar">
                                        {p.profile?.avatar ? <img src={getAssetUrl(p.profile.avatar)} alt="" /> : <User size={20} />}
                                    </span>
                                    <span className="follow-text">
                                        <span className="follow-name">{isPlaceholderName(p.profile?.name) ? t('profileView.newMember') : p.profile.name}</span>
                                        {(p.profile?.company || p.profile?.bio) && (
                                            <span className="follow-sub">{p.profile.company || p.profile.bio}</span>
                                        )}
                                    </span>
                                </Link>
                                {user?.id && p.id !== user.id && (
                                    <FollowIconButton
                                        targetUserId={p.id}
                                        isFollowing={myFollowing.has(p.id)}
                                        onToggle={(now) => setMyFollowing((prev) => {
                                            const next = new Set(prev);
                                            if (now) next.add(p.id); else next.delete(p.id);
                                            return next;
                                        })}
                                    />
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            <style jsx>{`
                .follow-list-page { padding-top: var(--page-top, 1.5rem); padding-bottom: 4rem; }
                .follow-list { max-width: 640px; margin: 0 auto; }
                .back-head { margin: 0.25rem 0 1rem; }
                .follow-title { font-size: 1.5rem; font-weight: 700; margin: 0; }
                .follow-empty { text-align: center; padding: 3rem 1rem; color: var(--color-gray-500); display: flex; justify-content: center; }
                .follow-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
                .follow-row {
                    display: flex; align-items: center; gap: 12px; padding: 10px 12px;
                    background: var(--color-surface); border: 1px solid var(--color-gray-200); border-radius: var(--radius-lg);
                }
                .follow-row :global(.follow-person) {
                    flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px;
                    text-decoration: none; color: inherit;
                }
                .follow-avatar {
                    width: 44px; height: 44px; border-radius: 50%; flex-shrink: 0; overflow: hidden;
                    display: flex; align-items: center; justify-content: center;
                    background: var(--color-gray-100); color: var(--color-gray-400);
                }
                .follow-avatar img { width: 100%; height: 100%; object-fit: cover; }
                .follow-text { min-width: 0; display: flex; flex-direction: column; }
                .follow-name { font-weight: 700; }
                .follow-sub {
                    font-size: 0.82rem; color: var(--color-gray-500);
                    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
                }
            `}</style>
        </div>
    );
};

export default FollowList;
