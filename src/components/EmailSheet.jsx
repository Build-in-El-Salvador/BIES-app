import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Mail } from 'lucide-react';

/**
 * What an Email button opens: the address, then Copy or Open in the email
 * app, like the menu iOS shows when you press and hold an email link. A
 * mailto: link alone opens whatever mail app the phone has set, and not
 * everyone reads their email there. Over the page, on document.body.
 *
 * @param {string} props.email
 * @param {string} [props.subject] - filled into the new email
 * @param {() => void} props.onClose
 */
export default function EmailSheet({ email, subject, onClose }) {
    const { t } = useTranslation();
    const sheetRef = useRef(null);
    const [copied, setCopied] = useState('');
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

    // After "copied" shows for a moment, the sheet goes.
    useEffect(() => {
        if (copied !== 'yes') return undefined;
        const timer = setTimeout(() => onCloseRef.current(), 900);
        return () => clearTimeout(timer);
    }, [copied]);

    // The clipboard API first; older web views only take the selection copy.
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(email);
            setCopied('yes');
            return;
        } catch { /* try the selection below */ }
        const field = document.createElement('textarea');
        field.value = email;
        field.setAttribute('readonly', '');
        field.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
        document.body.appendChild(field);
        field.select();
        field.setSelectionRange(0, email.length); // iOS selects nothing without this
        let done = false;
        try { done = document.execCommand('copy'); } catch { done = false; }
        field.remove();
        setCopied(done ? 'yes' : 'failed');
    };

    const mailto = `mailto:${email}${subject ? `?subject=${encodeURIComponent(subject)}` : ''}`;

    return createPortal(
        <div className="es-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="es-sheet" role="dialog" aria-modal="true" aria-labelledby="es-title" tabIndex={-1} ref={sheetRef}>
                <div className="es-group">
                    <div className="es-head">
                        <span id="es-title" className="es-title">{t('emailSheet.title')}</span>
                        <span className="es-address">{email}</span>
                    </div>
                    <button type="button" className="es-row" onClick={copy} disabled={copied === 'yes'}>
                        {copied === 'yes' ? <Check size={20} aria-hidden="true" /> : <Copy size={20} aria-hidden="true" />}
                        <span>{copied === 'yes' ? t('emailSheet.copied') : t('emailSheet.copy')}</span>
                    </button>
                    {copied === 'failed' && <p className="es-note">{t('emailSheet.copyFailed')}</p>}
                    <a className="es-row" href={mailto} onClick={() => setTimeout(onClose, 0)}>
                        <Mail size={20} aria-hidden="true" />
                        <span>{t('emailSheet.open')}</span>
                    </a>
                </div>
                <button type="button" className="es-group es-cancel" onClick={onClose}>{t('emailSheet.cancel')}</button>
            </div>
            <style jsx>{`
                .es-overlay {
                    position: fixed; top: 0; right: 0; bottom: 0; left: 0; z-index: 10100;
                    display: flex; align-items: flex-end; justify-content: center;
                    padding: 10px 10px calc(10px + env(safe-area-inset-bottom, 0px));
                    background: rgba(15, 23, 42, 0.45);
                }
                .es-sheet { width: 100%; max-width: 420px; display: flex; flex-direction: column; gap: 8px; outline: none; }
                .es-group { background: var(--color-surface); border-radius: 16px; overflow: hidden; }
                .es-head { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 14px 16px 12px; border-bottom: 1px solid var(--color-gray-200); text-align: center; }
                .es-title { font-size: 0.9rem; font-weight: 700; color: var(--color-gray-900); }
                .es-address { font-size: 0.85rem; color: var(--color-gray-500); overflow-wrap: anywhere; user-select: text; -webkit-user-select: text; }
                .es-row {
                    display: flex; align-items: center; gap: 12px; width: 100%; min-height: 52px; padding: 0 16px; box-sizing: border-box;
                    border: 0; border-bottom: 1px solid var(--color-gray-200); background: none; cursor: pointer;
                    font: inherit; font-size: 1rem; font-weight: 500; color: var(--color-gray-900); text-decoration: none; text-align: left;
                }
                .es-row:last-child { border-bottom: 0; }
                .es-row :global(svg) { color: var(--color-primary); flex: none; }
                .es-row:disabled { cursor: default; }
                .es-note { margin: 0; padding: 8px 16px; font-size: 0.85rem; color: var(--color-gray-500); border-bottom: 1px solid var(--color-gray-200); }
                .es-cancel {
                    min-height: 52px; border: 0; cursor: pointer; font: inherit; font-size: 1rem; font-weight: 700; color: var(--color-primary);
                }
            `}</style>
        </div>,
        document.body,
    );
}
