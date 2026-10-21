/**
 * Lists this session has shown (Members, Farms, Businesses, Talents,
 * Opportunities), kept in memory so going back to a page shows its list at
 * once instead of a spinner; the page still asks the server and swaps in the
 * fresh answer. Keyed by the exact request, so a search or filter shows its
 * own results. Never written to storage, and cleared at sign-out
 * (authService.clearLocalSecrets), so the next person on a shared browser
 * doesn't see them.
 */
const lists = new Map();
const MAX_LISTS = 30;

/** The list last shown for this request, or undefined. */
export function cachedList(key) {
    return lists.get(key);
}

/** Keep a list for next time; the oldest go first past MAX_LISTS. */
export function rememberList(key, value) {
    lists.delete(key);
    lists.set(key, value);
    if (lists.size > MAX_LISTS) lists.delete(lists.keys().next().value);
}

export function clearLists() {
    lists.clear();
}
