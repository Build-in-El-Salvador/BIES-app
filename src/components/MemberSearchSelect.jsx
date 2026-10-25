import React, { useState, useEffect, useRef } from 'react';
import { Search, X, UserPlus, Loader2 } from 'lucide-react';
import { profilesApi } from '../services/api';
import { getAssetUrl } from '../utils/assets';

/**
 * MemberSearchSelect — search BIES members and build a guestlist.
 *
 * Props:
 *   value: Array<{ name: string, userId: string, avatar?: string }>
 *   onChange: (newList) => void
 *   placeholder?: string
 */
const MemberSearchSelect = ({ value = [], onChange, placeholder = 'Search BIES members by name...' }) => {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState([]);
    const [searching, setSearching] = useState(false);
    const [open, setOpen] = useState(false);
    const inputRef = useRef(null);
    const dropdownRef = useRef(null);

    useEffect(() => {
        if (!query.trim()) { setResults([]); setOpen(false); return; }
        const timer = setTimeout(async () => {
            setSearching(true);
            try {
                const res = await profilesApi.list({ search: query, limit: 10 });
                const list = res?.data || res || [];
                setResults(list);
                setOpen(list.length > 0);
            } catch {
                setResults([]);
            } finally {
                setSearching(false);
            }
        }, 300);
        return () => clearTimeout(timer);
    }, [query]);

    // Close dropdown on outside click
    useEffect(() => {
        const handler = (e) => {
            if (
                dropdownRef.current && !dropdownRef.current.contains(e.target) &&
                inputRef.current && !inputRef.current.contains(e.target)
            ) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    const isSelected = (userId) => value.some(g => g.userId === userId);

    const handleAdd = (profile) => {
        if (isSelected(profile.userId || profile.user?.id)) return;
        const userId = profile.userId || profile.user?.id || profile.id;
        const name = profile.name || profile.user?.profile?.name || 'Unknown';
        const avatar = profile.avatar || profile.user?.profile?.avatar || '';
        onChange([...value, { name, userId, avatar }]);
        setQuery('');
        setResults([]);
        setOpen(false);
    };

    const handleRemove = (userId) => {
        onChange(value.filter(g => g.userId !== userId));
    };

    return (
        <div className="member-search">
            {/* Selected guests */}
            {value.length > 0 && (
                <div className="guest-chips">
                    {value.map(g => (
                        <div key={g.userId || g.name} className="chip">
                            {g.avatar ? (
                                <img src={getAssetUrl(g.avatar)} alt={g.name} className="chip-avatar" />
                            ) : (
                                <span className="chip-initials">{(g.name || '?')[0].toUpperCase()}</span>
                            )}
                            <span className="chip-name">{g.name}</span>
                            <button
                                type="button"
                                className="chip-remove"
                                onClick={() => handleRemove(g.userId)}
                                title={`Remove ${g.name}`}
                            >
                                <X size={12} />
                            </button>
                        </div>
                    ))}
                </div>
            )}

            {/* Search input */}
            <div className="search-wrap">
                <Search size={15} className="search-icon" />
                <input
                    ref={inputRef}
                    type="text"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    onFocus={() => results.length > 0 && setOpen(true)}
                    placeholder={placeholder}
                    className="search-input"
                    autoComplete="off"
                />
                {searching && <Loader2 size={15} className="spin search-spin" />}
            </div>

            {/* Dropdown results */}
            {open && (
                <div ref={dropdownRef} className="results-dropdown">
                    {results.map(profile => {
                        const userId = profile.userId || profile.user?.id || profile.id;
                        const name = profile.name || 'Unknown';
                        const avatar = profile.avatar || '';
                        const company = profile.company || profile.user?.profile?.company || '';
                        const selected = isSelected(userId);
                        return (
                            <button
                                key={userId}
                                type="button"
                                className={`result-item ${selected ? 'selected' : ''}`}
                                onClick={() => handleAdd(profile)}
                                disabled={selected}
                            >
                                <div className="result-avatar">
                                    {avatar ? (
                                        <img src={getAssetUrl(avatar)} alt={name} />
                                    ) : (
                                        <span>{(name || '?')[0].toUpperCase()}</span>
                                    )}
                                </div>
                                <div className="result-info">
                                    <span className="result-name">{name}</span>
                                    {company && <span className="result-company">{company}</span>}
                                </div>
                                {selected ? (
                                    <span className="result-added">Added</span>
                                ) : (
                                    <UserPlus size={14} className="result-add-icon" />
                                )}
                            </button>
                        );
                    })}
                </div>
            )}

            <style jsx>{`
                .member-search { position: relative; }

                .guest-chips {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 0.4rem;
                    margin-bottom: 0.5rem;
                }

                .chip {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.35rem;
                    padding: 4px 8px 4px 4px;
                    background: var(--color-blue-tint);
                    border: 1px solid #bfdbfe;
                    border-radius: 99px;
                    font-size: 0.82rem;
                    color: #1d4ed8;
                }

                .chip-avatar {
                    width: 20px;
                    height: 20px;
                    border-radius: 50%;
                    object-fit: cover;
                }

                .chip-initials {
                    width: 20px;
                    height: 20px;
                    border-radius: 50%;
                    background: #bfdbfe;
                    color: #1d4ed8;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 0.7rem;
                    font-weight: 700;
                    flex-shrink: 0;
                }

                .chip-name { font-weight: 600; }

                .chip-remove {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 16px;
                    height: 16px;
                    border-radius: 50%;
                    border: none;
                    background: #bfdbfe;
                    color: #1d4ed8;
                    cursor: pointer;
                    padding: 0;
                    flex-shrink: 0;
                    transition: background 0.1s;
                }
                .chip-remove:hover { background: #93c5fd; }

                .search-wrap {
                    position: relative;
                    display: flex;
                    align-items: center;
                }

                .search-icon {
                    position: absolute;
                    left: 10px;
                    color: var(--color-gray-400);
                    pointer-events: none;
                }

                .search-input {
                    width: 100%;
                    padding: 0.65rem 2.25rem 0.65rem 2.25rem;
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-md);
                    font-size: 0.9rem;
                    background: var(--color-gray-50);
                    outline: none;
                    box-sizing: border-box;
                    transition: border-color 0.2s;
                }
                .search-input:focus {
                    border-color: var(--color-secondary);
                    box-shadow: 0 0 0 3px rgba(255,91,0,0.1);
                }

                .search-spin {
                    position: absolute;
                    right: 10px;
                    color: var(--color-gray-400);
                    animation: spin 1s linear infinite;
                }
                @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

                .results-dropdown {
                    position: absolute;
                    top: calc(100% + 4px);
                    left: 0;
                    right: 0;
                    background: var(--color-surface);
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-md);
                    box-shadow: 0 8px 24px rgba(0,0,0,0.1);
                    z-index: 200;
                    max-height: 240px;
                    overflow-y: auto;
                }

                .result-item {
                    display: flex;
                    align-items: center;
                    gap: 0.75rem;
                    padding: 0.6rem 0.85rem;
                    width: 100%;
                    background: none;
                    border: none;
                    cursor: pointer;
                    text-align: left;
                    transition: background 0.1s;
                }
                .result-item:hover:not(:disabled) { background: var(--color-gray-50); }
                .result-item.selected { opacity: 0.6; cursor: default; }

                .result-avatar {
                    width: 32px;
                    height: 32px;
                    border-radius: 50%;
                    background: var(--color-gray-200);
                    overflow: hidden;
                    flex-shrink: 0;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 0.8rem;
                    font-weight: 700;
                    color: var(--color-gray-500);
                }
                .result-avatar img { width: 100%; height: 100%; object-fit: cover; }

                .result-info {
                    flex: 1;
                    display: flex;
                    flex-direction: column;
                    gap: 1px;
                    min-width: 0;
                }
                .result-name { font-size: 0.88rem; font-weight: 600; color: var(--color-gray-900); }
                .result-company { font-size: 0.75rem; color: var(--color-gray-500); }

                .result-added { font-size: 0.75rem; color: #16a34a; font-weight: 600; }
                .result-add-icon { color: var(--color-secondary); flex-shrink: 0; }
            `}</style>
        </div>
    );
};

export default MemberSearchSelect;
