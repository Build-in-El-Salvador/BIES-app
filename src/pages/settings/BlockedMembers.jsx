import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ArrowLeft, Loader2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useBlocks } from '../../hooks/useBlocks';
import { unblock } from '../../services/blockStore';
import { getAssetUrl } from '../../utils/assets';
import './AccountFlows.css';

/**
 * Settings → Blocked members: who this member blocked, and Unblock. What a
 * block does is in BlockDialog (components/moderation).
 */
const BlockedMembers = () => {
    const { t } = useTranslation();
    const { user } = useAuth();
    const { loaded, members } = useBlocks();
    const [busyId, setBusyId] = useState(null);
    const [error, setError] = useState('');

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

    return (
        <div className="acct-page">
            <Link to="/settings" className="acct-back"><ArrowLeft size={16} /> {t('account.backToSettings')}</Link>
            <h1 className="acct-title">{t('moderation.blocked.title')}</h1>
            <div className="acct-card">
                <p className="acct-muted">{t('moderation.blocked.intro')}</p>
                {error && (
                    <div className="acct-error" role="alert"><AlertCircle size={16} /><span>{error}</span></div>
                )}
                {!loaded ? (
                    <Loader2 size={22} className="acct-spin" style={{ alignSelf: 'center' }} />
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
            <style>{`
                .blocked-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
                .blocked-list li { display: flex; align-items: center; gap: 0.75rem; padding: 0.6rem 0; border-top: 1px solid var(--color-gray-100); }
                .blocked-list li:first-child { border-top: none; }
                .blocked-avatar { width: 36px; height: 36px; border-radius: 50%; overflow: hidden; flex-shrink: 0; display: flex; align-items: center; justify-content: center; background: var(--color-gray-100); color: var(--color-gray-600); font-weight: 600; }
                .blocked-avatar img { width: 100%; height: 100%; object-fit: cover; }
                .blocked-name { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .blocked-unblock { width: auto; padding: 0.4rem 1rem; font-size: 0.9rem; }
            `}</style>
        </div>
    );
};

export default BlockedMembers;
