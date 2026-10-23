import { useEffect, useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

// How long Back waits for a page to be tall enough to return to its place.
const RESTORE_MS = 2000;

/**
 * Back (the page's back arrow, the phone's back) returns to the same place
 * on the page it goes back to, a list included; any other move starts at the
 * top, except a change made in place (a filter in the address). Used once, in
 * App.
 *
 * Each visit's place is taken from its scroll events, and stops being taken
 * the moment the next page is put in: that page's first frame, often shorter,
 * moves the scroll, and must not count as where the list was left. The
 * browser's own restoring is off, as it jumps before the page has drawn.
 */
export default function useScrollMemory() {
    const location = useLocation();
    const navigationType = useNavigationType();
    const places = useRef(new Map());
    const visit = useRef(location.key);
    // Before the browser can fire a scroll event for the new page.
    useLayoutEffect(() => { visit.current = location.key; }, [location.key]);

    useEffect(() => {
        try { window.history.scrollRestoration = 'manual'; } catch { /* not supported */ }
        const onScroll = () => places.current.set(visit.current, window.scrollY);
        window.addEventListener('scroll', onScroll, { passive: true });
        return () => window.removeEventListener('scroll', onScroll);
    }, []);

    const last = useRef(location);
    useEffect(() => {
        const before = last.current;
        last.current = location;
        const saved = navigationType === 'POP' ? places.current.get(location.key) : undefined;
        if (saved === undefined) {
            // A filter put in the address (Opportunities) stays where it is.
            // The page's tab tapped again (the same address) starts it
            // afresh, at the top.
            const filtered = navigationType === 'REPLACE' && before.pathname === location.pathname
                && before.search !== location.search;
            if (!filtered) window.scrollTo(0, 0);
            return undefined;
        }
        // Once the page is tall enough to scroll there: its list can come a
        // moment later (from the server, or drawn after its first screen).
        // Not once the member has started scrolling it themselves.
        let frame = 0;
        const started = performance.now();
        const stop = () => {
            cancelAnimationFrame(frame);
            window.removeEventListener('touchstart', stop);
            window.removeEventListener('wheel', stop);
        };
        const attempt = () => {
            const room = document.documentElement.scrollHeight - window.innerHeight;
            if (room >= saved || performance.now() - started > RESTORE_MS) {
                stop();
                window.scrollTo(0, Math.min(saved, Math.max(room, 0)));
                return;
            }
            frame = requestAnimationFrame(attempt);
        };
        window.addEventListener('touchstart', stop, { passive: true });
        window.addEventListener('wheel', stop, { passive: true });
        frame = requestAnimationFrame(attempt);
        return stop;
    }, [location.key]);
}
