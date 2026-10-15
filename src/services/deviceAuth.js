/**
 * "Is this the phone's owner?" before showing a secret key in the phone app:
 * Face ID or Touch ID, or the phone's passcode (or PIN, pattern or password
 * on Android). A browser has no such check, so there it always passes.
 */

import { isNativePlatform } from '../utils/platform.js';

/**
 * Resolves to 'ok', 'cancelled' (the member backed out or failed), or
 * 'no-lock' (the phone has no passcode, so there is nothing to check against).
 */
export async function confirmDeviceOwner({ reason, cancelTitle }) {
    if (!isNativePlatform()) return 'ok';
    const { BiometricAuth, BiometryErrorType } = await import('@aparajita/capacitor-biometric-auth');
    try {
        const { deviceIsSecure } = await BiometricAuth.checkBiometry();
        if (!deviceIsSecure) return 'no-lock';
        await BiometricAuth.authenticate({
            reason,
            cancelTitle,
            allowDeviceCredential: true,
            androidTitle: reason,
        });
        return 'ok';
    } catch (err) {
        if (err?.code === BiometryErrorType.passcodeNotSet || err?.code === BiometryErrorType.noDeviceCredential) return 'no-lock';
        return 'cancelled';
    }
}
