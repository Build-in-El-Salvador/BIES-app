import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { isDark, opaqueHex } from '../utils/barColors';

const SystemBarColors = registerPlugin('SystemBarColors');
const available = () => Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('SystemBarColors');

/** The colour painted at a point on screen: the first element there with an opaque background. */
function colorAt(x, y) {
    for (let el = document.elementFromPoint(x, y); el; el = el.parentElement) {
        const hex = opaqueHex(getComputedStyle(el).backgroundColor);
        if (hex) return hex;
    }
    return document.documentElement.getAttribute('data-theme') === 'dark' ? '#0f172a' : '#ffffff';
}

function sync() {
    const x = Math.floor(window.innerWidth / 2);
    const top = colorAt(x, 0);
    const bottom = colorAt(x, window.innerHeight - 1);
    Promise.resolve(SystemBarColors.set({ top, bottom, topDark: isDark(top), bottomDark: isDark(bottom) })).catch(() => {});
}

/**
 * On Android, the status bar and gesture bar take the colours of the page
 * under them, the header and bottom bar or the sign-in page, in light and
 * dark mode, and their icons stay readable (SystemBarColorsPlugin.java).
 * It checks again after each page change (once lazy pages have drawn), a
 * theme change, a turn of the phone, and coming back to the app: Capacitor
 * resets the bars when the phone's settings change.
 */
export default function SystemBarsSync() {
    const location = useLocation();

    useEffect(() => {
        if (!available()) return undefined;
        const timers = [0, 250, 900].map((ms) => setTimeout(sync, ms));
        return () => timers.forEach(clearTimeout);
    }, [location.key]);

    useEffect(() => {
        if (!available()) return undefined;
        let timers = [];
        const soon = () => {
            timers.forEach(clearTimeout);
            timers = [50, 400].map((ms) => setTimeout(sync, ms));
        };
        const themeObserver = new MutationObserver(soon);
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
        systemTheme.addEventListener?.('change', soon);
        window.addEventListener('resize', soon);
        const onVisible = () => { if (document.visibilityState === 'visible') soon(); };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            timers.forEach(clearTimeout);
            themeObserver.disconnect();
            systemTheme.removeEventListener?.('change', soon);
            window.removeEventListener('resize', soon);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, []);

    return null;
}
