import React, { useState, useRef } from 'react';
import { X } from 'lucide-react';

/** `id` goes on the text input, so a <label htmlFor> can name it. */
const TagInput = ({ tags, onChange, placeholder = 'Bitcoin, Lightning, Workshop…', id }) => {
    const [input, setInput] = useState('');
    const inputRef = useRef(null);

    const addTag = (raw) => {
        const tag = raw.trim().replace(/,+$/, '').trim();
        if (!tag || tags.includes(tag)) return;
        onChange([...tags, tag]);
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            addTag(input);
            setInput('');
        } else if (e.key === 'Backspace' && !input && tags.length) {
            onChange(tags.slice(0, -1));
        }
    };

    const handleBlur = () => {
        if (input.trim()) { addTag(input); setInput(''); }
    };

    return (
        <div className="tag-input-wrap" onClick={() => inputRef.current?.focus()}>
            {tags.map(tag => (
                <span key={tag} className="tag-chip">
                    {tag}
                    <button type="button" onClick={() => onChange(tags.filter(t => t !== tag))} className="tag-chip-remove" aria-label={`Remove ${tag}`}>
                        <X size={11} />
                    </button>
                </span>
            ))}
            <input
                ref={inputRef}
                id={id}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={handleBlur}
                placeholder={tags.length ? '' : placeholder}
                className="tag-chip-input"
            />
            <style>{`
                .tag-input-wrap {
                    display: flex; flex-wrap: wrap; gap: 0.4rem;
                    padding: 0.5rem 0.75rem; border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-md); background: var(--color-gray-50);
                    cursor: text; min-height: 44px; align-items: center;
                    transition: border-color 0.2s, box-shadow 0.2s;
                }
                .tag-input-wrap:focus-within {
                    border-color: var(--color-secondary); box-shadow: 0 0 0 3px rgba(255,91,0,0.1);
                }
                .tag-chip {
                    display: inline-flex; align-items: center; gap: 4px;
                    padding: 3px 8px 3px 10px; background: var(--color-orange-tint); border: 1px solid #fed7aa;
                    border-radius: 99px; font-size: 0.82rem; font-weight: 600; color: var(--color-secondary-dark);
                }
                .tag-chip-remove {
                    display: flex; align-items: center; justify-content: center;
                    width: 14px; height: 14px; border-radius: 50%; border: none;
                    background: #fed7aa; color: #9a3412; cursor: pointer; padding: 0;
                    transition: background 0.1s;
                }
                .tag-chip-remove:hover { background: #fb923c; color: white; }
                .tag-chip-input {
                    border: none; background: transparent; outline: none; font-size: 0.9rem;
                    color: var(--color-gray-900); min-width: 140px; flex: 1;
                    padding: 2px 0;
                }
            `}</style>
        </div>
    );
};

export default TagInput;
