import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Loader2, User } from 'lucide-react';
import { profilesApi } from '../services/api';
import { useAuth } from '../context/AuthContext';
import FollowIconButton from '../components/FollowIconButton';

/**
 * A member's followers, or who they follow (/members/:userId/followers,
 * /members/:userId/following) — the lists a profile's counts open, as on
 * LinkedIn and Instagram. Each row links to the member and has Follow.
 *
 * @param {'followers'|'following'} kind
 */
const FollowList = ({ kind }) => {
    const { t } = useTranslation();
    const { userId } = useParams();
    const navigate = useNavigate();
    const { user } = useAuth();
    const [people, setPeople] = useState(null); // null while loading
    const [myFollowing, setMyFollowing] = useState(new Set());

    useEffect(() => {
        let cancelled = false;
        setPeople(null);
        const load = kind === 'followers' ? profilesApi.getFollowers : profilesApi.getFollowing;
        load(userId, { limit: 50 })
            .then((res) => { if (!cancelled) setPeople(res?.data || []); })
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

    const title = kind === 'followers' ? t('publicProfile.followers', 'Followers') : t('publicProfile.following', 'Following');

    return (
        <div className="follow-list-page container">
            <div className="follow-list">
                <button type="button" className="follow-back" onClick={() => navigate(-1)}>
                    <ArrowLeft size={18} /> {t('common.back')}
                </button>
                <h1 className="follow-title">{title}</h1>

                {people === null ? (
                    <div className="follow-empty"><Loader2 size={24} style={{ animation: 'spin 1s linear infinite' }} /></div>
                ) : people.length === 0 ? (
                    <p className="follow-empty">
                        {kind === 'followers' ? t('follow.noFollowers', 'No followers yet.') : t('follow.noFollowing', 'Not following anyone yet.')}
                    </p>
                ) : (
                    <ul className="follow-rows">
                        {people.map((p) => (
                            <li key={p.id} className="follow-row">
                                <Link to={`/builder/${p.nostrPubkey}`} className="follow-person">
                                    <span className="follow-avatar">
                                        {p.profile?.avatar ? <img src={p.profile.avatar} alt="" /> : <User size={20} />}
                                    </span>
                                    <span className="follow-text">
                                        <span className="follow-name">{p.profile?.name || t('common.unnamed', 'Unnamed')}</span>
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
                .follow-list-page { padding-top: 1.5rem; padding-bottom: 4rem; }
                .follow-list { max-width: 640px; margin: 0 auto; }
                .follow-back {
                    display: inline-flex; align-items: center; gap: 6px; min-height: 44px;
                    background: none; border: none; padding: 0; cursor: pointer;
                    color: var(--color-gray-600); font-weight: 600; font-size: 0.9rem;
                }
                .follow-title { font-size: 1.5rem; font-weight: 700; margin: 0.25rem 0 1rem; }
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
