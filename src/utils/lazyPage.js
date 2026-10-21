import { lazy } from 'react';

/**
 * A page that's downloaded (on the web) or read from the app bundle (in the
 * phone app) the first time it's opened, instead of with the whole app at
 * start. `Page.preload()` fetches it ahead of time; App.jsx does that for
 * the pages in the bottom bar once Home is on screen, so tapping them
 * doesn't wait.
 *
 * After a deploy, a web app that was already open still names the old page
 * files, which are gone. The first failure then reloads the app once to get
 * the new version; a second failure is a real error.
 */
const RELOADED_KEY = 'bies_page_reload';

export function lazyPage(load) {
    let pending = null;
    const preload = () => {
        if (!pending) {
            pending = load().catch((error) => {
                pending = null;
                throw error;
            });
        }
        return pending;
    };

    const Page = lazy(() => preload().then(
        (module) => {
            try { sessionStorage.removeItem(RELOADED_KEY); } catch { /* storage off */ }
            return module;
        },
        (error) => {
            let reloaded = false;
            try { reloaded = sessionStorage.getItem(RELOADED_KEY) === '1'; } catch { /* storage off */ }
            if (!reloaded) {
                try { sessionStorage.setItem(RELOADED_KEY, '1'); } catch { /* storage off */ }
                window.location.reload();
                return new Promise(() => {});
            }
            throw error;
        },
    ));
    Page.preload = preload;
    return Page;
}
