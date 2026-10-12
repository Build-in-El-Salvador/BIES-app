import { useEffect, useSyncExternalStore } from 'react';
import { useAuth } from '../context/AuthContext';
import { EMPTY, getBlocks, loadBlocks, subscribe } from '../services/blockStore';
import { getMuted, subscribeMuted } from '../services/muteStore';

/** The members the signed-in member blocked: `{ loaded, error, members, ids, pubkeys }`. */
export function useBlocks() {
    const { user } = useAuth();
    const userId = user?.id ?? null;
    const snapshot = useSyncExternalStore(subscribe, getBlocks);
    useEffect(() => {
        const current = getBlocks();
        // Load, or try again after a failure.
        if (current.userId !== userId || (userId && (!current.loaded || current.error))) loadBlocks(userId);
    }, [userId]);
    return snapshot.userId === userId ? snapshot : EMPTY;
}

/** Pubkeys the signed-in member muted on this device (services/muteStore.js). */
export function useMuted() {
    const { user } = useAuth();
    const userId = user?.id ?? null;
    return useSyncExternalStore(subscribeMuted, () => getMuted(userId)).pubkeys;
}
