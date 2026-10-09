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
let lastToken = null;

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
                lastToken = value;
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
}

/**
 * Best-effort removal of the last captured device token from the backend.
 * Called on logout. Never throws.
 */
export async function unregisterNativePush() {
    if (!isNativePlatform()) return;
    if (!lastToken) return;
    try {
        await notificationsApi.deviceTokenUnregister(lastToken);
    } catch {
        // Best-effort — the server also prunes dead tokens on APNs 410.
    }
}
