import React, { useState } from 'react';
import { UserPlus, UserCheck, Loader2 } from 'lucide-react';
import { profilesApi } from '../services/api';

/**
 * A follow button for profiles: icon and label, "Follow" / "Following"
 * (as LinkedIn labels it), so it can't be mistaken for "add contact".
 * 
 * @param {Object} props
 * @param {string} props.targetUserId - The ID of the user to follow/unfollow
 * @param {boolean} props.isFollowing - Current follow status
 * @param {function} props.onToggle - Callback when follow status changes (optimistic)
 * @param {'sm' | 'md'} [props.size='sm'] - Button size
 * @param {'outline' | 'filled'} [props.variant='outline'] - filled: solid
 *   blue until followed, as "Follow" is on Instagram and Facebook cards
 */
const FollowIconButton = ({ targetUserId, isFollowing: initiallyFollowing, onToggle, size = 'sm', variant = 'outline' }) => {
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
            className={`icon-btn follow-btn ${variant === 'filled' ? 'filled' : ''} ${following ? 'following' : ''}`}
            onClick={handleToggleFollow}
            disabled={loading}
            title={following ? 'Unfollow' : 'Follow'}
            aria-pressed={following}
        >
            {loading ? (
                <Loader2 size={iconSize} style={{ animation: 'spin 1s linear infinite' }} />
            ) : following ? (
                <UserCheck size={iconSize} />
            ) : (
                <UserPlus size={iconSize} />
            )}
            <span className="follow-label">{following ? 'Following' : 'Follow'}</span>

            <style jsx>{`
                .icon-btn {
                    min-width: 44px;
                    height: 44px;
                    padding: 0 12px;
                    gap: 6px;
                    border-radius: 22px;
                    font-size: 0.85rem;
                    font-weight: 700;
                    white-space: nowrap;
                    border: 1px solid var(--color-gray-200);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: var(--color-primary);
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
                .icon-btn.filled:not(.following) {
                    color: white;
                    border-color: var(--color-primary);
                    background: var(--color-primary);
                }
                .icon-btn.filled:not(.following):hover {
                    border-color: var(--color-primary-dark);
                    background: var(--color-primary-dark);
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
