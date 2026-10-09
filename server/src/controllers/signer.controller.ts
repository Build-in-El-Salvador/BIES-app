import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { checkAppSignRequest, signAsHostedUser, type SignRefusal } from '../services/hostedSigner.service';

export const signRequestSchema = z.object({
    event: z.object({
        kind: z.number().int().min(0).max(65535),
        created_at: z.number().int().min(0),
        tags: z.array(z.array(z.string())),
        content: z.string(),
        pubkey: z.string().optional(),
    }),
});

const REFUSALS: Record<SignRefusal, string> = {
    kind_not_allowed: 'BIES does not sign this kind of event for email accounts.',
    bad_time: "The event's time is too far from now.",
    too_large: 'The event is too large.',
    bad_relay: 'BIES only signs relay sign-ins for its own relay.',
    bad_expiration: 'Upload permissions must expire within a day.',
};

/**
 * POST /api/signer/sign
 * Sign an event with the key BIES holds for this account and return it. The
 * key never leaves the server.
 */
export async function signForApp(req: Request, res: Response): Promise<void> {
    try {
        const { pubkey, ...template } = (req.body as z.infer<typeof signRequestSchema>).event;
        if (pubkey !== undefined && pubkey !== req.user!.nostrPubkey) {
            res.status(400).json({ error: 'The event belongs to a different account.', reason: 'wrong_pubkey' });
            return;
        }

        const account = await prisma.user.findUnique({
            where: { id: req.user!.id },
            select: { encryptedPrivkey: true, isBanned: true, deletedAt: true },
        });
        if (!account || account.isBanned || account.deletedAt) {
            res.status(403).json({ error: 'Your account has been suspended', reason: 'suspended' });
            return;
        }
        if (!account.encryptedPrivkey) {
            res.status(409).json({ error: 'This account signs on its own device, not through BIES.', reason: 'not_hosted' });
            return;
        }

        const refusal = checkAppSignRequest(template);
        if (refusal) {
            res.status(400).json({ error: REFUSALS[refusal], reason: refusal });
            return;
        }

        const signed = await signAsHostedUser(req.user!.id, template, 'app');
        if (!signed) {
            res.status(409).json({ error: 'This account signs on its own device, not through BIES.', reason: 'not_hosted' });
            return;
        }
        res.json({ event: signed });
    } catch (error) {
        console.error('Hosted signing error:', error);
        res.status(500).json({ error: 'Signing failed' });
    }
}

/**
 * GET /api/signer/log?limit=50
 * What BIES has signed with this account's key, newest first.
 */
export async function getSignatureLog(req: Request, res: Response): Promise<void> {
    try {
        const requested = parseInt(String(req.query.limit ?? ''), 10);
        const limit = Number.isNaN(requested) ? 50 : Math.min(Math.max(requested, 1), 200);
        const signatures = await prisma.hostedSignature.findMany({
            where: { userId: req.user!.id },
            orderBy: { createdAt: 'desc' },
            take: limit,
            select: { kind: true, eventId: true, source: true, createdAt: true },
        });
        res.json({ signatures });
    } catch (error) {
        console.error('Signature log error:', error);
        res.status(500).json({ error: 'Failed to load the signature log' });
    }
}
