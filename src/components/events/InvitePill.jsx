import { useTranslation } from 'react-i18next';
import Avatar from '../Avatar';
import { firstNameOf } from '../../utils/eventFormat';

/**
 * "Edwin invited you": on a proposed meetup the member was invited to and
 * hasn't answered, with the small round photo (or initial) of who invited
 * them. `by` is { id, name, avatar } (the event's myInvite.by).
 */
export default function InvitePill({ by }) {
    const { t } = useTranslation();
    const name = firstNameOf(by?.name) || t('directory.ownership.aMember');
    return (
        <span className="ip">
            <span className="ip-face" aria-hidden="true">
                <Avatar src={by?.avatar} size={18} fallback={<span className="ip-initial">{name[0].toUpperCase()}</span>} />
            </span>
            {t('events.proposals.invitedYou', { name })}
            <style jsx>{`
                .ip {
                    align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
                    height: 24px; padding: 0 10px 0 2px; box-sizing: border-box; border-radius: var(--radius-full);
                    background: var(--color-orange-tint); color: var(--color-orange-text); border: 1px solid rgba(255, 91, 0, 0.3);
                    font-size: 12px; font-weight: 700; line-height: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
                }
                .ip-face {
                    width: 18px; height: 18px; border-radius: 50%; overflow: hidden; flex: none;
                    background: rgba(255, 91, 0, 0.15); display: inline-flex; align-items: center; justify-content: center;
                }
                .ip-face :global(img) { width: 100%; height: 100%; object-fit: cover; display: block; }
                .ip-initial { font-size: 10px; font-weight: 700; color: var(--color-orange-text); }
            `}</style>
        </span>
    );
}
