/**
 * Run members' saved formatted text through the request sanitizer's last
 * step again (keepAlignmentOnly, middleware/sanitize.ts), as text saved now
 * goes through it: inline styles keep only their alignment, and tags after
 * which a browser reads text another way (textarea, title, svg…) go, their
 * words staying. For text saved before that step read tags as a browser does.
 *
 * Only that step: the earlier ones (entities, scripts, handlers) ran when the
 * text was saved, and running them twice would decode entities twice. A
 * value is written only if the step changes it, and only if it is still the
 * value read (a member may be editing it); "last updated" dates are kept.
 *
 * The fields: those the sanitizer treats as formatted text (description,
 * body, content, bio), including inside JSON lists (custom sections, a
 * profile's experience). Messages, notifications and lessons aren't touched.
 *
 * Dry run by default, or with --dry-run: counts what would change, nothing
 * else. --apply makes the changes. The running server caches lists for
 * 2 minutes and profiles for 5.
 *
 *   docker exec bies-bies-server-1 node dist/src/scripts/recleanRichText.js [--dry-run | --apply]
 */
import prisma from '../lib/prisma';
import { keepAlignmentOnly } from '../middleware/sanitize';

interface Table {
    model: 'profile' | 'project' | 'projectUpdate' | 'event' | 'article' | 'video' | 'legalResource' | 'album' | 'course' | 'bounty' | 'bountySubmission';
    /** Columns holding formatted text. */
    text: string[];
    /** JSON columns whose description / body / content / bio entries are formatted text. */
    json: string[];
    /** Has a "last updated" date, kept as it was. */
    updatedAt: boolean;
}

const TABLES: Table[] = [
    { model: 'profile', text: ['bio'], json: ['experience', 'customSections'], updatedAt: true },
    { model: 'project', text: ['description'], json: ['customSections'], updatedAt: true },
    { model: 'projectUpdate', text: ['content'], json: [], updatedAt: false },
    { model: 'event', text: ['description'], json: ['customSections'], updatedAt: true },
    { model: 'article', text: ['content'], json: [], updatedAt: true },
    { model: 'video', text: ['description'], json: [], updatedAt: false },
    { model: 'legalResource', text: ['description'], json: [], updatedAt: false },
    { model: 'album', text: ['description'], json: [], updatedAt: true },
    { model: 'course', text: ['description'], json: [], updatedAt: true },
    { model: 'bounty', text: ['description'], json: [], updatedAt: true },
    { model: 'bountySubmission', text: ['content'], json: [], updatedAt: true },
];

// As the sanitizer: these keys hold formatted text wherever they are.
const RICH_KEYS = new Set(['description', 'body', 'content', 'bio']);

/** The value after the step (trimmed, as saving trims), or itself if the step leaves it alone. Pure. */
export function recleaned(value: string): string {
    if (!value.includes('<')) return value;
    const cleaned = keepAlignmentOnly(value);
    return cleaned === value ? value : cleaned.trim();
}

/** A JSON column's value after the step, or itself if nothing in it changes. Pure. */
export function recleanedJson(raw: string): string {
    if (!raw.includes('<')) return raw;
    let changed = false;
    const walk = (value: unknown, key?: string): unknown => {
        if (typeof value === 'string') {
            if (!key || !RICH_KEYS.has(key)) return value;
            const cleaned = recleaned(value);
            if (cleaned !== value) changed = true;
            return cleaned;
        }
        if (Array.isArray(value)) return value.map((item) => walk(item, key));
        if (value && typeof value === 'object') {
            return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
        }
        return value;
    };
    try {
        const cleaned = walk(JSON.parse(raw));
        return changed ? JSON.stringify(cleaned) : raw;
    } catch {
        return raw; // not JSON: left as it is
    }
}

async function main(): Promise<void> {
    const apply = process.argv.includes('--apply') && !process.argv.includes('--dry-run');
    console.log(`[Reclean] formatted text through keepAlignmentOnly${apply ? '' : ' (dry run: counting only, nothing changes)'}`);

    let total = 0;
    for (const table of TABLES) {
        // A dynamic table, from the fixed list above.
        const delegate = (prisma as any)[table.model];
        const columns = [...table.text, ...table.json];
        const rows: Array<Record<string, any>> = await delegate.findMany({
            where: { OR: columns.map((column) => ({ [column]: { contains: '<' } })) },
            select: Object.fromEntries([['id', true], ...columns.map((c) => [c, true]), ...(table.updatedAt ? [['updatedAt', true]] : [])]),
        });

        for (const column of columns) {
            const clean = table.json.includes(column) ? recleanedJson : recleaned;
            let would = 0;
            let written = 0;
            for (const row of rows) {
                const value = row[column];
                if (typeof value !== 'string') continue;
                const cleaned = clean(value);
                if (cleaned === value) continue;
                would++;
                if (!apply) continue;
                // Only if it is still what was read; its "last updated" date stays.
                const result = await delegate.updateMany({
                    where: { id: row.id, [column]: value },
                    data: { [column]: cleaned, ...(table.updatedAt ? { updatedAt: row.updatedAt } : {}) },
                });
                written += result.count;
                row[column] = cleaned;
            }
            if (would > 0) {
                console.log(`[Reclean] ${table.model}.${column}: ${apply ? `${written} of ${would} changed` : `${would} would change`}`);
            }
            total += apply ? written : would;
        }
    }
    console.log(`[Reclean] ${apply ? 'changed' : 'would change'} ${total} value(s) in all`);
}

if (require.main === module) {
    main().then(async () => { await prisma.$disconnect(); process.exit(0); }, async (error) => {
        console.error('[Reclean] stopped:', error);
        await prisma.$disconnect();
        process.exit(1);
    });
}
