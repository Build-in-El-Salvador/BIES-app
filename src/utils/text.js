/**
 * Strips HTML tags from a string and decodes basic entities.
 * Useful for providing plain-text previews of rich-text content in thumbnails/cards.
 */
export const stripHtml = (html) => {
    if (!html || typeof html !== 'string') return '';
    
    try {
        if (typeof DOMParser !== 'undefined') {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            return doc.body.textContent || "";
        }
    } catch (e) {
        // Fallback
    }
    
    return html.replace(/<[^>]*>?/gm, '');
};

/**
 * The text of rich-text HTML, as it reads: a line for each line break, block
 * and list item, and a blank line after a paragraph (stripHtml runs them
 * together). A contentEditable's "Line one<div>Line two</div>" is two lines.
 */
export const htmlToText = (html) => {
    if (!html || typeof html !== 'string') return '';
    const lines = html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<(div|p|li|h[1-6]|blockquote|tr)\b[^>]*>/gi, '\n$&')
        .replace(/<\/(p|h[1-6]|blockquote)>/gi, '$&\n');
    return stripHtml(lines).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
};
