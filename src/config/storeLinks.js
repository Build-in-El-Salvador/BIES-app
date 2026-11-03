/**
 * The BIES app's store pages, for the invite page on the web (Invite.jsx).
 * Set at build time (VITE_APP_STORE_URL, VITE_PLAY_STORE_URL) once the
 * listings are public; until then the page says to search the stores.
 */
export const APP_STORE_URL = import.meta.env.VITE_APP_STORE_URL || '';
export const PLAY_STORE_URL = import.meta.env.VITE_PLAY_STORE_URL || '';
