import { Request, Response } from 'express';
// nostr-tools is ESM-only (@noble/curves has no CJS build);
// use dynamic import() so the compiled CJS output doesn't call require().
import prisma from '../lib/prisma';
import { isAdminPubkey } from '../middleware/auth';
import { encryptPrivateKey } from '../services/crypto.service';
import { publishRelayList } from '../services/nostr.service';
import { HEX_PUBKEY_RE, addToRelayWhitelist } from '../services/relayWhitelist.service';
import { recordOnboardingRedemption } from '../services/voucher.service';
import {
    SESSION_END_MESSAGES,
    clearRefreshCookie,
    clientKind,
    deliverSession,
    refreshSession,
    refreshTokenFromRequest,
    revokeSession,
    sessionIdFromRefreshToken,
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

/**
 * Strip encrypted wallet credentials (Coinos JWT, Blink API key) from a
 * profile object before sending it to any client. Connection metadata
 * (coinosUsername, blinkUsername, blinkWalletId) stays visible so the client
 * can detect the connection.
 */
function sanitizeProfile(profile: any): any {
    return profile ? { ...profile, coinosToken: undefined, blinkApiKey: undefined } : null;
}

/**
 * The user as sent to the client after sign-in and from /auth/me.
 * `hostedKey` says whether BIES holds this account's Nostr key. The key
 * itself never leaves the server.
 */
function publicUser(user: any) {
    return {
        id: user.id,
        email: user.email,
        nostrPubkey: user.nostrPubkey,
        role: user.role,
        isAdmin: user.isAdmin,
        hostedKey: !!user.encryptedPrivkey,
        profile: sanitizeProfile(user.profile),
    };
}

// ─── Fingerprint helpers (ban evasion detection) ───

/**
 * Store a browser fingerprint for a user.
 * Called on every login/signup so we build a fingerprint history.
 */
async function storeFingerprint(
    userId: string,
    fingerprintHash: string | null | undefined,
    req: Request,
): Promise<void> {
    if (!fingerprintHash || typeof fingerprintHash !== 'string' || fingerprintHash.length < 16) return;

    try {
        // Avoid duplicates: only store if this exact user+fingerprint combo doesn't exist
        const existing = await prisma.browserFingerprint.findFirst({
            where: { userId, fingerprintHash },
        });
        if (existing) return;

        await prisma.browserFingerprint.create({
            data: {
                userId,
                fingerprintHash,
                ipAddress: req.ip || null,
                userAgent: req.headers['user-agent'] || null,
            },
        });
    } catch (err) {
        console.error('[Fingerprint] Failed to store:', err);
    }
}

/**
 * Check if a fingerprint hash matches any banned user's fingerprints.
 * Returns the banned user IDs if a match is found.
 */
async function checkBanEvasion(
    fingerprintHash: string | null | undefined,
): Promise<string[]> {
    if (!fingerprintHash || typeof fingerprintHash !== 'string' || fingerprintHash.length < 16) return [];

    try {
        const matches = await prisma.browserFingerprint.findMany({
            where: {
                fingerprintHash,
                user: { isBanned: true },
            },
            select: { userId: true },
        });
        return [...new Set(matches.map((m) => m.userId))];
    } catch (err) {
        console.error('[Fingerprint] Ban evasion check failed:', err);
        return [];
    }
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

// In-memory challenge store (use Redis in production)
const challenges = new Map<string, { challenge: string; expiresAt: number }>();

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

        // Relay access, re-granted on every sign-in as Nostr login does.
        addToRelayWhitelist(user.nostrPubkey);

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

    challenges.set(pubkey, {
        challenge,
        expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
    });

    res.json({ challenge });
}

/**
 * POST /auth/nostr-login
 * Verify a signed challenge from a Nostr extension (step 2).
 * Client sends pubkey + signedEvent (kind:27235 with challenge as content).
 */
export async function nostrLogin(req: Request, res: Response): Promise<void> {
    try {
        const { pubkey, signedEvent, fingerprint, voucherCode } = req.body;

        if (!pubkey || !HEX_PUBKEY_RE.test(pubkey)) {
            res.status(400).json({ error: 'Valid hex pubkey required' });
            return;
        }

        // Verify challenge-response
        const stored = challenges.get(pubkey);
        if (!stored) {
            res.status(400).json({ error: 'No challenge found. Request a new one.' });
            return;
        }

        if (Date.now() > stored.expiresAt) {
            challenges.delete(pubkey);
            res.status(400).json({ error: 'Challenge expired. Request a new one.' });
            return;
        }

        if (!signedEvent || !signedEvent.sig || !signedEvent.id) {
            res.status(400).json({ error: 'Signed event required' });
            return;
        }

        if (signedEvent.pubkey !== pubkey) {
            res.status(400).json({ error: 'Pubkey mismatch in signed event' });
            return;
        }

        if (signedEvent.content !== stored.challenge) {
            res.status(400).json({ error: 'Challenge mismatch' });
            return;
        }

        // Verify event kind (NIP-98 HTTP auth)
        if (signedEvent.kind !== 27235) {
            res.status(400).json({ error: 'Signed event must be kind 27235' });
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
        challenges.delete(pubkey);

        // Find or create the user
        let user = await prisma.user.findUnique({
            where: { nostrPubkey: pubkey },
            include: { profile: true },
        });

        const isEnvAdmin = isAdminPubkey(pubkey);

        if (!user) {
            // Check for ban evasion before creating the new account
            const bannedUserIds = await checkBanEvasion(fingerprint);

            // Auto-create user for Nostr login (no custodial key needed — they manage their own)
            user = await prisma.user.create({
                data: {
                    nostrPubkey: pubkey,
                    role: 'MEMBER',
                    isAdmin: isEnvAdmin,
                    isBanned: bannedUserIds.length > 0,
                    profile: {
                        create: {
                            name: `nostr:${pubkey.substring(0, 8)}`,
                        },
                    },
                },
                include: { profile: true },
            });

            // Store fingerprint for the new account
            await storeFingerprint(user.id, fingerprint, req);

            // If ban evasion detected, log it and block
            if (bannedUserIds.length > 0) {
                await prisma.auditLog.create({
                    data: {
                        userId: user.id,
                        action: 'BAN_EVASION_DETECTED',
                        resource: `user:${user.id}`,
                        ipAddress: req.ip || null,
                        userAgent: req.headers['user-agent'] || null,
                        metadata: JSON.stringify({
                            matchedBannedUsers: bannedUserIds,
                            fingerprintHash: fingerprint,
                        }),
                    },
                });
                console.log(`[Auth] Ban evasion detected: new user ${user.id} matches banned users ${bannedUserIds.join(', ')}`);
                res.status(403).json({ error: 'Your account has been suspended' });
                return;
            }

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
        // Store fingerprint for existing users (builds fingerprint database)
        await storeFingerprint(user.id, fingerprint, req);

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

        // Add pubkey to relay whitelist so user can publish to the BIES relay
        addToRelayWhitelist(pubkey);

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
 * token, or with the refresh token alone.
 */
export async function logout(req: Request, res: Response): Promise<void> {
    try {
        let sessionId: string | null = null;
        const authHeader = req.headers.authorization;
        if (authHeader?.startsWith('Bearer ')) {
            const token = verifyAccessToken(authHeader.slice(7), { ignoreExpiration: true });
            if (token.ok) {
                sessionId = token.claims.sid;
                res.locals.auditUserId = token.claims.userId;
            }
        }
        if (!sessionId) sessionId = await sessionIdFromRefreshToken(refreshTokenFromRequest(req));

        if (sessionId) await revokeSession(sessionId, 'logout');
        if (clientKind(req) === 'web') clearRefreshCookie(res);
        res.json({ message: 'Logged out successfully' });
    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({ error: 'Logout failed' });
    }
}
