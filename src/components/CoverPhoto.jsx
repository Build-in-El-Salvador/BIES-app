import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { getAssetUrl } from '../utils/assets';
import { focusOf, leavesSpace, parseFrame, placeFrame } from '../utils/coverFrame';

const FILL = { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, display: 'block', overflow: 'hidden' };
// Larger than the box, so the blur doesn't fade out at its edges.
const BACKDROP = {
    position: 'absolute', top: '-10%', left: '-10%', width: '120%', height: '120%', maxWidth: 'none',
    objectFit: 'cover', filter: 'blur(20px) brightness(0.85)', display: 'block',
};

/**
 * A cover photo on its page: it fills its box (the parent places, sizes and
 * clips it) and shows the part of the photo its member chose when they
 * positioned it (utils/coverFrame.js). Where that leaves space around the
 * photo (a flyer zoomed out to show all of it), a blurred copy fills it.
 * Without a chosen part, the photo centred and cropped to the box, as before.
 * Inline styles, so a page's `:global(img)` rules don't move the photo.
 *
 * @param {string} src - the photo (absolute, or /uploads/...)
 * @param {string} [frame] - its stored position, "x,y,w,h"
 * @param {string} [alt]
 * @param {string} [focus] - without a position, the CSS object-position to crop around
 */
export default function CoverPhoto({ src, frame, alt = '', focus }) {
    const parsed = parseFrame(frame);
    const framed = !!parsed;
    const boxRef = useRef(null);
    const [box, setBox] = useState(null);
    const [natural, setNatural] = useState(null);

    useLayoutEffect(() => {
        if (!framed) return undefined;
        const el = boxRef.current;
        const measure = () => setBox((b) => (b && b.width === el.clientWidth && b.height === el.clientHeight ? b : { width: el.clientWidth, height: el.clientHeight }));
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, [framed]);

    // A photo already loaded (from the cache) can finish before React listens.
    const sized = useCallback((img) => {
        if (img?.complete && img.naturalWidth) setNatural({ width: img.naturalWidth, height: img.naturalHeight, src: img.getAttribute('src') });
    }, []);

    const url = getAssetUrl(src);
    const known = natural?.src === url ? natural : null; // not the last photo's size
    const place = parsed && box?.width && box?.height && known ? placeFrame(parsed, known, box) : null;
    return (
        <span ref={boxRef} style={FILL}>
            {place && leavesSpace(place, box) && <img src={url} alt="" aria-hidden="true" style={BACKDROP} />}
            <img
                ref={sized}
                src={url}
                alt={alt}
                onLoad={(e) => sized(e.currentTarget)}
                style={place
                    ? { position: 'absolute', left: place.left, top: place.top, width: place.width, height: place.height, maxWidth: 'none', objectFit: 'fill', display: 'block' }
                    : { ...FILL, width: '100%', height: '100%', objectFit: 'cover', objectPosition: parsed ? focusOf(parsed) : focus || '50% 50%' }}
            />
        </span>
    );
}
