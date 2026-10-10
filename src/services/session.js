/**
 * The signed-in session on this device: a short-lived access token for API
 * calls, renewed with a refresh token before it runs out.
 *
 *  - Access token: lasts 15 minutes. Kept in localStorage ('bies_token') so
 *    every tab uses the newest one.
 *  - Refresh token, web: an httpOnly cookie the server sets. Scripts on the
 *    page never see it; the browser sends it to /api/auth/refresh only.
 *  - Refresh token, native app: returned in the response body and kept on
 *    the device ('bies_refresh').
 *    TODO(store build): move it to the Keychain/Keystore with the
 *    secure-storage plugin, together with pasted Nostr keys.
 *
 * Each refresh replaces the refresh token. The server ends the session if an
 * old one is used again, which is how a stolen copy shows up.
 */

import { isNativePlatform } from '../utils/platform.js';

export const API_BASE = import.meta.env?.VITE_API_URL || '/api';

const ACCESS_KEY = 'bies_token';
const REFRESH_KEY = 'bies_refresh';
const USER_KEY = 'bies_user';
const LOGOUT_PENDING_KEY = 'bies_logout_pending';

/**
 * Refresh this long before the access token expires: a minute, or a quarter
 * of the token's life if that is shorter, so a short-lived token doesn't
 * trigger a refresh on every request.
 */
const REFRESH_MARGIN_SECONDS = 60;

/** 401 reasons that mean the session is over, rather than "refresh first". */
const SESSION_OVER = new Set(['missing_token', 'invalid_token', 'session_ended', 'suspended', 'account_deleted']);

export const getAccessToken = () => localStorage.getItem(ACCESS_KEY);

/** Store what sign-in or a refresh returned. */
export function saveSession({ token, refreshToken }) {
    if (token) localStorage.setItem(ACCESS_KEY, token);
    if (refreshToken && isNativePlatform()) localStorage.setItem(REFRESH_KEY, refreshToken);
    // A new sign-in replaces whatever an unfinished logout was holding on to.
    localStorage.removeItem(LOGOUT_PENDING_KEY);
}

// Bumped whenever this device signs out, so a refresh that was already in
// flight can't write its tokens back afterwards.
let generation = 0;

export function clearSession() {
    generation++;
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(USER_KEY);
}

/** Sign out locally and tell the app (AuthContext listens). */
export function endSession() {
    const hadSession = !!getAccessToken();
    clearSession();
    if (hadSession) window.dispatchEvent(new CustomEvent('bies:unauthorized'));
}

export const isSessionOver = (reason) => SESSION_OVER.has(reason);

function claims(token) {
    try {
        const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        return JSON.parse(atob(payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), '=')));
    } catch {
        return {};
    }
}

/** Seconds until a JWT expires, or 0 if it can't be read. */
export function secondsLeft(token) {
    const { exp } = claims(token);
    return Number.isFinite(exp) ? Math.max(0, exp - Math.floor(Date.now() / 1000)) : 0;
}

/** Time to refresh: inside the margin before expiry, or already expired. */
export function needsRefresh(token) {
    const { exp, iat } = claims(token);
    const lifetime = Number.isFinite(exp) && Number.isFinite(iat) ? exp - iat : 0;
    const margin = lifetime > 0 ? Math.min(REFRESH_MARGIN_SECONDS, lifetime / 4) : REFRESH_MARGIN_SECONDS;
    return secondsLeft(token) <= margin;
}

// ─── Refresh ──────────────────────────────────────────────────────────────────

let inFlight = null;

/**
 * Get a new access token. One request at a time: callers that arrive while
 * one is running share its answer.
 *
 * Resolves to the new token, or to null when the session is over (it then
 * signs out). Rejects when the server couldn't be reached, which leaves the
 * session as it is.
 */
export function refreshSession() {
    if (!inFlight) {
        inFlight = doRefresh().finally(() => { inFlight = null; });
    }
    return inFlight;
}

async function doRefresh() {
    const startedIn = generation;
    const stale = getAccessToken();
    const native = isNativePlatform();
    const refreshToken = native ? localStorage.getItem(REFRESH_KEY) : undefined;
    if (native && !refreshToken) {
        endSession();
        return null;
    }

    const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            // Only so the server's rate limit counts this per account.
            ...(stale ? { Authorization: `Bearer ${stale}` } : {}),
        },
        body: JSON.stringify(native ? { refreshToken } : {}),
    });

    if (startedIn !== generation) return null; // signed out meanwhile
    if (res.status === 401) {
        endSession();
        return null;
    }
    if (!res.ok) throw new Error(`Session refresh failed (${res.status})`);

    const data = await res.json();
    if (startedIn !== generation) return null;
    saveSession(data);
    return data.token;
}

/**
 * The access token to send now, refreshed first if it is about to expire.
 * Null when signed out. If the server can't be reached, returns the old token
 * and lets the request fail on its own.
 */
export async function freshAccessToken() {
    const token = getAccessToken();
    if (!token || !needsRefresh(token)) return token;
    try {
        return await refreshSession();
    } catch {
        return token;
    }
}

// ─── Logout ───────────────────────────────────────────────────────────────────

/**
 * End this device's session on the server, then locally. Signing out here
 * works offline too; if the server couldn't be told, the next launch tells it
 * (retryPendingLogout), so a shared computer doesn't keep a live session.
 */
export async function logoutSession() {
    const token = getAccessToken();
    const refreshToken = isNativePlatform() ? localStorage.getItem(REFRESH_KEY) : null;
    generation++;
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(USER_KEY);
    if (await tellServerLogout(token, refreshToken)) {
        localStorage.removeItem(REFRESH_KEY);
        localStorage.removeItem(LOGOUT_PENDING_KEY);
    } else {
        // Keeps the native refresh token (the web's is its cookie) for the retry.
        localStorage.setItem(LOGOUT_PENDING_KEY, '1');
    }
}

/** Finish a logout the server never heard about. Called at startup. */
export async function retryPendingLogout() {
    if (!localStorage.getItem(LOGOUT_PENDING_KEY) || getAccessToken()) return;
    const refreshToken = isNativePlatform() ? localStorage.getItem(REFRESH_KEY) : null;
    if (await tellServerLogout(null, refreshToken)) {
        localStorage.removeItem(REFRESH_KEY);
        localStorage.removeItem(LOGOUT_PENDING_KEY);
    }
}

/** True once the server has answered, whatever it said. */
async function tellServerLogout(token, refreshToken) {
    try {
        await fetch(`${API_BASE}/auth/logout`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify(refreshToken ? { refreshToken } : {}),
            signal: AbortSignal.timeout?.(5000),
        });
        return true;
    } catch {
        return false;
    }
}
