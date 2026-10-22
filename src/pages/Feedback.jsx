import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { feedbackApi } from '../services/api';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import { FEEDBACK_PAGES, pageFromPath } from '../config/feedbackPages';
import { lastPage } from '../utils/lastPage';
import { deviceInfo } from '../utils/deviceInfo';
import { CheckCircle, ChevronDown, Loader2, Send, ImagePlus, X } from 'lucide-react';
import './Feedback.css';

// What the form sends as the report's type: a problem, or anything else.
const KINDS = [
    { value: 'BUG', labelKey: 'feedback.kindProblem' },
    { value: 'GENERAL', labelKey: 'feedback.kindFeedback' },
];

// The server takes up to 15 MB (feedback.routes.ts).
const MAX_SCREENSHOT_BYTES = 15 * 1024 * 1024;

/**
 * Report / Feedback: testers and members tell the BIES team about a problem
 * or an idea in three steps: which page, what happened, and a screenshot if
 * they have one. The page starts on the one they came from. The app's
 * version, the device and the path go with it (utils/deviceInfo.js); the
 * form says so. Admins read them in Admin → Feedback.
 */
const Feedback = () => {
    const { t, i18n } = useTranslation();
    const { flags } = useFeatureFlags();
    const cameFrom = useRef(lastPage());
    const pages = FEEDBACK_PAGES.filter((page) => !page.flag || flags[page.flag] !== false);
    const startPage = () => {
        const id = pageFromPath(cameFrom.current);
        return pages.some((page) => page.id === id) ? id : '';
    };

    const [type, setType] = useState('BUG');
    // The page it starts on, if it could tell: the form says so, as the
    // report may be about another page.
    const [guessed] = useState(startPage);
    const [page, setPage] = useState(guessed);
    const [message, setMessage] = useState('');
    const [screenshot, setScreenshot] = useState(null);
    const [preview, setPreview] = useState('');
    const [loading, setLoading] = useState(false);
    const [submitted, setSubmitted] = useState(false);
    const [error, setError] = useState('');
    const fileRef = useRef(null);

    useEffect(() => {
        if (!screenshot) {
            setPreview('');
            return undefined;
        }
        const url = URL.createObjectURL(screenshot);
        setPreview(url);
        return () => URL.revokeObjectURL(url);
    }, [screenshot]);

    const pickScreenshot = (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            setError(t('feedback.errorNotPicture'));
            return;
        }
        if (file.size > MAX_SCREENSHOT_BYTES) {
            setError(t('feedback.errorTooBig'));
            return;
        }
        setError('');
        setScreenshot(file);
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!page) {
            setError(t('feedback.errorPage'));
            return;
        }
        if (message.trim().length < 5) {
            setError(t('feedback.errorShort'));
            return;
        }
        setError('');
        setLoading(true);
        try {
            const device = await deviceInfo({ path: cameFrom.current, language: i18n.language });
            await feedbackApi.submit({ type, page, message: message.trim(), device, screenshot });
            setSubmitted(true);
        } catch (err) {
            setError(err.message || t('feedback.errorSend'));
        } finally {
            setLoading(false);
        }
    };

    const reset = () => {
        setSubmitted(false);
        setMessage('');
        setScreenshot(null);
        setError('');
    };

    if (submitted) {
        return (
            <div className="feedback-page">
                <div className="feedback-card feedback-success-card">
                    <CheckCircle size={48} color="#16a34a" />
                    <h2>{t('feedback.thanksTitle')}</h2>
                    <p>{t('feedback.thanksBody')}</p>
                    <button type="button" onClick={reset} className="feedback-btn-primary">{t('feedback.sendAnother')}</button>
                </div>
            </div>
        );
    }

    const problem = type === 'BUG';
    const pageGuessed = !!page && page === guessed;

    return (
        <div className="feedback-page">
            <div className="feedback-card">
                <h1>{t('feedback.title')}</h1>
                <p className="feedback-subtitle">{t('feedback.subtitle')}</p>

                <div className="feedback-kinds" role="radiogroup" aria-label={t('feedback.title')}>
                    {KINDS.map((kind) => {
                        const selected = type === kind.value;
                        return (
                            <button
                                key={kind.value}
                                type="button"
                                role="radio"
                                aria-checked={selected}
                                className={`feedback-kind ${selected ? 'selected' : ''}`}
                                onClick={() => setType(kind.value)}
                            >
                                {t(kind.labelKey)}
                            </button>
                        );
                    })}
                </div>

                <form onSubmit={handleSubmit}>
                    <label className="feedback-label" htmlFor="feedback-page">{t('feedback.pageLabel')}</label>
                    <div className={`feedback-select-wrap ${pageGuessed ? 'has-hint' : ''}`}>
                        <select
                            id="feedback-page"
                            className="feedback-select"
                            value={page}
                            onChange={(e) => setPage(e.target.value)}
                            aria-describedby={pageGuessed ? 'feedback-page-hint' : undefined}
                        >
                            {!page && <option value="">{t('feedback.pageChoose')}</option>}
                            {pages.map((p) => (
                                <option key={p.id} value={p.id}>{t(`feedback.pages.${p.id}`)}</option>
                            ))}
                        </select>
                        <ChevronDown size={20} className="feedback-select-arrow" aria-hidden="true" />
                    </div>
                    {pageGuessed && (
                        <p id="feedback-page-hint" className="feedback-hint">{t('feedback.pageGuessed')}</p>
                    )}

                    <label className="feedback-label" htmlFor="feedback-message">
                        {problem ? t('feedback.messageLabelProblem') : t('feedback.messageLabelFeedback')}
                    </label>
                    <textarea
                        id="feedback-message"
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        placeholder={problem ? t('feedback.messagePlaceholderProblem') : t('feedback.messagePlaceholderFeedback')}
                        rows={5}
                        maxLength={5000}
                        className="feedback-textarea"
                    />
                    <div className="feedback-char-count">{message.length} / 5000</div>

                    <span className="feedback-label">
                        {t('feedback.screenshotLabel')} <span className="feedback-optional">{t('feedback.optional')}</span>
                    </span>
                    <input ref={fileRef} type="file" accept="image/*" hidden onChange={pickScreenshot} data-testid="feedback-file" />
                    {screenshot ? (
                        <div className="feedback-shot">
                            {preview && <img src={preview} alt={t('feedback.screenshotAlt')} className="feedback-shot-img" />}
                            <button type="button" className="feedback-shot-remove" onClick={() => setScreenshot(null)} aria-label={t('feedback.screenshotRemove')}>
                                <X size={16} />
                            </button>
                        </div>
                    ) : (
                        <button type="button" className="feedback-shot-add" onClick={() => fileRef.current?.click()}>
                            <ImagePlus size={18} />
                            <span>{t('feedback.screenshotAdd')}</span>
                        </button>
                    )}

                    <p className="feedback-note">{t('feedback.deviceNote')}</p>

                    {error && <p className="feedback-error-text" role="alert">{error}</p>}

                    <button type="submit" disabled={loading || !message.trim()} className="feedback-submit-btn">
                        {loading ? <Loader2 size={18} className="feedback-spin" /> : <Send size={18} />}
                        <span>{loading ? t('feedback.sending') : t('feedback.send')}</span>
                    </button>
                </form>
            </div>
        </div>
    );
};

export default Feedback;
