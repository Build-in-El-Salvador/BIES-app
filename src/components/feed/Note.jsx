import { Link } from 'react-router-dom';
import { MoreHorizontal, Share, Link as LinkIcon, Type, Hash, Code, Trash2, VolumeX, Flag, Ban } from 'lucide-react';
import NostrIcon from '../NostrIcon';
import NoteHeader from './NoteHeader';
import NoteFooter from './NoteFooter';
import NoteRepostHeader from './NoteRepostHeader';
import ParsedNote from './ParsedNote';
import NoteImage from './NoteImage';
import TranslatableText from '../TranslatableText';
import { nip19 } from 'nostr-tools';

/**
 * Primal-style note card.
 * Renders: repost header → avatar + author grid → content → images → media → footer → comments
 */
const Note = ({
  post,
  profiles,
  stats,
  isLiked,
  isReposted,
  isCommentsOpen,
  isOwnPost,
  myPubkey,
  postMenuOpen,
  repostMenuOpen,
  onToggleComments,
  onLike,
  onRepostMenuToggle,
  onRepost,
  onZap,
  onShare,
  allowPublicRepost,
  onPostMenuToggle,
  onDeletePost,
  onMuteUser,
  onBlockUser,
  onReport,
  onCopyLink,
  onCopyText,
  onCopyId,
  onCopyRaw,
  parseNoteContent,
  formatTime,
  formatCount,
  formatSats,
  getDisplayName,
  getAvatar,
  onImageClick,
  renderOtherMedia,
  t,
  children, // comment section
}) => {
  const { text, images, otherMedia } = parseNoteContent(post.content);
  const profile = profiles[post.pubkey];
  const avatar = getAvatar(post.pubkey);

  return (
    <div className="primal-note" data-post-id={post.id}>
      {/* Context menu (three-dot) */}
      <div className="primal-note-context note-menu-wrapper">
        <button
          type="button"
          className="primal-note-context-btn"
          onClick={onPostMenuToggle}
          aria-label={t('moderation.menu.more', 'More options')}
          aria-expanded={!!postMenuOpen}
        >
          <MoreHorizontal size={18} />
        </button>
        {postMenuOpen && (
          <div className="primal-note-menu">
            {/* A BIES post's link opens in BIES (members only); a public post's on njump.me */}
            {onShare && (
              <button className="primal-note-menu-item" onClick={() => { onShare(); onPostMenuToggle(); }}>
                <Share size={14} /> {t('feed.shareNote', 'Share')}
              </button>
            )}
            {onCopyLink && (
              <button className="primal-note-menu-item" onClick={onCopyLink}>
                <LinkIcon size={14} /> {t('feed.copyNoteLink', 'Copy Link')}
              </button>
            )}
            <button className="primal-note-menu-item" onClick={onCopyText}>
              <Type size={14} /> {t('feed.copyNoteText', 'Copy Text')}
            </button>
            <button className="primal-note-menu-item" onClick={onCopyId}>
              <Hash size={14} /> {t('feed.copyNoteId', 'Copy ID')}
            </button>
            <button className="primal-note-menu-item" onClick={onCopyRaw}>
              <Code size={14} /> {t('feed.copyRawData', 'Copy Raw')}
            </button>
            {isOwnPost && (
              <button className="primal-note-menu-item danger" onClick={onDeletePost}>
                <Trash2 size={14} /> {t('feed.requestDelete', 'Delete')}
              </button>
            )}
            {!isOwnPost && (
              <>
                <button className="primal-note-menu-item danger" onClick={onMuteUser}>
                  <VolumeX size={14} /> {t('feed.muteUser', 'Mute User')}
                </button>
                {onBlockUser && (
                  <button className="primal-note-menu-item danger" onClick={onBlockUser}>
                    <Ban size={14} /> {t('moderation.menu.block')}
                  </button>
                )}
                <button className="primal-note-menu-item danger" onClick={onReport}>
                  <Flag size={14} /> {t('feed.reportContent', 'Report')}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Repost header */}
      {post._reposters?.length > 0 && (
        <NoteRepostHeader
          reposters={post._reposters}
          getDisplayName={getDisplayName}
          repostTime={post._repostTime}
          formatTime={formatTime}
        />
      )}

      {/* Main content grid: avatar | content */}
      <div className="primal-note-content-grid">
        {/* Left: avatar */}
        <div className="primal-note-left">
          <Link to={`/builder/${post.pubkey}`}>
            <div className="primal-avatar">
              {avatar ? (
                <img src={avatar} alt="" />
              ) : (
                <NostrIcon size={18} />
              )}
            </div>
          </Link>
        </div>

        {/* Right: author info + content + footer */}
        <div className="primal-note-right">
          <NoteHeader
            pubkey={post.pubkey}
            profile={profile}
            timestamp={post.created_at}
            formatTime={formatTime}
          />

          {/* Text content */}
          {text && (
            <ParsedNote
              text={text}
              profiles={profiles}
              getDisplayName={getDisplayName}
            />
          )}

          {/* Translate button */}
          {text && <TranslatableText text={text} buttonOnly />}

          {/* Image grid */}
          <NoteImage images={images} onImageClick={onImageClick} />

          {/* Other media (video, audio, youtube) */}
          {otherMedia.length > 0 && renderOtherMedia(otherMedia)}

          {/* Comment section (passed as children) */}
          {children}
        </div>
      </div>

      {/* Action bar — outside the content grid so it spans full card width */}
      <NoteFooter
        stats={stats}
        isLiked={isLiked}
        isReposted={isReposted}
        isCommentsOpen={isCommentsOpen}
        onToggleComments={onToggleComments}
        onLike={onLike}
        onRepost={onRepost}
        onZap={onZap}
        onShare={onShare}
        allowPublicRepost={allowPublicRepost}
        repostMenuOpen={repostMenuOpen}
        onRepostMenuToggle={onRepostMenuToggle}
        formatCount={formatCount}
        formatSats={formatSats}
        t={t}
      />
    </div>
  );
};

export default Note;
