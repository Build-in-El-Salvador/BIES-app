import { Request, Response } from 'express';
// nostr-tools is ESM-only (@noble/curves has no CJS build);
// use dynamic import() so the compiled CJS output doesn't call require().
import prisma from '../lib/prisma';
import { config } from '../config';
import { isAdminPubkey } from '../middleware/auth';
import { encryptPrivateKey } from '../services/crypto.service';
import { publishRelayList } from '../services/nostr.service';
import { HEX_PUBKEY_RE, addToRelayWhitelist } from '../services/relayWhitelist.service';
import { recordOnboardingRedemption } from '../services/voucher.service';
import {
    SESSION_END_MESSAGES,
    claimedSessionId,
    clearRefreshCookie,
    clientKind,
    readRefreshCookie,
    deliverSession,
    refreshSession,
    refreshTokenFromRequest,
    revokeSession,
    sessionFromRefreshToken,
    startSession,
    verifyAccessToken,
} from '../services/session.service';
import {
    CODE_TTL_SECONDS,
    RESEND_COOLDOWN_SECONDS,
    issueEmailCode,
    verifyEmailCode,
} from '../services/emailCode.service';
import { z } from 'zod';
import crypto from 'crypto';
import { allowNewAccount } from '../services/signupLimit.service';

/**
 * Strip encrypted wallet credentials (the Coinos JWT) from a
 * profile object before sending it to any client. Connection metadata
 * (coinosUsername) stays visible so the client
 * can detect the connection.
 */
function sanitizeProfile(profile: any): any {
    return profile ? { ...profile, coinosToken: undefined } : null;
}

/**
 * The user as sent to the client after sign-in and from /auth/me.
 * `hostedKey` says whether BIES holds this account's Nostr key. The key
 * itself never leaves the server. `termsAccepted` is false until the member
 * accepts the current terms of use, `termsVersion`, which is what
 * POST /api/account/terms takes.
 */
export function publicUser(user: any) {
    return {
        id: user.id,
        email: user.email,
        nostrPubkey: user.nostrPubkey,
        role: user.role,
        isAdmin: user.isAdmin,
        hostedKey: !!user.encryptedPrivkey,
        termsAccepted: user.termsVersion === config.termsVersion,
        termsVersion: config.termsVersion,
        profile: sanitizeProfile(user.profile),
    };
}

// ─── Validation Schemas ───

const emailField = z.string().trim().toLowerCase().max(254).email();

export const emailStartSchema = z.object({
    email: emailField,
    lang: z.enum(['en', 'es']).optional(),
});

export const emailVerifySchema = z.object({
    email: emailField,
    code: z.string().trim().regex(/^\d{6}$/, 'The code is 6 digits'),
    voucherCode: z.string().max(64).optional(),
});

export const nostrLoginSchema = z.object({
    pubkey: z.string().min(64).max(64),
    sig: z.string(),
    challenge: z.string(),
});

// Outstanding sign-in challenges, by challenge: several per pubkey, so asking
// for one with someone else's pubkey never replaces theirs. Kept in memory:
// the server is a single process, and after a restart the app asks again.
const challenges = new Map<string, { pubkey: string; expiresAt: number }>();
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_CHALLENGES = 10_000;

/**
 * NIP-98: a sign-in names this endpoint (its `u` tag) and POST. A login event
 * signed for another site, or with no tags, isn't a BIES sign-in.
 */
function isBiesLoginRequest(tags: unknown): boolean {
    if (!Array.isArray(tags)) return false;
    const only = (name: string) => {
        const found = tags.filter((t) => Array.isArray(t) && t[0] === name);
        return found.length === 1 && typeof found[0][1] === 'string' ? (found[0][1] as string) : null;
    };
    if (only('method')?.toUpperCase() !== 'POST') return false;
    let url: URL;
    try { url = new URL(only('u') ?? ''); } catch { return false; }
    const basePath = (process.env.BASE_PATH || '').replace(/\/+$/, '');
    const origins = [config.appPublicUrl, process.env.API_PUBLIC_URL || '', ...config.corsOrigin.split(',')]
        .map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
    return origins.includes(url.origin) && url.pathname === `${basePath}/api/auth/nostr-login` && !url.search;
}

// ─── NIP-05 auto-generation ───

async function generateNip05Name(baseName: string): Promise<string | null> {
    let name = baseName.toLowerCase().replace(/[^a-z0-9._-]/g, '').substring(0, 30);
    if (name.length < 3) name = `user${name}`;
    if (name.length < 3) return null;

    const existing = await prisma.profile.findFirst({ where: { nip05Name: name } });
    if (!existing) return name;

    for (let i = 1; i <= 99; i++) {
        const candidate = `${name.substring(0, 27)}${i}`;
        const taken = await prisma.profile.findFirst({ where: { nip05Name: candidate } });
        if (!taken) return candidate;
    }
    return null;
}

// ─── Controllers ───

/**
 * Create an account with a key BIES holds, for an address that just proved
 * itself with a code. The key is generated and encrypted here and never sent
 * to the client.
 */
async function createHostedUser(email: string) {
    const { generateSecretKey, getPublicKey } = await import('nostr-tools/pure');
    const secretKey = generateSecretKey();
    const nostrPubkey = getPublicKey(secretKey);
    const encryptedPrivkey = encryptPrivateKey(Buffer.from(secretKey).toString('hex'));
    secretKey.fill(0);

    try {
        const user = await prisma.user.create({
            data: {
                email,
                nostrPubkey,
                encryptedPrivkey,
                role: 'MEMBER',
                // The app asks for a name after the first sign-in.
                profile: { create: { name: '' } },
            },
            include: { profile: true },
        });
        return { user, created: true };
    } catch (err) {
        // Two codes for a new address verified at the same moment: the other
        // request created the account first.
        if ((err as { code?: string }).code === 'P2002') {
            const existing = await prisma.user.findUnique({ where: { email }, include: { profile: true } });
            if (existing) return { user: existing, created: false };
        }
        throw err;
    }
}

/**
 * POST /auth/email/start
 * Email a 6-digit sign-in code. The answer is the same whether or not an
 * account exists for the address.
 */
export async function startEmailLogin(req: Request, res: Response): Promise<void> {
    try {
        const { email, lang } = req.body as z.infer<typeof emailStartSchema>;
        const result = await issueEmailCode(email, 'login', { ip: req.ip ?? null, lang });

        if (result.ok) {
            res.json({ ok: true, expiresInSeconds: CODE_TTL_SECONDS, resendAfterSeconds: RESEND_COOLDOWN_SECONDS });
            return;
        }
        if (result.reason === 'send_failed') {
            res.status(503).json({ error: "We couldn't send the email. Please try again in a minute.", reason: 'send_failed' });
            return;
        }
        res.setHeader('Retry-After', String(result.retryAfterSeconds));
        res.status(429).json({
            error: result.reason === 'busy'
                ? 'Sign-in by email is busy right now. Please try again later.'
                : 'Too many codes requested. Please wait before asking for another.',
            reason: result.reason,
            retryAfterSeconds: result.retryAfterSeconds,
        });
    } catch (error) {
        console.error('Email sign-in start error:', error);
        res.status(500).json({ error: 'Could not send a sign-in code' });
    }
}

/**
 * POST /auth/email/verify
 * Check the code. Signs in the account with this address, or creates one
 * (with a key BIES holds) the first time.
 */
export async function verifyEmailLogin(req: Request, res: Response): Promise<void> {
    try {
        const { email, code, voucherCode } = req.body as z.infer<typeof emailVerifySchema>;
        const result = await verifyEmailCode(email, 'login', code);

        if (!result.ok) {
            if (result.reason === 'invalid') {
                res.status(400).json({
                    error: result.attemptsLeft > 0
                        ? 'That code is not right.'
                        : 'That code is not right, and it has now expired. Request a new one.',
                    reason: 'invalid_code',
                    attemptsLeft: result.attemptsLeft,
                });
            } else {
                res.status(400).json({ error: 'This code has expired. Request a new one.', reason: 'code_expired' });
            }
            return;
        }

        let user = await prisma.user.findUnique({
            where: { email: result.email },
            include: { profile: true },
        });
        let isNewUser = false;

        if (!user) {
            const created = await createHostedUser(result.email);
            user = created.user;
            isNewUser = created.created;
        }

        if (user.deletedAt) {
            res.status(403).json({ error: 'This account has been deleted', reason: 'deleted' });
            return;
        }
        if (user.isBanned) {
            res.status(403).json({ error: 'Your account has been suspended', reason: 'suspended' });
            return;
        }
        // The member took their key: BIES can't sign for this account any
        // more, so a session from an email code would be one that can't act.
        if (!user.encryptedPrivkey) {
            res.status(403).json({
                error: 'This account signs in with Nostr now. Use "Sign in with Nostr" with your key.',
                reason: 'nostr_account',
            });
            return;
        }

        // Relay access, re-granted on every sign-in as Nostr login does.
        addToRelayWhitelist(user.nostrPubkey, { proven: true });

        if (isNewUser) {
            // Attribute the signup to an onboarding voucher (fire-and-forget — never blocks signup)
            recordOnboardingRedemption(voucherCode, user.id, req.ip || null).catch((err) =>
                console.error('[Voucher] Onboarding attribution failed:', err)
            );

            // Publish NIP-65 relay list for the new custodial user
            publishRelayList(user.id).catch((err) =>
                console.error('[Nostr] Relay list publish failed:', err)
            );

            // NIP-05 name from the pubkey, never from the email address,
            // which would publish part of it. The user can pick a handle later.
            const nip05Name = await generateNip05Name(`nostr-${user.nostrPubkey.substring(0, 8)}`);
            if (nip05Name && user.profile) {
                const updatedProfile = await prisma.profile.update({
                    where: { id: user.profile.id },
                    data: { nip05Name },
                });
                user = { ...user, profile: updatedProfile };
            }
        }

        res.locals.auditUserId = user.id;
        const session = await startSession(req, res, user);
        res.status(isNewUser ? 201 : 200).json({ user: publicUser(user), ...session, isNewUser });
    } catch (error) {
        console.error('Email sign-in verify error:', error);
        res.status(500).json({ error: 'Sign-in failed' });
    }
}

/**
 * GET /auth/nostr-challenge
 * Get a challenge for Nostr login (step 1 of challenge-response).
 */
export async function getNostrChallenge(req: Request, res: Response): Promise<void> {
    const challenge = crypto.randomBytes(32).toString('hex');
    const pubkey = req.query.pubkey as string;

    if (!pubkey || !HEX_PUBKEY_RE.test(pubkey)) {
        res.status(400).json({ error: 'Valid hex pubkey required' });
        return;
    }

    // Every challenge lives as long, so the map's order is expiry order: drop
    // the expired ones from the front, and when it's full, the oldest (a
    // flood then only costs sign-ins that took longer than it to finish).
    const now = Date.now();
    for (const [key, entry] of challenges) {
        if (entry.expiresAt > now) break;
        challenges.delete(key);
    }
    while (challenges.size >= MAX_CHALLENGES) {
        challenges.delete(challenges.keys().next().value as string);
    }
    challenges.set(challenge, { pubkey, expiresAt: now + CHALLENGE_TTL_MS });

    res.json({ challenge });
}

/**
 * POST /auth/nostr-login
 * Verify a signed challenge from a Nostr extension (step 2).
 * Client sends pubkey + signedEvent (kind:27235 with challenge as content).
 */
export async function nostrLogin(req: Request, res: Response): Promise<void> {
    try {
        const { pubkey, signedEvent, voucherCode } = req.body;

        if (!pubkey || !HEX_PUBKEY_RE.test(pubkey)) {
            res.status(400).json({ error: 'Valid hex pubkey required' });
            return;
        }

        if (!signedEvent || !signedEvent.sig || !signedEvent.id) {
            res.status(400).json({ error: 'Signed event required' });
            return;
        }

        // Verify challenge-response: the challenge is the event's content.
        const challenge = typeof signedEvent.content === 'string' ? signedEvent.content : '';
        const stored = challenges.get(challenge);
        if (!stored || stored.pubkey !== pubkey) {
            res.status(400).json({ error: 'No challenge found. Request a new one.' });
            return;
        }

        if (Date.now() > stored.expiresAt) {
            challenges.delete(challenge);
            res.status(400).json({ error: 'Challenge expired. Request a new one.' });
            return;
        }

        if (signedEvent.pubkey !== pubkey) {
            res.status(400).json({ error: 'Pubkey mismatch in signed event' });
            return;
        }

        // Verify event kind (NIP-98 HTTP auth)
        if (signedEvent.kind !== 27235) {
            res.status(400).json({ error: 'Signed event must be kind 27235' });
            return;
        }

        // ...for this endpoint, so a signature another site asked for fails.
        // No tags at all: a BIES app from before this check (a tab left open
        // across an update, or an old build), which only a reload fixes.
        if (!isBiesLoginRequest(signedEvent.tags)) {
            const untagged = Array.isArray(signedEvent.tags)
                && !signedEvent.tags.some((t: unknown) => Array.isArray(t) && (t[0] === 'u' || t[0] === 'method'));
            res.status(400).json(untagged
                ? { error: 'BIES was updated. Reload the page (or update the app), then sign in again.', reason: 'update_required' }
                : { error: "This sign-in wasn't made for BIES. Please try again.", reason: 'wrong_target' });
            return;
        }

        // Verify event timestamp is recent (within 5 minutes)
        const now = Math.floor(Date.now() / 1000);
        if (Math.abs(now - signedEvent.created_at) > 300) {
            res.status(400).json({ error: 'Signed event timestamp is too old or too far in the future' });
            return;
        }

        // Verify signature using nostr-tools (dynamic import — ESM-only package)
        const { verifyEvent } = await import('nostr-tools/pure');
        if (!verifyEvent(signedEvent)) {
            res.status(401).json({ error: 'Invalid signature' });
            return;
        }

        // Challenge verified — clean up
        challenges.delete(challenge);

        // Find or create the user
        let user = await prisma.user.findUnique({
            where: { nostrPubkey: pubkey },
            include: { profile: true },
        });

        const isEnvAdmin = isAdminPubkey(pubkey);

        if (!user) {
            // A new account: a few a day from one address (signupLimit.service.ts).
            if (!allowNewAccount(req.ip)) {
                res.status(429).json({ error: 'Too many new accounts from this network today. Try again tomorrow, or sign up with your email.', reason: 'too_many_new_accounts' });
                return;
            }
            // Auto-create user for Nostr login (no custodial key needed — they manage their own)
            user = await prisma.user.create({
                data: {
                    nostrPubkey: pubkey,
                    role: 'MEMBER',
                    isAdmin: isEnvAdmin,
                    profile: {
                        create: {
                            name: `nostr:${pubkey.substring(0, 8)}`,
                        },
                    },
                },
                include: { profile: true },
            });

            // Attribute the signup to an onboarding voucher (fire-and-forget — never blocks login)
            recordOnboardingRedemption(voucherCode, user.id, req.ip || null).catch((err) =>
                console.error('[Voucher] Onboarding attribution failed:', err)
            );

            // Publish NIP-65 relay list for the new user
            publishRelayList(user.id).catch((err) =>
                console.error('[Nostr] Relay list publish failed:', err)
            );

            // Auto-generate NIP-05 name for new Nostr users
            const nip05Name = await generateNip05Name(`nostr-${pubkey.substring(0, 8)}`);
            if (nip05Name && user.profile) {
                const updatedProfile = await prisma.profile.update({
                    where: { id: user.profile.id },
                    data: { nip05Name },
                });
                user = { ...user, profile: updatedProfile };
            }

        } else if (isEnvAdmin && !user.isAdmin) {
            // Grant admin flag without changing their existing role
            user = await prisma.user.update({
                where: { id: user.id },
                data: { isAdmin: true },
                include: { profile: true },
            });
        } else if (!isEnvAdmin && user.isAdmin) {
            // Revoke admin flag if pubkey was removed from ADMIN_PUBKEYS
            user = await prisma.user.update({
                where: { id: user.id },
                data: { isAdmin: false },
                include: { profile: true },
            });
        }
        // Block deleted and banned accounts from signing in and re-whitelisting
        if (user.deletedAt) {
            res.status(403).json({ error: 'This account has been deleted', reason: 'deleted' });
            return;
        }
        if (user.isBanned) {
            res.status(403).json({ error: 'Your account has been suspended', reason: 'suspended' });
            return;
        }

        const session = await startSession(req, res, user);

        // Add pubkey to relay whitelist so user can publish to the BIES relay.
        // Signing in proves the key, so a member rejoining after deleting
        // their account gets access back.
        addToRelayWhitelist(pubkey, { proven: true });

        res.locals.auditUserId = user.id;
        res.json({ user: publicUser(user), ...session });
    } catch (error) {
        console.error('Nostr login error:', error);
        res.status(500).json({ error: 'Nostr login failed' });
    }
}

/**
 * GET /auth/me
 * Get current user from JWT.
 */
export async function getMe(req: Request, res: Response): Promise<void> {
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.user!.id },
            include: { profile: true },
        });

        if (!user) {
            res.status(404).json({ error: 'User not found' });
            return;
        }

        // Never includes the private key, even for accounts whose key BIES
        // holds: those sign through the server.
        res.json(publicUser(user));
    } catch (error) {
        console.error('Get me error:', error);
        res.status(500).json({ error: 'Failed to get user info' });
    }
}

/**
 * POST /auth/refresh
 * Swap a refresh token for a new access token and the next refresh token.
 * The web app's refresh token is its cookie; other clients send
 * `{ refreshToken }`. No access token needed: it has usually just expired.
 */
export async function refresh(req: Request, res: Response): Promise<void> {
    try {
        const result = await refreshSession(refreshTokenFromRequest(req));
        if (!result.ok) {
            if (clientKind(req) === 'web') clearRefreshCookie(res);
            res.status(401).json({ error: SESSION_END_MESSAGES[result.reason], reason: result.reason });
            return;
        }
        res.json(deliverSession(req, res, result.user, result.session));
    } catch (error) {
        console.error('Session refresh error:', error);
        res.status(503).json({ error: 'Please try again in a moment' });
    }
}

/**
 * POST /auth/logout
 * End this device's session, so neither its access token nor its refresh
 * token works again, even before they expire. Works with an expired access
 * token, or with the refresh token alone. `pushToken`, if sent, is this
 * phone's push registration, removed so it stops getting the account's
 * notifications.
 */
export async function logout(req: Request, res: Response): Promise<void> {
    let ended: { sessionId: string; userId: string } | null = null;
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
        const token = verifyAccessToken(authHeader.slice(7), { ignoreExpiration: true });
        if (token.ok) ended = { sessionId: token.claims.sid, userId: token.claims.userId };
    }

    // Clear the web cookie first, so the browser drops it even if the rest
    // fails (the app then retries with its access token). Not when it belongs
    // to another session: a retried logout of an older session must not sign
    // out the one this browser holds now.
    if (clientKind(req) === 'web') {
        const cookieSession = claimedSessionId(readRefreshCookie(req));
        if (!ended || !cookieSession || cookieSession === ended.sessionId) clearRefreshCookie(res);
    }

    try {
        if (!ended) ended = await sessionFromRefreshToken(refreshTokenFromRequest(req));

        if (ended) {
            res.locals.auditUserId = ended.userId;
            await revokeSession(ended.sessionId, 'logout');
            const pushToken = req.body?.pushToken;
            if (typeof pushToken === 'string' && pushToken.length <= 512) {
                await prisma.deviceToken.deleteMany({ where: { userId: ended.userId, token: pushToken } });
            }
        }
        res.json({ message: 'Logged out successfully' });
    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({ error: 'Logout failed' });
    }
}
