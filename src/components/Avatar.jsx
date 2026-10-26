import { useEffect, useState } from 'react';
import { getAssetUrl } from '../utils/assets';
import { thumbnailUrl } from '../utils/thumbnail';

/**
 * A member's (or listing's) photo for lists and grids.
 *
 * - The server's small copy first (utils/thumbnail.js): a few KB for a 72px
 *   circle instead of the full photo. No copy, or it fails: the photo itself.
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
 * @param {string} [position] - CSS object-position: a cover's chosen part
 *   (utils/coverFrame.js focusOf) where the box crops the photo
 */
export default function Avatar({ src, alt = '', size, className, fallback = null, position }) {
    const thumb = thumbnailUrl(src);
    // 0: the small copy (when there is one), 1: the photo, 2: the fallback.
    const [stage, setStage] = useState(thumb ? 0 : 1);
    useEffect(() => { setStage(thumbnailUrl(src) ? 0 : 1); }, [src]);

    if (!src || stage === 2) return fallback;
    return (
        <img
            key={stage}
            src={getAssetUrl(stage === 0 ? thumb : src)}
            alt={alt}
            className={className}
            width={size}
            height={size}
            loading="lazy"
            decoding="async"
            onError={() => setStage((s) => s + 1)}
            {...(position ? { style: { objectPosition: position } } : {})}
        />
    );
}
