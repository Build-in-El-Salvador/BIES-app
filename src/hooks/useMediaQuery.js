import { useEffect, useState } from 'react';

/** Whether a CSS media query matches now; follows it as the window changes. */
export default function useMediaQuery(query) {
    const [matches, setMatches] = useState(() =>
        typeof window !== 'undefined' && !!window.matchMedia?.(query).matches);
    useEffect(() => {
        const list = window.matchMedia?.(query);
        if (!list) return undefined;
        const update = () => setMatches(list.matches);
        update();
        list.addEventListener('change', update);
        return () => list.removeEventListener('change', update);
    }, [query]);
    return matches;
}
