/**
 * The community rules' word filter, for text that doesn't go through the
 * BIES server: Feed posts and replies, signed in the app and sent to the
 * BIES relay. The app checks them before signing; the relay's proxy
 * (relay-proxy/index.js) checks them again and refuses them.
 *
 * A copy of server/src/services/contentFilter.ts (which explains the
 * choice of words), kept byte-for-byte the same in two places, each built
 * on its own: src/utils/contentFilter.js (the app) and
 * relay-proxy/contentFilter.js (the proxy). Change all three together:
 * server/src/__tests__/contentFilterCopies.test.ts fails when they differ.
 *
 * Plain JavaScript with no imports, so it runs in the app, in the proxy and
 * under `node --test`.
 */

// Single words, without accents.
export const WORDS = [
    // English slurs
    'nigger', 'niggers', 'nigga', 'niggas', 'faggot', 'faggots', 'wetback', 'wetbacks',
    // English sexual and degrading terms
    'cunt', 'cunts', 'whore', 'whores', 'slut', 'sluts', 'porno', 'blowjob', 'blowjobs',
    'cumshot', 'gangbang', 'kys',
    // Spanish slurs and sexual insults
    'maricon', 'maricones', 'joto', 'jotos', 'sudaca', 'sudacas', 'puta', 'putas', 'puto', 'putos',
    'hijueputa', 'hijueputas', 'malparido', 'malparidos',
];

// Phrases, without accents, words separated by single spaces.
export const PHRASES = ['kill yourself', 'hijo de puta', 'hijos de puta', 'suicidate'];

const BLOCKED = new Set(WORDS);

const LETTER_SWAPS = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };

// Cyrillic and Greek letters that look like Latin ones.
const LOOKALIKES = {
    'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'і': 'i', 'ї': 'i', 'ј': 'j', 'к': 'k', 'м': 'm', 'н': 'h',
    'о': 'o', 'р': 'p', 'с': 'c', 'ѕ': 's', 'т': 't', 'у': 'y', 'х': 'x', 'ԁ': 'd', 'ɡ': 'g',
    'α': 'a', 'β': 'b', 'γ': 'y', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't',
    'υ': 'u', 'χ': 'x',
};

// Formatting tags inside a word (<b>ni</b>gger) go without a trace; other tags
// separate words. Invisible characters (zero-width spaces, soft hyphens) go.
const INLINE_TAG = /^<\/?(?:a|b|i|u|s|em|strong|span|mark|small|sub|sup|font|code)\b/i;
const INVISIBLE = /\p{Cf}/gu;

// Text past this is not screened.
const MAX_SCREENED = 100_000;

/** Tags out, in one pass (see the server's copy for why not a regular expression). */
function withoutTags(text) {
    let out = '';
    let at = 0;
    while (at < text.length) {
        const open = text.indexOf('<', at);
        if (open === -1) break;
        const close = text.indexOf('>', open + 1);
        if (close === -1) break;
        out += text.slice(at, open) + (INLINE_TAG.test(text.slice(open, Math.min(close, open + 12))) ? '' : ' ');
        at = close + 1;
    }
    return out + text.slice(at);
}

/**
 * Lower-case words separated by spaces: tags and invisible characters gone,
 * look-alikes and accents folded to plain letters, and letter swaps undone
 * in words that have letters ("f4gg0t", but not "$500").
 */
export function normalize(text) {
    return withoutTags(String(text).slice(0, MAX_SCREENED))
        .replace(INVISIBLE, '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^\x00-\x7f]/g, (c) => LOOKALIKES[c] ?? c)
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .split(/[^a-z0-9@$]+/)
        .map((token) => (/[a-z]/.test(token) ? token.replace(/[013457@$]/g, (c) => LETTER_SWAPS[c]) : ''))
        .map((token) => token.replace(/[^a-z]/g, ''))
        .filter(Boolean)
        .join(' ');
}

/** The first objectionable word or phrase in the text, or null. */
export function findObjectionable(text) {
    if (!text) return null;
    const normalized = normalize(text);
    if (!normalized) return null;
    for (const word of normalized.split(' ')) {
        if (BLOCKED.has(word)) return word;
    }
    const padded = ` ${normalized} `;
    for (const phrase of PHRASES) {
        if (padded.includes(` ${phrase} `)) return phrase;
    }
    return null;
}
