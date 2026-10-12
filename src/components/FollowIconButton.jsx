import React, { useState } from 'react';
import { UserPlus, UserCheck, Loader2 } from 'lucide-react';
import { profilesApi } from '../services/api';

/**
 * A reusable icon-only follow button for profiles.
 * 
 * @param {Object} props
 * @param {string} props.targetUserId - The ID of the user to follow/unfollow
 * @param {boolean} props.isFollowing - Current follow status
 * @param {function} props.onToggle - Callback when follow status changes (optimistic)
 * @param {'sm' | 'md'} [props.size='sm'] - Button size
 */
const FollowIconButton = ({ targetUserId, isFollowing: initiallyFollowing, onToggle, size = 'sm' }) => {
    const [following, setFollowing] = useState(initiallyFollowing);
    const [loading, setLoading] = useState(false);

    // Sync state if prop changes
    React.useEffect(() => {
        setFollowing(initiallyFollowing);
    }, [initiallyFollowing]);

    const handleToggleFollow = async (e) => {
        e.preventDefault();
        e.stopPropagation();

        if (loading) return;

        const originalState = following;
        setFollowing(!originalState);
        if (onToggle) onToggle(!originalState);
        setLoading(true);

        try {
            if (originalState) {
                await profilesApi.unfollow(targetUserId);
            } else {
                await profilesApi.follow(targetUserId);
            }
        } catch (err) {
            // Revert on error
            setFollowing(originalState);
            if (onToggle) onToggle(originalState);
            if (err?.status !== 409) { // 409 means already following, so we don't alert
                console.error('Follow error:', err);
            }
        } finally {
            setLoading(false);
        }
    };

    const iconSize = size === 'sm' ? 18 : 20;

    return (
        <button
            className={`icon-btn follow-btn ${following ? 'following' : ''}`}
            onClick={handleToggleFollow}
            disabled={loading}
            title={following ? 'Unfollow' : 'Follow'}
        >
            {loading ? (
                <Loader2 size={iconSize} style={{ animation: 'spin 1s linear infinite' }} />
            ) : following ? (
                <UserCheck size={iconSize} />
            ) : (
                <UserPlus size={iconSize} />
            )}

            <style jsx>{`
                .icon-btn {
                    width: 44px;
                    height: 44px;
                    border-radius: 8px;
                    border: 1px solid var(--color-gray-200);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: var(--color-gray-400);
                    background: transparent;
                    transition: all 0.2s;
                    flex-shrink: 0;
                    cursor: pointer;
                }
                .icon-btn:hover {
                    border-color: var(--color-primary);
                    color: var(--color-primary);
                    background: rgba(0, 82, 204, 0.04);
                }
                .icon-btn.following {
                    color: var(--color-primary);
                    border-color: var(--color-primary);
                    background: rgba(0, 82, 204, 0.08);
                }
                .icon-btn:disabled {
                    opacity: 0.7;
                    cursor: wait;
                }
                @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
            `}</style>
        </button>
    );
};

export default FollowIconButton;
