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
 * made-up token falls back to the IP. A token that expired in the last hour
 * still counts: the app sends its expired access token when it refreshes, so
 * a room renewing its sessions at once is limited per person. Older tokens
 * fall back to the IP, so one leaked long ago can't use up its owner's
 * limit. Revoked tokens get their own bucket too; `authenticate` rejects
 * them on the route itself.
 */
const RECENTLY_EXPIRED_SECONDS = 60 * 60;

export function rateLimitKey(req: Request): string {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
        const token = verifyAccessToken(header.slice(7), { ignoreExpiration: true });
        const recent = token.ok && (token.claims.exp ?? 0) > Date.now() / 1000 - RECENTLY_EXPIRED_SECONDS;
        if (token.ok && recent && token.claims.userId) return `user:${token.claims.userId}`;
    }
    return `ip:${req.ip}`;
}
