import { directoryApi, profilesApi, projectsApi } from '../services/api';
import { cachedList, rememberList } from './listCache';
import {
    directoryKey, directoryRequest, listOf, membersKey, membersPageSize, morePages, opportunitiesKey, opportunitiesRequest,
} from './listRequests';
import { isTypeShown, typesShown } from '../components/opportunities/opportunityOptions';
import { isNativePlatform } from './platform';

/**
 * The first page of each list in the bottom bar (Businesses, Farms,
 * Opportunities, Members), fetched quietly once the app is up, so the first
 * tap on a tab shows its list at once (listCache.js) instead of a spinner.
 * The page still refreshes it as usual. A list already shown is skipped, and
 * one that fails is left to its page.
 */
async function directory(type) {
    const params = directoryRequest({ type });
    if (cachedList(directoryKey(params))) return;
    const result = await directoryApi.list(params);
    rememberList(directoryKey(params), { listings: listOf(result), pages: 1, hasMore: morePages(result, 1) });
}

async function opportunities() {
    const native = isNativePlatform();
    const request = opportunitiesRequest({}, { types: native ? typesShown(native) : null });
    if (cachedList(opportunitiesKey(request))) return;
    const result = await projectsApi.list(request);
    rememberList(opportunitiesKey(request), (Array.isArray(result?.data) ? result.data : []).filter((o) => isTypeShown(o.type, native)));
}

async function members() {
    let view = 'icons';
    try { view = localStorage.getItem('bies_members_view') || 'icons'; } catch { /* unavailable */ }
    const pageSize = membersPageSize(view);
    if (cachedList(membersKey(pageSize))) return;
    const result = await profilesApi.list({ page: 1, limit: pageSize, fields: 'card' });
    const list = Array.isArray(result?.data) ? result.data : Array.isArray(result) ? result : [];
    rememberList(membersKey(pageSize), {
        builders: list, page: 1, hasMore: 1 < (result?.pagination?.totalPages || 1), at: Date.now(),
    });
}

const LOADERS = {
    trusted: () => directory('PROVIDER'),
    farms: () => directory('FARM'),
    opportunities,
    members,
};

/** Fetch the lists of these bottom-bar tabs (NAV_PAGES ids) ahead of time. */
export function prefetchLists(tabIds) {
    return Promise.allSettled(tabIds.filter((id) => LOADERS[id]).map((id) => LOADERS[id]()));
}
