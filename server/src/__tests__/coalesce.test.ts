/**
 * coalesced (utils/coalesce.ts): many requests for the same work make one
 * run; asking during a run makes one more after it; a few keys run at once.
 * The course auto-claim (coursePurchase.service.ts) runs through it, so a
 * buyer's receipts arriving together make one relay query.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { coalesced } from '../utils/coalesce';

/** A run that ends when told to. */
function controlledRuns() {
    const ends: Array<() => void> = [];
    const run = vi.fn((_value: string) => new Promise<void>((resolve) => ends.push(resolve)));
    return { run, endOne: async () => { ends.shift()?.(); await vi.advanceTimersByTimeAsync(0); } };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('coalesced', () => {
    it('makes one run of many requests arriving together, after the delay', async () => {
        const { run } = controlledRuns();
        const ask = coalesced(run, { delayMs: 5000, maxConcurrent: 2, maxWaiting: 10 });
        for (let i = 0; i < 10; i++) ask('buyer:course', 'buyer:course');
        await vi.advanceTimersByTimeAsync(4999);
        expect(run).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('asked during a run, runs once more when it ends, never two at once', async () => {
        const { run, endOne } = controlledRuns();
        const ask = coalesced(run, { delayMs: 5000, maxConcurrent: 2, maxWaiting: 10 });
        ask('k', 'first');
        await vi.advanceTimersByTimeAsync(5000);
        expect(run).toHaveBeenCalledTimes(1);

        ask('k', 'second');
        ask('k', 'third');
        await vi.advanceTimersByTimeAsync(10_000);
        expect(run).toHaveBeenCalledTimes(1);

        await endOne();
        expect(run).toHaveBeenCalledTimes(2);
        expect(run).toHaveBeenLastCalledWith('second');
        await endOne();
        expect(run).toHaveBeenCalledTimes(2);
    });

    it('runs a few keys at once, the others when one ends', async () => {
        const { run, endOne } = controlledRuns();
        const ask = coalesced(run, { delayMs: 100, maxConcurrent: 2, maxWaiting: 10 });
        for (const key of ['a', 'b', 'c', 'd']) ask(key, key);
        await vi.advanceTimersByTimeAsync(100);
        expect(run.mock.calls.map(([v]) => v)).toEqual(['a', 'b']);
        await endOne();
        expect(run.mock.calls.map(([v]) => v)).toEqual(['a', 'b', 'c']);
    });

    it('takes no new key while too many wait', async () => {
        const { run } = controlledRuns();
        const ask = coalesced(run, { delayMs: 100, maxConcurrent: 5, maxWaiting: 2 });
        for (const key of ['a', 'b', 'c']) ask(key, key);
        await vi.advanceTimersByTimeAsync(100);
        expect(run.mock.calls.map(([v]) => v)).toEqual(['a', 'b']);
    });

    it('goes on after a run that fails', async () => {
        const run = vi.fn(async () => { throw new Error('relay down'); });
        const ask = coalesced(run, { delayMs: 100, maxConcurrent: 1, maxWaiting: 10 });
        ask('a', 'a');
        ask('b', 'b');
        await vi.advanceTimersByTimeAsync(100);
        expect(run).toHaveBeenCalledTimes(2);
    });
});
