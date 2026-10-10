import type { Request } from 'express';
import { verifyAccessToken } from '../services/session.service';

/**
 * Rate-limit key: the account for signed-in requests, the IP otherwise.
 *
 * Everyone on one network shares an IP: at a BIES event the whole room is on
 * the venue Wi-Fi, and mobile carriers put many phones behind one address.
 * Limiting signed-in requests per IP would lock the room out together.
 *
 * Only a token this server signed counts (checked with the JWT secret), so a
 * made-up token falls back to the IP. Expired tokens still count: the app
 * sends its expired access token when it refreshes, so a room renewing its
 * sessions at once is limited per person. Revoked tokens get their own
 * bucket too; `authenticate` rejects them on the route itself.
 */
export function rateLimitKey(req: Request): string {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
        const token = verifyAccessToken(header.slice(7), { ignoreExpiration: true });
        if (token.ok && token.claims.userId) return `user:${token.claims.userId}`;
    }
    return `ip:${req.ip}`;
}
