import { useState, useEffect } from 'react';
import { Loader2, Heart, Repeat, MessageCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const XIcon = ({ size = 12, style }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={style}>
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
);

import { newsApi } from '../services/api';

const stripHtml = (html) => {
    if (!html) return '';
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return doc.body.textContent || '';
};

const News = () => {
    const [tweets, setTweets] = useState([]);
    const [tweetsLoading, setTweetsLoading] = useState(true);

    const [liveNews, setLiveNews] = useState([]);
    const [liveNewsLoading, setLiveNewsLoading] = useState(true);
    const [newsKeyword, setNewsKeyword] = useState('');

    const [mobileTab, setMobileTab] = useState('news'); // 'news' | 'twitter'

    // Fetch Twitter/X feed
    useEffect(() => {
        newsApi.twitterFeed()
            .then(res => setTweets(res?.data || []))
            .catch(() => setTweets([]))
            .finally(() => setTweetsLoading(false));
    }, []);

    // Fetch live news from gnews.io + RSS (El Salvador)
    useEffect(() => {
        setLiveNewsLoading(true);
        newsApi.liveFeed(newsKeyword)
            .then(res => setLiveNews(res?.data || []))
            .catch(() => setLiveNews([]))
            .finally(() => setLiveNewsLoading(false));
    }, [newsKeyword]);

    const timeAgo = (dateStr) => {
        if (!dateStr) return '';
        try {
            const diff = Date.now() - new Date(dateStr).getTime();
            const mins = Math.floor(diff / 60000);
            if (mins < 60) return `${mins}m`;
            const hrs = Math.floor(mins / 60);
            if (hrs < 24) return `${hrs}h`;
            const days = Math.floor(hrs / 24);
            return `${days}d`;
        } catch { return ''; }
    };

    return (
        <div className="news-page container py-8">

            {/* Mobile-only tabs */}
            <div className="mobile-feed-tabs">
                <button
                    className={`feed-tab ${mobileTab === 'news' ? 'active' : ''}`}
                    onClick={() => setMobileTab('news')}
                >
                    El Salvador News
                </button>
                <button
                    className={`feed-tab ${mobileTab === 'twitter' ? 'active' : ''}`}
                    onClick={() => setMobileTab('twitter')}
                >
                    X / Twitter
                </button>
            </div>

            <div className="grid news-layout">

                {/* Left/Main Column: El Salvador News */}
                <main className={`news-col main-col ${mobileTab !== 'news' ? 'mobile-hidden' : ''}`}>
                    <div className="col-header page-header">
                        <h3>El Salvador News</h3>
                        {liveNews.length > 0 && <span className="live-badge">LIVE</span>}
                    </div>
                    <div style={{ marginBottom: '1rem' }}>
                        <input
                            type="text"
                            placeholder="Filter news..."
                            value={newsKeyword}
                            onChange={(e) => setNewsKeyword(e.target.value)}
                            style={{
                                width: '100%',
                                padding: '0.5rem',
                                border: '1px solid var(--color-border)',
                                borderRadius: 'var(--radius-md)',
                                fontSize: '0.9rem',
                            }}
                        />
                    </div>

                    {liveNewsLoading ? (
                        <div style={{ textAlign: 'center', padding: '3rem' }}>
                            <Loader2 size={32} style={{ animation: 'spin 1s linear infinite', margin: '0 auto' }} />
                        </div>
                    ) : liveNews.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--color-gray-500)' }}>
                            No El Salvador news found.
                        </div>
                    ) : (
                        liveNews.slice(0, 15).map((article, i) => (
                            <a
                                key={article.id}
                                href={article.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="news-item-link"
                            >
                                <div className={`news-item ${i === 0 ? 'featured' : ''}`}>
                                    {i === 0 && article.image && (
                                        <div className="news-img" style={{ backgroundImage: `url(${article.image})`, backgroundSize: 'cover', backgroundPosition: 'center' }}></div>
                                    )}
                                    <div className="news-content">
                                        <span className="tag">{article.source}</span>
                                        {i === 0 ? (
                                            <>
                                                <h2>{article.title}</h2>
                                                <p className="excerpt">{stripHtml(article.description)?.slice(0, 200)}{stripHtml(article.description)?.length > 200 ? '...' : ''}</p>
                                                <span className="date">{timeAgo(article.publishedAt)}</span>
                                            </>
                                        ) : (
                                            <>
                                                <h3>{article.title}</h3>
                                                <p className="excerpt">{stripHtml(article.description)?.slice(0, 120)}{stripHtml(article.description)?.length > 120 ? '...' : ''}</p>
                                                <span className="date">{timeAgo(article.publishedAt)}</span>
                                            </>
                                        )}
                                    </div>
                                </div>
                            </a>
                        ))
                    )}
                </main>

                {/* Right Column: X/Twitter Feed */}
                <aside className={`news-col sidebar-col ${mobileTab !== 'twitter' ? 'mobile-hidden' : ''}`}>
                    <div className="col-header">
                        <h3>X / Twitter</h3>
                        {tweets.length > 0 && <span className="live-badge">LIVE</span>}
                    </div>
                    <div className="social-feed">
                        {tweetsLoading ? (
                            <div style={{ textAlign: 'center', padding: '2rem' }}>
                                <Loader2 size={24} style={{ animation: 'spin 1s linear infinite', margin: '0 auto' }} />
                            </div>
                        ) : tweets.length === 0 ? (
                            <p className="empty-text">No X/Twitter accounts configured.</p>
                        ) : (
                            tweets.slice(0, 10).map(tweet => (
                                <a
                                    key={tweet.id}
                                    href={`https://x.com/${tweet.authorHandle}/status/${tweet.id}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="tweet-card-link"
                                >
                                    <div className="tweet-card">
                                        <div className="tweet-header">
                                            <div className="avatar">
                                                {tweet.authorAvatar ? (
                                                    <img src={tweet.authorAvatar} alt="" style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }} />
                                                ) : (
                                                    (tweet.authorName || 'X')[0].toUpperCase()
                                                )}
                                            </div>
                                            <div className="u-info">
                                                <span className="u-name">{tweet.authorName}</span>
                                                <XIcon size={12} style={{ color: '#1d9bf0', marginLeft: 4 }} />
                                            </div>
                                            <span className="tweet-time">{timeAgo(tweet.createdAt)}</span>
                                        </div>
                                        <p>{tweet.text?.slice(0, 280)}{tweet.text?.length > 280 ? '...' : ''}</p>
                                        {tweet.images?.length > 0 && (
                                            <div className="tweet-media">
                                                {tweet.images.slice(0, 4).map((img, i) => (
                                                    <img key={i} src={img} alt="" className="tweet-thumb" />
                                                ))}
                                            </div>
                                        )}
                                        {tweet.videos?.length > 0 && !tweet.images?.length && (
                                            <div className="tweet-media">
                                                <video src={tweet.videos[0]} muted loop playsInline className="tweet-thumb tweet-video" onMouseOver={e => e.target.play()} onMouseOut={e => { e.target.pause(); e.target.currentTime = 0; }} />
                                            </div>
                                        )}
                                        <div className="tweet-metrics">
                                            <span><MessageCircle size={12} /> {tweet.metrics?.replies || 0}</span>
                                            <span><Repeat size={12} /> {tweet.metrics?.retweets || 0}</span>
                                            <span><Heart size={12} /> {tweet.metrics?.likes || 0}</span>
                                        </div>
                                    </div>
                                </a>
                            ))
                        )}
                    </div>
                </aside>

            </div>

            <style jsx>{`
        .py-8 { padding-top: var(--page-top, 2rem); padding-bottom: 2rem; }

        .news-layout {
          display: grid;
          grid-template-columns: 1fr 300px;
          gap: 2rem;
        }

        .col-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 1.5rem;
          border-bottom: 2px solid var(--color-neutral-dark);
          padding-bottom: 0.5rem;
        }

        .col-header h3 { font-size: 1.1rem; text-transform: uppercase; letter-spacing: 0.05em; }

        .live-badge {
          background: var(--color-error);
          color: white;
          font-size: 0.7rem;
          padding: 2px 6px;
          border-radius: 4px;
          font-weight: 700;
          animation: pulse 2s infinite;
        }

        @keyframes pulse {
          0% { opacity: 1; }
          50% { opacity: 0.5; }
          100% { opacity: 1; }
        }

        .empty-text {
          color: var(--color-gray-400);
          font-size: 0.9rem;
          text-align: center;
          padding: 1rem;
        }

        .tweet-card {
          background: var(--color-surface, #fff);
          padding: 1rem;
          border-radius: var(--radius-md);
          border: 1px solid var(--color-border, var(--color-gray-200));
          margin-bottom: 1rem;
          transition: transform 0.2s;
        }
        .tweet-card:hover { transform: translateY(-1px); box-shadow: var(--shadow-sm); }
        .tweet-card-link { text-decoration: none; color: inherit; display: block; }
        .tweet-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem; }
        .avatar {
          width: 32px; height: 32px; background: var(--color-neutral-dark);
          color: white; border-radius: 50%; font-size: 0.75rem;
          display: flex; align-items: center; justify-content: center;
          overflow: hidden; flex-shrink: 0;
        }
        .u-info { font-size: 0.85rem; font-weight: 600; display: flex; align-items: center; flex: 1; min-width: 0; }
        .u-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .tweet-time { flex-shrink: 0; margin-left: auto; font-size: 0.75rem; color: var(--color-gray-400); }
        .tweet-card p { font-size: 0.9rem; line-height: 1.4; word-wrap: break-word; overflow-wrap: break-word; color: var(--color-text, inherit); }
        .tweet-media {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(80px, 1fr));
          gap: 4px;
          margin-top: 0.5rem;
          border-radius: 8px;
          overflow: hidden;
        }
        .tweet-thumb {
          width: 100%;
          height: 80px;
          object-fit: cover;
          border-radius: 4px;
          display: block;
        }
        .tweet-video { cursor: pointer; }
        .tweet-metrics {
          display: flex;
          gap: 1rem;
          margin-top: 0.5rem;
          padding-top: 0.5rem;
          border-top: 1px solid var(--color-gray-200);
          font-size: 0.75rem;
          color: var(--color-gray-400);
        }
        .tweet-metrics span { display: flex; align-items: center; gap: 3px; }

        .news-item-link { text-decoration: none; color: inherit; display: block; }
        .news-item {
          background: var(--color-surface, #fff);
          border-radius: var(--radius-md);
          overflow: hidden;
          margin-bottom: 1.5rem;
          border: 1px solid var(--color-border, var(--color-gray-200));
          transition: transform 0.2s;
        }
        .news-item:hover { transform: translateY(-2px); box-shadow: var(--shadow-sm); }
        .news-item.featured .news-img {
          height: 250px;
          background: var(--color-gray-200);
        }
        .news-content { padding: 1.5rem; }
        .tag { font-size: 0.7rem; font-weight: 700; letter-spacing: 0.05em; color: var(--color-primary); text-transform: uppercase; display: block; margin-bottom: 0.5rem; }
        .news-item h2 { font-size: 1.5rem; margin-bottom: 0.5rem; }
        .news-item h3 { font-size: 1.1rem; }
        .excerpt { color: var(--color-gray-500); font-size: 1rem; margin-bottom: 0.5rem; }
        .date { color: var(--color-gray-400); font-size: 0.8rem; }

        /* Mobile tabs - hidden on desktop */
        .mobile-feed-tabs {
          display: none;
        }

        @media (max-width: 1024px) {
          .news-layout { grid-template-columns: 1fr; }

          .mobile-feed-tabs {
            display: flex;
            align-items: stretch;
            height: 50px;
            width: 100%;
            box-sizing: border-box;
            margin-bottom: 0.75rem;
          }

          .feed-tab {
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            padding: 0 16px;
            font-size: 15px;
            font-weight: 600;
            border: none;
            border-bottom: 2px solid transparent;
            cursor: pointer;
            transition: color 0.15s, border-color 0.15s;
            background: none;
            color: var(--feed-text-tertiary);
          }
          .feed-tab:hover {
            color: var(--feed-text-secondary);
          }
          .feed-tab.active {
            color: var(--feed-text-primary);
            border-bottom-color: var(--feed-accent);
          }

          .mobile-hidden {
            display: none !important;
          }

          /* Hide per-column headers on mobile since tabs handle it */
          .col-header {
            display: none;
          }
        }

        @media (max-width: 768px) {
          .page-header { display: none !important; }
        }
      `}</style>
        </div>
    );
};

export default News;
