import { useState, useCallback } from 'react';
import Cropper from 'react-easy-crop';
import { X, Check, ZoomIn, ZoomOut } from 'lucide-react';

/**
 * Crop an image and return a Blob.
 */
function getCroppedImg(imageSrc, pixelCrop) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = 'anonymous';
        image.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = pixelCrop.width;
            canvas.height = pixelCrop.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(
                image,
                pixelCrop.x, pixelCrop.y, pixelCrop.width, pixelCrop.height,
                0, 0, pixelCrop.width, pixelCrop.height
            );
            canvas.toBlob((blob) => {
                if (!blob) { reject(new Error('Canvas toBlob failed')); return; }
                resolve(blob);
            }, 'image/jpeg', 0.92);
        };
        image.onerror = reject;
        image.src = imageSrc;
    });
}

/**
 * ImageCropModal
 *
 * @param {string}   imageSrc   - Data URL or object URL of the selected file
 * @param {number}   aspect     - Aspect ratio (1 for avatar, 16/5 for banner)
 * @param {string}   shape      - 'round' or 'rect'
 * @param {function} onCrop     - Called with the cropped File object
 * @param {function} onCancel   - Called when modal is dismissed
 */
export default function ImageCropModal({ imageSrc, aspect = 1, shape = 'rect', onCrop, onCancel }) {
    const [crop, setCrop] = useState({ x: 0, y: 0 });
    const [zoom, setZoom] = useState(1);
    const [croppedAreaPixels, setCroppedAreaPixels] = useState(null);

    const onCropComplete = useCallback((_croppedArea, croppedPixels) => {
        setCroppedAreaPixels(croppedPixels);
    }, []);

    const handleConfirm = async () => {
        if (!croppedAreaPixels) return;
        try {
            const blob = await getCroppedImg(imageSrc, croppedAreaPixels);
            const file = new File([blob], 'cropped.jpg', { type: 'image/jpeg' });
            onCrop(file);
        } catch (err) {
            console.error('Crop failed:', err);
            onCancel();
        }
    };

    return (
        <div style={{
            // Above the bottom bar (10000), like the app's other sheets.
            position: 'fixed', inset: 0, zIndex: 10100,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.7)',
        }}>
            <div style={{
                background: 'white', borderRadius: 16, overflow: 'hidden',
                width: '90vw', maxWidth: 600, boxShadow: '0 25px 50px rgba(0,0,0,0.3)',
            }}>
                {/* Header */}
                <div style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '1rem 1.5rem', borderBottom: '1px solid #e5e7eb',
                }}>
                    <h3 style={{ fontWeight: 700, fontSize: '1.125rem', fontFamily: 'var(--font-display)' }}>
                        Crop Image
                    </h3>
                    <button onClick={onCancel} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', padding: 4 }}>
                        <X size={20} />
                    </button>
                </div>

                {/* Cropper */}
                {/* Short enough on a small phone for the buttons under it to show. */}
                <div style={{ position: 'relative', width: '100%', height: 'min(400px, 55vh)', background: '#111' }}>
                    <Cropper
                        image={imageSrc}
                        crop={crop}
                        zoom={zoom}
                        aspect={aspect}
                        cropShape={shape === 'round' ? 'round' : 'rect'}
                        onCropChange={setCrop}
                        onZoomChange={setZoom}
                        onCropComplete={onCropComplete}
                    />
                </div>

                {/* Zoom controls */}
                <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    gap: '1rem', padding: '1rem',
                }}>
                    <ZoomOut size={18} style={{ color: '#6b7280' }} />
                    <input
                        type="range"
                        min={1} max={3} step={0.05}
                        value={zoom}
                        onChange={(e) => setZoom(Number(e.target.value))}
                        style={{ width: 200, accentColor: 'var(--color-primary, #0052cc)' }}
                    />
                    <ZoomIn size={18} style={{ color: '#6b7280' }} />
                </div>

                {/* Actions */}
                <div style={{
                    display: 'flex', justifyContent: 'flex-end', gap: '0.75rem',
                    padding: '1rem 1.5rem', borderTop: '1px solid #e5e7eb',
                }}>
                    <button onClick={onCancel} style={{
                        padding: '0.625rem 1.5rem', borderRadius: 8, border: '1px solid #d1d5db',
                        background: 'white', fontWeight: 600, cursor: 'pointer', fontSize: '0.875rem',
                    }}>
                        Cancel
                    </button>
                    <button onClick={handleConfirm} style={{
                        padding: '0.625rem 1.5rem', borderRadius: 8, border: 'none',
                        background: 'var(--color-primary, #0052cc)', color: 'white',
                        fontWeight: 600, cursor: 'pointer', fontSize: '0.875rem',
                        display: 'flex', alignItems: 'center', gap: '0.5rem',
                    }}>
                        <Check size={16} /> Apply
                    </button>
                </div>
            </div>
        </div>
    );
}
