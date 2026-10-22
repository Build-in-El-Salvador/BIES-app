import { directoryApi, profilesApi, projectsApi } from '../services/api';

/**
 * What each detail page fetches, and its key in detailCache.js: shared by the
 * page and by the cards that start the fetch when a finger touches them.
 * Each returns [key, load].
 */
export const listingPage = (id) => [`listing:${id}`, () => directoryApi.get(id).then((r) => r?.data || r)];

export const opportunityPage = (id) => [`opportunity:${id}`, () => projectsApi.get(id)];

/** `id` as the link has it: a user id, profile id or pubkey (/builder/:id). */
export const profilePage = (id) => [`profile:${id}`, () => profilesApi.get(id)];
