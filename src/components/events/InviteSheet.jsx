import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Loader2 } from 'lucide-react';
import { eventsApi } from '../../services/api';
import ModerationSheet from '../moderation/ModerationSheet';
import MemberSearchSelect from '../MemberSearchSelect';

/**
 * Invite members to a proposed meetup, from its page (its proposer): pick
 * them, then Send invites. Each one gets a notification; only the proposer
 * sees who's invited. Members already invited, already in, or the proposer
 * show in the search but can't be picked. `onSent(count)` once it's done.
 */
export default function InviteSheet({ event, me, onClose, onSent }) {
    const { t } = useTranslation();
    const [picked, setPicked] = useState([]);
    const [sending, setSending] = useState(false);
    const [error, setError] = useState('');
    const taken = {
        ...Object.fromEntries((event.going || []).map((p) => [p.id, t('events.proposals.inLabel')])),
        ...Object.fromEntries((event.invited || []).map((p) => [p.id, t('events.proposals.invitedLabel')])),
        ...(me ? { [me]: t('events.proposals.you') } : {}),
    };

    const send = async () => {
        if (!picked.length || sending) return;
        setSending(true);
        setError('');
        try {
            const res = await eventsApi.inviteMembers(event.id, picked.map((p) => p.userId));
            onSent(res?.invited || 0);
        } catch (err) {
            const reason = err?.data?.reason;
            setError(t(`events.proposals.errors.${reason}`, { count: err?.data?.max, defaultValue: t('events.proposals.errors.generic') }));
            setSending(false);
        }
    };

    return (
        <ModerationSheet title={t('events.proposals.inviteMembers')} onClose={onClose}>
            <p className="mod-muted">{t('events.proposals.inviteHint')}</p>
            <div className="inv-pick">
                <MemberSearchSelect value={picked} onChange={setPicked} placeholder={t('events.propose.invitePlaceholder')} taken={taken} inline />
            </div>
            {error && <p className="mod-error" role="alert"><AlertCircle size={16} /> <span>{error}</span></p>}
            <div className="mod-actions">
                <button type="button" className="mod-button" onClick={send} disabled={!picked.length || sending}>
                    {sending && <Loader2 size={18} className="mod-spin" />} {t('events.proposals.sendInvites')}
                </button>
            </div>
            <style jsx>{`
                /* The sheet is light in dark mode too: so is the picker in it. */
                .inv-pick {
                    --color-surface: #FFFFFF; --color-gray-50: #F9F5F4; --color-gray-200: #E2E8F0; --color-gray-400: #94A3B8;
                    --color-gray-500: #5E6B7F; --color-gray-900: #0F172A; --color-blue-tint: #EDF5FF; color: #111827;
                }
            `}</style>
        </ModerationSheet>
    );
}
