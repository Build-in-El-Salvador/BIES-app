import { useEffect, useSyncExternalStore } from 'react';
import { useAuth } from '../context/AuthContext';
import { EMPTY, getBlocks, loadBlocks, subscribe } from '../services/blockStore';

/** The members the signed-in member blocked: `{ loaded, members, ids, pubkeys }`. */
export function useBlocks() {
    const { user } = useAuth();
    const userId = user?.id ?? null;
    const snapshot = useSyncExternalStore(subscribe, getBlocks);
    useEffect(() => {
        const current = getBlocks();
        if (current.userId !== userId || (userId && !current.loaded)) loadBlocks(userId);
    }, [userId]);
    return snapshot.userId === userId ? snapshot : EMPTY;
}
