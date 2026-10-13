import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Loader2 } from 'lucide-react';
import { nip19 } from 'nostr-tools';
import { useAuth } from '../../context/AuthContext';
import { useBlocks, useMuted } from '../../hooks/useBlocks';
import { loadBlocks, unblock } from '../../services/blockStore';
import { unmute } from '../../services/muteStore';
import { getAssetUrl } from '../../utils/assets';
import BackButton from '../../components/BackButton';
import './AccountFlows.css';

const shortNpub = (pubkey) => {
    try {
        const npub = nip19.npubEncode(pubkey);
        return `${npub.slice(0, 12)}…${npub.slice(-6)}`;
    } catch {
        return `${pubkey.slice(0, 12)}…`;
    }
};

/**
 * Settings → Blocked members: who this member blocked, and Unblock; and the
 * accounts outside BIES muted on this device, and Unmute. What a block does
 * is in BlockDialog (components/moderation).
 */
const BlockedMembers = () => {
    const { t } = useTranslation();
    const { user } = useAuth();
    const { loaded, error: loadFailed, members } = useBlocks();
    const muted = useMuted();
    const [busyId, setBusyId] = useState(null);
    const [error, setError] = useState('');
    const [retrying, setRetrying] = useState(false);

    const doUnblock = async (id) => {
        setBusyId(id);
        setError('');
        try {
            await unblock(user?.id, id);
        } catch {
            setError(t('moderation.blocked.unblockFailed'));
        } finally {
            setBusyId(null);
        }
    };

    const retry = async () => {
        setRetrying(true);
        await loadBlocks(user?.id);
        setRetrying(false);
    };

    return (
        <div className="acct-page">
            <div className="back-head acct-head">
                <BackButton to="/settings" label={t('account.backToSettings')} />
                <h1 className="acct-title">{t('moderation.blocked.title')}</h1>
            </div>
            <div className="acct-card">
                <p className="acct-muted">{t('moderation.blocked.intro')}</p>
                {error && (
                    <div className="acct-error" role="alert"><AlertCircle size={16} /><span>{error}</span></div>
                )}
                {!loaded ? (
                    <Loader2 size={22} className="acct-spin" style={{ alignSelf: 'center' }} />
                ) : loadFailed && members.length === 0 ? (
                    <div className="acct-error" role="alert">
                        <AlertCircle size={16} />
                        <span>
                            {t('moderation.blocked.loadFailed')}{' '}
                            <button type="button" className="acct-link" onClick={retry} disabled={retrying}>
                                {t('common.tryAgain')}
                            </button>
                        </span>
                    </div>
                ) : members.length === 0 ? (
                    <p className="acct-hint">{t('moderation.blocked.empty')}</p>
                ) : (
                    <ul className="blocked-list">
                        {members.map((m) => (
                            <li key={m.id}>
                                <span className="blocked-avatar">
                                    {m.avatar ? <img src={getAssetUrl(m.avatar)} alt="" /> : (m.name || '?')[0].toUpperCase()}
                                </span>
                                <span className="blocked-name">{m.name || t('common.unnamed')}</span>
                                <button
                                    type="button"
                                    className="acct-button secondary blocked-unblock"
                                    onClick={() => doUnblock(m.id)}
                                    disabled={busyId === m.id}
                                >
                                    {busyId === m.id && <Loader2 size={16} className="acct-spin" />}
                                    {t('moderation.unblock')}
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            {muted.size > 0 && (
                <div className="acct-card">
                    <h2>{t('moderation.blocked.mutedTitle')}</h2>
                    <p className="acct-muted">{t('moderation.blocked.mutedIntro')}</p>
                    <ul className="blocked-list">
                        {[...muted].map((pubkey) => (
                            <li key={pubkey}>
                                <span className="blocked-name blocked-npub">{shortNpub(pubkey)}</span>
                                <button
                                    type="button"
                                    className="acct-button secondary blocked-unblock"
                                    onClick={() => unmute(user?.id, pubkey)}
                                >
                                    {t('moderation.unmute')}
                                </button>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            <style>{`
                .blocked-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
                .blocked-list li { display: flex; align-items: center; gap: 0.75rem; padding: 0.6rem 0; border-top: 1px solid var(--color-gray-100); }
                .blocked-list li:first-child { border-top: none; }
                .blocked-avatar { width: 36px; height: 36px; border-radius: 50%; overflow: hidden; flex-shrink: 0; display: flex; align-items: center; justify-content: center; background: var(--color-gray-100); color: var(--color-gray-600); font-weight: 600; }
                .blocked-avatar img { width: 100%; height: 100%; object-fit: cover; }
                .blocked-name { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .blocked-npub { font-family: Menlo, Consolas, monospace; font-size: 0.85rem; font-weight: 500; }
                .blocked-unblock { width: auto; padding: 0.4rem 1rem; font-size: 0.9rem; }
            `}</style>
        </div>
    );
};

export default BlockedMembers;
