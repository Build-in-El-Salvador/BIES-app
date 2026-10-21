import { useEffect } from 'react';
import { isNativePlatform } from '../utils/platform';
import { runBackHandler } from '../utils/backHandlers';

/**
 * Android's Back button, as in other apps: it closes what's open on top (the
 * side menu), else goes back a page, else leaves the app (to the background,
 * as Android does for an app's first screen). Without a listener, Capacitor
 * only goes back a page, so Back on Home did nothing. Only Android sends
 * `backButton`.
 *
 * The plugin is read from `window.Capacitor.Plugins`, like AppLinkListener,
 * so the web bundle doesn't import @capacitor/app.
 */
export default function BackButtonListener() {
    useEffect(() => {
        const app = isNativePlatform() ? window.Capacitor?.Plugins?.App : null;
        if (!app?.addListener) return undefined;

        let handle = null;
        let gone = false;
        Promise.resolve(app.addListener('backButton', ({ canGoBack } = {}) => {
            if (runBackHandler()) return;
            if (canGoBack) window.history.back();
            else Promise.resolve(app.minimizeApp?.()).catch(() => {});
        })).then((h) => {
            if (gone) h?.remove?.();
            else handle = h;
        }).catch(() => {});

        return () => {
            gone = true;
            handle?.remove?.();
        };
    }, []);

    return null;
}
