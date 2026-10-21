import { useEffect, useState } from 'react';
import { getAssetUrl } from '../utils/assets';

/**
 * A member's (or listing's) photo for lists and grids.
 *
 * - Loads only when it nears the screen and decodes off the main thread, so
 *   a page of 48 photos doesn't download and decode them all at once (on an
 *   iPhone that ran out of memory and left photos half drawn or missing).
 * - Relative /uploads/... paths are made absolute, which the phone app needs.
 * - A photo that fails to load shows `fallback` instead of WebKit's "?".
 *
 * @param {string} src - the photo's address (absolute, or /uploads/...)
 * @param {string} alt
 * @param {number} [size] - the displayed size in px, for the browser's layout
 * @param {string} [className]
 * @param {React.ReactNode} fallback - shown when there's no photo or it fails
 */
export default function Avatar({ src, alt = '', size, className, fallback = null }) {
    const [failed, setFailed] = useState(false);
    useEffect(() => { setFailed(false); }, [src]);

    if (!src || failed) return fallback;
    return (
        <img
            src={getAssetUrl(src)}
            alt={alt}
            className={className}
            width={size}
            height={size}
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
        />
    );
}
