/**
 * Secrets the phone app keeps between launches, in the iOS Keychain or the
 * Android Keystore: the session's refresh token, a pasted Nostr key, the
 * remote signer's (NIP-46) client key and bunker, and a wallet (NWC) link.
 *
 * The rest of the app reads them synchronously, so the Keychain is read into
 * memory once before the app renders (loadSecureStore, from main.jsx), and
 * every change is written through to it. Items stay on this device: no iCloud
 * sync, and not in a backup restored to another phone.
 *
 * Where there is no Keychain (a browser, the unit tests, or a plugin that
 * failed to load) each item stays where it always was: the refresh token in
 * localStorage and a pasted key in sessionStorage, which ends with the tab;
 * the remote signer and wallet in localStorage.
 */

import { isNativePlatform } from '../utils/platform.js';

const FALLBACK = {
    refresh: { storage: () => localStorage, key: 'bies_refresh' },
    nsec: { storage: () => sessionStorage, key: 'bies_sk_session' },
    nip46Sk: { storage: () => localStorage, key: 'bies_nip46_client_sk' },
    nip46Bunker: { storage: () => localStorage, key: 'bies_nip46_bunker' },
    nwc: { storage: () => localStorage, key: 'bies_nwc_uri' },
};

// iOS keeps Keychain items after the app is deleted. Marked in localStorage,
// which is deleted with the app, so a fresh install starts signed out.
const INSTALL_MARK = 'bies_installed';
const LOAD_TIMEOUT_MS = 3000;

let keychain = null;
const cache = new Map();

function fallback(name) {
    const { storage, key } = FALLBACK[name];
    try {
        return { store: storage(), key };
    } catch {
        return null;
    }
}

async function openKeychain() {
    const { SecureStorage, KeychainAccess } = await import('@aparajita/capacitor-secure-storage');
    await SecureStorage.setKeyPrefix('bies_');
    await SecureStorage.setSynchronize(false);
    await SecureStorage.setDefaultKeychainAccess(KeychainAccess.afterFirstUnlockThisDeviceOnly);
    if (!localStorage.getItem(INSTALL_MARK)) {
        await SecureStorage.clear();
        localStorage.setItem(INSTALL_MARK, '1');
    }
    const values = {};
    for (const name of Object.keys(FALLBACK)) {
        values[name] = await SecureStorage.getItem(name);
    }
    return { SecureStorage, values };
}

/** Read the Keychain into memory. Native app only; a no-op in a browser. */
export async function loadSecureStore() {
    if (!isNativePlatform() || keychain) return;
    try {
        const { SecureStorage, values } = await Promise.race([
            openKeychain(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Keychain timed out')), LOAD_TIMEOUT_MS)),
        ]);
        keychain = SecureStorage;
        for (const [name, value] of Object.entries(values)) {
            if (value) cache.set(name, value);
        }
        // Move over what an earlier version kept in web storage.
        for (const name of Object.keys(FALLBACK)) {
            const old = fallback(name);
            const value = old?.store.getItem(old.key);
            if (!value) continue;
            if (!cache.has(name)) secureSet(name, value);
            old.store.removeItem(old.key);
        }
    } catch (err) {
        console.warn('[SecureStore] Keychain unavailable, using web storage:', err?.message || err);
        keychain = null;
    }
}

/** The stored value, or null. */
export function secureGet(name) {
    if (keychain) return cache.get(name) ?? null;
    const old = fallback(name);
    return old ? old.store.getItem(old.key) : null;
}

export function secureSet(name, value) {
    if (keychain) {
        cache.set(name, value);
        keychain.setItem(name, value).catch((err) => console.warn('[SecureStore] write failed:', err?.message || err));
        return;
    }
    const old = fallback(name);
    try { old?.store.setItem(old.key, value); } catch { /* storage full or unavailable */ }
}

export function secureRemove(name) {
    cache.delete(name);
    keychain?.removeItem(name).catch(() => { });
    const old = fallback(name);
    try { old?.store.removeItem(old.key); } catch { /* unavailable */ }
}
