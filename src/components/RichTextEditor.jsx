import React, { useRef, useEffect, useState } from 'react';
import { cleanMemberHtml } from '../utils/memberHtml';
import { Bold, Italic, Underline, List, ListOrdered, AlignLeft, AlignCenter, AlignRight, AlignJustify } from 'lucide-react';

const RichTextEditor = ({ value, onChange, placeholder, minHeight = '120px' }) => {
    const editorRef = useRef(null);
    const [formats, setFormats] = useState({
        bold: false,
        italic: false,
        underline: false,
        unorderedList: false,
        orderedList: false,
        justifyLeft: false,
        justifyCenter: false,
        justifyRight: false,
        justifyFull: false
    });

    const checkFormats = () => {
        if (!editorRef.current) return;
        setFormats({
            bold: document.queryCommandState('bold'),
            italic: document.queryCommandState('italic'),
            underline: document.queryCommandState('underline'),
            unorderedList: document.queryCommandState('insertUnorderedList'),
            orderedList: document.queryCommandState('insertOrderedList'),
            justifyLeft: document.queryCommandState('justifyLeft'),
            justifyCenter: document.queryCommandState('justifyCenter'),
            justifyRight: document.queryCommandState('justifyRight'),
            justifyFull: document.queryCommandState('justifyFull')
        });
    };

    useEffect(() => {
        if (editorRef.current && editorRef.current.innerHTML !== value) {
            editorRef.current.innerHTML = cleanMemberHtml(value);
        }
    }, [value]);

    const handleInput = () => {
        if (editorRef.current) {
            onChange(editorRef.current.innerHTML);
            checkFormats();
        }
    };

    const handlePaste = (e) => {
        e.preventDefault();
        const html = e.clipboardData.getData('text/html');
        const text = e.clipboardData.getData('text/plain');
        if (html) {
            const clean = cleanMemberHtml(html);
            document.execCommand('insertHTML', false, clean);
        } else {
            document.execCommand('insertText', false, text);
        }
    };

    const execCmd = (cmd, arg = null) => {
        document.execCommand(cmd, false, arg);
        editorRef.current.focus();
        handleInput();
        checkFormats();
    };

    return (
        <div className="rich-text-editor">
            <div className="rte-toolbar">
                <button type="button" className={formats.bold ? 'active' : ''} onMouseDown={(e) => { e.preventDefault(); execCmd('bold'); }} title="Bold">
                    <Bold size={16} />
                </button>
                <button type="button" className={formats.italic ? 'active' : ''} onMouseDown={(e) => { e.preventDefault(); execCmd('italic'); }} title="Italic">
                    <Italic size={16} />
                </button>
                <button type="button" className={formats.underline ? 'active' : ''} onMouseDown={(e) => { e.preventDefault(); execCmd('underline'); }} title="Underline">
                    <Underline size={16} />
                </button>
                <div className="rte-divider" />
                <button type="button" className={formats.unorderedList ? 'active' : ''} onMouseDown={(e) => { e.preventDefault(); execCmd('insertUnorderedList'); }} title="Bullet List">
                    <List size={16} />
                </button>
                <button type="button" className={formats.orderedList ? 'active' : ''} onMouseDown={(e) => { e.preventDefault(); execCmd('insertOrderedList'); }} title="Numbered List">
                    <ListOrdered size={16} />
                </button>
                <div className="rte-divider" />
                <button type="button" className={formats.justifyLeft ? 'active' : ''} onMouseDown={(e) => { e.preventDefault(); execCmd('justifyLeft'); }} title="Align Left">
                    <AlignLeft size={16} />
                </button>
                <button type="button" className={formats.justifyCenter ? 'active' : ''} onMouseDown={(e) => { e.preventDefault(); execCmd('justifyCenter'); }} title="Align Center">
                    <AlignCenter size={16} />
                </button>
                <button type="button" className={formats.justifyRight ? 'active' : ''} onMouseDown={(e) => { e.preventDefault(); execCmd('justifyRight'); }} title="Align Right">
                    <AlignRight size={16} />
                </button>
                <button type="button" className={formats.justifyFull ? 'active' : ''} onMouseDown={(e) => { e.preventDefault(); execCmd('justifyFull'); }} title="Justify">
                    <AlignJustify size={16} />
                </button>
            </div>

            <div
                ref={editorRef}
                className="rte-content input-field"
                contentEditable
                onInput={handleInput}
                onBlur={() => { handleInput(); checkFormats(); }}
                onKeyUp={checkFormats}
                onMouseUp={checkFormats}
                onPaste={handlePaste}
                style={{
                    minHeight,
                    outline: 'none',
                    borderTopLeftRadius: 0,
                    borderTopRightRadius: 0,
                    borderTop: 'none',
                    borderLeft: '1px solid var(--color-gray-300)',
                    borderRight: '1px solid var(--color-gray-300)',
                    borderBottom: '1px solid var(--color-gray-300)',
                }}
            />

            {!value && (
                <div className="rte-placeholder" style={{ pointerEvents: 'none' }}>
                    {placeholder}
                </div>
            )}

            <style jsx>{`
                .rich-text-editor {
                    display: flex;
                    flex-direction: column;
                    width: 100%;
                    position: relative;
                }
                .rte-toolbar {
                    display: flex;
                    flex-wrap: wrap; /* on a narrow phone, a second row rather than wider than the screen */
                    gap: 0.25rem;
                    padding: 0.5rem;
                    background: var(--color-gray-100);
                    border: 1px solid var(--color-gray-300);
                    border-top-left-radius: var(--radius-md, 8px);
                    border-top-right-radius: var(--radius-md, 8px);
                    border-bottom: 1px solid var(--color-gray-200);
                }
                .rte-toolbar button {
                    background: transparent;
                    border: none;
                    border-radius: 4px;
                    padding: 0.4rem;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: var(--color-text);
                    transition: all 0.1s;
                }
                .rte-toolbar button:hover {
                    background: var(--color-gray-200);
                }
                .rte-toolbar button.active {
                    background: var(--color-blue-tint);
                    color: var(--color-primary);
                }
                .rte-divider {
                    width: 1px;
                    background: var(--color-gray-300);
                    margin: 0 0.25rem;
                }
                .rte-content {
                    padding: 0.75rem 1rem;
                    font-size: 0.95rem;
                    line-height: 1.5;
                    border-bottom-left-radius: var(--radius-md, 8px);
                    border-bottom-right-radius: var(--radius-md, 8px);
                    background: var(--color-surface);
                    color: var(--color-text);
                }
                .rte-content:empty:before {
                    content: attr(placeholder);
                    color: var(--color-gray-400);
                    pointer-events: none;
                    display: block; // For Firefox
                }
                .rte-placeholder {
                    position: absolute;
                    top: 3.5rem; /* Adjust based on toolbar height */
                    left: 1rem;
                    color: var(--color-gray-400);
                    font-size: 0.95rem;
                }
            `}</style>
        </div>
    );
};

export default RichTextEditor;
