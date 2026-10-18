import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor configuration for the BIES native shell.
 *
 * NOTE: `appId` must match the Bundle Identifier registered in your Apple
 * Developer account (App Store Connect). If you registered a different
 * identifier there, change it here BEFORE running `npx cap add ios` —
 * see docs/IOS_TESTFLIGHT.md.
 *
 * Build the web bundle with the native env first:
 *   npx vite build --mode native   (uses .env.native — see .env.native.example)
 * then sync it into the iOS project:
 *   npx cap sync ios
 */
const config: CapacitorConfig = {
    appId: 'com.bies.app',
    appName: 'BIES',
    webDir: 'dist',
    ios: {
        // The app already uses viewport-fit=cover + env(safe-area-inset-*) CSS
        // throughout, so the WebView should extend edge-to-edge and let CSS
        // handle the notch/home-indicator insets itself.
        contentInset: 'never',
        // Matches the #0A192F splash background in index.html so the WebView
        // never flashes white behind the boot splash.
        backgroundColor: '#0A192F',
    },
    plugins: {
        // The launch screen (the BIES logo, LaunchScreen.storyboard) stays up
        // while the app starts: until it knows who's signed in and has drawn
        // its first page, Home or signing in (App.jsx hides it). index.html
        // hides it too on a boot error, at the Reload prompt, and after 15 s.
        SplashScreen: {
            launchAutoHide: false,
        },
    },
};

export default config;
