/**
 * Edit profile → custom sections: whether one has anything to show. A section
 * a member added and left blank (no words, no photo, no chart) would otherwise
 * show on their profile as an empty box.
 */

// Words in a TEXT section's rich text, without its tags and spaces.
const textOf = (html) => String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .trim();

/** A section shows when it has words, a photo, photos or a chart's points. A title alone isn't enough. */
export function sectionHasContent(section) {
    if (!section || typeof section !== 'object') return false;
    const type = section.type || 'TEXT';
    if (type === 'TEXT') {
        const html = section.body || section.content;
        return !!textOf(html) || /<(img|video|iframe)\b/i.test(String(html || ''));
    }
    if (type === 'PHOTO') return !!section.imageUrl;
    if (type === 'CAROUSEL') return Array.isArray(section.images) && section.images.some(Boolean);
    // A chart counts once it has a point the member filled in: a new one
    // starts with an example point ("Data 1", 100), which isn't theirs.
    if (type === 'GRAPH') {
        return Array.isArray(section.dataPoints)
            && section.dataPoints.some((d) => d && !(d.label === 'Data 1' && String(d.value) === '100'));
    }
    return false;
}
