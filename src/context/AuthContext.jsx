import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { authService } from '../services/authService';
import { BiesWebSocket, notificationsApi } from '../services/api';
import { notifyIncomingMessage, subscribeToPush, unsubscribeFromPush } from '../utils/notificationManager';
import { isNativePlatform } from '../utils/platform';
import { initNativePush, nativePushToken, forgetNativePushToken } from '../services/pushService';
import { nostrSigner } from '../services/nostrSigner';
import { toSignerError, signerErrorKey } from '../services/signerError';
import i18n from '../i18n';
import { keytrService } from '../services/keytrService';
import { PASSKEY_ENABLED } from '../config/featureFlags';
import PasskeySavePrompt from '../components/PasskeySavePrompt';
import PasskeyMigratePrompt from '../components/PasskeyMigratePrompt';
import PushPermissionPrompt from '../components/PushPermissionPrompt';
import TermsGate from '../components/moderation/TermsGate';
import ProfileGate from '../components/ProfileGate';
import { needsProfile } from '../utils/profileComplete';

/** Login-screen text for a remote-signer failure (string rejections included). */
function signerErrorText(err) {
    const error = toSignerError(err);
    const known = signerErrorKey(error);
    return known ? i18n.t(known.key, known.params) : error.message;
}

const AuthContext = createContext();

export const useAuth = () => useContext(AuthContext);

export const AuthProvider = ({ children }) => {
    const [user, setUser] = useState(null);
    // For handlers registered once, which would otherwise see the first `user`.
    const userRef = useRef(null);
    useEffect(() => { userRef.current = user; }, [user]);
    const [loading, setLoading] = useState(true);
    const [wsClient, setWsClient] = useState(null);
    const [notifications, setNotifications] = useState([]);
    const [unreadCount, setUnreadCount] = useState(0);
    const [showPasskeyPrompt, setShowPasskeyPrompt] = useState(false);
    const [showMigratePrompt, setShowMigratePrompt] = useState(false);
    const [showPushPrompt, setShowPushPrompt] = useState(false);

    // The terms of use come before everything else, once per version; then
    // a name and photo, for members who don't have both yet.
    const termsPending = !!user && user.termsAccepted === false;
    // Deleting the account needs neither the terms nor a name: that page
    // holds the two sheets back while it's open (DeleteAccount.jsx).
    const [gatesHeld, holdGates] = useState(false);
    const profilePending = !termsPending && needsProfile(user);
    useEffect(() => {
        // A request refused for want of the current terms (api.js).
        const onTermsRequired = (e) => setUser((prev) => (prev
            ? { ...prev, termsAccepted: false, termsVersion: e.detail?.termsVersion || prev.termsVersion }
            : prev));
        window.addEventListener('bies:terms-required', onTermsRequired);
        return () => window.removeEventListener('bies:terms-required', onTermsRequired);
    }, []);
    // Work that has to wait for the terms (a profile is public): resolves
    // true once they are accepted, false if the member signs out instead.
    const termsWaiters = useRef([]);
    const settleTermsWaiters = (accepted) => {
        termsWaiters.current.splice(0).forEach((resolve) => resolve(accepted));
    };
    const whenTermsAccepted = useCallback((forUser) => {
        if (!forUser || forUser.termsAccepted !== false) return Promise.resolve(!!forUser);
        return new Promise((resolve) => termsWaiters.current.push(resolve));
    }, []);
    const handleTermsAccepted = useCallback((updated) => {
        setUser((prev) => {
            const next = prev ? { ...prev, ...updated } : updated;
            authService.setCachedUser(next);
            return next;
        });
        settleTermsWaiters(true);
    }, []);

    // ─── Passkey save prompt ─────────────────────────────────────────────────

    /**
     * After a successful login that gives us the nsec in memory, check whether
     * we should prompt the user to save a passkey for easier future logins.
     */
    const maybePromptPasskeySave = useCallback(async () => {
        if (!PASSKEY_ENABLED) return;
        if (!nostrSigner.hasKey || !nostrSigner.getNsec()) return;
        if (keytrService.hasCredential(nostrSigner.pubkey)) return;
        if (sessionStorage.getItem('bies_passkey_prompt_dismissed')) return;

        // Registration is PRF-only as of keytr 0.8.0 — don't offer a save
        // that would throw on non-PRF authenticators.
        const prf = await keytrService.checkPrfSupport();
        if (!prf.supported) return;

        setShowPasskeyPrompt(true);
    }, []);

    const dismissPasskeyPrompt = useCallback(() => {
        sessionStorage.setItem('bies_passkey_prompt_dismissed', '1');
        setShowPasskeyPrompt(false);
    }, []);

    const handlePasskeySaved = useCallback(() => {
        setShowPasskeyPrompt(false);
    }, []);

    // ─── KiH → PRF migration prompt ─────────────────────────────────────────

    /**
     * After an explicit passkey login, offer to upgrade legacy KiH (v=3)
     * credentials to PRF. Silent when PRF is unavailable (KiH login keeps
     * working), snoozed for 7 days on dismissal.
     */
    const maybePromptKihMigration = useCallback(async () => {
        if (!PASSKEY_ENABLED) return;
        const info = keytrService.getLastLoginKihInfo();
        if (!info?.hasKih) return;
        if (sessionStorage.getItem('bies_kih_migration_prompt_dismissed')) return;
        const snooze = Number(localStorage.getItem('bies_kih_migration_snooze_until') || 0);
        if (Date.now() < snooze) return;

        const prf = await keytrService.checkPrfSupport();
        if (!prf.supported) return;

        setShowMigratePrompt(true);
    }, []);

    const dismissMigratePrompt = useCallback(() => {
        sessionStorage.setItem('bies_kih_migration_prompt_dismissed', '1');
        localStorage.setItem('bies_kih_migration_snooze_until', String(Date.now() + 7 * 24 * 3600 * 1000));
        setShowMigratePrompt(false);
    }, []);

    const handleMigrated = useCallback(() => {
        setShowMigratePrompt(false);
    }, []);

    // ─── Session restore on mount ──────────────────────────────────────────

    useEffect(() => {
        let mounted = true;

        authService.restoreSession({ atLaunch: true })
            .then((user) => {
                if (!mounted) return;
                if (user) {
                    setUser(user);
                    initWebSocket(user);
                    fetchInitialNotifications();
                    // Warm up the NIP-46 connection so the first signing action
                    // doesn't stall on a cold reconnect. Guarded to bunker mode
                    // only — tryRestore() for 'nsec' would fire a WebAuthn prompt.
                    if (nostrSigner.storedMethod === 'bunker') {
                        nostrSigner.tryRestore().catch(() => {});
                    }
                }
            })
            .finally(() => {
                if (mounted) setLoading(false);
            });

        // The session ended without a logout here: the server said so (ban,
        // expiry, logout elsewhere) or another tab signed out. Forget this
        // device's secrets too, as logout does.
        const handleUnauthorized = () => {
            if (userRef.current) {
                // Tell the server too (best effort), so this phone stops getting
                // the account's notifications, and stop this browser's.
                authService.logout({ pushToken: nativePushToken() }).catch(() => { });
                forgetNativePushToken();
                if (!isNativePlatform()) unsubscribeFromPush().catch(() => { });
            }
            setUser(null);
            setShowPushPrompt(false);
            setWsClient((prev) => { prev?.disconnect(); return null; });
        };
        window.addEventListener('bies:unauthorized', handleUnauthorized);

        // Tabs share localStorage: when another tab signs out (or site data is
        // cleared), sign out here as well.
        const handleStorage = (e) => {
            if ((e.key === 'bies_token' || e.key === null) && !localStorage.getItem('bies_token')) {
                handleUnauthorized();
            }
        };
        window.addEventListener('storage', handleStorage);

        return () => {
            mounted = false;
            window.removeEventListener('bies:unauthorized', handleUnauthorized);
            window.removeEventListener('storage', handleStorage);
        };
    }, []);

    // ─── Push subscription ─────────────────────────────────────────────────
    //
    // Three cases after login:
    //   1. Permission already granted — silently (re)subscribe, no UI.
    //   2. Permission default (never asked) — show the non-blocking banner
    //      so the user can enable it with a click (required by browsers;
    //      Notification.requestPermission() needs a user gesture).
    //   3. Permission denied — do nothing; respect the user's choice.
    //
    // The banner is sessionStorage-gated so it only shows once per session.

    const initPushSubscription = useCallback(async () => {
        // Native shells have no Service Worker / PushManager — use the APNs
        // (Capacitor PushNotifications) path instead and skip the entire
        // web-push / PushPermissionPrompt flow below.
        if (isNativePlatform()) { initNativePush(); return; }

        if (!('Notification' in window) || !('PushManager' in window)) return;

        if (Notification.permission === 'granted') {
            try {
                const { publicKey } = await notificationsApi.getVapidKey();
                if (!publicKey) return;
                const subscription = await subscribeToPush(publicKey);
                if (subscription) await notificationsApi.pushSubscribe(subscription);
            } catch {
                // Push is best-effort — silent failure
            }
            return;
        }

        if (Notification.permission === 'default') {
            if (sessionStorage.getItem('bies_push_prompt_dismissed')) return;
            setShowPushPrompt(true);
        }
    }, []);

    const dismissPushPrompt = useCallback(() => {
        sessionStorage.setItem('bies_push_prompt_dismissed', '1');
        setShowPushPrompt(false);
    }, []);

    // ─── WebSocket setup ───────────────────────────────────────────────────

    const initWebSocket = useCallback((user) => {
        let connectedBefore = false;
        const ws = new BiesWebSocket(
            // onMessage
            (msg) => {
                if (msg.type === 'notification') {
                    setNotifications((prev) => [msg.notification, ...prev]);
                    setUnreadCount((c) => c + 1);
                }
                // Play sound + browser notification for incoming DMs (app-wide)
                if (msg.type === 'new_message' && msg.message) {
                    const m = msg.message;
                    notifyIncomingMessage(
                        m.id || m.nostrEventId || ('ws-' + Date.now()),
                        m.senderName || 'New message',
                        m.content || 'You have a new message',
                        () => { window.location.href = '/messages'; }
                    );
                }
                // Gamification broadcasts (level-ups, monthly winners) → global toast
                if (msg.type === 'gamification') {
                    window.dispatchEvent(new CustomEvent('bies:gamification', { detail: msg }));
                }
            },
            // onConnect: after a reconnect (the socket closes when its token
            // expires, every 15 minutes), catch up on what came in meanwhile.
            () => {
                if (connectedBefore) fetchInitialNotifications();
                connectedBefore = true;
            },
            // onDisconnect
            null
        );
        ws.connect();
        setWsClient(ws);

        // Subscribe silently if permission is granted, or show the enable
        // banner once per session if permission is still default.
        initPushSubscription();

        return ws;
    }, [initPushSubscription]);

    // ─── Auth actions ──────────────────────────────────────────────────────

    const loginWithNostr = async () => {
        try {
            const user = await authService.loginWithNostr();
            setUser(user);
            initWebSocket(user);
            return { success: true, user };
        } catch (error) {
            return { success: false, error: error.message };
        }
    };

    /**
     * Email sign-in, step 1: send a 6-digit code. Errors carry the server's
     * `reason` and `retryAfterSeconds` so the screen can explain a wait.
     */
    const requestEmailCode = async (email, lang) => {
        try {
            const result = await authService.requestEmailCode(email, lang);
            return { success: true, ...result };
        } catch (error) {
            return { success: false, ...(error.data || {}), error: error.message };
        }
    };

    /**
     * Email sign-in, step 2: the code. Creates the account the first time.
     * Errors carry `reason` ('invalid_code' | 'code_expired' | …) and
     * `attemptsLeft`.
     */
    const loginWithEmailCode = async (email, code) => {
        try {
            const { user, isNewUser } = await authService.loginWithEmailCode(email, code);
            setUser(user);
            initWebSocket(user);
            return { success: true, user, isNewUser };
        } catch (error) {
            return { success: false, ...(error.data || {}), error: error.message };
        }
    };

    const loginWithNsec = async (nsec) => {
        try {
            const user = await authService.loginWithNsec(nsec);
            setUser(user);
            initWebSocket(user);
            maybePromptPasskeySave();
            return { success: true, user };
        } catch (error) {
            return { success: false, error: error.message };
        }
    };

    const loginWithSeedPhrase = async (mnemonic) => {
        try {
            const user = await authService.loginWithSeedPhrase(mnemonic);
            setUser(user);
            initWebSocket(user);
            maybePromptPasskeySave();
            return { success: true, user };
        } catch (error) {
            return { success: false, error: error.message };
        }
    };



    const loginWithBunker = async (bunkerInput) => {
        try {
            const user = await authService.loginWithBunker(bunkerInput);
            setUser(user);
            initWebSocket(user);
            return { success: true, user };
        } catch (error) {
            return { success: false, error: signerErrorText(error) };
        }
    };


    /**
     * Adopt a user whose JWT was already established outside AuthContext
     * (the Amber NIP-55 callback route — authService.finishAmberLogin).
     * Wires React state + WebSocket and returns the post-login target path.
     */
    const completeExternalLogin = (user) => {
        setUser(user);
        initWebSocket(user);
        return '/home';
    };

    /**
     * Login with an already-paired BunkerSigner (nostrconnect:// QR flow).
     * Same pipeline as loginWithBunker, minus the pairing step.
     */
    const loginWithNostrConnect = async (signer) => {
        try {
            const user = await authService.loginWithConnectedBunker(signer);
            setUser(user);
            initWebSocket(user);
            return { success: true, user };
        } catch (error) {
            return { success: false, error: signerErrorText(error) };
        }
    };

    const loginWithPasskey = async () => {
        try {
            const user = await authService.loginWithPasskey();
            setUser(user);
            initWebSocket(user);
            maybePromptKihMigration();
            return { success: true, user };
        } catch (error) {
            if (error.cancelled) return { success: false, cancelled: true };
            return { success: false, error: error.message };
        }
    };

    const logout = () => {
        settleTermsWaiters(false);
        wsClient?.disconnect();
        setWsClient(null);
        // The logout request also removes this phone's push registration; a
        // browser stops its own push subscription.
        authService.logout({ pushToken: nativePushToken() });
        forgetNativePushToken();
        if (!isNativePlatform()) unsubscribeFromPush().catch(() => { });
        setUser(null);
        setShowPushPrompt(false);
        setNotifications([]);
        setUnreadCount(0);
    };

    const updateRole = async (role) => {
        const result = await authService.updateRole(role);
        setUser((prev) => ({ ...prev, role: result.role }));
        return result;
    };

    const refreshUser = async () => {
        const updated = await authService.restoreSession();
        if (updated) setUser(updated);
        return updated;
    };

    const fetchInitialNotifications = async () => {
        try {
            const result = await notificationsApi.list({ limit: 20 });
            const list = result?.data || result || [];
            if (Array.isArray(list)) {
                setNotifications(list);
                setUnreadCount(list.filter(n => !n.isRead).length);
            }
        } catch { /* ignore on failure */ }
    };

    const clearNotificationCount = () => setUnreadCount(0);

    return (
        <AuthContext.Provider value={{
            user,
            loading,
            wsClient,
            notifications,
            unreadCount,
            clearNotificationCount,
            refreshNotifications: fetchInitialNotifications,
            loginWithNostr,
            loginWithNsec,
            loginWithSeedPhrase,
            loginWithBunker,
            loginWithNostrConnect,
            completeExternalLogin,
            loginWithPasskey,
            requestEmailCode,
            loginWithEmailCode,
            logout,
            updateRole,
            refreshUser,
            whenTermsAccepted,
            holdGates,
            isAuthenticated: !!user,
            isBuilder: user?.role === 'BUILDER',
            isInvestor: user?.role === 'INVESTOR',
            isMod: user?.role === 'MOD',
            isAdmin: !!user?.isAdmin,
            isStaff: !!user?.isAdmin || user?.role === 'MOD',
        }}>
            {children}
            {termsPending && !gatesHeld && (
                <TermsGate user={user} onAccepted={handleTermsAccepted} onSignOut={logout} />
            )}
            {profilePending && !gatesHeld && (
                <ProfileGate key={user.id} user={user} onDone={refreshUser} onSignOut={logout} />
            )}
            {showPasskeyPrompt && !termsPending && !profilePending && (
                <PasskeySavePrompt
                    onClose={dismissPasskeyPrompt}
                    onSaved={handlePasskeySaved}
                />
            )}
            {showMigratePrompt && !showPasskeyPrompt && !termsPending && !profilePending && (
                <PasskeyMigratePrompt
                    onClose={dismissMigratePrompt}
                    onMigrated={handleMigrated}
                />
            )}
            {showPushPrompt && !showPasskeyPrompt && !showMigratePrompt && !termsPending && !profilePending && (
                <PushPermissionPrompt onClose={dismissPushPrompt} />
            )}
        </AuthContext.Provider>
    );
};
