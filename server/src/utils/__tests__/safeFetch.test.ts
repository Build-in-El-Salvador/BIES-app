import http from 'http';
import https from 'https';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { isBlockedIp, safeGet, safeGetJson } from '../safeFetch';

describe('isBlockedIp (SSRF guard)', () => {
    it('blocks the cloud metadata address', () => {
        expect(isBlockedIp('169.254.169.254')).toBe(true);
    });

    it.each([
        '127.0.0.1',   // loopback
        '10.1.2.3',    // 10/8 private
        '172.16.0.1',  // 172.16/12 private
        '172.31.255.255',
        '192.168.1.1', // 192.168/16 private
        '169.254.0.5', // link-local
        '100.64.0.1',  // CGNAT
        '0.0.0.0',     // unspecified
        '224.0.0.1',   // multicast
        '240.0.0.1',   // reserved
        '127.0.0.2',   // all of 127/8
        '198.18.0.1',  // benchmarking
        '192.0.2.1',   // documentation
    ])('blocks private/reserved IPv4 %s', (ip) => {
        expect(isBlockedIp(ip)).toBe(true);
    });

    it.each([
        '::1',                 // loopback
        '::',                  // unspecified
        'fe80::1',             // link-local
        'fd00::1',             // unique-local
        'fc00::1',
        'ff02::1',             // multicast
        '::ffff:127.0.0.1',    // IPv4-mapped loopback (bypass attempt)
        '::ffff:10.0.0.1',     // IPv4-mapped private
        '::ffff:7f00:1',       // the same, as the URL parser writes it
        '::7f00:1',            // IPv4-compatible
        'fe81::1',             // still fe80::/10
        'fec0::1',             // site-local
        '64:ff9b::a00:1',      // NAT64 of 10.0.0.1
        '2002:a00:1::1',       // 6to4 of 10.0.0.1
        '2001:db8::1',         // documentation
    ])('blocks private/reserved IPv6 %s', (ip) => {
        expect(isBlockedIp(ip)).toBe(true);
    });

    it.each([
        '8.8.8.8',
        '1.1.1.1',
        '172.32.0.1',          // just outside 172.16/12
        '2606:4700:4700::1111',
    ])('allows public address %s', (ip) => {
        expect(isBlockedIp(ip)).toBe(false);
    });

    it('refuses non-IP strings (fail closed)', () => {
        expect(isBlockedIp('not-an-ip')).toBe(true);
        expect(isBlockedIp('')).toBe(true);
    });
});

describe('safeGetJson', () => {
    it('rejects non-https protocols without making a request', async () => {
        // http/file/etc. must be refused up front — returns null, no throw.
        expect(await safeGetJson('http://example.com/x', 500)).toBeNull();
        expect(await safeGetJson('file:///etc/passwd', 500)).toBeNull();
        expect(await safeGetJson('not a url', 500)).toBeNull();
    });

    it('does not connect to a hostname that resolves to a private IP', async () => {
        // localhost resolves to 127.0.0.1 → pinnedSafeLookup must abort the socket.
        const result = await safeGetJson('https://localhost/.well-known/lnurlp/x', 1000);
        expect(result).toBeNull();
    });

    afterEach(() => vi.restoreAllMocks());

    it('refuses an IP-address host before connecting, in every written form', async () => {
        // Node skips `lookup` for IP hosts, so the check has to happen first.
        const request = vi.spyOn(https, 'request');
        for (const url of [
            'https://169.254.169.254/latest/meta-data/',
            'https://127.0.0.2/', 'https://2130706433/', 'https://0x7f.0.0.1/', 'https://0177.0.0.1/', 'https://127.1/',
            'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://[64:ff9b::a00:1]/',
        ]) {
            expect(await safeGet(url, { timeoutMs: 1000 }), url).toBeNull();
        }
        expect(request).not.toHaveBeenCalled();
    });

    it('closes the request at the deadline, even while bytes keep coming', async () => {
        // A server that sends a byte every 50 ms never trips the idle timeout.
        let closedAt = 0;
        const server = http.createServer((_req, res) => {
            res.writeHead(200);
            const tick = setInterval(() => res.write('x'), 50);
            res.on('close', () => { clearInterval(tick); closedAt = Date.now(); });
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as { port: number }).port;
        // Route the https request to the plain http server, past the address
        // check (a stand-in for a slow public host).
        vi.spyOn(https, 'request').mockImplementation(((url: URL, options: any, cb: any) =>
            http.request({ host: '127.0.0.1', port, path: url.pathname, method: 'GET', timeout: options.timeout }, cb)) as any);
        const started = Date.now();
        expect(await safeGet('https://slow.example/', { timeoutMs: 300 })).toBeNull();
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(closedAt).toBeGreaterThan(0);
        expect(closedAt - started).toBeLessThan(450);
        server.close();
    });
});
