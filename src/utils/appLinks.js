/**
 * Links to the app's own pages open in the phone app when it's installed
 * (iOS Universal Links, Android App Links). Which pages qualify is decided by
 * the site: public/.well-known/apple-app-site-association on iOS, the intent
 * filter in android/app/src/main/AndroidManifest.xml on Android. The phone
 * hands the app the full https:// address; this turns it into the in-app
 * route.
 *
 * Pure module (no browser globals at import) so it runs under `node --test`.
 */

/**
 * The in-app route (path, query and hash) for a link to this app's site, or
 * null for any other address.
 * @param {string} url - e.g. https://app.buildinelsalvador.com/farms/abc
 * @param {string} origin - the app's web origin, e.g. https://app.buildinelsalvador.com
 */
export function appPathFromUrl(url, origin) {
    if (!url || !origin) return null;
    let link;
    try {
        link = new URL(url);
    } catch {
        return null;
    }
    if (link.origin !== origin) return null;
    return `${link.pathname}${link.search}${link.hash}` || '/';
}
