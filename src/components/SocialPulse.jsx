import { Heart, MessageCircle, Repeat, Share } from 'lucide-react';
import { useNostrFeed } from '../hooks/useNostr';
import InitialAvatar from './InitialAvatar';

const FEATURED_NPUBS = [
    'npub1uaxljreqe2j2hgpnhqac3n22syjn8yg6r3n7kmccvqjkdersn3qs0p6gw', // Nayib Bukele
    'npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m', // Jack Dorsey
    'npub1qe3e5wrvnsgpggtkytxteaqfprz0rgxr8c3l34kk3a9t7e2l3acslezefe', // Bitcoin Beach
];

const MOCK_POSTS = [
    {
        id: '1',
        user: 'Nayib Bukele',
        handle: 'nayibbukele',
        avatar: 'https://image.nostr.build/c33cae20eb6675e3e5618c66050f58095d3923ce3e4b4d727a6f23c12d7c0712.jpg',
        content: 'Bitcoin is the future of El Salvador. We are building the infrastructure for the next generation of finance. #Bitcoin',
        time: '2h',
    },
    {
        id: '2',
        user: 'Jack Dorsey',
        handle: 'jack',
        avatar: 'https://image.nostr.build/5c42d38555627694084da55d9b626d7d59166f212261763784532a67e076632f.jpg',
        content: 'Nostr is a protocol, not a platform. It enables true freedom of speech and censorship resistance. Excited to see what builders in El Salvador are creating.',
        time: '5h',
    },
    {
        id: '3',
        user: 'Bitcoin Beach',
        handle: 'bitcoinbeach',
        avatar: 'https://image.nostr.build/85c81d332616428387034d67352341e33031c5040e322306d1566497f267d359.jpg',
        content: 'The waves are great today in El Zonte! Come visit us and pay for your pupusas with Lightning.',
        time: '1d',
    },
];

const formatTime = (timestamp) => {
    const diff = Math.floor(Date.now() / 1000) - timestamp;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    return `${Math.floor(diff / 86400)}d`;
};

const SocialPulse = () => {
    const { posts: livePosts, loading, profiles } = useNostrFeed(FEATURED_NPUBS);

    // Use live data if available, otherwise fall back to mock data
    const useLive = !loading && livePosts.length > 0;

    const formattedPosts = useLive
        ? livePosts.slice(0, 3).map(post => {
            const profile = profiles[post.pubkey] || {};
            return {
                id: post.id,
                user: profile.display_name || profile.name || post.pubkey.substring(0, 12) + '...',
                handle: profile.name || '',
                avatar: profile.picture || '',
                content: post.content,
                time: formatTime(post.created_at),
            };
        })
        : MOCK_POSTS;

    return (
        <section className="social-pulse py-16">
            <div className="container">
                <div className="section-header text-center mb-12">
                    <h2>Live Social Pulse</h2>
                    <p className="text-gray-500">Real-time updates from the ecosystem via Nostr</p>
                </div>

                {loading ? (
                    <div className="text-center py-10 text-gray-400">Loading Nostr feed...</div>
                ) : (
                    <div className="feed-grid" data-testid="social-pulse-grid">
                        {formattedPosts.map(post => (
                            <div key={post.id} className="tweet-card" data-testid="social-pulse-card">
                                <div className="tweet-header">
                                    <div className="avatar-circle">
                                        {post.avatar ? (
                                            <img src={post.avatar} alt={post.user} className="w-full h-full rounded-full object-cover" />
                                        ) : (
                                            <InitialAvatar name={post.user} />
                                        )}
                                    </div>
                                    <div className="user-info">
                                        <div className="name-row">
                                            <span className="font-bold">{post.user}</span>
                                        </div>
                                        <div className="handle-row">
                                            <span className="text-gray-500 text-sm">{post.time}</span>
                                        </div>
                                    </div>
                                </div>

                                <p className="tweet-content" style={{ whiteSpace: 'pre-wrap' }}>{post.content}</p>

                                <div className="tweet-actions">
                                    <div className="action-item">
                                        <MessageCircle size={16} />
                                    </div>
                                    <div className="action-item">
                                        <Repeat size={16} />
                                    </div>
                                    <div className="action-item">
                                        <Heart size={16} />
                                    </div>
                                    <div className="action-item">
                                        <Share size={16} />
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {!loading && formattedPosts.length === 0 && (
                    <div className="text-center py-10 text-gray-400">No posts found from tracked accounts.</div>
                )}
            </div>

            <style jsx>{`
                .social-pulse {
                    background: var(--color-gray-50);
                    border-top: 1px solid var(--color-gray-200);
                }

                .ml-auto { margin-left: auto; }

                .feed-grid {
                    display: grid;
                    grid-template-columns: repeat(3, 1fr);
                    gap: 1.5rem;
                }

                .tweet-card {
                    background: white;
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-lg);
                    padding: 1.5rem;
                    transition: transform 0.2s;
                }
                .tweet-card:hover { transform: translateY(-3px); box-shadow: var(--shadow-md); }

                .tweet-header {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    margin-bottom: 1rem;
                }

                .avatar-circle {
                    width: 40px;
                    height: 40px;
                    background: var(--color-gray-200);
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-weight: bold;
                    color: var(--color-gray-500);
                    overflow: hidden;
                }

                .verified-badge {
                    color: var(--color-primary);
                    font-size: 0.8rem;
                }

                .tweet-content {
                    font-size: 0.95rem;
                    line-height: 1.5;
                    margin-bottom: 1rem;
                    color: var(--color-neutral-dark);
                    overflow-wrap: break-word;
                }

                .tweet-actions {
                    display: flex;
                    justify-content: space-between;
                    border-top: 1px solid var(--color-gray-100);
                    padding-top: 1rem;
                    color: var(--color-gray-500);
                    font-size: 0.85rem;
                }

                .action-item {
                    display: flex;
                    align-items: center;
                    gap: 5px;
                    cursor: pointer;
                    transition: color 0.2s;
                }
                .action-item:hover { color: var(--color-primary); }

                .text-blue-400 { color: var(--color-primary); }

                @media (max-width: 1024px) {
                    .feed-grid { grid-template-columns: repeat(2, 1fr); }
                }
                @media (max-width: 768px) {
                    .feed-grid { grid-template-columns: 1fr; }
                }
            `}</style>
        </section>
    );
};

export default SocialPulse;
