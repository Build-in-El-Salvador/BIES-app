import { useEffect, useState } from 'react';

/** The input types typed into, which bring up the on-screen keyboard. */
const TYPED = new Set(['text', 'search', 'email', 'url', 'tel', 'number', 'password']);

/** Whether an element, focused, brings up the on-screen keyboard. */
export function bringsKeyboard(el) {
    if (!el || el.disabled || el.readOnly) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === 'TEXTAREA') return true;
    return el.tagName === 'INPUT' && TYPED.has(String(el.type || 'text').toLowerCase());
}

/**
 * Whether the on-screen keyboard is up, on a phone or tablet: a field that
 * brings it up has focus. The bottom bar steps aside then, as in other apps,
 * instead of riding up on top of the keyboard (iOS keeps fixed things on the
 * page, not the screen, while it's up). Sets `keyboard-open` on <html> too,
 * for the styles. Desktops never count: their keyboard isn't on the screen.
 */
export default function useKeyboardOpen() {
    const [open, setOpen] = useState(false);

    useEffect(() => {
        const touch = window.matchMedia?.('(hover: none) and (pointer: coarse)');
        if (!touch?.matches) return undefined;
        let timer;
        const onIn = (e) => {
            if (!bringsKeyboard(e.target)) return;
            clearTimeout(timer);
            setOpen(true);
        };
        // Moving to the next field (the keyboard's arrows) keeps it up: a
        // moment's wait before calling it closed, so the bar doesn't flash.
        const onOut = () => {
            clearTimeout(timer);
            timer = setTimeout(() => setOpen(bringsKeyboard(document.activeElement)), 150);
        };
        document.addEventListener('focusin', onIn);
        document.addEventListener('focusout', onOut);
        return () => {
            clearTimeout(timer);
            document.removeEventListener('focusin', onIn);
            document.removeEventListener('focusout', onOut);
        };
    }, []);

    useEffect(() => {
        document.documentElement.classList.toggle('keyboard-open', open);
        if (!open) return undefined;
        // A field taken off the page (a search that opens a result) loses
        // focus without a focusout in WebKit: check now and then while up.
        const check = setInterval(() => {
            if (!bringsKeyboard(document.activeElement)) setOpen(false);
        }, 500);
        return () => {
            clearInterval(check);
            document.documentElement.classList.remove('keyboard-open');
        };
    }, [open]);

    return open;
}
