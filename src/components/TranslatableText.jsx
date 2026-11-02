import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { translateText, translateHtml } from '../services/translationService';
import { Globe, Loader2 } from 'lucide-react';
import { cleanMemberHtml } from '../utils/memberHtml';

/**
 * TranslatableText — section wrapper with a globe translate icon in the top-right.
 *
 * Usage:
 *   <TranslatableText title="About the Project" text={description} isHtml />
 *   <TranslatableText text={text} buttonOnly />    // Feed (no title)
 */
const TranslatableText = ({
    title,
    titleTag = 'h2',
    titleStyle = {},
    text,
    isHtml = false,
    buttonOnly = false,
    sourceLang = 'en',
    className = '',
    style = {}
}) => {
    const { i18n, t } = useTranslation();
    const [translated, setTranslated] = useState(null);
    const [loading, setLoading] = useState(false);
    const [showTranslated, setShowTranslated] = useState(false);
    const [error, setError] = useState(false);

    const currentLang = i18n.language?.split('-')[0];
    const canTranslate = currentLang && currentLang !== sourceLang && text?.trim();

    const handleTranslate = useCallback(async () => {
        if (translated) {
            setShowTranslated(prev => !prev);
            return;
        }

        setLoading(true);
        setError(false);
        try {
            const result = isHtml
                ? await translateHtml(text, sourceLang, currentLang)
                : await translateText(text, sourceLang, currentLang);
            setTranslated(result);
            setShowTranslated(true);
        } catch {
            setError(true);
        } finally {
            setLoading(false);
        }
    }, [translated, text, isHtml, sourceLang, currentLang]);

    const globeButton = canTranslate ? (
        <button
            className={`tt-icon-btn ${showTranslated ? 'tt-active' : ''}`}
            onClick={handleTranslate}
            disabled={loading}
            title={showTranslated
                ? t('translation.showOriginal', 'Show Original')
                : t('translation.translate', 'Translate')
            }
        >
            {loading ? (
                <Loader2 size={15} className="tt-spin" />
            ) : (
                <Globe size={15} />
            )}
        </button>
    ) : null;

    // ── buttonOnly mode (Feed) ──
    if (buttonOnly) {
        return (
            <>
                {canTranslate && (
                    <div style={{ marginTop: '4px' }}>
                        {globeButton}
                        {error && <span className="tt-error">{t('translation.translationFailed', 'Translation failed')}</span>}
                    </div>
                )}
                {showTranslated && translated && (
                    <div className="tt-result">{translated}</div>
                )}
                <style>{ttStyles}</style>
            </>
        );
    }

    // ── Normal mode ──
    const TitleTag = titleTag;
    const displayText = showTranslated ? (translated || text) : text;

    return (
        <div style={{ position: 'relative' }}>
            {/* Globe icon — absolute top-right, tight to card edge */}
            {globeButton && (
                <div style={{ position: 'absolute', top: '-2px', right: '-4px', zIndex: 2 }}>
                    {globeButton}
                </div>
            )}

            {/* Title */}
            {title && (
                <TitleTag style={{ ...titleStyle, paddingRight: canTranslate ? '36px' : 0 }}>
                    {title}
                </TitleTag>
            )}

            {/* Content */}
            {isHtml ? (
                <div
                    className={className}
                    style={style}
                    dangerouslySetInnerHTML={{
                        __html: cleanMemberHtml(displayText)
                    }}
                />
            ) : (
                <div className={className} style={style}>
                    {displayText}
                </div>
            )}

            {error && (
                <span className="tt-error">
                    {t('translation.translationFailed', 'Translation failed')}
                </span>
            )}

            <style>{ttStyles}</style>
        </div>
    );
};

const ttStyles = `
    .tt-icon-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: var(--color-gray-400);
        cursor: pointer;
        transition: all 0.15s ease;
        padding: 0;
    }

    .tt-icon-btn:hover:not(:disabled) {
        background: rgba(0, 82, 204, 0.08);
        color: var(--color-primary);
    }

    .tt-icon-btn:disabled {
        opacity: 0.5;
        cursor: wait;
    }

    .tt-icon-btn.tt-active {
        color: var(--color-primary);
        background: rgba(0, 82, 204, 0.08);
    }

    .tt-result {
        margin-top: 8px;
        padding: 10px 12px;
        background: rgba(0, 82, 204, 0.03);
        border: 1px solid var(--color-gray-200);
        border-radius: 8px;
        font-size: 0.9rem;
        line-height: 1.6;
        color: var(--color-gray-700);
    }

    .tt-spin {
        animation: ttspin 1s linear infinite;
    }

    @keyframes ttspin {
        to { transform: rotate(360deg); }
    }

    .tt-error {
        display: block;
        margin-top: 4px;
        font-size: 0.7rem;
        color: var(--color-error, #ef4444);
    }
`;

export default TranslatableText;
