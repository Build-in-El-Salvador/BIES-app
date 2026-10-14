/**
 * Native push (APNs / FCM) service.
 *
 * Web push is handled elsewhere (public/sw.js + notificationManager). This
 * module is the native counterpart: it obtains the platform device token via
 * the Capacitor PushNotifications plugin and registers it with the backend so
 * the server can deliver push through APNs on iOS.
 *
 * IMPORTANT: like the rest of the shared code, this file never imports any
 * @capacitor/* package. The plugin is reached only through the runtime
 * `window.Capacitor.Plugins` registry the native shell injects, so the web
 * bundle stays unchanged and this is a complete no-op on web (and on any
 * native shell that doesn't bundle the PushNotifications plugin).
 */

import { isNativePlatform, getPlatform } from '../utils/platform';
import { notificationsApi } from './api';
import { ANDROID_PUSH_ENABLED } from '../config/featureFlags';

// initNativePush runs on every login and session restore, so guard the
// listener binding with a module-level flag — otherwise a single tap would
// fire multiple navigations.
let listenersBound = false;

// Last device token we captured, so logout can best-effort unregister it.
// Kept across launches too: logout must be able to send it even before this
// launch's registration has answered.
let lastToken = null;
const TOKEN_KEY = 'bies_push_token';
const rememberToken = (value) => {
    lastToken = value;
    try { if (value) localStorage.setItem(TOKEN_KEY, value); else localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
};

/** Fired on window when this phone's notification permission may have changed. */
export const PERMISSION_EVENT = 'bies:push-permission';

/** The runtime PushNotifications plugin, or null on web / older shells. */
function getPlugin() {
    return (typeof window !== 'undefined' && window.Capacitor?.Plugins?.PushNotifications) || null;
}

/**
 * Register this device for native push and send the token to the backend.
 * Safe to call repeatedly; no-op unless running in a native shell that has the
 * PushNotifications plugin. Never throws.
 */
export async function initNativePush() {
    if (!isNativePlatform()) return;
    // Android push needs Firebase (google-services.json) and server-side FCM,
    // neither of which exists yet. Skip rather than call register() without it.
    if (getPlatform() === 'android' && !ANDROID_PUSH_ENABLED) return;

    const push = getPlugin();
    if (!push) return; // Plugin not installed in this shell — silently skip.

    // Bind listeners exactly once.
    if (!listenersBound) {
        listenersBound = true;
        try {
            push.addListener('registration', (token) => {
                const value = token?.value;
                if (!value) return;
                rememberToken(value);
                notificationsApi.deviceTokenRegister(value, getPlatform()).catch(() => {});
            });

            push.addListener('registrationError', (err) => {
                console.warn('[Push] Native registration error:', err?.error || err);
            });

            // Tapping a delivered notification navigates to the server-provided
            // url (set by getNotificationUrl on the backend), matching the
            // existing window.location.href navigation pattern.
            push.addListener('pushNotificationActionPerformed', (action) => {
                const url = action?.notification?.data?.url;
                if (url) window.location.href = url;
            });
        } catch (err) {
            console.warn('[Push] Failed to bind native push listeners:', err);
        }
    }

    try {
        let status = await push.checkPermissions();
        if (status?.receive === 'prompt' || status?.receive === 'prompt-with-rationale') {
            status = await push.requestPermissions();
        }
        if (status?.receive === 'granted') {
            await push.register();
        }
    } catch (err) {
        console.warn('[Push] Native push init failed:', err);
    }
    // Settings → Notifications may be open while iOS asks: tell it the answer.
    window.dispatchEvent(new Event(PERMISSION_EVENT));
}

/**
 * This device's push token, or null on the web. Logout sends it with the
 * logout request, so the server removes it while ending the session.
 */
export function nativePushToken() {
    if (!isNativePlatform()) return null;
    if (lastToken) return lastToken;
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

/** After logout: the server no longer has this phone's token for anyone. */
export function forgetNativePushToken() {
    rememberToken(null);
}

/**
 * Register this phone when iOS already allows BIES, without asking: after
 * the member allowed it in iPhone Settings, say. Settings → Notifications
 * calls it when it sees the permission granted. (Not initNativePush: that
 * fires PERMISSION_EVENT, which Settings listens to.)
 */
export async function registerNativePushIfAllowed() {
    if (!isNativePlatform()) return;
    if (getPlatform() === 'android' && !ANDROID_PUSH_ENABLED) return;
    const push = getPlugin();
    if (!push || !listenersBound) return; // initNativePush binds them at sign-in
    try {
        const { receive } = await push.checkPermissions();
        if (receive === 'granted') await push.register();
    } catch (err) {
        console.warn('[Push] Native registration failed:', err);
    }
}

/**
 * This phone's notification permission for BIES: 'granted', 'denied',
 * 'prompt' (not asked yet) or 'unavailable' (web, or a shell without push).
 */
export async function nativePushPermission() {
    if (!isNativePlatform()) return 'unavailable';
    if (getPlatform() === 'android' && !ANDROID_PUSH_ENABLED) return 'unavailable';
    const push = getPlugin();
    if (!push) return 'unavailable';
    try {
        const { receive } = await push.checkPermissions();
        return receive === 'granted' || receive === 'denied' ? receive : 'prompt';
    } catch {
        return 'unavailable';
    }
}

/**
 * Settings → Notifications on: ask iOS if it hasn't been asked, register
 * this phone, and say where that left the permission.
 */
export async function enableNativePush() {
    await initNativePush();
    return nativePushPermission();
}

/**
 * Open BIES's page in iPhone Settings, where notifications that were turned
 * off can be allowed again. The WebView hands the app-settings: URL to iOS.
 */
export function openNativeAppSettings() {
    window.location.href = 'app-settings:';
}
