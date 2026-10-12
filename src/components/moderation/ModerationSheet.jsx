import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import './Moderation.css';

// While any sheet is open the app behind it is inert: no Tab into it, no
// clicks, nothing for a screen reader. The sheets live outside #root.
let openSheets = 0;
const appRoot = () => document.getElementById('root');

/**
 * The sheet Report, Block and the terms of use open in: over the page, on
 * document.body so no menu's styles clip it. Escape and a tap outside close
 * it, unless `onClose` is left out. Give each step its own `key`, so the new
 * step takes focus and is announced.
 */
const ModerationSheet = ({ title, onClose, children, className = '' }) => {
    const { t } = useTranslation();
    const sheetRef = useRef(null);
    const titleId = useId();
    // Kept in a ref: a new onClose each render must not re-run the effect,
    // which would pull focus out of a field being typed in.
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    useEffect(() => {
        const previous = document.activeElement;
        if (openSheets++ === 0) appRoot()?.setAttribute('inert', '');
        sheetRef.current?.focus();
        const onKey = (e) => { if (e.key === 'Escape') onCloseRef.current?.(); };
        document.addEventListener('keydown', onKey);
        const overflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.removeEventListener('keydown', onKey);
            document.body.style.overflow = overflow;
            if (--openSheets === 0) appRoot()?.removeAttribute('inert');
            // Back where the member was, if that is still on the page.
            if (previous && previous !== document.body && previous.isConnected) previous.focus({ preventScroll: true });
        };
    }, []);

    return createPortal(
        <div className="mod-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onCloseRef.current?.(); }}>
            <div
                className={`mod-sheet ${className}`}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
                ref={sheetRef}
            >
                <div className="mod-head">
                    <h2 className="mod-title" id={titleId}>{title}</h2>
                    {onClose && (
                        <button type="button" className="mod-close" onClick={onClose} aria-label={t('common.close')}>
                            <X size={20} />
                        </button>
                    )}
                </div>
                {children}
            </div>
        </div>,
        document.body,
    );
};

export default ModerationSheet;
