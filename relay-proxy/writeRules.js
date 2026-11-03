// What the proxy doesn't pass on from a signed-in member, beside the word
// filter (noteFilter.js):
// - a post a moderator removed, sent again, or a repost of it: the server
//   lists them in removed.txt beside the whitelist (relayWhitelist.service.ts
//   requestEventRemoval), and the relay deleted them;
// - more than a member writes: events a minute and an hour, and bytes a day,
//   so no one member can fill the relay's database for everyone.
import fs from 'fs';

export const LIMITS = {
    perMinute: 60,
    perHour: 600,
    bytesPerDay: 20 * 1024 * 1024,
};

const HEX_ID = /^[0-9a-f]{64}$/;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function createWriteRules({ removedPath, limits = LIMITS, now = () => Date.now() }) {
    let removed = new Set();
    let removedStamp = null;
    // Read again only when the file changes.
    function removedIds() {
        try {
            const { mtimeMs, size } = fs.statSync(removedPath);
            const stamp = `${mtimeMs}:${size}`;
            if (stamp !== removedStamp) {
                removedStamp = stamp;
                removed = new Set(fs.readFileSync(removedPath, 'utf8').split('\n').map((s) => s.trim()).filter((s) => HEX_ID.test(s)));
            }
        } catch {
            // Nothing removed yet.
        }
        return removed;
    }

    // Per member: [window start, count] for the minute and the hour, [start, bytes] for the day.
    const usage = new Map();
    function spend(pubkey, bytes) {
        const at = now();
        let u = usage.get(pubkey);
        if (!u) { u = { minute: [at, 0], hour: [at, 0], day: [at, 0] }; usage.set(pubkey, u); }
        if (at - u.minute[0] >= MINUTE) u.minute = [at, 0];
        if (at - u.hour[0] >= HOUR) u.hour = [at, 0];
        if (at - u.day[0] >= DAY) u.day = [at, 0];
        if (u.minute[1] >= limits.perMinute || u.hour[1] >= limits.perHour || u.day[1] + bytes > limits.bytesPerDay) return false;
        u.minute[1] += 1;
        u.hour[1] += 1;
        u.day[1] += bytes;
        return true;
    }
    // Members who haven't written in a day are forgotten.
    function prune() {
        const at = now();
        for (const [pubkey, u] of usage) if (at - u.day[0] >= DAY) usage.delete(pubkey);
    }

    /**
     * An ["OK", id, false, reason] answer for an EVENT message the member
     * `sender` sent (`bytes` long), or null to pass it on. Other messages
     * pass.
     */
    function refusal(msg, sender, bytes) {
        if (!Array.isArray(msg) || msg[0] !== 'EVENT' || !msg[1] || typeof msg[1] !== 'object') return null;
        const event = msg[1];
        const id = typeof event.id === 'string' ? event.id : '';
        const ids = removedIds();
        if (ids.size) {
            const repostOfRemoved = (event.kind === 6 || event.kind === 16) && Array.isArray(event.tags)
                && event.tags.some((t) => Array.isArray(t) && t[0] === 'e' && ids.has(t[1]));
            if (ids.has(id) || repostOfRemoved) return ['OK', id, false, 'blocked: removed by a moderator'];
        }
        if (!spend(sender, bytes)) return ['OK', id, false, 'rate-limited: slow down and try again later'];
        return null;
    }

    return { refusal, prune };
}
