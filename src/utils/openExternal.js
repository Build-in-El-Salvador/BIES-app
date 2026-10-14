import { isNativePlatform } from './platform';
import { getAssetUrl } from './assets';

/**
 * Open an external URL.
 *
 * On web this is a plain window.open in a new tab. In the Capacitor native
 * shell there are no tabs — window.open would navigate the app's own WebView
 * away from the SPA — so external links are routed through the
 * @capacitor/browser plugin (SFSafariViewController on iOS), accessed via the
 * runtime `window.Capacitor.Plugins` registry so the web bundle never imports
 * any @capacitor package.
 *
 * Server-relative paths (e.g. /uploads/... from the non-S3 storage fallback)
 * are absolutized first: the Browser plugin requires an absolute http(s) URL,
 * and on native a relative window.open would resolve against
 * capacitor://localhost and navigate the SPA to a dead page.
 *
 * @param {string} url - The URL to open.
 */
export function openExternal(url) {
    if (!url) return;
    if (url.startsWith('/') && !url.startsWith('//')) {
        url = getAssetUrl(url); // absolutize against VITE_API_URL
        if (url.startsWith('/')) {
            // No API base configured (same-origin web build) — use the page origin
            url = window.location.origin + url;
        }
    }
    // Only web links: a member's javascript: or data: "link" opens nothing.
    if (!/^https?:\/\//i.test(url)) return;
    if (isNativePlatform()) {
        const browser = window.Capacitor?.Plugins?.Browser;
        if (browser?.open) {
            browser.open({ url }).catch(() => {
                // Plugin failed (e.g. not installed) — fall back to window.open
                window.open(url, '_blank', 'noopener');
            });
            return;
        }
        window.open(url, '_blank', 'noopener');
        return;
    }
    window.open(url, '_blank', 'noopener');
}
