/**
 * authService — bridges the frontend auth flow with the BIES backend.
 *
 * Sign-in starts a session: a 15-minute access token, renewed by a refresh
 * token (services/session.js). User object (without secrets) is cached under
 * 'bies_user'.
 *
 * The service:
 *  - Stores the session each sign-in method returns
 *  - Calls backend to validate/restore sessions
 *  - Never stores private keys — keys belong in the Nostr extension
 */

import { authApi } from './api.js';
import { nip19, getPublicKey, finalizeEvent } from 'nostr-tools';
import { privateKeyFromSeedWords, validateWords } from 'nostr-tools/nip06';
import { nostrSigner } from './nostrSigner.js';
import { fingerprintService } from './fingerprintService.js';
import { nwcClient } from './nwcService.js';
import { clearSession, getAccessToken, logoutSession, retryPendingLogout, saveSession } from './session.js';

const USER_KEY = 'bies_user';

export const authService = {
    // ─── Token management ───────────────────────────────────────────────────

    getToken: () => getAccessToken(),

    /** Store a sign-in response: `{ token, refreshToken? }`. */
    setSession: (session) => saveSession(session),

    clearToken: () => clearSession(),

    // ─── User cache (lightweight, not authoritative — always re-verify with /me) ─

    getCachedUser: () => {
        try {
            const raw = localStorage.getItem(USER_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    },

    setCachedUser: (user) => {
        localStorage.setItem(USER_KEY, JSON.stringify(user));
    },

    // ─── Session restore ────────────────────────────────────────────────────

    /**
     * Called on app mount. Returns the user if the token is still valid.
     * Makes a real network request to /auth/me.
     */
    restoreSession: async () => {
        const token = authService.getToken();
        if (!token) {
            retryPendingLogout();
            return null;
        }

        try {
            const user = await authApi.me();
            authService.setCachedUser(user);
            // Email accounts sign through the server; the key stays there.
            const method = nostrSigner.storedMethod;
            if (user.hostedKey && (!method || method === 'hosted')) {
                nostrSigner.setHostedMode(user.nostrPubkey);
            }
            return user;
        } catch (err) {
            // The API client already signed out if the session is over.
            // Anything else (offline, server restarting) keeps the session:
            // carry on as the cached user and let the next request decide.
            if (err?.status === 401 || !authService.getToken()) {
                authService.clearToken();
                return null;
            }
            const cached = authService.getCachedUser();
            if (cached?.hostedKey && (!nostrSigner.storedMethod || nostrSigner.storedMethod === 'hosted')) {
                nostrSigner.setHostedMode(cached.nostrPubkey);
            }
            return cached;
        }
    },

    // ─── Nostr login ────────────────────────────────────────────────────────

    /**
     * Login using a Nostr browser extension (Alby, nos2x, etc.).
     * Uses challenge-response: get pubkey → fetch challenge → sign it → verify.
     * Returns the user object + stores JWT.
     */
    loginWithNostr: async () => {
        if (!window.nostr) {
            throw new Error('No Nostr extension found. Please install Alby or nos2x.');
        }

        const pubkey = await window.nostr.getPublicKey();
        const { challenge } = await authApi.nostrChallenge(pubkey);

        const signedEvent = await window.nostr.signEvent({
            kind: 27235,
            pubkey,
            created_at: Math.floor(Date.now() / 1000),
            tags: [],
            content: challenge,
        });

        const fingerprint = await fingerprintService.getFingerprint();
        const session = await authApi.nostrLogin(pubkey, signedEvent, fingerprint);
        const { user } = session;

        authService.setSession(session);
        authService.setCachedUser(user);
        nostrSigner.setExtensionMode();
        return user;
    },

    // ─── Nsec login ────────────────────────────────────────────────────────

    /**
     * Login using an nsec key directly.
     * Decodes the nsec, derives the pubkey, then does the same
     * challenge-response flow as extension login.
     * The secret key is never stored — only held in memory during signing.
     */
    loginWithNsec: async (nsecString) => {
        const decoded = nip19.decode(nsecString.trim());
        if (decoded.type !== 'nsec') {
            throw new Error('Invalid nsec key.');
        }
        const sk = decoded.data;
        const pubkey = getPublicKey(sk);

        const { challenge } = await authApi.nostrChallenge(pubkey);

        const signedEvent = finalizeEvent({
            kind: 27235,
            pubkey,
            created_at: Math.floor(Date.now() / 1000),
            tags: [],
            content: challenge,
        }, sk);

        const fingerprint = await fingerprintService.getFingerprint();
        const session = await authApi.nostrLogin(pubkey, signedEvent, fingerprint);
        const { user } = session;

        authService.setSession(session);
        authService.setCachedUser(user);
        nostrSigner.setNsec(nsecString);
        return user;
    },

    // ─── Seed phrase login ─────────────────────────────────────────────────

    /**
     * Login using a BIP-39 seed phrase (NIP-06).
     * Derives the Nostr secret key from the mnemonic, then does the same
     * challenge-response flow as extension/nsec login.
     */
    loginWithSeedPhrase: async (mnemonic) => {
        const words = mnemonic.trim().toLowerCase();
        if (!validateWords(words)) {
            throw new Error('Invalid seed phrase.');
        }
        const sk = privateKeyFromSeedWords(words);
        const pubkey = getPublicKey(sk);

        const { challenge } = await authApi.nostrChallenge(pubkey);

        const signedEvent = finalizeEvent({
            kind: 27235,
            pubkey,
            created_at: Math.floor(Date.now() / 1000),
            tags: [],
            content: challenge,
        }, sk);

        const fingerprint = await fingerprintService.getFingerprint();
        const session = await authApi.nostrLogin(pubkey, signedEvent, fingerprint);
        const { user } = session;

        authService.setSession(session);
        authService.setCachedUser(user);
        nostrSigner.setNsec(sk);
        return user;
    },

    // ─── Passkey login ──────────────────────────────────────────────────────

    /**
     * Login using a saved passkey.
     * Decrypts the stored nsec via WebAuthn PRF, then does the same
     * challenge-response flow as nsec login.
     */
    loginWithPasskey: async () => {
        const { keytrService } = await import('./keytrService.js');
        const nsec = await keytrService.loginWithPasskey();
        return authService.loginWithNsec(nsec);
    },

    // ─── Bunker login (NIP-46 remote signer) ───────────────────────────────

    /**
     * Shared challenge-response pipeline for external signers: get the pubkey
     * from the signer, sign the kind-27235 challenge remotely, exchange it for
     * a JWT. Does NOT set the nostrSigner mode — callers do that.
     * Returns { user, pubkey }.
     */
    _completeSignerLogin: async (signer) => {
        const pubkey = await signer.getPublicKey();
        const { challenge } = await authApi.nostrChallenge(pubkey);

        const signedEvent = await signer.signEvent({
            kind: 27235,
            created_at: Math.floor(Date.now() / 1000),
            tags: [],
            content: challenge,
        });

        const fingerprint = await fingerprintService.getFingerprint();
        const session = await authApi.nostrLogin(pubkey, signedEvent, fingerprint);
        const { user } = session;

        authService.setSession(session);
        authService.setCachedUser(user);
        return { user, pubkey };
    },

    /**
     * Login using a NIP-46 remote signer (Amber, nsecBunker, etc.).
     * Connects via bunker:// URI or name@domain, then does the same
     * challenge-response flow — signing happens on the remote device.
     */
    loginWithBunker: async (bunkerInput) => {
        const { nostrConnectService } = await import('./nostrConnectService.js');
        const bunkerSigner = await nostrConnectService.connect(bunkerInput);

        const { user, pubkey } = await authService._completeSignerLogin(bunkerSigner);
        nostrSigner.setBunkerMode(pubkey);
        return user;
    },

    /**
     * Login with a BunkerSigner that is already connected — the
     * nostrconnect:// client-initiated pairing (see NostrConnectQR).
     */
    loginWithConnectedBunker: async (bunkerSigner) => {
        const { user, pubkey } = await authService._completeSignerLogin(bunkerSigner);
        nostrSigner.setBunkerMode(pubkey);
        return user;
    },

    // ─── Amber login (NIP-55 Android intents) ───────────────────────────────
    //
    // Two app-switch round trips, each landing on /amber-callback:
    //   1. startAmberLogin()  — get_public_key with permissions → Amber
    //   2. continueAmberLogin(pubkey) — fetch challenge NOW (5-min backend
    //      TTL starts here, only one round trip inside it) → sign_event → Amber
    //   3. finishAmberLogin(signedEvent) — exchange for JWT, set amber mode.
    // State between trips lives in localStorage (the page unloads each time).

    /** Kick off Amber login. MUST be called from a user gesture. */
    startAmberLogin: async () => {
        const { amberSignerService, AMBER_PERMISSIONS } = await import('./amberSignerService.js');
        amberSignerService.setLoginState({ step: 'awaiting-pubkey', startedAt: Date.now() });
        // Navigates away; the promise only settles if this tab stays alive
        // (not-installed watchdog, or callback landing in another tab).
        return amberSignerService.requestPublicKey(AMBER_PERMISSIONS, {
            kind: 'login-pubkey',
            returnPath: '/login',
        });
    },

    /** Round trip 2 — called by the callback route with Amber's pubkey. */
    continueAmberLogin: async (pubkeyHex) => {
        const { amberSignerService } = await import('./amberSignerService.js');
        const { challenge } = await authApi.nostrChallenge(pubkeyHex);
        amberSignerService.setLoginState({
            step: 'awaiting-challenge-sig',
            pubkey: pubkeyHex,
            challenge,
            startedAt: Date.now(),
        });
        return amberSignerService.signEvent(
            {
                kind: 27235,
                created_at: Math.floor(Date.now() / 1000),
                tags: [],
                content: challenge,
                pubkey: pubkeyHex,
            },
            // Callback-driven (gestureless) navigation — skip the not-installed
            // watchdog; the AmberCallback page renders a manual continue button.
            { resume: { kind: 'login-challenge', returnPath: '/login' }, skipWatchdog: true }
        );
    },

    /** Final step — called by the callback route with the signed challenge. */
    finishAmberLogin: async (signedEvent) => {
        const { amberSignerService } = await import('./amberSignerService.js');
        const state = amberSignerService.getPendingLoginState();
        if (!state || state.step !== 'awaiting-challenge-sig' || !state.pubkey) {
            // The challenge callback can land in both the initiating tab (its
            // signEvent promise resolves via a storage event) and a fresh
            // Amber-opened tab — both call finishAmberLogin. The first clears
            // the login state; the second must not error or re-POST the
            // single-use challenge. If we're already authenticated, treat it
            // as a benign duplicate and return the established user.
            const cached = authService.getCachedUser();
            if (authService.getToken() && cached) return cached;
            throw new Error('Login session expired. Please try again.');
        }
        if (signedEvent.pubkey !== state.pubkey) {
            throw new Error('Amber signed with a different identity than expected. Please try again.');
        }

        // Claim the challenge before the network call so a racing tab sees
        // no pending state and takes the duplicate-success path above.
        amberSignerService.clearLoginState();

        const fingerprint = await fingerprintService.getFingerprint();
        const session = await authApi.nostrLogin(state.pubkey, signedEvent, fingerprint);
        const { user } = session;

        authService.setSession(session);
        authService.setCachedUser(user);
        nostrSigner.setAmberMode(state.pubkey);
        return user;
    },

    // ─── Email sign-in ──────────────────────────────────────────────────────

    /** Email a 6-digit sign-in code. lang: 'en' | 'es'. */
    requestEmailCode: (email, lang) => authApi.emailStart(email, lang),

    /**
     * Exchange the code for a session. The first sign-in creates the account.
     * BIES holds its key and signs on the server, so the app never gets it.
     */
    loginWithEmailCode: async (email, code) => {
        const session = await authApi.emailVerify(email, code);
        const { user, isNewUser } = session;
        authService.setSession(session);
        authService.setCachedUser(user);
        nostrSigner.setHostedMode(user.nostrPubkey);
        return { user, isNewUser };
    },

    // ─── Logout ─────────────────────────────────────────────────────────────

    /**
     * Sign out: local state at once, then the server ends the session so
     * neither token works again. Returns when the server has been told.
     */
    logout: () => {
        const told = logoutSession();
        nostrSigner.clear();
        // Clear the NWC wallet connection — the spend-capable secret in
        // localStorage must never survive logout (or leak to the next user
        // on a shared browser).
        try {
            nwcClient.disconnect();
        } catch { /* best-effort */ }
        return told;
    },

    // ─── Role management ────────────────────────────────────────────────────

    updateRole: async (role) => {
        const result = await authApi.updateRole(role);
        // Update cached user
        const cached = authService.getCachedUser();
        if (cached) {
            authService.setCachedUser({ ...cached, role: result.role });
        }
        return result;
    },

    // ─── Nostr signup flow (for new Nostr users filling in profile) ──────────

    /**
     * After Nostr login for new users, complete the profile setup.
     * The backend auto-creates the user on nostrLogin; this just updates the profile.
     */
    completeNostrProfile: async (profileData) => {
        const { profilesApi } = await import('./api.js');
        return profilesApi.update(profileData);
    },
};
