/**
 * The small copy of a BIES-hosted public photo, for lists: the server keeps
 * one at uploads/public/t/<name>.jpg (server/src/services/thumbnails.service.ts).
 * Any other address (an outside host, a video) has none: null.
 *
 * Pure module (no browser globals) so it runs under `node --test`.
 * @param {string} url - absolute or /uploads/... path
 */
export function thumbnailUrl(url) {
    if (typeof url !== 'string') return null;
    const match = /^(.*\/uploads\/public\/)(\d{13}-[0-9a-f]{32})\.(?:jpe?g|png|gif|webp)$/i.exec(url);
    return match ? `${match[1]}t/${match[2]}.jpg` : null;
}
