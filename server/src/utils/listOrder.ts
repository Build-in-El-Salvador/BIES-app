/**
 * The list orders the database can't give as people expect them, so the
 * list endpoints sort these in code: A–Z as people read it (SQLite orders by
 * bytes, which puts "Árbol" and "iShop" after "Zona"), and orders that put a
 * missing value last whichever the direction (no price, no closing day).
 * Every match's few sort fields are sorted, then only the page's rows are
 * fetched in full. The directory, Opportunities, Talents and Members lists
 * are hundreds of rows, not millions.
 */

type Row = { id: string };
type Compare<T> = (a: T, b: T) => number;

const collator = new Intl.Collator('es', { sensitivity: 'base', numeric: true });

/** A–Z, ignoring case and accents ("árbol" between "Arbor" and "Arca"). */
export function alphabetical<T>(text: (row: T) => string | null | undefined): Compare<T> {
    return (a, b) => collator.compare((text(a) || '').trim(), (text(b) || '').trim());
}

/** A business's price level: "$" to "$$$$" as 1 to 4; free text or none has no level. */
export function priceLevel(pricing: string | null | undefined): number | null {
    const match = /^\s*(\${1,4})\s*$/.exec(pricing || '');
    return match ? match[1].length : null;
}

/**
 * By `value`, low to high (1) or high to low (-1); rows without one ('' or
 * none) come last either way.
 */
export function missingLast<T>(value: (row: T) => number | string | null | undefined, direction: 1 | -1): Compare<T> {
    return (a, b) => {
        const x = value(a);
        const y = value(b);
        const xMissing = x === null || x === undefined || x === '';
        const yMissing = y === null || y === undefined || y === '';
        if (xMissing || yMissing) return xMissing === yMissing ? 0 : xMissing ? 1 : -1;
        return (x! < y! ? -1 : x! > y! ? 1 : 0) * direction;
    };
}

/** Newest first. */
export function newestFirst<T>(at: (row: T) => Date): Compare<T> {
    return (a, b) => at(b).getTime() - at(a).getTime();
}

/** The first comparison that tells two rows apart decides; then the id, so pages keep one order. */
export function inOrder<T extends Row>(...compares: Compare<T>[]): Compare<T> {
    return (a, b) => {
        for (const compare of compares) {
            const result = compare(a, b);
            if (result) return result;
        }
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    };
}

/** The ids on one page of `rows` in this order. */
export function pageIds<T extends Row>(rows: T[], compare: Compare<T>, skip: number, take: number): string[] {
    return [...rows].sort(compare).slice(skip, skip + take).map((row) => row.id);
}

/** Rows fetched by id (in any order) put back in the order of `ids`. */
export function inIdOrder<T extends Row>(ids: string[], rows: T[]): T[] {
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.map((id) => byId.get(id)).filter((row): row is T => !!row);
}
