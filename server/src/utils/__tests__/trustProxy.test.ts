import { describe, it, expect } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { parseTrustProxy } from '../trustProxy';

describe('parseTrustProxy', () => {
    it('defaults to 1 hop when unset or empty', () => {
        expect(parseTrustProxy(undefined)).toBe(1);
        expect(parseTrustProxy('  ')).toBe(1);
    });
    it('parses hop counts, booleans and passes other values through', () => {
        expect(parseTrustProxy('2')).toBe(2);
        expect(parseTrustProxy('true')).toBe(true);
        expect(parseTrustProxy('false')).toBe(false);
        expect(parseTrustProxy('loopback, 172.18.0.0/16')).toBe('loopback, 172.18.0.0/16');
    });
});

// The production chain: client -> YunoHost nginx (adds the client IP to
// X-Forwarded-For) -> container nginx (adds the Docker gateway) -> server.
async function clientIpSeen(trust: number | boolean | string, xff: string): Promise<string> {
    const app = express();
    app.set('trust proxy', trust);
    app.get('/ip', (req, res) => { res.send(req.ip); });
    const server: Server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    try {
        const port = (server.address() as { port: number }).port;
        const res = await fetch(`http://127.0.0.1:${port}/ip`, { headers: { 'X-Forwarded-For': xff } });
        return await res.text();
    } finally {
        server.close();
    }
}

describe("Express 'trust proxy' with the production proxy chain", () => {
    it('1 hop sees the Docker gateway for every visitor (the old shared rate limit)', async () => {
        expect(await clientIpSeen(1, '190.53.101.168, 172.18.0.1')).toBe('172.18.0.1');
    });
    it('2 hops sees the real visitor', async () => {
        expect(await clientIpSeen(2, '190.53.101.168, 172.18.0.1')).toBe('190.53.101.168');
    });
    it('2 hops ignores an X-Forwarded-For value forged by the visitor', async () => {
        expect(await clientIpSeen(2, '6.6.6.6, 190.53.101.168, 172.18.0.1')).toBe('190.53.101.168');
    });
});
