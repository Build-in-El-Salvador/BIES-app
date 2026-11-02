import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { CalendarDays, CalendarRange } from 'lucide-react';

/**
 * What saving an edit of a repeating event asks when the change is one a
 * date can have of its own (its time, title, words or place): for that date
 * only, or for it and every date after, as the iPhone's Calendar asks. Over
 * the page, on document.body, in the look of the other action sheets.
 *
 * @param {string} props.title - "BIES Soccer repeats every Saturday"
 * @param {string} props.date - the date edited, by its usual day: "Sat 7 Nov"
 * @param {(scope: 'date' | 'series') => void} props.onPick
 * @param {() => void} props.onClose
 */
export default function DateScopeSheet({ title, date, onPick, onClose }) {
    const { t } = useTranslation();
    const sheetRef = useRef(null);
    // Kept in a ref, so a new onClose each render doesn't re-run the effect.
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    useEffect(() => {
        const previous = document.activeElement;
        sheetRef.current?.focus();
        const onKey = (e) => { if (e.key === 'Escape') onCloseRef.current(); };
        document.addEventListener('keydown', onKey);
        const overflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.removeEventListener('keydown', onKey);
            document.body.style.overflow = overflow;
            if (previous && previous !== document.body && previous.isConnected) previous.focus({ preventScroll: true });
        };
    }, []);

    return createPortal(
        <div className="ds-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="ds-sheet" role="dialog" aria-modal="true" aria-labelledby="ds-title" aria-describedby="ds-question" tabIndex={-1} ref={sheetRef}>
                <div className="ds-group">
                    <div className="ds-head">
                        <span id="ds-title" className="ds-title">{title}</span>
                        <span id="ds-question" className="ds-question">{t('events.dates.scopeQuestion')}</span>
                    </div>
                    <button type="button" className="ds-row" onClick={() => onPick('date')}>
                        <CalendarDays size={20} aria-hidden="true" />
                        <span>{t('events.dates.onlyDate', { date })}</span>
                    </button>
                    <button type="button" className="ds-row" onClick={() => onPick('series')}>
                        <CalendarRange size={20} aria-hidden="true" />
                        <span>{t('events.dates.dateAndAfter', { date })}</span>
                    </button>
                </div>
                <button type="button" className="ds-group ds-cancel" onClick={onClose}>{t('events.dates.cancel')}</button>
            </div>
            <style jsx>{`
                .ds-overlay {
                    position: fixed; top: 0; right: 0; bottom: 0; left: 0; z-index: 10100;
                    display: flex; align-items: flex-end; justify-content: center;
                    padding: 10px 10px calc(10px + env(safe-area-inset-bottom, 0px));
                    background: rgba(15, 23, 42, 0.45);
                }
                .ds-sheet { width: 100%; max-width: 420px; display: flex; flex-direction: column; gap: 8px; outline: none; }
                .ds-group { background: var(--color-surface); border-radius: 16px; overflow: hidden; }
                .ds-head { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 14px 16px 12px; border-bottom: 1px solid var(--color-gray-200); text-align: center; }
                .ds-title { font-size: 0.9rem; font-weight: 700; color: var(--color-gray-900); overflow-wrap: anywhere; }
                .ds-question { font-size: 0.85rem; color: var(--color-gray-500); }
                .ds-row {
                    display: flex; align-items: center; gap: 12px; width: 100%; min-height: 52px; padding: 0 16px; box-sizing: border-box;
                    border: 0; border-bottom: 1px solid var(--color-gray-200); background: none; cursor: pointer;
                    font: inherit; font-size: 1rem; font-weight: 500; color: var(--color-gray-900); text-align: left;
                }
                .ds-row:last-child { border-bottom: 0; }
                .ds-row :global(svg) { color: var(--color-primary); flex: none; }
                .ds-cancel {
                    min-height: 52px; border: 0; cursor: pointer; font: inherit; font-size: 1rem; font-weight: 700; color: var(--color-primary);
                }
            `}</style>
        </div>,
        document.body,
    );
}
