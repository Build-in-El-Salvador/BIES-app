/**
 * Whether two business or farm names are probably the same place, however
 * each was typed: capitals, accents and punctuation; a missing or extra space
 * ("CasaFuego"); a typo ("Cassa Fuego"); the words in another order; small
 * words ("The", "La", "de"); a name cut short while typing ("Casa Fue"); or
 * more words on one of them ("Brutto" and "Brutto Restaurante"). Different
 * numbers are different places ("Hotel 1" and "Hotel 12"). For the
 * "Did you mean…?" when a member adds a listing (directory.controller.ts).
 */

/** At or above this, two names are probably the same place. */
export const SIMILAR = 0.8;

// Small words that don't tell two names apart.
const FILLER = new Set(['the', 'a', 'an', 'of', 'and', 'el', 'la', 'los', 'las', 'lo', 'un', 'una', 'de', 'del', 'y', 'e']);

/** A name's words as compared: no accents or capitals, no punctuation, no small words. */
export function nameWords(name: string): string[] {
    return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/['’`]/g, '')
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .split(' ')
        .filter((word) => word && !FILLER.has(word));
}

/** How many letters to add, take away or change to turn one into the other. */
export function editDistance(a: string, b: string): number {
    if (a === b) return 0;
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const current = [i];
        for (let j = 1; j <= b.length; j++) {
            current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        previous = current;
    }
    return previous[b.length];
}

/** The same word, a typo aside: one letter in a word of 4 or more, two in one of 8 or more. */
function sameWord(a: string, b: string): boolean {
    if (a === b) return true;
    const shorter = Math.min(a.length, b.length);
    return shorter >= 4 && editDistance(a, b) <= (shorter >= 8 ? 2 : 1);
}

/**
 * Whether every word of `few` is in `many`, in any order, each paired with a
 * different word. A one-word name must be there as it is ("Verdis" isn't in
 * "Pasos Verdes"); a longer one may have typos, with at least one word exact
 * ("Viva Vino" isn't "Viña Enoteca").
 */
function wordsWithin(few: string[], many: string[]): boolean {
    if (few.length === 1) return many.includes(few[0]);
    const unused = [...many];
    let exact = 0;
    // Exact words first, so a typo doesn't take another word's pair.
    const sorted = [...few].sort((a, b) => Number(many.includes(b)) - Number(many.includes(a)));
    for (const word of sorted) {
        let at = unused.indexOf(word);
        if (at !== -1) exact++;
        else at = unused.findIndex((other) => sameWord(word, other));
        if (at === -1) return false;
        unused.splice(at, 1);
    }
    return exact > 0;
}

const numbersIn = (words: string[]) => words.filter((word) => /\d/.test(word)).map((word) => word.replace(/\D/g, '')).sort().join(' ');

/** Every run of consecutive words, joined: where a space may have been missed. */
function runsOf(words: string[]): string[] {
    const runs: string[] = [];
    for (let i = 0; i < words.length; i++) {
        for (let j = i + 1; j <= words.length; j++) runs.push(words.slice(i, j).join(''));
    }
    return runs;
}

/** How alike two names are, from 0 to 1; SIMILAR or more is probably the same place. */
export function nameSimilarity(a: string, b: string): number {
    const wordsA = nameWords(a);
    const wordsB = nameWords(b);
    const lettersA = wordsA.join('');
    const lettersB = wordsB.join('');
    if (!lettersA || !lettersB) return 0;
    if (lettersA === lettersB) return 1;
    // Branches and numbered places differ by their number.
    const numbersA = numbersIn(wordsA);
    const numbersB = numbersIn(wordsB);
    if (numbersA && numbersB && numbersA !== numbersB) return 0;

    let score = 0;
    // A typo or two, or a space missed: nearly the same letters.
    const longest = Math.max(lettersA.length, lettersB.length);
    if (longest >= 6) score = Math.max(score, 1 - editDistance(lettersA, lettersB) / longest);

    // Every word of the shorter name in the longer, in any order.
    const [few, many] = wordsA.length <= wordsB.length ? [wordsA, wordsB] : [wordsB, wordsA];
    if (few.join('').length >= 4 && wordsWithin(few, many)) {
        score = Math.max(score, 0.8 + 0.2 * (few.length / many.length));
    }

    // One cut short (typing, or a word left off the end), or written as one
    // word where the other has a space.
    const [shortLetters, longLetters, longWords] = lettersA.length <= lettersB.length
        ? [lettersA, lettersB, wordsB] : [lettersB, lettersA, wordsA];
    if (shortLetters.length >= 4 && longLetters.startsWith(shortLetters)) score = Math.max(score, 0.8);
    if (shortLetters.length >= 5 && runsOf(longWords).some((run) => run === shortLetters
        || (run.length >= 8 && editDistance(run, shortLetters) <= 1))) {
        score = Math.max(score, 0.85);
    }
    return score;
}
