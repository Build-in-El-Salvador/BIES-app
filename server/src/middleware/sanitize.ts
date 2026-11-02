/**
 * Input sanitization middleware.
 *
 * Strips HTML tags from string fields to prevent stored XSS.
 * Applied globally to all request bodies, query params, and URL params.
 *
 * Note: Does NOT encode for HTML — that's the frontend's responsibility.
 * This layer removes injection vectors at the ingress point.
 */

import { Request, Response, NextFunction } from 'express';

/**
 * Takes out every stretch from a match of `open` to the first match of
 * `close` after it, as `.replace(/open[\s\S]*?close/g, '')` does. Both carry
 * the g flag: their lastIndex says where to look.
 */
function removeSpans(str: string, open: RegExp, close: RegExp): string {
    let out = '';
    let kept = 0;
    open.lastIndex = 0;
    for (let start = open.exec(str); start; start = open.exec(str)) {
        close.lastIndex = start.index + start[0].length;
        const end = close.exec(str);
        // Nothing closes this one, so nothing closes a later one either.
        if (!end) break;
        out += str.slice(kept, start.index);
        kept = end.index + end[0].length;
        open.lastIndex = kept;
    }
    return out + str.slice(kept);
}

/**
 * Takes out every tag: a "<", at least one character, and the first ">" after it (`<[^>]+>`),
 * in one pass (the regular expression takes time growing with the square of the text).
 */
export function removeTags(str: string): string {
    let out = '';
    let kept = 0;
    for (let lt = str.indexOf('<'); lt !== -1;) {
        const gt = str.indexOf('>', lt + 1);
        // No ">" after this "<", so none after a later one either.
        if (gt === -1) break;
        if (gt > lt + 1) {
            out += str.slice(kept, lt);
            kept = gt + 1;
            lt = str.indexOf('<', kept);
        } else {
            // "<>" isn't a tag.
            lt = str.indexOf('<', lt + 1);
        }
    }
    return out + str.slice(kept);
}

const DATA_URI = /data\s*:/gi;
const BASE64 = /;base64/gi;

/**
 * Takes out "data:" up to the last ";base64" before the next comma, as
 * `.replace(/data\s*:[^,]*;base64/gi, '')` does.
 */
function removeBase64DataUris(str: string): string {
    let out = '';
    let kept = 0;
    DATA_URI.lastIndex = 0;
    for (let start = DATA_URI.exec(str); start; start = DATA_URI.exec(str)) {
        const from = DATA_URI.lastIndex;
        const comma = str.indexOf(',', from);
        const until = comma === -1 ? str.length : comma;
        // Looked for only up to that comma, so no stretch is searched twice.
        const stretch = str.slice(from, until);
        let end = -1;
        BASE64.lastIndex = 0;
        for (let found = BASE64.exec(stretch); found; found = BASE64.exec(stretch)) end = from + BASE64.lastIndex;
        if (end !== -1) {
            out += str.slice(kept, start.index);
            kept = end;
        }
        // A later "data:" before that comma ends at the same comma, with no
        // ";base64" left before it.
        DATA_URI.lastIndex = until;
    }
    return out + str.slice(kept);
}

const TAG_END = />/g;

// Blocks that go with what's in them.
const SCRIPT_AND_STYLE: ReadonlyArray<[RegExp, RegExp]> = [
    [/<script/gi, /<\/script>/gi],
    [/<style/gi, /<\/style>/gi],
];

// Lightweight HTML tag stripper — applied recursively, handles nested tag reconstruction
function stripTags(str: string): string {
    let prev = '';
    let result = str;
    // Loop to handle nested/reconstructed tags (e.g. <scr<script>ipt>)
    while (result !== prev) {
        prev = result;
        // Script and style blocks, then the remaining tags.
        for (const [open, close] of SCRIPT_AND_STYLE) result = removeSpans(result, open, close);
        result = removeTags(result);
    }
    return result;
}

function sanitizeValue(value: unknown, key?: string): unknown {
    if (typeof value === 'string') {
        if (key && RICH_HTML_FIELDS.has(key)) {
            return sanitizeRichHtml(value);
        }
        return stripTags(value.trim());
    }
    if (Array.isArray(value)) {
        return value.map(item => sanitizeValue(item, key));
    }
    if (value !== null && typeof value === 'object') {
        return sanitizeObject(value as Record<string, unknown>);
    }
    return value;
}

// Fields that must never be sanitized (encrypted data and passwords)
const EXEMPT_FIELDS = new Set(['encryptedPrivkey', 'password']);

// Fields that contain rich HTML (user-authored formatted text).
// These get a lighter sanitization: dangerous tags/attributes are removed,
// but safe formatting tags (<b>, <i>, <u>, <span>, <p>, <div>, etc.) are preserved.
const RICH_HTML_FIELDS = new Set(['description', 'body', 'content', 'bio']);

// Decode HTML entities so encoded payloads (&#106;avascript:, &#x6A;, etc.) are caught.
function decodeHtmlEntities(str: string): string {
    return str
        .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/&#(\d+);?/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
        .replace(/&tab;|&newline;/gi, '');
}

// What rich HTML loses, in this order: blocks with what's in them, and tags
// up to their ">".
const DANGEROUS_HTML: ReadonlyArray<[RegExp, RegExp]> = [
    ...SCRIPT_AND_STYLE,
    [/<iframe/gi, /<\/iframe>/gi],
    [/<object/gi, TAG_END],
    [/<embed/gi, TAG_END],
    [/<form/gi, /<\/form>/gi],
    [/<form/gi, TAG_END],
];

const ALIGN = /(?:^|;)\s*text-align\s*:\s*(left|center|right|justify|start|end)\s*(?=;|$)/i;

// How a browser reads tags (the HTML standard's tokenizer). Space is tab,
// line feed, form feed, carriage return (read as a line feed) or space.
const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\n' || c === '\t' || c === '\f' || c === '\r';
const isLetter = (c: string | undefined): boolean => !!c && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));

// After these a browser reads what follows as plain text (script, style,
// textarea, title…), or by SVG's or MathML's rules, and whether it does can
// depend on where the text ends up. So these tags go (the words stay) and
// rich text is read one way only: the way readTag reads it.
const CONTEXT_TAGS = new Set([
    'script', 'style', 'iframe', 'textarea', 'title', 'xmp', 'noembed', 'noframes', 'noscript', 'plaintext', 'svg', 'math',
]);

interface TagRead {
    /** Just past its ">", or the end of the text if it has none. */
    end: number;
    /** Its name, lowercased. */
    name: string;
    /** Its style attributes: where each starts and ends, and its value. */
    styles: Array<{ start: number; end: number; value: string }>;
}

/**
 * The tag starting at `lt` ("<" and a letter, or "</" and a letter), read as
 * a browser reads it: a ">" inside a quoted attribute value doesn't end it.
 * Looks only as far as its end.
 */
function readTag(str: string, lt: number): TagRead {
    const n = str.length;
    let i = str[lt + 1] === '/' ? lt + 2 : lt + 1;
    const nameStart = i;
    while (i < n && !isSpace(str[i]) && str[i] !== '/' && str[i] !== '>') i++;
    const name = str.slice(nameStart, i).toLowerCase();
    const styles: TagRead['styles'] = [];
    while (i < n) {
        const c = str[i];
        if (isSpace(c) || c === '/') {
            i++;
            continue;
        }
        if (c === '>') return { end: i + 1, name, styles };
        // An attribute: its name (an "=" first is part of it), then perhaps
        // "=" and a value, in double or single quotes or none.
        const start = i++;
        while (i < n && !isSpace(str[i]) && str[i] !== '/' && str[i] !== '>' && str[i] !== '=') i++;
        const attrName = str.slice(start, i);
        let value = '';
        let j = i;
        while (isSpace(str[j])) j++;
        if (str[j] === '=') {
            j++;
            while (isSpace(str[j])) j++;
            const quote = str[j];
            if (quote === '"' || quote === "'") {
                const close = str.indexOf(quote, j + 1);
                value = str.slice(j + 1, close === -1 ? n : close);
                i = close === -1 ? n : close + 1;
            } else {
                const from = j;
                // Unquoted, up to a space or ">" (just "=" before ">": no value).
                while (j < n && !isSpace(str[j]) && str[j] !== '>') j++;
                value = str.slice(from, j);
                i = j;
            }
        }
        if (attrName.toLowerCase() === 'style') styles.push({ start, end: i, value });
    }
    return { end: n, name, styles };
}

/** Where a comment ends ("-->", "--!>"), from just after its "<!--"; the end of the text if nowhere. */
function commentEnd(str: string, from: number): number {
    if (str[from] === '>') return from + 1; // "<!-->"
    if (str.startsWith('->', from)) return from + 2; // "<!--->"
    for (let dashes = str.indexOf('--', from); dashes !== -1; dashes = str.indexOf('--', dashes + 1)) {
        if (str[dashes + 2] === '>') return dashes + 3;
        if (str[dashes + 2] === '!' && str[dashes + 3] === '>') return dashes + 4;
    }
    return str.length;
}

/** Where "<!…>", "<?…>" and "</ …>" end: the first ">" from `from` (the end of the text if none). */
function firstGt(str: string, from: number): number {
    const gt = str.indexOf('>', from);
    return gt === -1 ? str.length : gt + 1;
}

/**
 * Inline styles in rich HTML keep only text alignment (the editor's align
 * buttons write it), as the app shows them (src/utils/memberHtml.js), and
 * CONTEXT_TAGS go. One pass, reading tags, attributes (quoted or not) and
 * comments as a browser does; each part is looked at once.
 */
export function keepAlignmentOnly(str: string): string {
    const out: string[] = [];
    let copied = 0; // str before this is in `out`
    for (let i = 0; i < str.length;) {
        const lt = str.indexOf('<', i);
        if (lt === -1) break;
        const next = str[lt + 1];
        if (isLetter(next) || (next === '/' && isLetter(str[lt + 2]))) {
            const tag = readTag(str, lt);
            if (CONTEXT_TAGS.has(tag.name)) {
                const before = str.slice(copied, lt);
                // A "<" of the text just before it would now open whatever follows.
                out.push(before.endsWith('<') ? `${before.slice(0, -1)}&lt;` : before);
                copied = tag.end;
            } else if (tag.styles.length > 0) {
                out.push(str.slice(copied, lt));
                let at = lt;
                for (const style of tag.styles) {
                    out.push(str.slice(at, style.start));
                    const align = ALIGN.exec(style.value);
                    if (align) out.push(`style="text-align: ${align[1].toLowerCase()}"`);
                    at = style.end;
                }
                out.push(str.slice(at, tag.end));
                copied = tag.end;
            }
            i = tag.end;
        } else if (next === '!') {
            i = str.startsWith('<!--', lt) ? commentEnd(str, lt + 4) : firstGt(str, lt + 2);
        } else if (next === '?') {
            i = firstGt(str, lt + 1);
        } else if (next === '/' && lt + 2 < str.length && str[lt + 2] !== '>') {
            i = firstGt(str, lt + 2);
        } else {
            // A "<" of the text ("</>" a browser drops).
            i = lt + 1;
        }
    }
    out.push(str.slice(copied));
    return out.join('');
}

// Strip only dangerous content from rich HTML, preserving safe formatting tags.
function sanitizeRichHtml(str: string): string {
    // Decode entities first, so encoded attributes are caught too. Not a full
    // sanitizer: every page that shows rich HTML runs DOMPurify too.
    let result = decodeHtmlEntities(str);
    for (const [open, close] of DANGEROUS_HTML) result = removeSpans(result, open, close);
    result = result
        // Event handlers, after a space, slash or quote ("<img/onerror=").
        .replace(/[\s/"']on\w+\s*=\s*"[^"]*"/gi, ' ')
        .replace(/[\s/"']on\w+\s*=\s*'[^']*'/gi, ' ')
        .replace(/[\s/"']on\w+\s*=\s*[^\s>]*/gi, ' ');

    // Then the javascript: protocol (catches &#106;avascript: etc.)
    result = result.replace(/javascript\s*:/gi, '');
    // Also strip vbscript: and data: URIs in attributes (additional protocol vectors)
    result = removeBase64DataUris(result.replace(/vbscript\s*:/gi, ''));

    return keepAlignmentOnly(result).trim();
}

function sanitizeObject(obj: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
        if (EXEMPT_FIELDS.has(key)) {
            sanitized[key] = val;
        } else {
            sanitized[key] = sanitizeValue(val, key);
        }
    }
    return sanitized;
}

// Routes whose bodies must reach the handler unchanged. The hosted signer
// signs exactly what the member's app sent (stripping or trimming would sign
// different text) and stores none of it; Nostr content is escaped by whatever
// displays it. The account routes check signed events, whose id covers the
// content: any change would break the signature. They store no text.
// Reports carry a signed note the same way; the report text they store is
// only ever shown escaped (React in Admin → Reports, the moderator email).
const UNSANITIZED_PREFIXES = ['/api/signer/', '/api/account/', '/api/reports'];

/**
 * Sanitize req.body, req.query, and req.params.
 */
export function sanitize(req: Request, _res: Response, next: NextFunction): void {
    // Match paths the way Express routes them: any case, repeated slashes collapsed.
    const path = req.path.toLowerCase().replace(/\/{2,}/g, '/');
    if (UNSANITIZED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
        next();
        return;
    }
    if (req.body && typeof req.body === 'object') {
        req.body = sanitizeObject(req.body);
    }
    // Sanitize query parameters (common XSS vector via reflected values)
    if (req.query && typeof req.query === 'object') {
        (req as any).query = sanitizeObject(req.query as Record<string, unknown>);
    }
    // Sanitize URL parameters
    if (req.params && typeof req.params === 'object') {
        (req as any).params = sanitizeObject(req.params as Record<string, unknown>) as Record<string, string>;
    }
    next();
}
