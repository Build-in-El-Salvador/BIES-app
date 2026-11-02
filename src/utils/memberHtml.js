import DOMPurify from 'dompurify';

/**
 * Formatted text members write, as pages show it. Each kind is a list of the
 * tags and attributes it keeps; anything else goes (its words stay).
 *
 * - Member text (bios, event and listing descriptions, project updates, what
 *   the editor takes in on paste): paragraphs and line breaks, bold, italic,
 *   underline and strikethrough, lists, quotes, small headings, code, links.
 * - Documents (lesson and course markdown, articles): all that, plus pictures,
 *   tables, every heading, rules, and a task list's boxes, ticked or not,
 *   never clickable.
 *
 * Of inline styles both keep only text alignment, which the editor's align
 * buttons write. Classes, ids, names and data attributes never stay, so a
 * member's text can't take on the app's own look or the names of its parts.
 * The server keeps to the same alignment rule when it saves
 * (server/src/middleware/sanitize.ts).
 */

const ALIGN = /(?:^|;)\s*text-align\s*:\s*(left|center|right|justify|start|end)\s*(?=;|$)/i;

/** The style a member's text keeps: its alignment, or nothing. Pure. */
export function keptStyle(style) {
    const match = ALIGN.exec(style || '');
    return match ? `text-align: ${match[1].toLowerCase()}` : '';
}

const MEMBER_TAGS = [
    'p', 'div', 'span', 'br',
    'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del',
    'a', 'ul', 'ol', 'li', 'blockquote',
    'h2', 'h3', 'h4', 'code', 'pre',
];
// `style` only for its alignment (keptStyle, in the hook below).
const MEMBER_ATTR = ['href', 'rel', 'style'];

/** What member text keeps. */
export const MEMBER_TEXT = Object.freeze({
    ALLOWED_TAGS: MEMBER_TAGS,
    ALLOWED_ATTR: MEMBER_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    SANITIZE_NAMED_PROPS: true,
});

/** What documents keep: member text and what markdown writes besides. */
export const DOCUMENT = Object.freeze({
    ...MEMBER_TEXT,
    ALLOWED_TAGS: [
        ...MEMBER_TAGS,
        'h1', 'h5', 'h6', 'hr', 'img',
        'table', 'thead', 'tbody', 'tr', 'th', 'td',
        // A task list's box ("- [x] done"): checkboxes only, never clickable (the hook below).
        'input',
    ],
    ALLOWED_ATTR: [...MEMBER_ATTR, 'title', 'src', 'alt', 'start', 'align', 'type', 'checked', 'disabled'],
});

/** Of form controls, a document keeps only a checkbox. Pure. */
export const keepsInput = (type) => String(type || '').toLowerCase() === 'checkbox';

function alignmentOnly(_node, data) {
    if (data.attrName !== 'style') return;
    const style = keptStyle(data.attrValue);
    if (style) data.attrValue = style;
    else data.keepAttr = false;
}

function taskBoxesOnly(node) {
    if (node.nodeName !== 'INPUT') return;
    if (keepsInput(node.getAttribute('type'))) node.setAttribute('disabled', '');
    else node.remove();
}

// Their own DOMPurify instances, so these rules don't touch other uses of it.
const purifiers = {};
function purifier(kind) {
    if (!purifiers[kind]) {
        const instance = DOMPurify(window);
        instance.addHook('uponSanitizeAttribute', alignmentOnly);
        if (kind === 'document') instance.addHook('afterSanitizeAttributes', taskBoxesOnly);
        purifiers[kind] = instance;
    }
    return purifiers[kind];
}

/** A member's formatted text, safe to show as HTML. */
export const cleanMemberHtml = (html) => purifier('member').sanitize(html || '', MEMBER_TEXT);

/** A document (markdown made HTML, an article), safe to show as HTML. */
export const cleanDocumentHtml = (html) => purifier('document').sanitize(html || '', DOCUMENT);
