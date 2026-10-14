import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Loader2 } from 'lucide-react';
import { accountApi } from '../../services/api';
import { legalPage } from '../../config/legal';
import { openExternal } from '../../utils/openExternal';
import ModerationSheet from './ModerationSheet';

/**
 * The terms of use, accepted once per version before anything else (App
 * Store guideline 1.2: zero tolerance for objectionable content and abusive
 * users). Shown while `user.termsAccepted` is false; it can't be dismissed,
 * only accepted or signed out of. The server refuses publishing until then
 * (server/src/middleware/contentRules.ts).
 */
const TermsGate = ({ user, onAccepted, onSignOut }) => {
    const { t, i18n } = useTranslation();
    const [version, setVersion] = useState(user.termsVersion);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const open = (e, page) => {
        e.preventDefault();
        openExternal(legalPage(i18n.language, page));
    };

    const agree = async () => {
        if (busy) return;
        setBusy(true);
        setError('');
        try {
            const res = await accountApi.acceptTerms(version);
            onAccepted(res.user);
        } catch (err) {
            if (err?.data?.reason === 'terms_changed' && err.data.termsVersion) {
                // Updated while this was open: read the new ones, then agree to them.
                setVersion(err.data.termsVersion);
                setError(t('moderation.terms.changed'));
            } else {
                setError(t('moderation.terms.error'));
            }
        } finally {
            setBusy(false);
        }
    };

    return (
        <ModerationSheet title={t('moderation.terms.title')}>
            <p className="mod-muted">{t('moderation.terms.intro')}</p>
            <ul className="mod-list">
                <li>{t('moderation.terms.ruleZeroTolerance')}</li>
                <li>{t('moderation.terms.ruleRemoved')}</li>
                <li>{t('moderation.terms.ruleReport')}</li>
            </ul>
            <div className="mod-links">
                <a className="mod-link" href={legalPage(i18n.language, 'terms')} onClick={(e) => open(e, 'terms')}>
                    {t('moderation.terms.readTerms')}
                </a>
                <a className="mod-link" href={legalPage(i18n.language, 'privacy')} onClick={(e) => open(e, 'privacy')}>
                    {t('moderation.terms.readPrivacy')}
                </a>
            </div>
            {error && (
                <div className="mod-error" role="alert"><AlertCircle size={16} /><span>{error}</span></div>
            )}
            <div className="mod-actions">
                <button type="button" className="mod-button" onClick={agree} disabled={busy}>
                    {busy && <Loader2 size={18} className="mod-spin" />}
                    {t('moderation.terms.agree')}
                </button>
                <button type="button" className="mod-link" onClick={onSignOut} disabled={busy}>
                    {t('moderation.terms.signOut')}
                </button>
                <button type="button" className="mod-link" onClick={() => window.location.assign('/settings/delete-account')} disabled={busy}>
                    {t('moderation.terms.deleteInstead')}
                </button>
            </div>
        </ModerationSheet>
    );
};

export default TermsGate;
