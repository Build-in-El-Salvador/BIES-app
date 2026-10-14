/**
 * A bolt11 invoice's amount in millisats, from its human-readable part (no
 * full decode), or null for amountless or invalid invoices. Multipliers:
 * m = milli-BTC, u = micro-BTC, n = nano-BTC, p = pico-BTC.
 * @param {string} bolt11
 * @returns {number|null}
 */
export function bolt11Msats(bolt11) {
    if (typeof bolt11 !== 'string') return null;
    const match = bolt11.trim().toLowerCase().match(/^ln(?:bc|tb|tbs|bcrt)(\d+)([munp]?)1/);
    if (!match) return null;
    const num = Number(match[1]);
    if (!Number.isSafeInteger(num) || num <= 0) return null;
    const MSATS_PER_BTC = 100_000_000_000;
    let msats;
    switch (match[2]) {
        case 'm': msats = num * (MSATS_PER_BTC / 1e3); break;
        case 'u': msats = num * (MSATS_PER_BTC / 1e6); break;
        case 'n': msats = num * (MSATS_PER_BTC / 1e9); break;
        case 'p': msats = num / 10; break; // 10 pico-BTC = 1 msat
        default: msats = num * MSATS_PER_BTC;
    }
    if (!Number.isInteger(msats) || msats <= 0) return null;
    return msats;
}
