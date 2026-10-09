/**
 * Parse TRUST_PROXY into a value for Express's 'trust proxy' setting.
 *
 * Express takes the client IP from X-Forwarded-For, skipping as many proxies
 * as it trusts. If it trusts too few, every visitor appears to come from the
 * nearest proxy, and per-IP rate limits become one limit shared by everyone.
 *
 * - a number of hops, e.g. "2" (production: YunoHost nginx -> container nginx)
 * - "true" / "false"
 * - anything else is passed through: an IP, a subnet or a comma-separated list
 *
 * Unset or empty keeps the previous default of 1 hop.
 */
export function parseTrustProxy(raw: string | undefined): number | boolean | string {
    const value = (raw ?? '').trim();
    if (value === '') return 1;
    if (/^\d+$/.test(value)) return parseInt(value, 10);
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
}
