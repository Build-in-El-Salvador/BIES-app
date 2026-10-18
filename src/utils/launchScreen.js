/**
 * The phone app's launch screen (the BIES logo) stays up while the app starts
 * (capacitor.config.ts: SplashScreen.launchAutoHide false), so the logo goes
 * straight to the first page. This takes it away, fading; once it's gone,
 * calling it again does nothing. Nothing happens in a browser.
 *
 * The plugin comes from the `window.Capacitor.Plugins` registry the native
 * shell injects, so the web bundle never imports a @capacitor package.
 */
export function hideLaunchScreen() {
    const splash = typeof window !== 'undefined' ? window.Capacitor?.Plugins?.SplashScreen : null;
    if (!splash?.hide) return;
    Promise.resolve(splash.hide({ fadeOutDuration: 250 })).catch(() => {});
}
