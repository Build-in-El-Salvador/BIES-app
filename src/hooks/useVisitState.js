import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { visitValue, keepVisitValue } from '../utils/visitMemory.js';

/**
 * useState for what a list page is showing (its search, filter chips, the
 * filters drawer), which Back brings back as it was left, so the list it
 * returns to is the same one, at the same place (useScrollMemory). Kept per
 * visit (history entry) in memory. A new visit, from a tab or a link, starts
 * from `initial`. `name` is unique on the page ("directory.category").
 */
export default function useVisitState(name, initial) {
    const { key } = useLocation();
    const read = (visit) => visitValue(visit, name, initial);
    const [state, setState] = useState(() => ({ visit: key, value: read(key) }));
    // The same page, another visit (Back to it, or its tab tapped again).
    let current = state;
    if (state.visit !== key) {
        current = { visit: key, value: read(key) };
        setState(current);
    }
    useEffect(() => { keepVisitValue(current.visit, name, current.value); }, [current.visit, current.value]);
    const set = useCallback((next) => setState((prev) => ({
        visit: prev.visit,
        value: typeof next === 'function' ? next(prev.value) : next,
    })), []);
    return [current.value, set];
}
