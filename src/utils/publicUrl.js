/**
 * The web address of an app page, for sharing. In the native app
 * window.location is capacitor://localhost, so the address comes from the
 * API's origin (VITE_API_URL, e.g. https://app.buildinelsalvador.com/api);
 * on the web it's the page's own origin.
 * @param {string} path - e.g. /farms/abc
 */
export function publicUrl(path) {
    const api = import.meta.env.VITE_API_URL || '';
    const origin = /^https?:\/\//i.test(api) ? new URL(api).origin : window.location.origin;
    return origin + path;
}
