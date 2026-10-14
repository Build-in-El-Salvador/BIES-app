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
const MAX_BODY_BYTES = 256 * 1024; // LNURL metadata is tiny; 256KB is generous

/** True if an IP literal is in a private, loopback, link-local, or otherwise reserved range. */
export function isBlockedIp(ip: string): boolean {
    const family = net.isIP(ip);
    if (family === 0) return true; // not a valid IP → refuse rather than guess

    if (family === 4) {
        const p = ip.split('.').map(Number);
        if (p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
        const [a, b] = p;
        if (a === 0) return true;                          // 0.0.0.0/8 "this host"
        if (a === 10) return true;                         // 10.0.0.0/8 private
        if (a === 127) return true;                        // 127.0.0.0/8 loopback
        if (a === 169 && b === 254) return true;           // 169.254.0.0/16 link-local (incl. cloud metadata 169.254.169.254)
        if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12 private
        if (a === 192 && b === 168) return true;           // 192.168.0.0/16 private
        if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
        if (a >= 224) return true;                         // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
        return false;
    }

    // IPv6
    const v6 = ip.toLowerCase();
    if (v6 === '::' || v6 === '::1') return true;          // unspecified / loopback
    if (v6.startsWith('fe80') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb')) return true; // fe80::/10 link-local
    if (v6.startsWith('fc') || v6.startsWith('fd')) return true; // fc00::/7 unique-local
    if (v6.startsWith('ff')) return true;                  // ff00::/8 multicast
    // IPv4-mapped/-embedded (::ffff:a.b.c.d, ::a.b.c.d) — re-check the embedded v4
    const embedded = v6.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (embedded) return isBlockedIp(embedded[1]);
    return false;
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
        // The whole request, redirects included, within timeoutMs.
        const deadline = setTimeout(() => done(null), timeoutMs);
        const done = (v: { body: Buffer; contentType: string } | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            resolve(v);
        };

        const attempt = (urlStr: string, redirectsLeft: number): void => {
            let url: URL;
            try {
                url = new URL(urlStr);
            } catch {
                return done(null);
            }
            if (url.protocol !== 'https:') return done(null); // https only — blocks http/file/gopher and downgrade redirects

            const req = https.request(
                url,
                { method: 'GET', lookup: pinnedSafeLookup as any, timeout: timeoutMs, headers },
                (res) => {
                    const status = res.statusCode || 0;
                    // Manual redirect handling so each hop is re-validated by pinnedSafeLookup.
                    if (status >= 300 && status < 400 && res.headers.location) {
                        res.resume(); // drain
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
                        res.resume();
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
    const res = await safeGet(rawUrl, { timeoutMs });
    if (!res) return null;
    try {
        return JSON.parse(res.body.toString('utf8'));
    } catch {
        return null;
    }
}
