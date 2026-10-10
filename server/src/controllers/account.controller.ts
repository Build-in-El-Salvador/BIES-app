import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import {
    CODE_TTL_SECONDS,
    RESEND_COOLDOWN_SECONDS,
    issueEmailCode,
    verifyEmailCode,
    type EmailCodePurpose,
} from '../services/emailCode.service';
import {
    checkSignedChallenge,
    deleteAccount,
    exportKey,
    issueChallenge,
    releaseKey,
    type ChallengeCheck,
} from '../services/account.service';
import { clearRefreshCookie, clientKind } from '../services/session.service';
import { publicUser } from './auth.controller';

// ─── Request bodies ───────────────────────────────────────────────────────────

const HEX64 = /^[0-9a-f]{64}$/;

const lang = z.enum(['en', 'es']).optional();
const code = z.string().trim().regex(/^\d{6}$/, 'The code is 6 digits');

/** A signed Nostr event, as the app sends it. The signature is checked later. */
const signedEvent = z.object({
    id: z.string().regex(HEX64),
    pubkey: z.string().regex(HEX64),
    created_at: z.number().int().nonnegative(),
    kind: z.number().int().nonnegative(),
    tags: z.array(z.array(z.string().max(256)).max(4)).max(8),
    content: z.string().max(1024),
    sig: z.string().regex(/^[0-9a-f]{128}$/),
});

export const langSchema = z.object({ lang });

export const deleteConfirmSchema = z.object({
    code: code.optional(),
    signedEvent: signedEvent.optional(),
    lang,
});

export const keyExportSchema = z.object({ code });

export const keyReleaseSchema = z.object({ signedEvent, lang });

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function account(userId: string) {
    return prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, nostrPubkey: true, encryptedPrivkey: true },
    });
}

const NOT_HOSTED = {
    error: 'BIES holds no key for this account: it signs in with Nostr.',
    reason: 'not_hosted',
};

/** Email a confirmation code, answering the way email sign-in does. */
async function sendCode(req: Request, res: Response, email: string, purpose: EmailCodePurpose): Promise<boolean> {
    const result = await issueEmailCode(email, purpose, { ip: req.ip ?? null, lang: req.body.lang });
    if (result.ok) return true;
    if (result.reason === 'send_failed') {
        res.status(503).json({ error: "We couldn't send the email. Please try again in a minute.", reason: 'send_failed' });
        return false;
    }
    res.setHeader('Retry-After', String(result.retryAfterSeconds));
    res.status(429).json({
        error: result.reason === 'busy'
            ? 'Email is busy right now. Please try again later.'
            : 'Too many codes requested. Please wait before asking for another.',
        reason: result.reason,
        retryAfterSeconds: result.retryAfterSeconds,
    });
    return false;
}

/** Check a code; on failure, answer as email sign-in does and return false. */
async function checkCode(res: Response, email: string, purpose: EmailCodePurpose, value: string): Promise<boolean> {
    const result = await verifyEmailCode(email, purpose, value);
    if (result.ok) return true;
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
    return false;
}

const SIGNATURE_ERRORS: Record<Exclude<ChallengeCheck, 'ok'>, string> = {
    challenge_expired: 'This confirmation has expired. Please start again.',
    bad_signature: 'That signature does not confirm this request.',
};

// ─── Delete account ───────────────────────────────────────────────────────────

/**
 * POST /account/delete/start
 * Begin deleting the account: email accounts get a code by email, Nostr
 * accounts a challenge to sign with their key.
 */
export async function startDeletion(req: Request, res: Response): Promise<void> {
    try {
        const user = await account(req.user!.id);
        if (!user) { res.status(404).json({ error: 'Account not found' }); return; }

        if (user.encryptedPrivkey) {
            if (!user.email) {
                res.status(409).json({ error: 'This account has no email address to confirm with.', reason: 'no_email' });
                return;
            }
            if (!(await sendCode(req, res, user.email, 'delete_account'))) return;
            res.json({
                method: 'email',
                email: user.email,
                expiresInSeconds: CODE_TTL_SECONDS,
                resendAfterSeconds: RESEND_COOLDOWN_SECONDS,
            });
            return;
        }
        res.json({ method: 'nostr', challenge: issueChallenge(user.id, 'delete_account') });
    } catch (error) {
        console.error('Start account deletion error:', error);
        res.status(500).json({ error: 'Could not start the deletion' });
    }
}

/**
 * POST /account/delete
 * Delete the account for good, with the emailed code (email accounts) or a
 * signature over the challenge (Nostr accounts).
 */
export async function confirmDeletion(req: Request, res: Response): Promise<void> {
    try {
        const body = req.body as z.infer<typeof deleteConfirmSchema>;
        const user = await account(req.user!.id);
        if (!user) { res.status(404).json({ error: 'Account not found' }); return; }

        if (user.encryptedPrivkey) {
            if (!body.code || !user.email) {
                res.status(400).json({ error: 'Enter the code we emailed you.', reason: 'code_required' });
                return;
            }
            if (!(await checkCode(res, user.email, 'delete_account', body.code))) return;
        } else {
            if (!body.signedEvent) {
                res.status(400).json({ error: 'Confirm with your Nostr key.', reason: 'signature_required' });
                return;
            }
            const check = await checkSignedChallenge(user.id, user.nostrPubkey, 'delete_account', body.signedEvent);
            if (check !== 'ok') {
                res.status(400).json({ error: SIGNATURE_ERRORS[check], reason: check });
                return;
            }
        }

        await deleteAccount(user.id, body.lang);
        if (clientKind(req) === 'web') clearRefreshCookie(res);
        res.json({ deleted: true });
    } catch (error) {
        console.error('Account deletion error:', error);
        res.status(500).json({ error: 'Could not delete the account. Please try again.' });
    }
}

// ─── Take your key ────────────────────────────────────────────────────────────

/**
 * POST /account/key/start
 * Email a code that unlocks the key. Email accounts only.
 */
export async function startKeyExport(req: Request, res: Response): Promise<void> {
    try {
        const user = await account(req.user!.id);
        if (!user?.encryptedPrivkey) { res.status(409).json(NOT_HOSTED); return; }
        if (!user.email) {
            res.status(409).json({ error: 'This account has no email address to confirm with.', reason: 'no_email' });
            return;
        }
        if (!(await sendCode(req, res, user.email, 'export_key'))) return;
        res.json({ email: user.email, expiresInSeconds: CODE_TTL_SECONDS, resendAfterSeconds: RESEND_COOLDOWN_SECONDS });
    } catch (error) {
        console.error('Start key export error:', error);
        res.status(500).json({ error: 'Could not send the code' });
    }
}

/**
 * POST /account/key/export
 * The key, once the code checks out, and the challenge to sign with it once
 * it is saved. Never cached anywhere on the way.
 */
export async function exportKeyHandler(req: Request, res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    try {
        const { code: value } = req.body as z.infer<typeof keyExportSchema>;
        const user = await account(req.user!.id);
        if (!user?.encryptedPrivkey) { res.status(409).json(NOT_HOSTED); return; }
        if (!user.email) {
            res.status(409).json({ error: 'This account has no email address to confirm with.', reason: 'no_email' });
            return;
        }
        if (!(await checkCode(res, user.email, 'export_key', value))) return;

        const exported = await exportKey(user.id);
        if (!exported) { res.status(409).json(NOT_HOSTED); return; }
        res.json(exported);
    } catch (error) {
        console.error('Key export error:', error);
        res.status(500).json({ error: 'Could not get your key' });
    }
}

/**
 * POST /account/key/release
 * The member signed the challenge with the key they saved: BIES deletes its
 * copy. This device stays signed in; the others must sign in with Nostr.
 */
export async function releaseKeyHandler(req: Request, res: Response): Promise<void> {
    try {
        const body = req.body as z.infer<typeof keyReleaseSchema>;
        const user = await account(req.user!.id);
        if (!user?.encryptedPrivkey) { res.status(409).json(NOT_HOSTED); return; }

        const check = await checkSignedChallenge(user.id, user.nostrPubkey, 'take_key', body.signedEvent);
        if (check !== 'ok') {
            res.status(400).json({ error: SIGNATURE_ERRORS[check], reason: check });
            return;
        }

        if (!(await releaseKey(user.id, req.sessionId!, body.lang))) {
            res.status(409).json(NOT_HOSTED);
            return;
        }
        const updated = await prisma.user.findUnique({ where: { id: user.id }, include: { profile: true } });
        res.json({ user: publicUser(updated) });
    } catch (error) {
        console.error('Key release error:', error);
        res.status(500).json({ error: 'Could not finish. Please try again.' });
    }
}
