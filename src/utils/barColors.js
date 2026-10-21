/**
 * Colours for Android's status bar and gesture bar (SystemBarsSync): a CSS
 * colour as #rrggbb, and whether the bar's icons need to be light on it.
 *
 * Pure module (no browser globals) so it runs under `node --test`.
 */

/**
 * A computed CSS colour ("rgb(0, 71, 171)", "rgba(…, a)", "#0047ab") as
 * #rrggbb, or null when it's see-through or not a colour.
 * @param {string} value
 */
export function opaqueHex(value) {
    if (typeof value !== 'string') return null;
    const v = value.trim().toLowerCase();
    let r;
    let g;
    let b;
    let a = 1;
    const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(v);
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v);
    if (fn) {
        [r, g, b] = [fn[1], fn[2], fn[3]].map(Number);
        if (fn[4] !== undefined) a = fn[4].endsWith('%') ? parseFloat(fn[4]) / 100 : Number(fn[4]);
    } else if (hex) {
        const h = hex[1].length === 3 ? hex[1].replace(/./g, '$&$&') : hex[1];
        [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    } else {
        return null;
    }
    if (!(a > 0.5) || [r, g, b].some((n) => !(n >= 0 && n <= 255))) return null;
    return `#${[r, g, b].map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Whether white icons read better than black ones on this colour (WCAG
 * contrast).
 * @param {string} hex - #rrggbb
 */
export function isDark(hex) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return (1.05 / (luminance + 0.05)) >= ((luminance + 0.05) / 0.05);
}
