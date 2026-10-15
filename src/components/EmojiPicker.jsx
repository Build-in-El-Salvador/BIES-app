import { useState, useEffect, useRef } from 'react';

const EMOJI_CATEGORIES = {
    'Smileys': ['😀','😂','🤣','😊','😍','🥰','😘','😎','🤩','🥳','😏','😢','😭','😤','🤬','😱','🤯','🥺','🤗','🤔','🫡','🫠','😴','🤮','🥴','😈','💀','👻','🤡','💩'],
    'Gestures': ['👍','👎','👏','🙌','🤝','✌️','🤞','🤙','👊','✊','🫶','❤️‍🔥','💪','🙏','🫂','👀','🧠','💅'],
    'Bitcoin': ['⚡','🔥','💰','🪙','💎','🚀','📈','📉','🐂','🐻','🏦','💸','🤑','🎯','🛡️','🔑','⛏️','🌽'],
    'Nature': ['🌎','🌋','🌊','☀️','🌙','⭐','🌈','🌸','🌴','🍀','🐝','🦋','🐸','🦁','🐺','🐉'],
    'Objects': ['🎉','🎊','🏆','🎵','🎶','📱','💻','⌨️','🔒','🔓','📧','💡','🔔','📣','🏗️','⚙️','🧪','🗳️'],
    'Flags': ['🇸🇻','🇺🇸','🇧🇷','🇬🇧','🇩🇪','🇯🇵','🇰🇷','🇮🇳','🇳🇬','🇿🇦','🇦🇷','🇲🇽','🇨🇴','🇨🇷','🇵🇦','🏴‍☠️','🏳️‍🌈','🏁'],
};

const EmojiPicker = ({ onSelect, onClose, below = false }) => {
    const [activeCategory, setActiveCategory] = useState('Smileys');
    const ref = useRef(null);

    useEffect(() => {
        const handleClickOutside = (e) => {
            if (ref.current && !ref.current.contains(e.target)) {
                onClose();
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [onClose]);

    return (
        <div className={`emoji-picker${below ? ' picker-below' : ''}`} ref={ref}>
            <div className="emoji-tabs">
                {Object.keys(EMOJI_CATEGORIES).map(cat => (
                    <button
                        key={cat}
                        className={`emoji-tab ${activeCategory === cat ? 'active' : ''}`}
                        onClick={() => setActiveCategory(cat)}
                    >
                        {EMOJI_CATEGORIES[cat][0]}
                    </button>
                ))}
            </div>
            <div className="emoji-grid">
                {EMOJI_CATEGORIES[activeCategory].map((emoji, i) => (
                    <button
                        key={i}
                        className="emoji-btn"
                        onClick={() => onSelect(emoji)}
                    >
                        {emoji}
                    </button>
                ))}
            </div>
            <style>{`
                .emoji-picker {
                    position: absolute;
                    bottom: 100%;
                    right: 0;
                    margin-bottom: 0.5rem;
                    background: var(--color-surface, white);
                    border: 1px solid #e5e7eb;
                    border-radius: 12px;
                    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.15);
                    width: 280px;
                    max-width: calc(100vw - 2rem);
                    z-index: 1000;
                    overflow: hidden;
                }
                /* Under the whole composer, from its left edge: a picker hung off one
                   button near the left ran off the screen on phones. */
                .emoji-picker.picker-below {
                    top: 100%;
                    bottom: auto;
                    left: 12px;
                    right: auto;
                    width: calc(100% - 24px);
                    max-width: 400px;
                    margin: 4px 0 0;
                }
                .emoji-tabs {
                    display: flex;
                    border-bottom: 1px solid #e5e7eb;
                    padding: 0.25rem;
                    gap: 2px;
                    overflow-x: auto;
                    scrollbar-width: none;
                }
                .emoji-tabs::-webkit-scrollbar { display: none; }
                .emoji-tab {
                    flex-shrink: 0;
                    width: 32px;
                    height: 32px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    border: none;
                    background: transparent;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 1rem;
                    transition: background 0.15s;
                }
                .emoji-tab:hover { background: #f3f4f6; }
                .emoji-tab.active { background: #ede9fe; }
                .emoji-grid {
                    display: grid;
                    grid-template-columns: repeat(8, 1fr);
                    gap: 2px;
                    padding: 0.5rem;
                    max-height: 200px;
                    overflow-y: auto;
                }
                .emoji-btn {
                    width: 32px;
                    height: 32px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    border: none;
                    background: transparent;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 1.15rem;
                    transition: background 0.1s, transform 0.1s;
                }
                .emoji-btn:hover {
                    background: #f3f4f6;
                    transform: scale(1.2);
                }

                :global([data-theme="dark"]) .emoji-picker {
                    background: #1e2a3a;
                    border-color: #2d3748;
                }
                :global([data-theme="dark"]) .emoji-tabs {
                    border-color: #2d3748;
                }
                :global([data-theme="dark"]) .emoji-tab:hover,
                :global([data-theme="dark"]) .emoji-btn:hover {
                    background: #2d3748;
                }
                :global([data-theme="dark"]) .emoji-tab.active {
                    background: rgba(124, 58, 237, 0.3);
                }
            `}</style>
        </div>
    );
};

export default EmojiPicker;
