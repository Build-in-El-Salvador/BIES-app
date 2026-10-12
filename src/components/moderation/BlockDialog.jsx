import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, CheckCircle, Loader2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { block } from '../../services/blockStore';
import ModerationSheet from './ModerationSheet';

/**
 * Block a member: confirm, block, say what it does. A pubkey that isn't a
 * BIES member (a post from elsewhere on Nostr) can't be blocked on the
 * server: `onNotMember` hides them on this device instead, when given.
 *
 * @param {{ userId?: string, pubkey?: string }} target
 * @param {string} [name]
 * @param {(result: { muted?: boolean }) => void} [onBlocked]  called when the sheet closes after blocking
 */
const BlockDialog = ({ target, name, onClose, onBlocked, onNotMember }) => {
    const { t } = useTranslation();
    const { user } = useAuth();
    const [phase, setPhase] = useState('confirm'); // confirm | blocking | blocked | muted
    const [error, setError] = useState('');

    const confirm = async () => {
        if (phase === 'blocking') return;
        setPhase('blocking');
        setError('');
        try {
            await block(user?.id, target.userId ? { userId: target.userId } : { pubkey: target.pubkey });
            setPhase('blocked');
        } catch (err) {
            if (err?.data?.reason === 'not_member' && onNotMember) {
                onNotMember();
                setPhase('muted');
                return;
            }
            setError(t(err?.data?.reason === 'self' ? 'moderation.block.errors.self' : 'moderation.block.errors.generic'));
            setPhase('confirm');
        }
    };

    const finish = () => {
        if (phase === 'blocked') onBlocked?.({});
        else if (phase === 'muted') onBlocked?.({ muted: true });
        onClose();
    };

    if (phase === 'blocked' || phase === 'muted') {
        const muted = phase === 'muted';
        return (
            <ModerationSheet
                key="done"
                title={muted ? t('moderation.block.mutedTitle') : t('moderation.block.doneTitle')}
                onClose={finish}
                className="mod-done"
            >
                <CheckCircle size={40} />
                <p className="mod-muted">
                    {muted
                        ? t('moderation.block.mutedBody')
                        : name ? t('moderation.block.doneBody', { name }) : t('moderation.block.doneBodyUnnamed')}
                </p>
                <div className="mod-actions">
                    <button type="button" className="mod-button" onClick={finish}>{t('moderation.done')}</button>
                </div>
            </ModerationSheet>
        );
    }

    const blocking = phase === 'blocking';
    return (
        <ModerationSheet
            key="confirm"
            title={name ? t('moderation.block.title', { name }) : t('moderation.block.titleUnnamed')}
            onClose={blocking ? undefined : onClose}
        >
            <ul className="mod-list">
                <li>{t('moderation.block.hides')}</li>
                <li>{t('moderation.block.noContact')}</li>
                <li>{t('moderation.block.notTold')}</li>
            </ul>
            <p className="mod-hint">{t('moderation.block.undo')}</p>
            {error && (
                <div className="mod-error" role="alert"><AlertCircle size={16} /><span>{error}</span></div>
            )}
            <div className="mod-actions">
                <button type="button" className="mod-button danger" onClick={confirm} disabled={blocking}>
                    {blocking && <Loader2 size={18} className="mod-spin" />}
                    {blocking ? t('moderation.block.blocking') : t('moderation.block.confirm')}
                </button>
                {!blocking && <button type="button" className="mod-link" onClick={onClose}>{t('common.cancel')}</button>}
            </div>
        </ModerationSheet>
    );
};

export default BlockDialog;
