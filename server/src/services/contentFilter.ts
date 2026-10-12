/**
 * A first line of defence against objectionable text in what members publish
 * through BIES (profiles, directory listings, recommendations): App Store
 * guideline 1.2 asks for "a method for filtering objectionable material".
 * Reports and moderators remain the main tool (moderation.service.ts).
 *
 * Deliberately short and unambiguous: slurs and explicit sexual terms in
 * English and Spanish, matched as whole words after lower-casing, removing
 * accents and undoing common letter swaps. Words with everyday uses in El
 * Salvador are left out on purpose ("negro" is a colour, "rapé" is snuff,
 * "vergón" means great); a false positive on a farm listing costs more trust
 * than this filter earns. Report text is never filtered: a report may need to
 * quote what it reports.
 */

// Single words, without accents.
const WORDS = [
    // English slurs
    'nigger', 'niggers', 'nigga', 'niggas', 'faggot', 'faggots', 'fag', 'fags', 'kike', 'kikes',
    'chink', 'chinks', 'spic', 'spics', 'wetback', 'wetbacks', 'tranny', 'trannies', 'retard', 'retards',
    // English sexual and degrading terms
    'cunt', 'cunts', 'whore', 'whores', 'slut', 'sluts', 'porn', 'porno', 'blowjob', 'blowjobs',
    'cumshot', 'gangbang', 'kys',
    // Spanish slurs and sexual insults
    'maricon', 'maricones', 'joto', 'jotos', 'sudaca', 'sudacas', 'puta', 'putas', 'puto', 'putos',
    'hijueputa', 'hijueputas', 'malparido', 'malparidos',
];

// Phrases, without accents, words separated by single spaces.
const PHRASES = ['kill yourself', 'hijo de puta', 'hijos de puta', 'matate', 'suicidate'];

const BLOCKED = new Set(WORDS);

const LETTER_SWAPS: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };

/** Lower-case, accents removed, common letter swaps undone, words split by spaces. */
export function normalize(text: string): string {
    return text
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[013457@$]/g, (c) => LETTER_SWAPS[c])
        .replace(/[^a-z]+/g, ' ')
        .trim();
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
