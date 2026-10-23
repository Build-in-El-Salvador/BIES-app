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
import { toSignerError, isDeadSessionError, SIGNER_ERROR } from './signerError.js';
import { isNativePlatform } from '../utils/platform.js';
import { nwcClient } from './nwcService.js';
import { clearLists } from '../utils/listCache.js';
import { clearDetails } from '../utils/detailCache.js';
import { clearFeeds } from '../utils/feedCache.js';
import { clearVisits } from '../utils/visitMemory.js';
import { API_BASE, clearSession, getAccessToken, logoutSession, retryPendingLogout, saveSession } from './session.js';

const USER_KEY = 'bies_user';

// At launch, how long to wait for the server before carrying on as the member
// this device last had, as it does offline: the phone app's launch screen
// stays up while it waits (App.jsx). With no member to carry on as, it waits
// longer, then shows signing in.
const RESTORE_WAIT_MS = 1500;
const RESTORE_LIMIT_MS = 12000;

// A remote signer answers get_public_key at once; sign_event may wait on a
// human approving it in the signer app, so it gets longer.
const SIGNER_PUBKEY_WAIT_MS = 30000;
const SIGNER_SIGN_WAIT_MS = 60000;

/** The promise's answer, or a rejection (`timedOut`) once `ms` have passed (the request carries on). */
function withinTime(promise, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Object.assign(new Error('Timed out'), { timedOut: true })), ms);
        promise.then(
            (value) => { clearTimeout(timer); resolve(value); },
            (error) => { clearTimeout(timer); reject(error); },
        );
    });
}

/**
 * NIP-98 tags for a sign-in (kind 27235): it names BIES's login endpoint, so
 * the signer shows where it's going, and a sign-in another site asked for
 * isn't accepted here (auth.controller.ts isBiesLoginRequest).
 */
function loginTags() {
    return [['u', new URL(`${API_BASE}/auth/nostr-login`, window.location.origin).href], ['method', 'POST']];
}

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
     * Returns the user if the token is still valid. Makes a real network
     * request to /auth/me. `atLaunch` (the app starting) doesn't wait long for
     * a slow server; after a change (refreshUser) it waits for the answer, as
     * the cached member is out of date.
     */
    restoreSession: async ({ atLaunch = false } = {}) => {
        const token = authService.getToken();
        if (!token) {
            retryPendingLogout();
            return null;
        }

        // A key pasted in the phone app comes back from the Keychain.
        nostrSigner.restore();

        try {
            const me = authApi.me();
            const user = await (!atLaunch ? me : withinTime(me, authService.getCachedUser() ? RESTORE_WAIT_MS : RESTORE_LIMIT_MS)
                .catch((error) => {
                    // Too slow: the app carries on (below). The answer, when
                    // it comes, is kept for next time, if it's still this member.
                    if (error?.timedOut) {
                        me.then((late) => {
                            if (late?.id && late.id === authService.getCachedUser()?.id) authService.setCachedUser(late);
                        }, () => {});
                    }
                    throw error;
                }));
            authService.setCachedUser(user);
            // Email accounts sign through the server; the key stays there.
            const method = nostrSigner.storedMethod;
            if (user.hostedKey && (!method || method === 'hosted')) {
                nostrSigner.setHostedMode(user.nostrPubkey);
            }
            // A device that can't sign for the account any more signs in
            // again, rather than failing at every signature: it signed
            // through BIES, which no longer holds the key (the member took it
            // and the answer never arrived), or with a pasted key the phone
            // no longer has (the Keychain couldn't be read).
            const cantSign = (method === 'hosted' && !user.hostedKey)
                || (method === 'nsec' && !nostrSigner.hasKey && isNativePlatform());
            if (cantSign) {
                await authService.logout();
                return null;
            }
            return user;
        } catch {
            // The API client has already signed out if the server said the
            // session is over. Anything else (offline, a server hiccup, no
            // answer in time at launch) keeps the session: carry on as the
            // cached user and let the next request decide.
            if (!authService.getToken()) return null;
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
            tags: loginTags(),
            content: challenge,
        });

        const session = await authApi.nostrLogin(pubkey, signedEvent);
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
            tags: loginTags(),
            content: challenge,
        }, sk);

        const session = await authApi.nostrLogin(pubkey, signedEvent);
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
            tags: loginTags(),
            content: challenge,
        }, sk);

        const session = await authApi.nostrLogin(pubkey, signedEvent);
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
        const pubkey = await authService._fromSigner(signer.getPublicKey(), SIGNER_PUBKEY_WAIT_MS);
        const { challenge } = await authApi.nostrChallenge(pubkey);

        const signedEvent = await authService._fromSigner(signer.signEvent({
            kind: 27235,
            created_at: Math.floor(Date.now() / 1000),
            tags: loginTags(),
            content: challenge,
        }), SIGNER_SIGN_WAIT_MS);

        const session = await authApi.nostrLogin(pubkey, signedEvent);
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
        // Pressing login again with the same URI reuses the signer paired by
        // the previous attempt: bunker:// secrets are single-use, so a fresh
        // connect with that URI would be refused as an unknown client.
        let bunkerSigner;
        try {
            bunkerSigner = await nostrConnectService.connect(bunkerInput);
        } catch (err) {
            throw toSignerError(err);
        }
        return authService._loginWithPairedSigner(bunkerSigner, nostrConnectService);
    },

    /**
     * Login with a BunkerSigner that is already connected — the
     * nostrconnect:// client-initiated pairing (see NostrConnectQR).
     */
    loginWithConnectedBunker: async (bunkerSigner) => {
        const { nostrConnectService } = await import('./nostrConnectService.js');
        return authService._loginWithPairedSigner(bunkerSigner, nostrConnectService);
    },

    /**
     * Challenge-response login over an already-paired BunkerSigner. A signer
     * refusal (e.g. no permission for kind 27235) keeps the pairing so the
     * user can allow it and retry; a dead session (link used, revoked) drops
     * it so the next attempt pairs afresh.
     */
    _loginWithPairedSigner: async (bunkerSigner, nostrConnectService) => {
        try {
            const { user, pubkey } = await authService._completeSignerLogin(bunkerSigner);
            nostrSigner.setBunkerMode(pubkey);
            return user;
        } catch (err) {
            const error = toSignerError(err);
            if (isDeadSessionError(error)) nostrConnectService.disconnect();
            throw error;
        }
    },

    /** A signer call bounded in time, so a lost relay message can't hang login. */
    _fromSigner: async (promise, ms) => {
        try {
            return await withinTime(promise, ms);
        } catch (err) {
            if (err?.timedOut) {
                throw Object.assign(new Error('The remote signer did not respond.'), { code: SIGNER_ERROR.NO_RESPONSE });
            }
            throw err;
        }
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
            returnPath: '/login/nostr',
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
                tags: loginTags(),
                content: challenge,
                pubkey: pubkeyHex,
            },
            // Callback-driven (gestureless) navigation — skip the not-installed
            // watchdog; the AmberCallback page renders a manual continue button.
            { resume: { kind: 'login-challenge', returnPath: '/login/nostr' }, skipWatchdog: true }
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

        const session = await authApi.nostrLogin(state.pubkey, signedEvent);
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
        // The server only signs in email accounts it holds a key for, but
        // never point the signer at a key that isn't there.
        if (user.hostedKey) nostrSigner.setHostedMode(user.nostrPubkey);
        return { user, isNewUser };
    },

    // ─── Logout ─────────────────────────────────────────────────────────────

    /**
     * Sign out: local state at once, then the server ends the session so
     * neither token works again. `pushToken` is this phone's push
     * registration, removed with it. Returns when the server has been told.
     */
    logout: ({ pushToken = null } = {}) => {
        const told = logoutSession({ pushToken });
        authService.clearLocalSecrets();
        return told;
    },

    /**
     * Forget the secrets this device holds for the account: the signer's key
     * and the wallet connection. On every sign-out, including one the server
     * forced (ban, expiry, logout in another tab).
     */
    clearLocalSecrets: () => {
        nostrSigner.clear();
        // Clear the NWC wallet connection — the spend-capable secret in
        // localStorage must never survive logout (or leak to the next user
        // on a shared browser).
        try {
            nwcClient.disconnect();
        } catch { /* best-effort */ }
        // Lists, pages and feed posts this session showed (members, listings,
        // the BIES feed), and the searches typed on them: members-only too.
        clearLists();
        clearDetails();
        clearFeeds();
        clearVisits();
        // Members' names and photos the feed kept: members-only, so not for
        // whoever uses this browser next.
        try {
            localStorage.removeItem('bies_member_names');
        } catch { /* unavailable */ }
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
