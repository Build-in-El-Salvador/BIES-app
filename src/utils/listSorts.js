/**
 * The orders each list page offers in its "Sort by" (components/SortBy.jsx),
 * as the server names them (?sort=). '' is the page's usual order, first in
 * each menu. Pure, so tests can import it.
 */

/** Businesses: top rated (usual), most recommended, newest, A–Z, and by price ($ to $$$$). Farms: no price. */
export function directorySorts(type) {
    return ['', 'vouches', 'newest', 'name', ...(type === 'PROVIDER' ? ['price-low', 'price-high'] : [])];
}

/**
 * Opportunities: newest (usual), closing soon, A–Z; by price for the types
 * that have a number for it (a business's asking price, the most a program gives).
 */
export function opportunitySorts(type) {
    return ['', 'closing', 'name', ...(type === 'business-for-sale' || type === 'program' ? ['price-low', 'price-high'] : [])];
}

/** Talents: members taking on work first (usual), newest, A–Z. */
export const TALENT_SORTS = ['', 'newest', 'name'];

/** Members: most viewed (usual), newest, A–Z, most followers. */
export const MEMBER_SORTS = ['', 'newest', 'name', 'followers'];

/** `value` if the page offers it, otherwise the usual order. */
export function sortOf(offered, value) {
    return value && offered.includes(value) ? value : '';
}
