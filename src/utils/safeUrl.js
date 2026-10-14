/**
 * A link a member wrote, made safe to put in an href or open: http(s) only.
 * Anything else (javascript:, data:) comes back undefined, so it isn't a link.
 * @param {string} url
 * @returns {string|undefined}
 */
export function safeHref(url) {
    if (typeof url !== 'string') return undefined;
    const trimmed = url.trim();
    return /^https?:\/\//i.test(trimmed) ? trimmed : undefined;
}
