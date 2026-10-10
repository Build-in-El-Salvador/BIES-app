import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { SESSION_END_MESSAGES, checkSession, verifyAccessToken } from '../services/session.service';

// Extend Express Request to include user info
declare global {
    namespace Express {
        interface Request {
            user?: {
                id: string;
                email: string | null;
                nostrPubkey: string;
                role: string;
                isAdmin: boolean;
            };
            /** The session the access token belongs to (services/session.service.ts). */
            sessionId?: string;
        }
    }
}

/**
 * Require a signed-in user: a valid access token whose session is still live
 * and whose account is neither suspended nor deleted. Checked on every
 * request, so logging out, a ban or a deletion applies at once.
 *
 * 401 responses carry a `reason` the app acts on: `token_expired` means
 * refresh and retry; every other reason means the session is over.
 */
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Missing or invalid authorization header', reason: 'missing_token' });
        return;
    }

    const token = verifyAccessToken(authHeader.slice(7));
    if (!token.ok) {
        res.status(401).json({
            error: token.reason === 'token_expired' ? 'Your session needs refreshing' : 'Invalid token',
            reason: token.reason,
        });
        return;
    }

    try {
        const session = await checkSession(token.claims.sid, token.claims.userId);
        if (!session.ok) {
            res.status(401).json({ error: SESSION_END_MESSAGES[session.reason], reason: session.reason });
            return;
        }
        req.user = session.user;
        req.sessionId = token.claims.sid;
    } catch (error) {
        // A database failure must not read as "signed out": the app would
        // drop a session that is fine.
        console.error('[Auth] Session check failed:', error);
        res.status(503).json({ error: 'Please try again in a moment' });
        return;
    }
    next();
}

/**
 * Optional auth: attaches the user when the request carries a live session,
 * and otherwise carries on as signed out. The app refreshes tokens before
 * they expire, so an expired one here is rare.
 */
export async function optionalAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
        const token = verifyAccessToken(authHeader.slice(7));
        if (token.ok) {
            try {
                const session = await checkSession(token.claims.sid, token.claims.userId);
                if (session.ok) {
                    req.user = session.user;
                    req.sessionId = token.claims.sid;
                }
            } catch (error) {
                console.error('[Auth] Session check failed:', error);
            }
        }
    }
    next();
}

/**
 * Require specific role(s). Must be used AFTER authenticate middleware.
 * Admins (isAdmin flag) pass any role gate automatically.
 */
export function requireRole(...roles: string[]) {
    return (req: Request, res: Response, next: NextFunction): void => {
        if (!req.user) {
            res.status(401).json({ error: 'Authentication required' });
            return;
        }

        // Admins pass any role gate
        if (req.user.isAdmin) {
            next();
            return;
        }

        if (!roles.includes(req.user.role)) {
            res.status(403).json({ error: `Requires one of: ${roles.join(', ')}` });
            return;
        }

        next();
    };
}

/**
 * Check if a pubkey belongs to an admin (listed in ADMIN_PUBKEYS env var).
 * Admins can manage mods; mods cannot manage admins or other mods.
 */
export function isAdminPubkey(nostrPubkey: string): boolean {
    return config.adminPubkeys.includes(nostrPubkey);
}
