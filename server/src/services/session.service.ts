/**
 * Sign-in sessions: a short-lived access token for API calls, and a refresh
 * token that renews it.
 *
 * - Access token: a JWT (HS256, `config.session.accessTokenSeconds`, 15
 *   minutes by default) naming the user and the session. `authenticate`
 *   checks the session on every request, so logging out, a ban or a deletion
 *   takes effect at once, not when the token runs out.
 * - Refresh token: `rt1.<sessionId>.<mac>`, where the MAC covers the session
 *   id, its salt and its counter under a key derived from JWT_SECRET. The
 *   database alone can't produce one, so a leaked backup signs nobody in.
 *   Every refresh moves the counter on, so the token changes each time.
 * - Reuse: any other token for a live session is either a stolen copy or the
 *   owner's copy after a thief refreshed first, so it ends the session for
 *   both. The exception is the token replaced in the last
 *   `refreshGraceSeconds` (a retry whose answer was lost, or two tabs
 *   refreshing at once), which gets the current token back.
 *
 * The web app's refresh token lives in an httpOnly cookie its scripts can't
 * read. The native app and other non-browser clients get it in the response
 * body and keep it themselves.
 */

import crypto from 'crypto';
import { EventEmitter } from 'events';
import jwt from 'jsonwebtoken';
import type { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { config } from '../config';

const DAY_MS = 24 * 60 * 60 * 1000;

export const REFRESH_COOKIE = 'bies_rt';
const REFRESH_COOKIE_PATH = '/api/auth';

/** Revoked and expired sessions are kept this long, then deleted. */
const KEEP_ENDED_SESSIONS_DAYS = 30;

// ─── Access tokens ───────────────────────────────────────────────────────────

export interface AccessClaims {
    userId: string;
    sid: string;
    role: string;
    isAdmin: boolean;
    typ: 'access';
}

export type AccessCheck =
    | { ok: true; claims: AccessClaims }
    | { ok: false; reason: 'token_expired' | 'invalid_token' };

export function signAccessToken(user: { id: string; role: string; isAdmin: boolean }, sessionId: string): string {
    const claims: AccessClaims = { userId: user.id, sid: sessionId, role: user.role, isAdmin: user.isAdmin, typ: 'access' };
    return jwt.sign(claims, config.jwtSecret, {
        algorithm: 'HS256',
        expiresIn: config.session.accessTokenSeconds,
    });
}

/**
 * Check an access token's signature and shape. Tokens from before sessions
 * existed have no `sid` and are refused, which signs everyone out once.
 * `ignoreExpiration` is for callers that only need to know who sent it.
 */
export function verifyAccessToken(token: string, { ignoreExpiration = false } = {}): AccessCheck {
    try {
        const claims = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'], ignoreExpiration }) as Partial<AccessClaims>;
        if (claims.typ !== 'access' || typeof claims.userId !== 'string' || typeof claims.sid !== 'string') {
            return { ok: false, reason: 'invalid_token' };
        }
        return { ok: true, claims: claims as AccessClaims };
    } catch (err) {
        return { ok: false, reason: err instanceof jwt.TokenExpiredError ? 'token_expired' : 'invalid_token' };
    }
}

// ─── Session checks ──────────────────────────────────────────────────────────

export interface SessionUser {
    id: string;
    email: string | null;
    nostrPubkey: string;
    role: string;
    isAdmin: boolean;
}

export type SessionEndReason = 'session_ended' | 'suspended' | 'account_deleted';

export type SessionCheck =
    | { ok: true; user: SessionUser }
    | { ok: false; reason: SessionEndReason };

export const SESSION_END_MESSAGES: Record<SessionEndReason, string> = {
    session_ended: 'Your session has ended. Please sign in again.',
    suspended: 'Your account has been suspended',
    account_deleted: 'This account has been deleted',
};

/** Is this session live, and is its account still allowed in? */
export async function checkSession(sessionId: string, userId: string): Promise<SessionCheck> {
    const session = await prisma.session.findUnique({
        where: { id: sessionId },
        select: {
            userId: true,
            revokedAt: true,
            expiresAt: true,
            maxExpiresAt: true,
            user: {
                select: { id: true, email: true, nostrPubkey: true, role: true, isAdmin: true, isBanned: true, deletedAt: true },
            },
        },
    });
    if (!session || session.userId !== userId || !isLive(session)) return { ok: false, reason: 'session_ended' };

    const { isBanned, deletedAt, ...user } = session.user;
    if (deletedAt) return { ok: false, reason: 'account_deleted' };
    if (isBanned) return { ok: false, reason: 'suspended' };
    return { ok: true, user };
}

function isLive(session: { revokedAt: Date | null; expiresAt: Date; maxExpiresAt: Date }): boolean {
    const now = Date.now();
    return !session.revokedAt && session.expiresAt.getTime() > now && session.maxExpiresAt.getTime() > now;
}

// ─── Refresh tokens ──────────────────────────────────────────────────────────

const refreshKey = crypto.createHash('sha256').update(`bies-refresh-token:${config.jwtSecret}`).digest();

function refreshMac(sessionId: string, salt: string, counter: number): string {
    return crypto.createHmac('sha256', refreshKey).update(`${sessionId}.${salt}.${counter}`).digest('base64url');
}

function refreshTokenFor(session: { id: string; salt: string; counter: number }): string {
    return `rt1.${session.id}.${refreshMac(session.id, session.salt, session.counter)}`;
}

function parseRefreshToken(token: unknown): { sessionId: string; mac: string } | null {
    if (typeof token !== 'string' || token.length > 200) return null;
    const [version, sessionId, mac, ...rest] = token.split('.');
    if (version !== 'rt1' || !sessionId || !mac || rest.length) return null;
    return { sessionId, mac };
}

function sameMac(a: string, b: string): boolean {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Where a client keeps its refresh token, from the request's Origin. */
export type ClientKind = 'web' | 'native' | 'api';

const nativeOrigins = config.corsNativeOrigin.split(',').map((o) => o.trim()).filter(Boolean);

/**
 * Browsers send Origin on every POST, so a POST without one is not from a
 * browser page (curl, tests, server-to-server). The web app is any other
 * origin and gets the cookie; it never receives a refresh token it could
 * read.
 */
export function clientKind(req: Request): ClientKind {
    const origin = req.headers.origin;
    if (!origin) return 'api';
    return nativeOrigins.includes(origin) ? 'native' : 'web';
}

export interface IssuedSession {
    sessionId: string;
    refreshToken: string;
    expiresAt: Date;
}

/** Start a session for a user who has just proved who they are. */
export async function createSession(userId: string, client: ClientKind): Promise<IssuedSession> {
    const now = Date.now();
    const session = await prisma.session.create({
        data: {
            userId,
            salt: crypto.randomBytes(16).toString('base64url'),
            client,
            expiresAt: new Date(now + Math.min(config.session.idleDays, config.session.maxDays) * DAY_MS),
            maxExpiresAt: new Date(now + config.session.maxDays * DAY_MS),
        },
        select: { id: true, salt: true, counter: true, expiresAt: true },
    });
    return { sessionId: session.id, refreshToken: refreshTokenFor(session), expiresAt: session.expiresAt };
}

export type RefreshResult =
    | { ok: true; user: { id: string; role: string; isAdmin: boolean }; session: IssuedSession }
    | { ok: false; reason: SessionEndReason };

/**
 * Exchange a refresh token for the next one. Ends the session on reuse, a
 * ban or a deletion. Every failure reads as `session_ended` to the client
 * unless the account itself is the reason.
 */
export async function refreshSession(token: unknown): Promise<RefreshResult> {
    const parsed = parseRefreshToken(token);
    if (!parsed) return { ok: false, reason: 'session_ended' };

    // A second pass only happens when another request rotated this session
    // between our read and our write; it then takes the grace path.
    for (let attempt = 0; attempt < 3; attempt++) {
        const session = await prisma.session.findUnique({
            where: { id: parsed.sessionId },
            select: {
                id: true, salt: true, counter: true, rotatedAt: true, revokedAt: true,
                expiresAt: true, maxExpiresAt: true,
                user: { select: { id: true, role: true, isAdmin: true, isBanned: true, deletedAt: true } },
            },
        });
        if (!session || !isLive(session)) return { ok: false, reason: 'session_ended' };

        const isCurrent = sameMac(parsed.mac, refreshMac(session.id, session.salt, session.counter));
        const isPrevious = !isCurrent && session.counter > 0
            && sameMac(parsed.mac, refreshMac(session.id, session.salt, session.counter - 1));
        const inGrace = isPrevious && !!session.rotatedAt
            && Date.now() - session.rotatedAt.getTime() <= config.session.refreshGraceSeconds * 1000;

        if (!isCurrent && !inGrace) {
            await revokeSession(session.id, 'reuse');
            return { ok: false, reason: 'session_ended' };
        }

        const { isBanned, deletedAt, ...user } = session.user;
        if (deletedAt || isBanned) {
            await revokeSession(session.id, deletedAt ? 'deleted' : 'suspended');
            return { ok: false, reason: deletedAt ? 'account_deleted' : 'suspended' };
        }

        if (inGrace) {
            return {
                ok: true,
                user,
                session: { sessionId: session.id, refreshToken: refreshTokenFor(session), expiresAt: session.expiresAt },
            };
        }

        const now = new Date();
        const counter = session.counter + 1;
        const expiresAt = new Date(Math.min(
            now.getTime() + config.session.idleDays * DAY_MS,
            session.maxExpiresAt.getTime(),
        ));
        const { count } = await prisma.session.updateMany({
            where: { id: session.id, counter: session.counter, revokedAt: null },
            data: { counter, rotatedAt: now, lastUsedAt: now, expiresAt },
        });
        if (count === 1) {
            return {
                ok: true,
                user,
                session: { sessionId: session.id, refreshToken: refreshTokenFor({ ...session, counter }), expiresAt },
            };
        }
    }
    return { ok: false, reason: 'session_ended' };
}

/**
 * The session a refresh token belongs to, if the token is its current or
 * just-replaced one. For logout, which must not let a made-up token end
 * someone else's session.
 */
export async function sessionIdFromRefreshToken(token: unknown): Promise<string | null> {
    const parsed = parseRefreshToken(token);
    if (!parsed) return null;
    const session = await prisma.session.findUnique({
        where: { id: parsed.sessionId },
        select: { id: true, salt: true, counter: true },
    });
    if (!session) return null;
    const matches = sameMac(parsed.mac, refreshMac(session.id, session.salt, session.counter))
        || (session.counter > 0 && sameMac(parsed.mac, refreshMac(session.id, session.salt, session.counter - 1)));
    return matches ? session.id : null;
}

// ─── Ending sessions ─────────────────────────────────────────────────────────

/**
 * Fired after sessions end, so open connections can close (the WebSocket
 * service listens). Kept as an event to avoid an import cycle.
 */
const ended = new EventEmitter();

export function onSessionsEnded(listener: (ev: { sessionId?: string; userId?: string }) => void): void {
    ended.on('ended', listener);
}

export async function revokeSession(sessionId: string, reason: string): Promise<void> {
    await prisma.session.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: reason },
    });
    ended.emit('ended', { sessionId });
}

/** End every session a user has: on a ban, a deletion or a merge. */
export async function revokeUserSessions(userId: string, reason: string): Promise<number> {
    const { count } = await prisma.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: reason },
    });
    ended.emit('ended', { userId });
    return count;
}

/** Delete sessions that ended more than KEEP_ENDED_SESSIONS_DAYS ago. */
export async function deleteOldSessions(): Promise<number> {
    const cutoff = new Date(Date.now() - KEEP_ENDED_SESSIONS_DAYS * DAY_MS);
    const { count } = await prisma.session.deleteMany({
        where: {
            OR: [
                { revokedAt: { lt: cutoff } },
                { expiresAt: { lt: cutoff } },
                { maxExpiresAt: { lt: cutoff } },
            ],
        },
    });
    return count;
}

// ─── Delivery: cookie for the web app, body for everyone else ────────────────

function cookieOptions() {
    return {
        httpOnly: true,
        secure: config.nodeEnv === 'production',
        sameSite: 'strict' as const,
        path: REFRESH_COOKIE_PATH,
    };
}

export function readRefreshCookie(req: Request): string | undefined {
    for (const part of (req.headers.cookie || '').split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0 && part.slice(0, eq).trim() === REFRESH_COOKIE) {
            try {
                return decodeURIComponent(part.slice(eq + 1).trim());
            } catch {
                return undefined;
            }
        }
    }
    return undefined;
}

export function clearRefreshCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, cookieOptions());
}

/** The refresh token a client sent: the cookie for the web app, the body otherwise. */
export function refreshTokenFromRequest(req: Request): unknown {
    return clientKind(req) === 'web' ? readRefreshCookie(req) : req.body?.refreshToken;
}

/**
 * Hand a session's tokens to the client: the access token in the body, and
 * the refresh token as a cookie (web app) or in the body (everyone else).
 */
export function deliverSession(
    req: Request,
    res: Response,
    user: { id: string; role: string; isAdmin: boolean },
    session: IssuedSession,
): { token: string; refreshToken?: string; expiresIn: number } {
    const token = signAccessToken(user, session.sessionId);
    const expiresIn = config.session.accessTokenSeconds;
    if (clientKind(req) === 'web') {
        res.cookie(REFRESH_COOKIE, session.refreshToken, {
            ...cookieOptions(),
            maxAge: Math.max(0, session.expiresAt.getTime() - Date.now()),
        });
        return { token, expiresIn };
    }
    return { token, refreshToken: session.refreshToken, expiresIn };
}

/** Sign-in: start a session and hand over its tokens. */
export async function startSession(
    req: Request,
    res: Response,
    user: { id: string; role: string; isAdmin: boolean },
): Promise<{ token: string; refreshToken?: string; expiresIn: number }> {
    const session = await createSession(user.id, clientKind(req));
    return deliverSession(req, res, user, session);
}
