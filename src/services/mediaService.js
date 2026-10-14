import { uploadApi } from './api';
import { getAssetUrl } from '../utils/assets';

/**
 * Photos and videos members add (feed posts, profile photos, GIFs, albums)
 * go to BIES's own storage (POST /upload/media). They used to go to public
 * Blossom hosts (Primal, nostr.build): a Private Feed post's text stayed on
 * the members-only relay while its photos sat on the open internet with
 * outside companies. URLs come back absolute, as Nostr events need them.
 *
 * The server shrinks photos and takes out their location and other
 * metadata, so what it stores isn't the file sent: its size, type, SHA-256
 * and pixel size come back with the link, for the post's imeta tag.
 */

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB
const MAX_ATTACHMENTS = 4;

// What the server takes (upload.controller.ts MEDIA_TYPES).
const ALLOWED_TYPES = [
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'video/mp4', 'video/webm', 'video/quicktime',
];

/**
 * Upload a file to BIES. `url` is absolute, for Nostr events; `path` is as
 * BIES stored it, for BIES's own records (album photos), which it checks.
 * The rest describe the stored file; `width` and `height` only for a photo.
 * @param {File} file
 * @returns {Promise<{url: string, path: string, sha256: string, size: number, type: string, width?: number, height?: number}>}
 */
async function uploadFile(file, options = {}) {
    const stored = await uploadApi.media(file, options);
    return {
        url: new URL(getAssetUrl(stored.url), window.location.origin).href,
        path: stored.url,
        sha256: stored.sha256,
        size: stored.size ?? file.size,
        type: stored.type || file.type,
        ...(stored.width && stored.height ? { width: stored.width, height: stored.height } : {}),
    };
}

/**
 * Build a NIP-92 imeta tag for a successfully uploaded file.
 * @param {{url: string, sha256: string, size: number, type: string, width?: number, height?: number}} result
 * @param {{width: number, height: number}|null} dimensions  the original's, for a video
 * @returns {string[]}
 */
function buildImetaTag(result, dimensions) {
    const tag = [
        'imeta',
        `url ${result.url}`,
        `m ${result.type}`,
        ...(result.sha256 ? [`x ${result.sha256}`] : []),
        `size ${result.size}`,
    ];
    const dim = result.width ? result : dimensions;
    if (dim) {
        tag.push(`dim ${dim.width}x${dim.height}`);
    }
    return tag;
}

/**
 * Validate a file for upload.
 * @returns {string|null} error message, or null if valid
 */
function validateFile(file, currentCount) {
    if (!ALLOWED_TYPES.includes(file.type)) {
        return `Unsupported file type: ${file.type}. Only images and videos are allowed.`;
    }
    if (file.size > MAX_FILE_SIZE) {
        return `File "${file.name}" is too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum is 25MB.`;
    }
    if (currentCount >= MAX_ATTACHMENTS) {
        return `Maximum ${MAX_ATTACHMENTS} attachments allowed.`;
    }
    return null;
}

/**
 * Load image dimensions from a File.
 * @returns {Promise<{width: number, height: number}|null>}
 */
function getImageDimensions(file) {
    if (!file.type.startsWith('image/')) return Promise.resolve(null);

    return new Promise((resolve) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            resolve({ width: img.naturalWidth, height: img.naturalHeight });
            URL.revokeObjectURL(url);
        };
        img.onerror = () => {
            resolve(null);
            URL.revokeObjectURL(url);
        };
        img.src = url;
    });
}

export const mediaService = {
    uploadFile,
    buildImetaTag,
    validateFile,
    getImageDimensions,
    MAX_FILE_SIZE,
    MAX_ATTACHMENTS,
};
