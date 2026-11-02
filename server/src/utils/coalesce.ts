/**
 * Runs a piece of work once for many requests to do it. Asking again for a
 * key that's already waiting changes nothing; asking while it runs makes one
 * more run after it, so nothing asked for meanwhile is missed. A key waits
 * `delayMs` (so requests arriving together make one run), never runs twice
 * at once, and at most `maxConcurrent` keys run at a time. While `maxWaiting`
 * keys wait, a new key isn't taken.
 */
export function coalesced<T>(
    run: (value: T) => Promise<unknown>,
    { delayMs, maxConcurrent, maxWaiting }: { delayMs: number; maxConcurrent: number; maxWaiting: number },
): (key: string, value: T) => void {
    const waiting = new Map<string, T>(); // asked for, not started yet
    const due: string[] = []; // waited their delay, oldest first
    const running = new Set<string>();

    function startDue(): void {
        for (let i = 0; i < due.length && running.size < maxConcurrent;) {
            const key = due[i];
            // Its run in progress started before this was asked for: next, once it ends.
            if (running.has(key)) {
                i++;
                continue;
            }
            due.splice(i, 1);
            const value = waiting.get(key) as T;
            waiting.delete(key);
            running.add(key);
            Promise.resolve()
                .then(() => run(value))
                .catch(() => {})
                .finally(() => {
                    running.delete(key);
                    startDue();
                });
        }
    }

    return (key, value) => {
        if (waiting.has(key) || waiting.size >= maxWaiting) return;
        waiting.set(key, value);
        const timer = setTimeout(() => {
            due.push(key);
            startDue();
        }, delayMs);
        timer.unref?.();
    };
}
