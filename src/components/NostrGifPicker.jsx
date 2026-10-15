import { useState, useEffect, useRef } from 'react';
import { Search, Upload, X, Loader2, Tag } from 'lucide-react';
import { gifStore } from '../services/gifStore';
import { mediaService } from '../services/mediaService';

const NostrGifPicker = ({ onSelect, onClose, dropDown = false, below = false }) => {
    const [gifs, setGifs] = useState(gifStore.gifs);
    const [search, setSearch] = useState('');
    const [uploading, setUploading] = useState(false);
    const [uploadMode, setUploadMode] = useState(false);
    const [uploadTags, setUploadTags] = useState('');
    const [uploadDesc, setUploadDesc] = useState('');
    const [uploadPreview, setUploadPreview] = useState(null);
    const [uploadFile, setUploadFile] = useState(null);
    const [error, setError] = useState('');
    const fileRef = useRef(null);
    const searchRef = useRef(null);
    const pickerRef = useRef(null);

    useEffect(() => {
        if (!gifStore.loaded) gifStore.fetchGifs();
        const unsub = gifStore.subscribe(setGifs);
        return unsub;
    }, []);

    useEffect(() => {
        searchRef.current?.focus();
    }, []);

    useEffect(() => {
        const handleClickOutside = (e) => {
            if (pickerRef.current && !pickerRef.current.contains(e.target)) {
                onClose();
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [onClose]);

    const filtered = search ? gifStore.search(search) : gifs;

    const handleFileChange = (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;

        if (file.type !== 'image/gif') {
            setError('Only GIF files can be added to the library');
            return;
        }
        const err = mediaService.validateFile(file, 0);
        if (err) {
            setError(err);
            return;
        }
        setUploadFile(file);
        setUploadPreview(URL.createObjectURL(file));
        setUploadMode(true);
        setError('');
    };

    const handleUpload = async () => {
        if (!uploadFile || uploading) return;
        setUploading(true);
        setError('');

        try {
            const tags = uploadTags.split(',').map(t => t.trim()).filter(Boolean);
            const gif = await gifStore.uploadGif(uploadFile, uploadDesc, tags);
            onSelect(gif.url);
            resetUpload();
        } catch (err) {
            setError(`Upload failed: ${err.message}`);
        } finally {
            setUploading(false);
        }
    };

    const resetUpload = () => {
        if (uploadPreview) URL.revokeObjectURL(uploadPreview);
        setUploadFile(null);
        setUploadPreview(null);
        setUploadMode(false);
        setUploadTags('');
        setUploadDesc('');
    };

    return (
        <div className={`gif-picker${dropDown ? ' gif-picker-dropdown' : ''}${below ? ' picker-below' : ''}`} ref={pickerRef}>
            <div className="gif-picker-header">
                <span className="gif-picker-title">GIF Library</span>
                <button className="gif-picker-close" onClick={onClose}><X size={14} /></button>
            </div>

            {!uploadMode ? (
                <>
                    <div className="gif-search-row">
                        <div className="gif-search-box">
                            <Search size={14} />
                            <input
                                ref={searchRef}
                                type="text"
                                placeholder="Search GIFs..."
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                            />
                        </div>
                        <button
                            className="gif-upload-btn"
                            onClick={() => fileRef.current?.click()}
                            title="Upload GIF to library"
                        >
                            <Upload size={14} />
                        </button>
                        <input
                            ref={fileRef}
                            type="file"
                            accept="image/gif"
                            style={{ display: 'none' }}
                            onChange={handleFileChange}
                        />
                    </div>

                    {error && <div className="gif-error">{error}</div>}

                    <div className="gif-grid">
                        {gifStore.loading && gifs.length === 0 && (
                            <div className="gif-loading">
                                <Loader2 size={16} className="spin" /> Loading library...
                            </div>
                        )}
                        {!gifStore.loading && filtered.length === 0 && (
                            <div className="gif-empty">
                                {search
                                    ? 'No GIFs match your search'
                                    : 'No GIFs yet — be the first to upload one!'
                                }
                            </div>
                        )}
                        {filtered.map(gif => (
                            <button
                                key={gif.id}
                                className="gif-item"
                                onClick={() => { onSelect(gif.url); onClose(); }}
                                title={gif.description || gif.tags.join(', ')}
                            >
                                <img src={gif.url} alt={gif.description} loading="lazy" />
                            </button>
                        ))}
                    </div>
                </>
            ) : (
                <div className="gif-upload-form">
                    {uploadPreview && (
                        <div className="gif-upload-preview">
                            <img src={uploadPreview} alt="Preview" />
                        </div>
                    )}
                    <input
                        type="text"
                        className="gif-upload-input"
                        placeholder="Description (optional)"
                        value={uploadDesc}
                        onChange={(e) => setUploadDesc(e.target.value)}
                    />
                    <div className="gif-tag-input-row">
                        <Tag size={13} />
                        <input
                            type="text"
                            className="gif-upload-input"
                            placeholder="Tags: funny, bitcoin, meme"
                            value={uploadTags}
                            onChange={(e) => setUploadTags(e.target.value)}
                        />
                    </div>
                    {error && <div className="gif-error">{error}</div>}
                    <div className="gif-upload-actions">
                        <button className="gif-cancel-btn" onClick={resetUpload}>Cancel</button>
                        <button
                            className="gif-submit-btn"
                            onClick={handleUpload}
                            disabled={uploading}
                        >
                            {uploading ? <><Loader2 size={13} className="spin" /> Uploading...</> : 'Upload & Send'}
                        </button>
                    </div>
                </div>
            )}

            <style>{`
                .gif-picker {
                    position: absolute;
                    bottom: 100%;
                    right: 0;
                    margin-bottom: 0.5rem;
                    background: var(--color-surface, white);
                    border: 1px solid #e5e7eb;
                    border-radius: 12px;
                    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.15);
                    width: 340px;
                    max-width: calc(100vw - 2rem);
                    z-index: 1000;
                    display: flex;
                    flex-direction: column;
                    max-height: 420px;
                    overflow: hidden;
                }
                .gif-picker-dropdown {
                    bottom: auto;
                    top: 100%;
                    margin-bottom: 0;
                    margin-top: 0.5rem;
                }
                /* Under the whole composer, from its left edge: a picker hung off one
                   button near the left ran off the screen on phones. */
                .gif-picker.picker-below {
                    top: 100%;
                    bottom: auto;
                    left: 12px;
                    right: auto;
                    width: calc(100% - 24px);
                    max-width: 400px;
                    margin: 4px 0 0;
                }
                .gif-picker-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 0.6rem 0.75rem;
                    border-bottom: 1px solid #e5e7eb;
                }
                .gif-picker-title {
                    font-weight: 600;
                    font-size: 0.85rem;
                    color: var(--color-gray-900, #1f2937);
                }
                .gif-picker-close {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 24px;
                    height: 24px;
                    border: none;
                    background: transparent;
                    color: #9ca3af;
                    cursor: pointer;
                    border-radius: 4px;
                }
                .gif-picker-close:hover { background: #f3f4f6; color: #374151; }
                .gif-search-row {
                    display: flex;
                    gap: 0.4rem;
                    padding: 0.5rem 0.75rem;
                }
                .gif-search-box {
                    flex: 1;
                    display: flex;
                    align-items: center;
                    gap: 0.4rem;
                    border: 1px solid #e5e7eb;
                    border-radius: 8px;
                    padding: 0.35rem 0.6rem;
                    color: #9ca3af;
                }
                .gif-search-box input {
                    flex: 1;
                    border: none;
                    outline: none;
                    background: transparent;
                    font-size: 0.8rem;
                    color: var(--color-gray-900, #1f2937);
                    font-family: inherit;
                }
                .gif-search-box input::placeholder { color: #9ca3af; }
                .gif-upload-btn {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 32px;
                    height: 32px;
                    border: 1px solid #e5e7eb;
                    border-radius: 8px;
                    background: transparent;
                    color: #6b7280;
                    cursor: pointer;
                    flex-shrink: 0;
                    transition: all 0.15s;
                }
                .gif-upload-btn:hover { background: #f3f4f6; color: #4b5563; border-color: #d1d5db; }
                .gif-error {
                    color: #ef4444;
                    font-size: 0.75rem;
                    padding: 0 0.75rem 0.25rem;
                }
                .gif-grid {
                    display: grid;
                    grid-template-columns: repeat(3, 1fr);
                    gap: 4px;
                    padding: 0.5rem;
                    flex: 1;
                    min-height: 0;
                    overflow-y: auto;
                    -webkit-overflow-scrolling: touch;
                }
                .gif-loading, .gif-empty {
                    grid-column: 1 / -1;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 0.5rem;
                    padding: 2rem 1rem;
                    color: #9ca3af;
                    font-size: 0.8rem;
                    text-align: center;
                }
                .gif-item {
                    border: none;
                    background: #f3f4f6;
                    border-radius: 6px;
                    overflow: hidden;
                    cursor: pointer;
                    aspect-ratio: 1;
                    padding: 0;
                    transition: transform 0.15s, box-shadow 0.15s;
                    min-height: 0;
                    height: 0;
                    padding-bottom: 100%;
                    position: relative;
                }
                .gif-item:hover {
                    transform: scale(1.05);
                    box-shadow: 0 2px 8px rgba(0,0,0,0.15);
                    z-index: 1;
                }
                .gif-item img {
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    display: block;
                }

                /* Upload form */
                .gif-upload-form {
                    padding: 0.75rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.5rem;
                }
                .gif-upload-preview {
                    border-radius: 8px;
                    overflow: hidden;
                    max-height: 160px;
                    background: #f3f4f6;
                }
                .gif-upload-preview img {
                    width: 100%;
                    max-height: 160px;
                    object-fit: contain;
                    display: block;
                }
                .gif-upload-input {
                    width: 100%;
                    border: 1px solid #e5e7eb;
                    border-radius: 8px;
                    padding: 0.4rem 0.6rem;
                    font-size: 0.8rem;
                    font-family: inherit;
                    outline: none;
                    background: var(--color-surface, white);
                    color: var(--color-gray-900, #1f2937);
                    box-sizing: border-box;
                }
                .gif-upload-input:focus { border-color: #7c3aed; }
                .gif-tag-input-row {
                    display: flex;
                    align-items: center;
                    gap: 0.4rem;
                    color: #9ca3af;
                }
                .gif-tag-input-row .gif-upload-input {
                    flex: 1;
                }
                .gif-upload-actions {
                    display: flex;
                    gap: 0.5rem;
                    justify-content: flex-end;
                    padding-top: 0.25rem;
                }
                .gif-cancel-btn {
                    padding: 0.35rem 0.75rem;
                    border: 1px solid #e5e7eb;
                    border-radius: 8px;
                    background: transparent;
                    color: #6b7280;
                    font-size: 0.8rem;
                    font-weight: 600;
                    cursor: pointer;
                }
                .gif-cancel-btn:hover { background: #f3f4f6; }
                .gif-submit-btn {
                    display: flex;
                    align-items: center;
                    gap: 0.3rem;
                    padding: 0.35rem 0.75rem;
                    border: none;
                    border-radius: 8px;
                    background: #7c3aed;
                    color: white;
                    font-size: 0.8rem;
                    font-weight: 600;
                    cursor: pointer;
                    transition: opacity 0.15s;
                }
                .gif-submit-btn:hover { opacity: 0.9; }
                .gif-submit-btn:disabled { opacity: 0.5; cursor: not-allowed; }

                .spin {
                    animation: spin 1s linear infinite;
                }
                @keyframes spin {
                    from { transform: rotate(0deg); }
                    to { transform: rotate(360deg); }
                }

                /* Dark mode */
                :global([data-theme="dark"]) .gif-picker {
                    background: #1e2a3a;
                    border-color: #2d3748;
                }
                :global([data-theme="dark"]) .gif-picker-header {
                    border-color: #2d3748;
                }
                :global([data-theme="dark"]) .gif-picker-close:hover {
                    background: #2d3748;
                    color: #e2e8f0;
                }
                :global([data-theme="dark"]) .gif-search-box {
                    border-color: #2d3748;
                }
                :global([data-theme="dark"]) .gif-search-box input {
                    color: #f1f5f9;
                }
                :global([data-theme="dark"]) .gif-upload-btn {
                    border-color: #2d3748;
                    color: #94a3b8;
                }
                :global([data-theme="dark"]) .gif-upload-btn:hover {
                    background: #2d3748;
                    color: #e2e8f0;
                }
                :global([data-theme="dark"]) .gif-item {
                    background: #2d3748;
                }
                :global([data-theme="dark"]) .gif-upload-input {
                    background: #0f172a;
                    border-color: #2d3748;
                    color: #f1f5f9;
                }
                :global([data-theme="dark"]) .gif-cancel-btn {
                    border-color: #2d3748;
                    color: #94a3b8;
                }
                :global([data-theme="dark"]) .gif-cancel-btn:hover {
                    background: #2d3748;
                }
                :global([data-theme="dark"]) .gif-upload-preview {
                    background: #2d3748;
                }
            `}</style>
        </div>
    );
};

export default NostrGifPicker;
