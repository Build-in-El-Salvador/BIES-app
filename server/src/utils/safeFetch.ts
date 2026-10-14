/**
 * SSRF-hardened outbound HTTP for fetching attacker-influenceable URLs
 * (e.g. a user's self-declared Lightning-address domain).
 *
 * Guarantees:
 *   - https only (no http/file/gopher/etc.)
 *   - every resolved IP is validated against private/reserved ranges, and the
 *     SAME resolution is pinned to the socket via the `lookup` option — so a
 *     DNS-rebinding flip between check and connect cannot occur
 *   - redirects are followed manually, re-validating each hop (default fetch
 *     would silently follow a 30x to an internal host)
 *   - response body is size- and time-bounded
 *
 * Returns parsed JSON, or null on any failure (blocked host, timeout, non-2xx,
 * oversized/invalid body). Callers treat null as "could not verify".
 */
import https from 'https';
import net from 'net';
import { lookup as dnsLookup } from 'dns';

const MAX_REDIRECTS = 3;
// Some hosts (Cloudflare's browser check, for one) refuse requests with no
// User-Agent.
export const OUTBOUND_HEADERS = { 'User-Agent': 'BIES/1.0 (+https://buildinelsalvador.com)', Accept: 'application/json' };
const MAX_BODY_BYTES = 256 * 1024; // LNURL metadata is tiny; 256KB is generous

// Private, loopback, link-local, shared, documentation, benchmark, multicast
// and reserved ranges, plus the IPv6 forms that carry an IPv4 address inside
// them (IPv4-compatible ::/96, NAT64, 6to4, Teredo). BlockList also checks
// IPv4-mapped addresses (::ffff:a.b.c.d, ::ffff:7f00:1) against the IPv4 rules.
const BLOCKED = new net.BlockList();
for (const [address, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
    ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) BLOCKED.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
    ['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32],
    ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) BLOCKED.addSubnet(address, prefix, 'ipv6');

/** True if an IP literal is in a private, loopback, link-local, or otherwise reserved range. */
export function isBlockedIp(ip: string): boolean {
    const family = net.isIP(ip);
    if (family === 0) return true; // not a valid IP → refuse rather than guess
    return BLOCKED.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * A `lookup` implementation for the socket that resolves the hostname and
 * refuses the connection if ANY resolved address is blocked. Because Node uses
 * the address returned here for the actual TCP connect, the validated IP is the
 * one connected to — no time-of-check/time-of-use rebinding window.
 */
function pinnedSafeLookup(
    hostname: string,
    options: any,
    callback: (err: NodeJS.ErrnoException | null, address?: any, family?: number) => void
): void {
    dnsLookup(hostname, { all: true }, (err, addresses) => {
        if (err) return callback(err);
        if (!addresses || addresses.length === 0) {
            return callback(new Error('SSRF_BLOCKED: no addresses resolved'));
        }
        for (const a of addresses) {
            if (isBlockedIp(a.address)) {
                return callback(new Error(`SSRF_BLOCKED: ${hostname} resolves to reserved address ${a.address}`));
            }
        }
        if (options && options.all) return callback(null, addresses as any);
        const first = addresses[0];
        return callback(null, first.address as any, first.family);
    });
}

/**
 * GET a URL with full SSRF protection: https only, every hop's addresses
 * checked and pinned, redirects re-validated, the body capped at `maxBytes`
 * and the whole request at `timeoutMs`. Resolves to the body and its type,
 * or null on any failure.
 */
export function safeGet(
    rawUrl: string,
    { timeoutMs, maxBytes = MAX_BODY_BYTES, headers = {} }: { timeoutMs: number; maxBytes?: number; headers?: Record<string, string> },
): Promise<{ body: Buffer; contentType: string } | null> {
    return new Promise((resolve) => {
        let settled = false;
        // The whole request, redirects included, within timeoutMs; at the
        // deadline the request in flight is closed too.
        let current: ReturnType<typeof https.request> | null = null;
        const deadline = setTimeout(() => { current?.destroy(); done(null); }, timeoutMs);
        const done = (v: { body: Buffer; contentType: string } | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            resolve(v);
        };

        const attempt = (urlStr: string, redirectsLeft: number): void => {
            if (settled) return;
            let url: URL;
            try {
                url = new URL(urlStr);
            } catch {
                return done(null);
            }
            if (url.protocol !== 'https:') return done(null); // https only — blocks http/file/gopher and downgrade redirects
            // Node doesn't call `lookup` for a host that is already an IP
            // address (the URL parser also turns 2130706433, 0x7f.1 and the
            // like into one), so check those here, on every hop.
            const literal = url.hostname.replace(/^\[|\]$/g, '');
            if (net.isIP(literal) && isBlockedIp(literal)) return done(null);

            const req = current = https.request(
                url,
                { method: 'GET', lookup: pinnedSafeLookup as any, timeout: timeoutMs, headers },
                (res) => {
                    const status = res.statusCode || 0;
                    // Manual redirect handling so each hop is re-validated by pinnedSafeLookup.
                    if (status >= 300 && status < 400 && res.headers.location) {
                        res.destroy(); // its body isn't needed
                        if (redirectsLeft <= 0) return done(null);
                        let next: string;
                        try {
                            next = new URL(res.headers.location, url).toString();
                        } catch {
                            return done(null);
                        }
                        return attempt(next, redirectsLeft - 1);
                    }
                    if (status < 200 || status >= 300) {
                        res.destroy();
                        return done(null);
                    }
                    let size = 0;
                    const chunks: Buffer[] = [];
                    res.on('data', (c: Buffer) => {
                        size += c.length;
                        if (size > maxBytes) {
                            req.destroy();
                            return done(null);
                        }
                        chunks.push(c);
                    });
                    res.on('end', () => done({ body: Buffer.concat(chunks), contentType: String(res.headers['content-type'] || '') }));
                }
            );
            req.on('timeout', () => { req.destroy(); done(null); });
            req.on('error', () => done(null)); // includes SSRF_BLOCKED from the lookup
            req.end();
        };

        attempt(rawUrl, MAX_REDIRECTS);
    });
}

/** GET a URL as JSON with full SSRF protection. Resolves to parsed JSON or null. */
export async function safeGetJson(rawUrl: string, timeoutMs: number): Promise<any | null> {
    const res = await safeGet(rawUrl, { timeoutMs, headers: OUTBOUND_HEADERS });
    if (!res) return null;
    try {
        return JSON.parse(res.body.toString('utf8'));
    } catch {
        return null;
    }
}
