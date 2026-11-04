/**
 * A form's "couldn't save" in words: which fields to look at, from the
 * server's validation details ({ field, message }), never its raw text
 * ("phone: Invalid string: must match pattern…"). Pure, so it's tested.
 */

// The fields members fill in, by the name the server gives them.
const KNOWN = new Set([
    'name', 'title', 'phone', 'whatsapp', 'email', 'website', 'instagram', 'location',
    'locationAddress', 'locationName', 'hours', 'about', 'bio', 'company', 'links', 'pricing',
    'category', 'languages', 'products', 'skills', 'onlineUrl', 'description', 'link', 'year',
]);

/** "the phone number", "the website": the field's own words, or its name spelled out. */
function label(t, field) {
    const key = String(field || '').split('.')[0];
    if (KNOWN.has(key)) return t(`common.fieldNames.${key}`);
    return key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() || t('common.fieldNames.something');
}

/** "Check the phone number and the website, then try again." */
export function fieldErrorText(t, details) {
    const names = [...new Set((Array.isArray(details) ? details : []).map((d) => label(t, d?.field)))];
    if (!names.length) return t('common.checkTheForm');
    const and = t('common.and');
    const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} ${and} ${names[names.length - 1]}`;
    return t('common.checkFields', { fields: list });
}
