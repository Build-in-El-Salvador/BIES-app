import DOMPurify from 'dompurify';

/**
 * Formatted text members write (bios, event and listing descriptions,
 * articles, lessons) as pages show it: its words, formatting, lists and
 * links. Of inline styles it keeps only text alignment, which the editor's
 * align buttons write; classes, ids and form controls go too, so a member's
 * text can't take on the app's own look. The server keeps to the same when
 * it saves (server/src/middleware/sanitize.ts).
 */

const ALIGN = /(?:^|;)\s*text-align\s*:\s*(left|center|right|justify|start|end)\s*(?=;|$)/i;

/** The style a member's text keeps: its alignment, or nothing. Pure. */
export function keptStyle(style) {
    const match = ALIGN.exec(style || '');
    return match ? `text-align: ${match[1].toLowerCase()}` : '';
}

const OPTIONS = {
    FORBID_ATTR: ['class', 'id'],
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'option'],
};

let purifier = null;
// Its own DOMPurify, so the style rule doesn't touch other uses of it.
function memberPurifier() {
    if (!purifier) {
        purifier = DOMPurify(window);
        purifier.addHook('uponSanitizeAttribute', (_node, data) => {
            if (data.attrName !== 'style') return;
            const style = keptStyle(data.attrValue);
            if (style) data.attrValue = style;
            else data.keepAttr = false;
        });
    }
    return purifier;
}

/** A member's formatted text, safe to show as HTML. */
export const cleanMemberHtml = (html) => memberPurifier().sanitize(html || '', OPTIONS);
