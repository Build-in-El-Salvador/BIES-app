/**
 * Translation service: BIES's own LibreTranslate (nginx /translate/). Nothing
 * goes to outside services: members' posts stay on BIES.
 */

const cache = new Map();

// The app has no same-origin server: it reaches the API's host (VITE_API_URL).
const LIBRE_URL = `${(import.meta.env.VITE_API_URL || '').replace(/\/api\/?$/, '')}/translate/translate`;

async function callTranslateApi(text, source, target, format = 'text') {
    const res = await fetch(LIBRE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: text, source, target, format }),
        signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Translation failed (${res.status})`);
    const data = await res.json();
    if (!data.translatedText) throw new Error('Translation failed');
    return data.translatedText;
}

/**
 * Translate plain text.
 */
export async function translateText(text, source = 'en', target = 'es') {
    if (!text || !text.trim()) return text;

    const cacheKey = `${source}|${target}|${text}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);

    const translated = await callTranslateApi(text, source, target, 'text');
    cache.set(cacheKey, translated);
    return translated;
}

/**
 * Translate HTML content, as plain text (its formatting is lost).
 */
export async function translateHtml(html, source = 'en', target = 'es') {
    if (!html || !html.trim()) return html;

    const cacheKey = `html|${source}|${target}|${html}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);

    // Plain text from the HTML, through an inert parser (nothing in it loads or runs).
    const plainText = new DOMParser().parseFromString(html, 'text/html').body.textContent || '';

    if (!plainText.trim()) return html;

    const translated = await callTranslateApi(plainText, source, target, 'text');
    // Wrap in a paragraph since we lost HTML formatting — escape to prevent injection
    const escaped = translated.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const result = `<p>${escaped}</p>`;
    cache.set(cacheKey, result);
    return result;
}

export function clearCache() {
    cache.clear();
}

export default { translateText, translateHtml, clearCache };
