import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';

/**
 * Rate-limit key: the account for signed-in requests, the IP otherwise.
 *
 * Everyone on one network shares an IP: at a BIES event the whole room is on
 * the venue Wi-Fi, and mobile carriers put many phones behind one address.
 * Limiting signed-in requests per IP would lock the room out together.
 *
 * Only a token this server signed counts (checked with the JWT secret), so a
 * made-up token falls back to the IP. Revoked tokens still get their own
 * bucket here; `authenticate` rejects them on the route itself.
 */
export function rateLimitKey(req: Request): string {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
        try {
            const payload = jwt.verify(header.slice(7), config.jwtSecret, { algorithms: ['HS256'] }) as { userId?: unknown };
            if (typeof payload.userId === 'string' && payload.userId) return `user:${payload.userId}`;
        } catch {
            // Invalid or expired: fall back to the IP.
        }
    }
    return `ip:${req.ip}`;
}
