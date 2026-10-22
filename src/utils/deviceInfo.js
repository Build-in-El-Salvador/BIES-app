import { getPlatform, isNativePlatform } from './platform';

/**
 * What a report sends about where it was made, so a problem can be found
 * again: web, iOS or Android, the app's version and build, the browser, the
 * screen, the language and the path. Nothing that names the member. The
 * server keeps these keys and drops any other (feedback.controller.ts).
 * The App plugin is read from `window.Capacitor.Plugins`, like
 * BackButtonListener, so the web bundle doesn't import @capacitor/app.
 * @param {{ path?: string, language?: string }} context
 */
export async function deviceInfo({ path = '', language = '' } = {}) {
    let appVersion = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';
    let build = '';
    if (isNativePlatform()) {
        try {
            const info = await window.Capacitor?.Plugins?.App?.getInfo?.();
            if (info?.version) appVersion = String(info.version);
            if (info?.build) build = String(info.build);
        } catch { /* sent without them */ }
    }
    const ratio = Math.round((window.devicePixelRatio || 1) * 100) / 100;
    return {
        platform: getPlatform(),
        appVersion: appVersion.slice(0, 20),
        build: build.slice(0, 20),
        userAgent: (navigator.userAgent || '').slice(0, 400),
        screen: `${window.innerWidth}×${window.innerHeight} @${ratio}x`,
        language: String(language).slice(0, 10),
        path: String(path).slice(0, 200),
    };
}
