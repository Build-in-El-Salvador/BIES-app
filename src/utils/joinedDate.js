/**
 * When a member joined BIES, as X shows it: the month and year
 * ("October 2026", "octubre de 2026"), or null without a date.
 */
export function joinedDate(createdAt, language) {
    const time = createdAt ? Date.parse(createdAt) : NaN;
    return Number.isNaN(time) ? null : new Date(time).toLocaleDateString(language, { month: 'long', year: 'numeric' });
}
