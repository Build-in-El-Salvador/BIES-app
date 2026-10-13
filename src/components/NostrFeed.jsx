import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useNostrFeed } from '../hooks/useNostr';
import { useLightbox } from '../context/LightboxContext';
import { formatTime, parseNoteContent, getDisplayName } from '../utils/noteUtils';
import { NoteHeader, ParsedNote, NoteImage, FeedSkeleton } from './feed';
import NostrIcon from './NostrIcon';
import './feed/Feed.css';

const NostrFeed = ({ npub, mode = 'combined' }) => {
    const navigate = useNavigate();
    // BIES posts open in the Feed with their replies, as a profile's activity
    // does on LinkedIn; public ones live outside BIES, so they don't.
    const openPost = mode === 'private' ? (id) => navigate('/feed', { state: { scrollToPost: id } }) : null;
    const { t } = useTranslation();
    const { posts, loading, profiles } = useNostrFeed(npub ? [npub] : [], mode);
    const lightbox = useLightbox();

    const handleImageClick = (src, allImages) => {
        lightbox?.open(src, allImages);
    };

    const renderOtherMedia = (media) => {
        if (!media || media.length === 0) return null;
        return (
            <div className="primal-note-media">
                {media.map((m, i) => {
                    if (m.type === 'video') {
                        return <video key={i} src={m.url} controls className="primal-note-video" preload="metadata" />;
                    }
                    if (m.type === 'audio') {
                        return <audio key={i} src={m.url} controls className="primal-note-audio" preload="metadata" />;
                    }
                    if (m.type === 'youtube') {
                        return (
                            <iframe
                                key={i}
                                className="primal-note-youtube"
                                src={`https://www.youtube-nocookie.com/embed/${m.id}`}
                                title="YouTube video"
                                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                                allowFullScreen
                                loading="lazy"
                            />
                        );
                    }
                    return null;
                })}
            </div>
        );
    };

    const modeLabel =
        mode === 'private'  ? t('profileEdit.privateOnly', 'Private') :
        mode === 'public'   ? t('nostrFeed.publicTab', 'Public') :
        t('nostrFeed.combined', 'Combined');

    const emptyMessage =
        mode === 'private'  ? t('nostrFeed.emptyPrivate', 'No private BIES notes found.') :
        mode === 'public'   ? t('nostrFeed.emptyPublic', 'No public Nostr activity found.') :
        t('nostrFeed.emptyCombined', 'No recent notes found.');

    return (
        <div className="nostr-profile-feed-wrapper">
            {/* Header */}
            <div className="nostr-profile-feed-header">
                <h3 className="nostr-profile-feed-title">
                    {t('profileEdit.nostrFeed', 'Nostr Feed')}
                </h3>
                <span className="nostr-profile-feed-badge">
                    <NostrIcon size={12} /> {modeLabel}
                </span>
            </div>

            {/* Scrollable feed container */}
            <div className="nostr-profile-feed-scroll">
                {/* Loading state */}
                {loading && posts.length === 0 && <FeedSkeleton count={3} />}

                {/* Empty state */}
                {!loading && posts.length === 0 && (
                    <div style={{
                        textAlign: 'center', padding: '2.5rem 1rem',
                        color: 'var(--feed-text-tertiary)'
                    }}>
                        <NostrIcon size={32} style={{ margin: '0 auto 0.75rem', opacity: 0.4 }} />
                        <p style={{ fontSize: '0.9rem' }}>{emptyMessage}</p>
                    </div>
                )}

                {/* Notes */}
                {posts.map(post => {
                    const { text, images, otherMedia } = parseNoteContent(post.content);
                    const profile = profiles[post.pubkey];
                    const avatar = profile?.picture;

                    return (
                        <div key={post.id} className="primal-note" style={{ borderBottom: '1px solid var(--feed-divider)' }}>
                            <div className="primal-note-content-grid">
                                <div className="primal-note-left">
                                    <Link to={`/builder/${post.pubkey}`}>
                                        <div className="primal-avatar">
                                            {avatar
                                                ? <img src={avatar} alt="" />
                                                : <NostrIcon size={18} />}
                                        </div>
                                    </Link>
                                </div>
                                <div
                                    className="primal-note-right"
                                    {...(openPost ? {
                                        role: 'link',
                                        tabIndex: 0,
                                        style: { cursor: 'pointer' },
                                        onClick: (e) => { if (!e.target.closest('a, button, img')) openPost(post.id); },
                                        onKeyDown: (e) => { if (e.key === 'Enter') openPost(post.id); },
                                    } : {})}
                                >
                                    <NoteHeader
                                        pubkey={post.pubkey}
                                        profile={profile}
                                        timestamp={post.created_at}
                                        formatTime={formatTime}
                                    />
                                    {text && (
                                        <ParsedNote
                                            text={text}
                                            profiles={profiles}
                                            getDisplayName={(pk) => getDisplayName(pk, profiles)}
                                        />
                                    )}
                                    <NoteImage images={images} onImageClick={handleImageClick} />
                                    {otherMedia.length > 0 && renderOtherMedia(otherMedia)}
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

export default NostrFeed;
