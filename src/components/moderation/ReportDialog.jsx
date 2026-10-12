import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, CheckCircle, Loader2 } from 'lucide-react';
import { moderationApi } from '../../services/api';
import ModerationSheet from './ModerationSheet';

// The reasons that fit each kind of thing, most likely first. They mirror the
// community rules (terms of use §4) and listing accuracy (§5).
const REASONS = {
    user: ['harassment', 'sexual', 'violence_illegal', 'scam_spam', 'impersonation', 'private_info', 'other'],
    listing: ['inaccurate_listing', 'scam_spam', 'impersonation', 'sexual', 'harassment', 'violence_illegal', 'private_info', 'other'],
    endorsement: ['fake_recommendation', 'harassment', 'sexual', 'scam_spam', 'private_info', 'other'],
    event: ['scam_spam', 'sexual', 'violence_illegal', 'harassment', 'other'],
    note: ['harassment', 'sexual', 'violence_illegal', 'scam_spam', 'impersonation', 'private_info', 'other'],
};

/**
 * Report a profile, listing, recommendation, event or post to BIES's
 * moderators (server/src/services/moderation.service.ts). Private: the
 * member reported isn't told who sent it.
 *
 * @param {{ type: keyof REASONS, id: string, event?: object }} target  a note comes with its signed event
 * @param {string} [name]       who is responsible, for "Block {name} too"
 * @param {() => void} [onBlock]  offered once the report is sent
 */
const ReportDialog = ({ target, name, onClose, onBlock }) => {
    const { t } = useTranslation();
    const [reason, setReason] = useState('');
    const [details, setDetails] = useState('');
    const [phase, setPhase] = useState('form'); // form | sending | done
    const [error, setError] = useState('');

    const send = async (e) => {
        e.preventDefault();
        if (!reason || phase === 'sending') return;
        setPhase('sending');
        setError('');
        try {
            await moderationApi.report({
                targetType: target.type,
                targetId: target.id,
                ...(target.event ? { event: target.event } : {}),
                reason,
                ...(details.trim() ? { details: details.trim() } : {}),
            });
            setPhase('done');
        } catch (err) {
            const known = ['not_found', 'own_content', 'too_many', 'bad_event'];
            const r = err?.data?.reason;
            setError(t(`moderation.report.errors.${known.includes(r) ? r : 'generic'}`));
            setPhase('form');
        }
    };

    if (phase === 'done') {
        return (
            <ModerationSheet key="done" title={t('moderation.report.doneTitle')} onClose={onClose} className="mod-done">
                <CheckCircle size={40} />
                <p className="mod-muted">{t('moderation.report.doneBody')}</p>
                <div className="mod-actions">
                    {onBlock && (
                        <button type="button" className="mod-button secondary" onClick={onBlock}>
                            {name ? t('moderation.report.blockToo', { name }) : t('moderation.report.blockTooUnnamed')}
                        </button>
                    )}
                    <button type="button" className="mod-button" onClick={onClose}>{t('moderation.done')}</button>
                </div>
            </ModerationSheet>
        );
    }

    const sending = phase === 'sending';
    return (
        <ModerationSheet key="form" title={t(`moderation.report.title.${target.type}`)} onClose={sending ? undefined : onClose}>
            <form onSubmit={send} style={{ display: 'contents' }}>
                <fieldset className="mod-reasons" disabled={sending}>
                    <legend>{t('moderation.report.why')}</legend>
                    {(REASONS[target.type] || REASONS.user).map((r) => (
                        <label key={r} className="mod-reason">
                            <input type="radio" name="report-reason" value={r} checked={reason === r} onChange={() => setReason(r)} />
                            <span>{t(`moderation.reasons.${r}`)}</span>
                        </label>
                    ))}
                </fieldset>
                <label className="mod-label" htmlFor="report-details">{t('moderation.report.detailsLabel')}</label>
                <textarea
                    id="report-details"
                    className="mod-textarea"
                    value={details}
                    maxLength={2000}
                    onChange={(e) => setDetails(e.target.value)}
                    disabled={sending}
                />
                <p className="mod-hint">{t('moderation.report.private')}</p>
                {error && (
                    <div className="mod-error" role="alert"><AlertCircle size={16} /><span>{error}</span></div>
                )}
                <div className="mod-actions">
                    <button type="submit" className="mod-button danger" disabled={!reason || sending}>
                        {sending && <Loader2 size={18} className="mod-spin" />}
                        {sending ? t('moderation.report.sending') : t('moderation.report.send')}
                    </button>
                    {!sending && <button type="button" className="mod-link" onClick={onClose}>{t('common.cancel')}</button>}
                </div>
            </form>
        </ModerationSheet>
    );
};

export default ReportDialog;
