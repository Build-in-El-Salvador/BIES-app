/**
 * Copy text, and say whether it worked. The clipboard can refuse (no
 * permission, a page not in focus, an older web view), so "Copied" shows
 * only when this answers true.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function copyText(text) {
    try {
        if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return false;
        await navigator.clipboard.writeText(String(text ?? ''));
        return true;
    } catch {
        return false;
    }
}
