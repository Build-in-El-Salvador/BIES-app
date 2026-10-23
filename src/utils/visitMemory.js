/**
 * What each visit to a page was showing (hooks/useVisitState.js), by its
 * history entry's key: in memory only, the newest MAX_VISITS. Pure, so tests
 * can import it.
 */
const visits = new Map();
const MAX_VISITS = 50;

/** The value `name` had on this visit, or `initial` (called, if a function). */
export function visitValue(visit, name, initial) {
    const kept = visits.get(visit);
    if (kept && Object.prototype.hasOwnProperty.call(kept, name)) return kept[name];
    return typeof initial === 'function' ? initial() : initial;
}

/** Remember `name` for this visit; the oldest visits go first. */
export function keepVisitValue(visit, name, value) {
    const kept = visits.get(visit) || {};
    visits.delete(visit);
    visits.set(visit, { ...kept, [name]: value });
    if (visits.size > MAX_VISITS) visits.delete(visits.keys().next().value);
}

export function clearVisits() {
    visits.clear();
}
