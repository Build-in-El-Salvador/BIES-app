import { Capacitor, registerPlugin } from '@capacitor/core';
import { nip19, getPublicKey } from 'nostr-tools';

/**
 * The member's Nostr key in their phone's password manager: iCloud Keychain
 * (the Passwords app) on iOS; Google Password Manager, or another provider,
 * on Android. It is saved as a password for app.buildinelsalvador.com with
 * the npub as the username, so it can sign them in with one tap later, on
 * this phone or another that shares the same passwords. BIES never sees it.
 *
 * Native only. On the web, the browser offers to save the key from the
 * sign-in form itself (the autocomplete attributes in pages/Login.jsx).
 *
 * Native code: ios/App/App/SavedKeyPlugin.swift and
 * android/app/src/main/java/com/bies/app/SavedKeyPlugin.java.
 */
const SavedKey = registerPlugin('SavedKey');

export const savedKeyAvailable = () => Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('SavedKey');

// What this device already did with a key ('saved' or 'declined'), so the
// offer is made once. Not a secret, so it outlives a sign-out.
const choiceKey = (pubkey) => `bies_key_saved:${pubkey}`;

const remember = (pubkey, choice) => {
    try { localStorage.setItem(choiceKey(pubkey), choice); } catch { /* private mode */ }
};

/** Whether to offer saving this member's key: native, and not offered before. */
export function shouldOfferToSave(pubkey) {
    if (!pubkey || !savedKeyAvailable()) return false;
    try {
        return !localStorage.getItem(choiceKey(pubkey));
    } catch {
        return true;
    }
}

export const rememberSaved = (pubkey) => pubkey && remember(pubkey, 'saved');
export const declineSave = (pubkey) => pubkey && remember(pubkey, 'declined');

/**
 * Hand the key to the password manager; the phone asks the member to confirm.
 * Takes an nsec or the secret key bytes. Resolves { saved, cancelled }.
 */
export async function saveKey(secret) {
    const secretKey = typeof secret === 'string' ? nip19.decode(secret.trim()).data : secret;
    const pubkey = getPublicKey(secretKey);
    const res = await SavedKey.save({
        username: nip19.npubEncode(pubkey),
        password: nip19.nsecEncode(secretKey),
    });
    if (res?.saved) rememberSaved(pubkey);
    else if (res?.cancelled) declineSave(pubkey);
    return { saved: !!res?.saved, cancelled: !!res?.cancelled };
}

/**
 * A key from the password manager, which shows the member what is saved for
 * BIES. Resolves { nsec }; { notAKey } when they picked a password that isn't
 * one; { none } when nothing is saved; null when they closed the sheet.
 */
export async function getSavedKey() {
    const res = await SavedKey.get();
    if (!res?.found) return res?.cancelled ? null : { none: true };
    const nsec = (res.password || '').trim();
    try {
        if (nip19.decode(nsec).type === 'nsec') return { nsec };
    } catch { /* not bech32 */ }
    return { notAKey: true };
}
