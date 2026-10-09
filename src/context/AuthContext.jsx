import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { authService } from '../services/authService';
import { BiesWebSocket, notificationsApi, profilesApi } from '../services/api';
import { nostrService, PUBLIC_RELAYS } from '../services/nostrService';
import { notifyIncomingMessage, subscribeToPush } from '../utils/notificationManager';
import { isNativePlatform } from '../utils/platform';
import { initNativePush, unregisterNativePush } from '../services/pushService';
import { nostrSigner } from '../services/nostrSigner';
import { keytrService } from '../services/keytrService';
import { PASSKEY_ENABLED } from '../config/featureFlags';
import PasskeySavePrompt from '../components/PasskeySavePrompt';
import PasskeyMigratePrompt from '../components/PasskeyMigratePrompt';
import PushPermissionPrompt from '../components/PushPermissionPrompt';

const AuthContext = createContext();

export const useAuth = () => useContext(AuthContext);

export const AuthProvider = ({ children }) => {
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);
    const [wsClient, setWsClient] = useState(null);
    const [notifications, setNotifications] = useState([]);
    const [unreadCount, setUnreadCount] = useState(0);
    const [showPasskeyPrompt, setShowPasskeyPrompt] = useState(false);
    const [showMigratePrompt, setShowMigratePrompt] = useState(false);
    const [showPushPrompt, setShowPushPrompt] = useState(false);

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

        authService.restoreSession()
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

        // Listen for 401 events from the API client
        const handleUnauthorized = () => {
            setUser(null);
            setWsClient((prev) => { prev?.disconnect(); return null; });
        };
        window.addEventListener('bies:unauthorized', handleUnauthorized);

        return () => {
            mounted = false;
            window.removeEventListener('bies:unauthorized', handleUnauthorized);
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
            // onConnect
            null,
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

    const loginWithSeedPhraseAndCheckNew = async (mnemonic) => {
        const result = await loginWithSeedPhrase(mnemonic);
        if (!result.success) return result;

        const isNew = result.user?.profile?.name?.startsWith('nostr:');
        if (isNew && result.user?.nostrPubkey) {
            seedProfileFromNostr(result.user.nostrPubkey).catch(() => {});
        }
        return { ...result, needsProfileSetup: isNew };
    };

    const loginWithNsecAndCheckNew = async (nsec) => {
        const result = await loginWithNsec(nsec);
        if (!result.success) return result;

        const isNew = result.user?.profile?.name?.startsWith('nostr:');
        if (isNew && result.user?.nostrPubkey) {
            seedProfileFromNostr(result.user.nostrPubkey).catch(() => {});
        }
        return { ...result, needsProfileSetup: isNew };
    };

    const loginWithBunker = async (bunkerInput) => {
        try {
            const user = await authService.loginWithBunker(bunkerInput);
            setUser(user);
            initWebSocket(user);
            return { success: true, user };
        } catch (error) {
            return { success: false, error: error.message };
        }
    };

    const loginWithBunkerAndCheckNew = async (bunkerInput) => {
        const result = await loginWithBunker(bunkerInput);
        if (!result.success) return result;

        const isNew = result.user?.profile?.name?.startsWith('nostr:');
        if (isNew && result.user?.nostrPubkey) {
            seedProfileFromNostr(result.user.nostrPubkey).catch(() => {});
        }
        return { ...result, needsProfileSetup: isNew };
    };

    /**
     * Adopt a user whose JWT was already established outside AuthContext
     * (the Amber NIP-55 callback route — authService.finishAmberLogin).
     * Wires React state + WebSocket and returns the post-login target path.
     */
    const completeExternalLogin = (user) => {
        setUser(user);
        initWebSocket(user);

        const isNew = user?.profile?.name?.startsWith('nostr:');
        if (isNew && user?.nostrPubkey) {
            seedProfileFromNostr(user.nostrPubkey).catch(() => {});
        }
        return isNew ? '/profile-setup' : '/feed';
    };

    /**
     * Login with an already-paired BunkerSigner (nostrconnect:// QR flow).
     * Same pipeline as loginWithBunkerAndCheckNew, minus the pairing step.
     */
    const loginWithNostrConnect = async (signer) => {
        try {
            const user = await authService.loginWithConnectedBunker(signer);
            setUser(user);
            initWebSocket(user);

            const isNew = user?.profile?.name?.startsWith('nostr:');
            if (isNew && user?.nostrPubkey) {
                seedProfileFromNostr(user.nostrPubkey).catch(() => {});
            }
            return { success: true, user, needsProfileSetup: isNew };
        } catch (error) {
            return { success: false, error: error.message };
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

    const loginWithPasskeyAndCheckNew = async () => {
        const result = await loginWithPasskey();
        if (!result.success) return result;

        const isNew = result.user?.profile?.name?.startsWith('nostr:');
        if (isNew && result.user?.nostrPubkey) {
            seedProfileFromNostr(result.user.nostrPubkey).catch(() => {});
        }
        return { ...result, needsProfileSetup: isNew };
    };


    /**
     * For Nostr users who need to complete profile setup after first login.
     * In the old flow, Signup.jsx was standalone.
     * Now: loginWithNostr() → returns user with needsProfileSetup=true if new.
     */
    const loginWithNostrAndCheckNew = async () => {
        const result = await loginWithNostr();
        if (!result.success) return result;

        // New users have a generated placeholder name like "nostr:abc12345"
        const isNew = result.user?.profile?.name?.startsWith('nostr:');

        // Auto-seed BIES profile from Nostr Kind 0 for new users
        if (isNew && result.user?.nostrPubkey) {
            seedProfileFromNostr(result.user.nostrPubkey).catch(() => {});
        }

        return { ...result, needsProfileSetup: isNew };
    };

    /**
     * Fetch the user's Kind 0 profile from public Nostr relays (Primal, Damus, etc.)
     * and apply it to both the BIES API profile and the BIES relay (kind:0).
     * This ensures the user's name/avatar from their existing Nostr identity
     * shows up on BIES before they manually set it.
     */
    const seedProfileFromNostr = async (pubkey) => {
        try {
            // Explicitly fetch from public relays (Primal, Damus, etc.) since
            // this is a new user whose profile won't be on the BIES relay yet
            const nostrProfile = await nostrService.getProfile(pubkey, PUBLIC_RELAYS);
            if (!nostrProfile) return;

            const updates = {};
            if (nostrProfile.display_name || nostrProfile.name) {
                updates.name = nostrProfile.display_name || nostrProfile.name;
            }
            if (nostrProfile.about) updates.bio = nostrProfile.about;
            if (nostrProfile.picture) updates.avatar = nostrProfile.picture;
            if (nostrProfile.banner) updates.banner = nostrProfile.banner;
            if (nostrProfile.website) updates.website = nostrProfile.website;

            if (Object.keys(updates).length > 0) {
                // Update the BIES backend profile (API)
                await profilesApi.update(updates);

                // Publish the kind:0 to the BIES relay so the name is visible
                // to other users on the relay before the user edits their profile
                try {
                    await nostrService.updateProfileToBiesRelay(nostrProfile);
                } catch (relayErr) {
                    console.warn('[Auth] Failed to publish profile to BIES relay:', relayErr);
                }
            }
        } catch (err) {
            console.error('[Auth] Failed to seed profile from Nostr:', err);
        }
    };

    const logout = () => {
        // Best-effort native token removal BEFORE the JWT is cleared, so the
        // authenticated DELETE still carries its Authorization header.
        unregisterNativePush();
        wsClient?.disconnect();
        setWsClient(null);
        authService.logout();
        setUser(null);
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
            loginWithNostrAndCheckNew,
            loginWithNsec,
            loginWithNsecAndCheckNew,
            loginWithSeedPhrase,
            loginWithSeedPhraseAndCheckNew,
            loginWithBunker,
            loginWithBunkerAndCheckNew,
            loginWithNostrConnect,
            completeExternalLogin,
            loginWithPasskey,
            loginWithPasskeyAndCheckNew,
            logout,
            updateRole,
            refreshUser,
            isAuthenticated: !!user,
            isBuilder: user?.role === 'BUILDER',
            isInvestor: user?.role === 'INVESTOR',
            isMod: user?.role === 'MOD',
            isAdmin: !!user?.isAdmin,
            isStaff: !!user?.isAdmin || user?.role === 'MOD',
        }}>
            {children}
            {showPasskeyPrompt && (
                <PasskeySavePrompt
                    onClose={dismissPasskeyPrompt}
                    onSaved={handlePasskeySaved}
                />
            )}
            {showMigratePrompt && !showPasskeyPrompt && (
                <PasskeyMigratePrompt
                    onClose={dismissMigratePrompt}
                    onMigrated={handleMigrated}
                />
            )}
            {showPushPrompt && !showPasskeyPrompt && !showMigratePrompt && (
                <PushPermissionPrompt onClose={dismissPushPrompt} />
            )}
        </AuthContext.Provider>
    );
};
