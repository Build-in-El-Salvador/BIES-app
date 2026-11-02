import { getPlatform, isNativePlatform } from './platform';

/**
 * This copy of the app's version: in the store app, its own (the version
 * and build App Store Connect and Google Play show, "1.0" and "17"); on the
 * web, the site's (version.json). Never throws.
 * @returns {Promise<{ version: string, build: string }>}
 */
export async function appVersionInfo() {
    let version = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';
    let build = '';
    if (isNativePlatform()) {
        try {
            const info = await window.Capacitor?.Plugins?.App?.getInfo?.();
            if (info?.version) version = String(info.version);
            if (info?.build) build = String(info.build);
        } catch { /* the site's version, then */ }
    }
    return { version, build };
}

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
    const { version: appVersion, build } = await appVersionInfo();
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
