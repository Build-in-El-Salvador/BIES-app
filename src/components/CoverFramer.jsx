import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Cropper from 'react-easy-crop';
import { useTranslation } from 'react-i18next';
import { X, ZoomIn, ZoomOut } from 'lucide-react';
import { getAssetUrl } from '../utils/assets';
import { cropFromFrame, formatFrame, frameFromCrop, keepInOutline, parseFrame, zoomRange } from '../utils/coverFrame';

// How much of the photo shows around the outline, so members see what's left out.
const SIDE = 20;
const ABOVE = 40;

/**
 * Positioning a cover photo: the outline is the cover's shape on its page
 * (utils/coverFrame.js COVER_ASPECT) and what's inside it is what the page
 * shows. Drag to move the photo, pinch or slide to zoom; zoomed out, all of a
 * flyer fits, and the page fills the space around it with a blurred copy, as
 * here. Nothing is cut off the photo itself: tapping the cover opens all of it.
 *
 * @param {string} src - the photo: a picked file's object URL, or the cover's address
 * @param {string} [frame] - its stored position, to start from
 * @param {number} aspect - the outline's width / height
 * @param {(frame: string) => void} onDone - with the position to store
 * @param {() => void} onCancel
 * @param {string} [title] - instead of "Position your cover"
 * @param {string} [shade] - a CSS background the page lays over the photo (the
 *   highlight card's words sit on one), drawn over the outline as there
 */
export default function CoverFramer({ src, frame, aspect, onDone, onCancel, title, shade }) {
    const { t } = useTranslation();
    const areaRef = useRef(null);
    const [outline, setOutline] = useState(null);
    const [media, setMedia] = useState(null);
    const [range, setRange] = useState(null);
    const [crop, setCrop] = useState({ x: 0, y: 0 });
    const [zoom, setZoom] = useState(1);

    useLayoutEffect(() => {
        const width = Math.floor(areaRef.current.clientWidth) - SIDE * 2;
        setOutline({ width, height: Math.round(width / aspect) });
    }, [aspect]);

    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onCancel(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onCancel]);

    // react-easy-crop reports the photo as fitted in the editor; start from the
    // stored position, or filling the outline.
    const loaded = (size) => {
        const fitted = { width: size.width, height: size.height };
        const zooms = zoomRange(fitted, outline);
        const start = parseFrame(frame);
        const from = start ? cropFromFrame(start, fitted, outline) : { zoom: zooms.fill, crop: { x: 0, y: 0 } };
        const z = Math.min(zooms.max, Math.max(zooms.min, from.zoom));
        setMedia(fitted);
        setRange(zooms);
        setZoom(z);
        setCrop(keepInOutline(from.crop, fitted, outline, z));
    };

    // Moved or zoomed (react-easy-crop zooms about the fingers, and moves first):
    // kept in the outline before the screen draws it.
    useLayoutEffect(() => {
        if (!media) return;
        const kept = keepInOutline(crop, media, outline, zoom);
        if (kept.x !== crop.x || kept.y !== crop.y) setCrop(kept);
    }, [crop, zoom, media, outline]);

    const done = () => onDone(formatFrame(frameFromCrop(crop, zoom, media, outline)));

    return (
        <div className="cf-overlay" role="dialog" aria-modal="true" aria-labelledby="cf-title">
            <div className="cf-card">
                <div className="cf-head">
                    <h2 id="cf-title" className="cf-title">{title || t('coverPhoto.title')}</h2>
                    <button type="button" className="cf-x" onClick={onCancel} aria-label={t('common.close')}><X size={20} /></button>
                </div>
                <p className="cf-hint">{t('coverPhoto.hint')}</p>
                <div ref={areaRef} className="cf-area" style={outline ? { height: outline.height + ABOVE * 2 } : undefined}>
                    {outline && (
                        <>
                            {/* What the page puts in any space the photo leaves */}
                            <span className="cf-backdrop" style={{ left: SIDE, top: ABOVE, width: outline.width, height: outline.height }} aria-hidden="true">
                                <img src={src} alt="" />
                            </span>
                            <Cropper
                                image={src}
                                crop={crop}
                                zoom={zoom}
                                aspect={aspect}
                                cropSize={outline}
                                minZoom={range?.min ?? 0.05}
                                maxZoom={range?.max ?? 20}
                                restrictPosition={false}
                                showGrid={false}
                                onCropChange={setCrop}
                                onZoomChange={setZoom}
                                onMediaLoaded={loaded}
                                style={{ cropAreaStyle: { border: '2px solid #FFFFFF', color: 'rgba(15, 23, 42, 0.62)' } }}
                            />
                            {shade && <span className="cf-shade" style={{ left: SIDE, top: ABOVE, width: outline.width, height: outline.height, background: shade }} aria-hidden="true" />}
                        </>
                    )}
                </div>
                <label className="cf-zoom">
                    <ZoomOut size={18} aria-hidden="true" />
                    <input
                        type="range"
                        min={range?.min ?? 0}
                        max={range?.max ?? 1}
                        step="any"
                        value={zoom}
                        disabled={!range}
                        onChange={(e) => setZoom(Number(e.target.value))}
                        aria-label={t('coverPhoto.zoom')}
                    />
                    <ZoomIn size={18} aria-hidden="true" />
                </label>
                <div className="cf-actions">
                    <button type="button" className="cf-btn" onClick={onCancel}>{t('coverPhoto.cancel')}</button>
                    <button type="button" className="cf-btn primary" onClick={done} disabled={!media}>{t('coverPhoto.done')}</button>
                </div>
            </div>
            <style jsx>{`
                .cf-overlay {
                    position: fixed; top: 0; right: 0; bottom: 0; left: 0; z-index: 9999;
                    display: flex; align-items: center; justify-content: center; padding: 16px;
                    background: rgba(15, 23, 42, 0.6);
                }
                .cf-card {
                    width: 100%; max-width: 560px; max-height: 100%; overflow-y: auto;
                    background: var(--color-surface, #FFFFFF); border-radius: 20px; box-shadow: 0 25px 50px rgba(15, 23, 42, 0.3);
                }
                .cf-head { display: flex; align-items: center; justify-content: space-between; padding: 16px 16px 0 20px; }
                .cf-title { margin: 0; font-size: 1.1rem; font-weight: 700; color: var(--color-gray-900); }
                .cf-x {
                    width: 36px; height: 36px; border-radius: 50%; border: 0; cursor: pointer;
                    display: flex; align-items: center; justify-content: center; background: none; color: var(--color-gray-500);
                }
                .cf-hint { margin: 4px 20px 12px; font-size: 0.875rem; color: var(--color-gray-500); }
                .cf-area { position: relative; width: 100%; height: 280px; background: #0F172A; overflow: hidden; }
                .cf-backdrop { position: absolute; overflow: hidden; }
                .cf-shade { position: absolute; pointer-events: none; }
                .cf-backdrop img {
                    position: absolute; top: -10%; left: -10%; width: 120%; height: 120%; max-width: none;
                    object-fit: cover; filter: blur(20px) brightness(0.85); display: block;
                }
                .cf-zoom { display: flex; align-items: center; gap: 12px; padding: 16px 20px 4px; color: var(--color-gray-500); }
                .cf-zoom input { flex: 1; min-width: 0; accent-color: var(--color-primary); }
                .cf-actions { display: flex; justify-content: flex-end; gap: 10px; padding: 12px 16px 16px; }
                .cf-btn {
                    height: 44px; padding: 0 20px; border-radius: var(--radius-full, 999px); cursor: pointer; font: inherit; font-weight: 700;
                    border: 1px solid var(--color-gray-300); background: var(--color-surface, #FFFFFF); color: var(--color-gray-700);
                }
                .cf-btn.primary { border-color: var(--color-primary); background: var(--color-primary); color: #FFFFFF; }
                .cf-btn:disabled { opacity: 0.5; cursor: default; }
            `}</style>
        </div>
    );
}

/**
 * Adding or positioning a cover in a form. `choose` is a file input's
 * onChange: the member positions the new photo before it uploads.
 * `adjust(src, frame)` positions the cover already there. Render `framer`
 * in the form. `onFramed({ file, frame })` gets the photo to upload (null
 * when adjusting) and the position to store. `options`: CoverFramer's title and shade.
 */
export function useCoverFramer(aspect, onFramed, options = {}) {
    const [framing, setFraming] = useState(null); // { src, frame, file? }
    // A picked photo's copy is let go when it's done with, or the form goes.
    const open = useRef(null);
    open.current = framing;
    useEffect(() => () => {
        if (open.current?.file) URL.revokeObjectURL(open.current.src);
    }, []);
    const close = () => setFraming((f) => {
        if (f?.file) URL.revokeObjectURL(f.src);
        return null;
    });
    const choose = (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (file) setFraming({ src: URL.createObjectURL(file), frame: '', file });
    };
    const adjust = (src, frame) => setFraming({ src: getAssetUrl(src), frame: frame || '' });
    const framer = framing && (
        <CoverFramer
            src={framing.src}
            frame={framing.frame}
            aspect={aspect}
            title={options.title}
            shade={options.shade}
            onCancel={close}
            onDone={(frame) => {
                const file = framing.file || null;
                close();
                onFramed({ file, frame });
            }}
        />
    );
    return { choose, adjust, framer };
}
