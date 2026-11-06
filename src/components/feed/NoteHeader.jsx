import { Link } from 'react-router-dom';

const NoteHeader = ({ pubkey, profile, timestamp, formatTime }) => {
  const displayName = profile?.display_name || profile?.name || (pubkey ? pubkey.substring(0, 12) + '...' : '');
  const handle = profile?.name ? `@${profile.name}` : '';
  const nip05 = profile?.nip05;
  const avatar = profile?.picture;

  // Show nip05 if it differs from @handle, otherwise show handle
  const secondaryText = nip05 || handle;

  return (
    <Link to={`/builder/${pubkey}`} className="primal-author-info" style={{ textDecoration: 'none' }}>
      <span className="primal-author-name">{displayName}</span>
      {secondaryText && (
        <span className="primal-author-nip05">{secondaryText}</span>
      )}
      <span className="primal-author-time">
        <span className="primal-author-dot">&middot;</span>
        {formatTime(timestamp)}
      </span>
    </Link>
  );
};

export default NoteHeader;
