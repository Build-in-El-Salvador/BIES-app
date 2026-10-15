import React, { createContext, useContext, useState, useRef, useCallback } from 'react';
import { sanitizeTabs, restoreTabs, savedTabs, DEFAULT_BOTTOM_NAV } from '../config/navPages';
import { preferencesApi } from '../services/api';

const STORAGE_KEY = 'bies_bottom_nav';

const BottomNavContext = createContext({
    tabs: DEFAULT_BOTTOM_NAV,
    updateTabs: () => {},
    applyServerTabs: () => {},
    resetTabs: () => {},
    isCustomized: false,
    saveError: false,
});

export const BottomNavProvider = ({ children }) => {
    const [tabs, setTabs] = useState(() => {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) return restoreTabs(JSON.parse(stored));
        } catch {
            // corrupt JSON → fall back to defaults
        }
        return [...DEFAULT_BOTTOM_NAV];
    });
    // True when the last server save failed: the layout is device-local only.
    const [saveError, setSaveError] = useState(false);

    // Mirror of `tabs` for synchronous change detection inside the stable callback.
    const tabsRef = useRef(tabs);
    tabsRef.current = tabs;

    // User-initiated change: persist to localStorage AND the backend preference.
    const updateTabs = useCallback((ids) => {
        const clean = sanitizeTabs(ids);
        if (JSON.stringify(clean) === JSON.stringify(tabsRef.current)) return; // nothing changed → skip the save
        setTabs(clean);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(savedTabs(clean)));
        setSaveError(false);
        preferencesApi.save({ bottomNavTabs: savedTabs(clean) }).catch((err) => {
            // Keep the local change, but surface that it did not reach the server.
            console.warn('[BottomNav] Failed to save navbar layout to the server:', err && err.message ? err.message : err);
            setSaveError(true);
        });
    }, []);

    // Server-initiated restore (login): localStorage only — no echo back to the server.
    const applyServerTabs = useCallback((ids) => {
        const clean = restoreTabs(ids);
        setTabs(clean);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(savedTabs(clean)));
    }, []);

    const resetTabs = useCallback(() => {
        updateTabs(DEFAULT_BOTTOM_NAV);
    }, [updateTabs]);

    const isCustomized = JSON.stringify(tabs) !== JSON.stringify(DEFAULT_BOTTOM_NAV);

    return (
        <BottomNavContext.Provider value={{ tabs, updateTabs, applyServerTabs, resetTabs, isCustomized, saveError }}>
            {children}
        </BottomNavContext.Provider>
    );
};

export const useBottomNav = () => useContext(BottomNavContext);
