/**
 * Invite-only sign-up: the public check, and Admin Panel → Invites
 * (services/invite.service.ts). Every answer is no-store: an invite code
 * never sits in a cache.
 */

import { Request, Response } from 'express';
import { z } from 'zod';
import {
    InviteLimitReached,
    MAX_OPEN_INVITES,
    NOTE_MAX,
    checkInvite,
    createInvite,
    giveBackInviteTry,
    isInviteOnly,
    listInvites,
    revokeInvite,
    setInviteNote,
    setInviteOnly,
    takeInviteTry,
} from '../services/invite.service';

const noStore = (res: Response) => res.setHeader('Cache-Control', 'no-store');

export const checkInviteSchema = z.object({ code: z.string().max(64) });
export const createInviteSchema = z.object({ note: z.string().max(NOTE_MAX).optional() });
export const inviteNoteSchema = z.object({ note: z.string().max(NOTE_MAX) });
export const inviteOnlySchema = z.object({ inviteOnly: z.boolean() });

/** GET /invites/status: whether new accounts need a code (the app's first screen). */
export async function inviteStatus(_req: Request, res: Response): Promise<void> {
    try {
        noStore(res);
        res.json({ inviteOnly: await isInviteOnly() });
    } catch (error) {
        console.error('Invite status error:', error);
        res.status(500).json({ error: 'Could not load sign-up settings' });
    }
}

/**
 * POST /invites/check { code }: whether a code would let a new account in.
 * Doesn't use it up. The same answer for every code that doesn't work, and
 * wrong codes count toward the guessing limit.
 */
export async function checkInviteCode(req: Request, res: Response): Promise<void> {
    try {
        noStore(res);
        const wait = takeInviteTry(req.ip);
        if (wait > 0) {
            res.setHeader('Retry-After', String(wait));
            res.status(429).json({ valid: false, error: 'Too many codes tried. Please wait a while before trying again.', reason: 'invite_rate_limited', retryAfterSeconds: wait });
            return;
        }
        const result = await checkInvite((req.body as z.infer<typeof checkInviteSchema>).code);
        if (!result.ok) {
            res.status(400).json({ valid: false, error: "That code didn't work. It may have been used or expired. Ask the person who invited you for a new one.", reason: 'invite_invalid' });
            return;
        }
        giveBackInviteTry(req.ip);
        res.json({ valid: true, expiresAt: result.expiresAt });
    } catch (error) {
        console.error('Invite check error:', error);
        res.status(500).json({ error: 'Could not check the code' });
    }
}

// ─── Admin Panel → Invites (admins only: admin.routes.ts) ───

export async function adminListInvites(_req: Request, res: Response): Promise<void> {
    try {
        noStore(res);
        res.json(await listInvites());
    } catch (error) {
        console.error('List invites error:', error);
        res.status(500).json({ error: 'Could not load invites' });
    }
}

export async function adminCreateInvite(req: Request, res: Response): Promise<void> {
    try {
        noStore(res);
        const { note } = req.body as z.infer<typeof createInviteSchema>;
        res.status(201).json({ invite: await createInvite(req.user!.id, note ?? '') });
    } catch (error) {
        if (error instanceof InviteLimitReached) {
            res.status(409).json({ error: `There are already ${MAX_OPEN_INVITES} open invites. Revoke some you don't need, or wait for them to expire.`, reason: 'too_many_open' });
            return;
        }
        console.error('Create invite error:', error);
        res.status(500).json({ error: 'Could not make an invite' });
    }
}

export async function adminRevokeInvite(req: Request, res: Response): Promise<void> {
    try {
        noStore(res);
        if (!(await revokeInvite(String(req.params.id)))) {
            res.status(409).json({ error: 'This invite is no longer open.', reason: 'not_open' });
            return;
        }
        res.json({ ok: true });
    } catch (error) {
        console.error('Revoke invite error:', error);
        res.status(500).json({ error: 'Could not revoke the invite' });
    }
}

export async function adminSetInviteNote(req: Request, res: Response): Promise<void> {
    try {
        noStore(res);
        const invite = await setInviteNote(String(req.params.id), (req.body as z.infer<typeof inviteNoteSchema>).note);
        if (!invite) {
            res.status(404).json({ error: 'Invite not found' });
            return;
        }
        res.json({ invite });
    } catch (error) {
        console.error('Invite note error:', error);
        res.status(500).json({ error: 'Could not save the note' });
    }
}

export async function adminSetInviteOnly(req: Request, res: Response): Promise<void> {
    try {
        noStore(res);
        const { inviteOnly } = req.body as z.infer<typeof inviteOnlySchema>;
        res.json(await setInviteOnly(inviteOnly, req.user!.id));
    } catch (error) {
        console.error('Invite-only switch error:', error);
        res.status(500).json({ error: 'Could not change sign-up' });
    }
}
