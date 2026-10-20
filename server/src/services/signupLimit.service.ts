/**
 * New accounts per address per day, for sign-up with a Nostr key: any key
 * makes an account (no email to receive), so without this one machine could
 * make thousands, each with its own share of every per-account limit.
 * Members signing in again are never counted, and new members joining by
 * email have the email code limits instead, so a room on one venue Wi-Fi is
 * fine. In memory: a restart starts the count again.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const PER_IP_PER_DAY = parseInt(process.env.NEW_ACCOUNTS_PER_IP_PER_DAY || '10', 10);
// Across everyone: past this in an hour, a warning in the log (once an hour).
const WARN_PER_HOUR = parseInt(process.env.NEW_ACCOUNTS_WARN_PER_HOUR || '30', 10);

const byIp = new Map<string, { count: number; resetAt: number }>();
let hour = { count: 0, resetAt: 0, warned: false };

/** Whether another new account may be made from this address now; counts it if so. */
export function allowNewAccount(ip: string | null | undefined, now = Date.now()): boolean {
    const key = ip || 'unknown';
    const entry = byIp.get(key);
    if (entry && entry.resetAt > now && entry.count >= PER_IP_PER_DAY) return false;
    if (!entry || entry.resetAt <= now) byIp.set(key, { count: 1, resetAt: now + DAY_MS });
    else entry.count += 1;

    if (hour.resetAt <= now) hour = { count: 0, resetAt: now + HOUR_MS, warned: false };
    hour.count += 1;
    if (hour.count > WARN_PER_HOUR && !hour.warned) {
        hour.warned = true;
        console.warn(`[Signup] More than ${WARN_PER_HOUR} new Nostr-key accounts in the last hour`);
    }
    // Drop expired entries now and then, so the map stays small.
    if (byIp.size > 10_000) for (const [k, v] of byIp) if (v.resetAt <= now) byIp.delete(k);
    return true;
}

/** Tests only. */
export function resetSignupLimits(): void {
    byIp.clear();
    hour = { count: 0, resetAt: 0, warned: false };
}
