/**
 * The requests the list pages make, and their keys in listCache.js: shared
 * with prefetchLists.js, so the lists fetched ahead of time are the very ones
 * the pages look up. A key is the exact request (property order included).
 * Pure, so tests can import it.
 */

/** Businesses (PROVIDER) or Farms (FARM), best Trust Score first. */
export function directoryRequest({ type, search = '', category = '', saved = false }) {
    const params = { type, limit: 50, sort: 'score' };
    if (search) params.search = search;
    if (category) params.category = category;
    if (saved) params.saved = 'true';
    return params;
}

export const directoryKey = (params) => `directory:${JSON.stringify(params)}`;

/**
 * Opportunities with the page's filters. `types` (the phone app's) limits the
 * list to the kinds the app shows; `userId` is the member's own, for Mine.
 */
export function opportunitiesRequest(filters = {}, { types = null, userId = null } = {}) {
    const {
        query, type, kind, stage, category, minAmount, maxAmount,
        remoteOnly, btcOnly, mineOnly, savedOnly,
    } = filters;
    const request = { limit: 50 };
    if (query) request.search = query;
    if (type) request.type = type;
    if (kind) request.kind = kind;
    if (stage) request.stage = stage;
    if (category) request.category = category;
    if (minAmount) request.minAmount = minAmount;
    if (maxAmount) request.maxAmount = maxAmount;
    if (remoteOnly) request.remote = 'true';
    if (btcOnly) request.btc = 'true';
    if (mineOnly && userId) request.ownerId = userId;
    if (savedOnly) request.saved = 'true';
    if (types) request.types = types.join(',');
    return request;
}

export const opportunitiesKey = (request) => `opportunities:${JSON.stringify(request)}`;

/** Members come a screenful at a time: Icons shows many per screen, cards fewer. */
export const membersPageSize = (view) => (view === 'icons' ? 48 : 24);

export const membersKey = (pageSize, search = '') => `members:${pageSize}:${search}`;
