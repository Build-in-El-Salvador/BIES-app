import React, { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { flagsApi } from '../services/api';
import { DEFAULT_FLAGS } from '../config/featureSlugs';
import { scopeFlags } from '../config/appScope';
import { isNativePlatform } from '../utils/platform';

/**
 * Runtime feature flags — admin-toggled, fetched from the public
 * GET /api/flags at app boot (works logged-out) and refreshed on window
 * focus. Fail-open: defaults to all-enabled while loading and keeps the
 * last known flags on fetch errors, so a flaky API never hides the app.
 * Unknown slugs default to enabled (`useFeature` treats only an explicit
 * `false` as disabled).
 *
 * `flags` are what this copy of the app runs with: in the store app,
 * nothing outside its scope (config/appScope.js). `serverFlags` are the
 * admin switches as stored, for the admin page that edits them.
 */
const FeatureFlagsContext = createContext({
    flags: DEFAULT_FLAGS,
    serverFlags: DEFAULT_FLAGS,
    loading: true,
    refresh: () => {},
});

// The last answer, so the app starts with the right pages instead of
// showing everything and then hiding what's off. Only switches, nothing
// personal; the server's answer replaces it a moment later.
const FLAGS_KEY = 'bies_flags';

function rememberedFlags() {
    try {
        const saved = JSON.parse(localStorage.getItem(FLAGS_KEY));
        return saved && typeof saved === 'object' && !Array.isArray(saved) ? { ...DEFAULT_FLAGS, ...saved } : DEFAULT_FLAGS;
    } catch {
        return DEFAULT_FLAGS;
    }
}

export const FeatureFlagsProvider = ({ children }) => {
    const [flags, setFlags] = useState(rememberedFlags);
    const [loading, setLoading] = useState(true);
    const inFlight = useRef(false);

    const refresh = useCallback(async () => {
        if (inFlight.current) return;
        inFlight.current = true;
        try {
            const data = await flagsApi.get();
            if (data && typeof data === 'object' && !Array.isArray(data)) {
                setFlags({ ...DEFAULT_FLAGS, ...data });
                try { localStorage.setItem(FLAGS_KEY, JSON.stringify(data)); } catch { /* storage off */ }
            }
        } catch {
            // fail-open: keep the last known flags (defaults on first load)
        } finally {
            inFlight.current = false;
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        refresh();
        const onFocus = () => refresh();
        window.addEventListener('focus', onFocus);
        return () => window.removeEventListener('focus', onFocus);
    }, [refresh]);

    const scoped = useMemo(() => scopeFlags(flags, isNativePlatform()), [flags]);

    return (
        <FeatureFlagsContext.Provider value={{ flags: scoped, serverFlags: flags, loading, refresh }}>
            {children}
        </FeatureFlagsContext.Provider>
    );
};

export const useFeatureFlags = () => useContext(FeatureFlagsContext);

/** True unless the slug is explicitly disabled (missing/unknown ⇒ enabled). */
export const useFeature = (slug) => {
    const { flags } = useFeatureFlags();
    return flags[slug] !== false;
};
