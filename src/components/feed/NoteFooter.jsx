import { MessageCircle, Heart, Repeat, Zap, Share, Lock, Globe } from 'lucide-react';

const NoteFooter = ({
  stats,
  isLiked,
  isReposted,
  isCommentsOpen,
  onToggleComments,
  onLike,
  onRepost,
  onZap,
  onShare,
  allowPublicRepost = true,
  repostMenuOpen,
  onRepostMenuToggle,
  formatCount,
  formatSats,
  t,
}) => {
  return (
    <div className="primal-note-footer">
      {/* Reply */}
      <button
        className={`primal-action-btn ${isCommentsOpen ? 'active-reply' : ''}`}
        onClick={onToggleComments}
        title="Comments"
      >
        <MessageCircle size={16} className="primal-action-icon-reply" />
        <span className="primal-action-count">{stats.replies ? formatCount(stats.replies) : ''}</span>
      </button>

      {/* Zap — only where the wallet feature is on */}
      {onZap && (
        <button
          className="primal-action-btn"
          onClick={onZap}
          title="Zap"
        >
          <Zap size={16} className="primal-action-icon-zap" />
          <span className="primal-action-count">{stats.satszapped ? formatSats(stats.satszapped) : ''}</span>
        </button>
      )}

      {/* Like */}
      <button
        className={`primal-action-btn ${isLiked ? 'active-like' : ''}`}
        onClick={onLike}
        title="Like"
      >
        <Heart size={16} className="primal-action-icon-like" fill={isLiked ? 'currentColor' : 'none'} />
        <span className="primal-action-count">{stats.likes ? formatCount(stats.likes) : ''}</span>
      </button>

      {/* Repost */}
      <div style={{ position: 'relative' }} className="repost-wrapper">
        <button
          className={`primal-action-btn ${isReposted ? 'active-repost' : ''}`}
          onClick={onRepostMenuToggle}
          title="Repost"
        >
          <Repeat size={16} className="primal-action-icon-repost" />
          <span className="primal-action-count">{stats.reposts ? formatCount(stats.reposts) : ''}</span>
        </button>
        {repostMenuOpen && (
          <div className="primal-repost-menu">
            <button className="primal-repost-menu-item" onClick={() => onRepost('private')}>
              <Lock size={14} />
              <span>{t('feed.repostPrivate', 'Private Relay')}</span>
            </button>
            {allowPublicRepost && (
              <button className="primal-repost-menu-item" onClick={() => onRepost('public')}>
                <Globe size={14} />
                <span>{t('feed.repostPublic', 'Public')}</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Share — public posts only */}
      {onShare && (
        <button
          className="primal-action-btn primal-action-share"
          onClick={onShare}
          title="Share"
          aria-label="Share"
        >
          <Share size={16} />
        </button>
      )}
    </div>
  );
};

export default NoteFooter;
