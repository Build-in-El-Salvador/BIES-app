// BIES Talents' lists and limits: a mirror of server/src/controllers/
// talent.controller.ts (keep both in sync). Pure, so tests can import it.

/** Kinds of talent (labels: talent.categories.*). */
export const TALENT_CATEGORIES = [
    'tech', 'design', 'media', 'marketing', 'writing', 'teaching', 'professional',
    'trades', 'home', 'events', 'wellness', 'transport', 'other',
];

/** The work a member takes on (labels: talent.workTypes.*). */
export const WORK_TYPES = ['one-off', 'short-term', 'long-term'];

export const MAX_TALENTS = 5;
export const MAX_WORKS = 8;
/** Photos and videos, together, for one example of their work. */
export const MAX_WORK_MEDIA = 4;
export const MAX_SKILLS = 15;
export const MAX_LANGUAGES = 10;

// A video the server takes: its size (upload.controller.ts) and length
// (mediaProcessing.ts MAX_VIDEO_SECONDS).
export const MAX_VIDEO_MB = 50;
export const MAX_VIDEO_SECONDS = 120;

/** A link to a video (stored as .mp4), not a photo. */
export function isVideo(url) {
    return /\.(mp4|m4v|mov|webm)(?:[?#]|$)/i.test(url || '');
}

/** A work's photos and videos, in order: [{ url, poster? }]. */
export function mediaOf(work) {
    return (Array.isArray(work?.media) ? work.media : []).filter((item) => item?.url);
}

/** What shows for a photo or video: the photo, or the video's poster ('' without one). */
export function pictureOf(item) {
    if (!item?.url) return '';
    return isVideo(item.url) ? item.poster || '' : item.url;
}

/** Every photo and video of a talent's proof of work, in order. */
export function workMedia(talent) {
    return (Array.isArray(talent?.works) ? talent.works : []).flatMap(mediaOf);
}

/** The picture a talent shows at the top: its cover, else its work's first picture. */
export function coverOf(talent) {
    return talent?.photo || workMedia(talent).map(pictureOf).find(Boolean) || '';
}

/** A link as typed ("example.com"), as a web link. */
export function asWebLink(text) {
    const link = (text || '').trim();
    return link && !/^https?:\/\//i.test(link) ? `https://${link}` : link;
}

/** A web link without its scheme, "www." and closing slash, to show. */
export function shortLink(link) {
    return (link || '').replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
}
