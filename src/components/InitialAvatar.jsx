import { initialOf } from '../utils/initialOf';

// PP Formula Narrow's capitals are 0.808 em tall: at 56 units the letter is
// 45.2 tall, so a baseline at 50 + 45.2 / 2 centres it in the 100-unit circle.
const FONT_SIZE = 56;
const BASELINE = 50 + (0.808 * FONT_SIZE) / 2;

/**
 * What a member without a photo shows, everywhere in the app: the first letter
 * of their name in the BIES display font and blue, inside the BIES orange ring.
 * No usable name (or it starts with a symbol): a person figure in the same ring.
 *
 * Drawn as one SVG so the letter and ring keep their proportions at any size.
 * By default it fills its box (the photo's circle, which the caller sizes);
 * pass `size` where the box has no size of its own.
 *
 * The Nostr ostrich is not used for people: BIES shows it only on the Nostr
 * settings row.
 *
 * @param {string} [name] - the member's name; only its first letter is shown
 * @param {number} [size] - a fixed size in px, when the parent isn't sized
 * @param {string} [className]
 */
export default function InitialAvatar({ name, size, className = '' }) {
    const letter = initialOf(name);
    return (
        <svg
            viewBox="0 0 100 100"
            className={`bies-initial${className ? ` ${className}` : ''}`}
            style={size ? { width: size, height: size } : undefined}
            aria-hidden="true"
            focusable="false"
        >
            <circle cx="50" cy="50" r="50" fill="#F9F5F4" />
            <circle cx="50" cy="50" r="46.75" fill="none" stroke="#FF5B00" strokeWidth="6.5" />
            {letter ? (
                <text
                    x="50"
                    y={BASELINE}
                    textAnchor="middle"
                    fill="#0047AB"
                    fontSize={FONT_SIZE}
                    fontWeight="700"
                    fontFamily="'PP Formula Narrow', system-ui, -apple-system, sans-serif"
                >
                    {letter}
                </text>
            ) : (
                <g fill="#0047AB" transform="translate(21 21) scale(2.4167)">
                    <circle cx="12" cy="8" r="4.2" />
                    <path d="M3.6 21.2c.6-4.6 4.1-7.4 8.4-7.4s7.8 2.8 8.4 7.4c.05.45-.3.8-.75.8H4.35c-.45 0-.8-.35-.75-.8z" />
                </g>
            )}
        </svg>
    );
}
