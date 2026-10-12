/**
 * A first line of defence against objectionable text in what members publish
 * through BIES (profiles, directory listings, recommendations): App Store
 * guideline 1.2 asks for "a method for filtering objectionable material".
 * Reports and moderators remain the main tool (moderation.service.ts).
 *
 * Deliberately short and unambiguous: slurs and explicit sexual terms in
 * English and Spanish, matched as whole words after lower-casing, removing
 * accents and undoing common letter swaps and look-alike characters. Words
 * with everyday uses are left out on purpose: "negro" is a colour, "rapé" is
 * snuff, "vergón" means great, Kike is short for Enrique, a matate is a pita
 * bag, cold storage retards ripening, a tranny is a gearbox. A false positive
 * on a farm listing costs more trust than this filter earns. Report text is
 * never filtered: a report may need to quote what it reports.
 */

// Single words, without accents.
const WORDS = [
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
const PHRASES = ['kill yourself', 'hijo de puta', 'hijos de puta', 'suicidate'];

const BLOCKED = new Set(WORDS);

const LETTER_SWAPS: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };

// Cyrillic and Greek letters that look like Latin ones.
const LOOKALIKES: Record<string, string> = {
    'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'і': 'i', 'ї': 'i', 'ј': 'j', 'к': 'k', 'м': 'm', 'н': 'h',
    'о': 'o', 'р': 'p', 'с': 'c', 'ѕ': 's', 'т': 't', 'у': 'y', 'х': 'x', 'ԁ': 'd', 'ɡ': 'g',
    'α': 'a', 'β': 'b', 'γ': 'y', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't',
    'υ': 'u', 'χ': 'x',
};

// Formatting tags inside a word (<b>ni</b>gger) go without a trace; other tags
// separate words. Invisible characters (zero-width spaces, soft hyphens) go.
const INLINE_TAGS = /<\/?(?:a|b|i|u|s|em|strong|span|mark|small|sub|sup|font|code)\b[^>]*>/gi;
const OTHER_TAGS = /<[^>]*>/g;
const INVISIBLE = /\p{Cf}/gu;

/**
 * Lower-case words separated by spaces: tags and invisible characters gone,
 * look-alikes and accents folded to plain letters, and letter swaps undone
 * in words that have letters ("f4gg0t", but not "$500").
 */
export function normalize(text: string): string {
    return text
        .replace(INLINE_TAGS, '')
        .replace(OTHER_TAGS, ' ')
        .replace(INVISIBLE, '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^\x00-\x7f]/g, (c) => LOOKALIKES[c] ?? c)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .split(/[^a-z0-9@$]+/)
        .map((token) => (/[a-z]/.test(token) ? token.replace(/[013457@$]/g, (c) => LETTER_SWAPS[c]) : ''))
        .map((token) => token.replace(/[^a-z]/g, ''))
        .filter(Boolean)
        .join(' ');
}

/** The first objectionable word or phrase in the text, or null. */
export function findObjectionable(text: string | null | undefined): string | null {
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

/**
 * Check several fields. Returns the first field that holds objectionable
 * text, or null. Values that aren't strings (numbers, arrays of strings,
 * nested objects) are checked through their string contents.
 */
export function objectionableField(fields: Record<string, unknown>): string | null {
    for (const [name, value] of Object.entries(fields)) {
        if (findObjectionable(textOf(value))) return name;
    }
    return null;
}

function textOf(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(textOf).join(' ');
    if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).map(textOf).join(' ');
    return '';
}

/** The answer a route gives when a field holds objectionable text. */
export function objectionableResponse(field: string) {
    return {
        error: 'This contains words that break our community rules. Please change it.',
        reason: 'objectionable_content',
        field,
    };
}
