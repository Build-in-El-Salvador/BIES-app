import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { isNativePlatform } from '../utils/platform';
import { publicUrl } from '../utils/publicUrl';
import { appPathFromUrl } from '../utils/appLinks';
import { pathOrNotifications } from '../utils/appPaths';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import { OPEN_PATH_EVENT, takeTappedPath } from '../services/pushService';

/**
 * In the phone app, a link to one of the app's pages (a shared farm,
 * business, talent, opportunity or post) opens that page in the app instead
 * of the browser. Capacitor's App plugin reports the link as `appUrlOpen`,
 * and keeps a link that launched the app until this listener is added, so
 * links that start the app work too. Members-only pages send a signed-out
 * person to sign in, then back to the page (ProtectedRoute).
 *
 * The plugin is read from `window.Capacitor.Plugins`, like openExternal, so
 * the web bundle doesn't import @capacitor/app.
 *
 * A tapped push notification opens its page the same way
 * (services/pushService.js), or the notifications when that page isn't in
 * this copy of the app (utils/appPaths.js).
 */
export default function AppLinkListener() {
    const navigate = useNavigate();
    const navigateRef = useRef(navigate);
    useEffect(() => { navigateRef.current = navigate; }, [navigate]);
    const { flags } = useFeatureFlags();
    const flagsRef = useRef(flags);
    useEffect(() => { flagsRef.current = flags; }, [flags]);

    useEffect(() => {
        const open = () => {
            const path = takeTappedPath();
            if (path) navigateRef.current(pathOrNotifications(path, flagsRef.current));
        };
        open(); // a tap that launched the app
        window.addEventListener(OPEN_PATH_EVENT, open);
        return () => window.removeEventListener(OPEN_PATH_EVENT, open);
    }, []);

    useEffect(() => {
        const app = isNativePlatform() ? window.Capacitor?.Plugins?.App : null;
        if (!app?.addListener) return undefined;

        const origin = publicUrl('');
        let handle = null;
        let gone = false;
        Promise.resolve(app.addListener('appUrlOpen', ({ url } = {}) => {
            const path = appPathFromUrl(url, origin);
            if (path) navigateRef.current(path);
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
