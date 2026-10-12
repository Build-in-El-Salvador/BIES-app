import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { config } from '../config';
import {
    REPORT_REASONS,
    REPORT_STATUSES,
    REPORT_TARGETS,
    blockMember,
    createReport,
    listBlocks,
    listReports,
    resolveReport,
    unblockMember,
} from '../services/moderation.service';
import { recomputeListingScore } from '../services/directoryReputation.service';
import { publicUser } from './auth.controller';

const HEX64 = /^[0-9a-f]{64}$/;

// ─── Request bodies ───────────────────────────────────────────────────────────

export const reportSchema = z.object({
    targetType: z.enum(REPORT_TARGETS),
    targetId: z.string().min(1).max(128),
    targetPubkey: z.string().regex(HEX64).optional(),
    reason: z.enum(REPORT_REASONS),
    // Never filtered: a report may need to quote what it reports.
    details: z.string().max(4000).optional(),
}).refine((r) => r.targetType !== 'note' || !!r.targetPubkey, {
    message: "A note's author is needed",
    path: ['targetPubkey'],
});

export const blockSchema = z.object({
    userId: z.string().min(1).max(128).optional(),
    pubkey: z.string().regex(HEX64).optional(),
}).refine((b) => !!b.userId !== !!b.pubkey, { message: 'Give the member id or their pubkey' });

export const resolveReportSchema = z.object({
    status: z.enum(REPORT_STATUSES),
    resolution: z.string().max(2000).optional(),
});

export const termsSchema = z.object({ version: z.string().min(1).max(32) });

// ─── Members ──────────────────────────────────────────────────────────────────

/** POST /api/reports */
export async function report(req: Request, res: Response): Promise<void> {
    try {
        const result = await createReport(req.user!.id, req.body);
        if (result.ok) {
            res.status(201).json({ ok: true, duplicate: result.duplicate });
            return;
        }
        const answers = {
            not_found: [404, "We couldn't find what you reported. It may have been removed already."],
            own_content: [400, "That's yours: edit or delete it instead."],
            too_many: [429, "You've sent a lot of reports today. Please email info@buildinelsalvador.com instead."],
        } as const;
        const [status, error] = answers[result.reason];
        res.status(status).json({ error, reason: result.reason });
    } catch (error) {
        console.error('[Moderation] Report failed:', error);
        res.status(500).json({ error: 'Failed to send the report' });
    }
}

/** GET /api/blocks */
export async function getBlocks(req: Request, res: Response): Promise<void> {
    try {
        res.json({ data: await listBlocks(req.user!.id) });
    } catch (error) {
        console.error('[Moderation] List blocks failed:', error);
        res.status(500).json({ error: 'Failed to load blocked members' });
    }
}

/** POST /api/blocks { userId } or { pubkey } */
export async function block(req: Request, res: Response): Promise<void> {
    try {
        let blockedId: string | undefined = req.body.userId;
        if (!blockedId) {
            const member = await prisma.user.findUnique({ where: { nostrPubkey: req.body.pubkey }, select: { id: true } });
            if (!member) {
                // Not a BIES member: the app mutes them on the device instead.
                res.status(404).json({ error: 'Not a BIES member', reason: 'not_member' });
                return;
            }
            blockedId = member.id;
        }
        const result = await blockMember(req.user!.id, blockedId);
        if (result === 'self') {
            res.status(400).json({ error: "You can't block yourself", reason: 'self' });
            return;
        }
        if (result === 'not_found') {
            res.status(404).json({ error: 'Member not found', reason: 'not_found' });
            return;
        }
        res.status(201).json({ ok: true, userId: blockedId });
    } catch (error) {
        console.error('[Moderation] Block failed:', error);
        res.status(500).json({ error: 'Failed to block the member' });
    }
}

/** DELETE /api/blocks/:userId */
export async function unblock(req: Request, res: Response): Promise<void> {
    try {
        await unblockMember(req.user!.id, req.params.userId);
        res.json({ ok: true });
    } catch (error) {
        console.error('[Moderation] Unblock failed:', error);
        res.status(500).json({ error: 'Failed to unblock the member' });
    }
}

/** POST /api/account/terms { version }: the member accepts the terms of use. */
export async function acceptTerms(req: Request, res: Response): Promise<void> {
    try {
        if (req.body.version !== config.termsVersion) {
            // The terms changed while the app showed the old ones.
            res.status(409).json({ error: 'The terms have changed. Please read them again.', reason: 'terms_changed', termsVersion: config.termsVersion });
            return;
        }
        const user = await prisma.user.update({
            where: { id: req.user!.id },
            data: { termsVersion: config.termsVersion, termsAcceptedAt: new Date() },
            include: { profile: true },
        });
        res.json({ user: publicUser(user) });
    } catch (error) {
        console.error('[Terms] Accept failed:', error);
        res.status(500).json({ error: 'Failed to save that' });
    }
}

// ─── Moderators (/api/admin) ──────────────────────────────────────────────────

/** GET /api/admin/reports?status=OPEN&page=1 */
export async function adminListReports(req: Request, res: Response): Promise<void> {
    try {
        const status = REPORT_STATUSES.find((s) => s === req.query.status);
        const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20));
        res.json(await listReports({ status, page, limit }));
    } catch (error) {
        console.error('[Moderation] List reports failed:', error);
        res.status(500).json({ error: 'Failed to load reports' });
    }
}

/** PUT /api/admin/reports/:id { status, resolution } */
export async function adminResolveReport(req: Request, res: Response): Promise<void> {
    try {
        const { status, resolution = '' } = req.body;
        const found = await resolveReport(req.params.id, req.user!.id, status, resolution);
        if (!found) {
            res.status(404).json({ error: 'Report not found' });
            return;
        }
        await prisma.auditLog.create({
            data: {
                userId: req.user!.id,
                action: `REPORT_${status}`,
                resource: `report:${req.params.id}`,
                metadata: JSON.stringify({ resolution: resolution.slice(0, 200) }),
            },
        });
        res.json({ ok: true });
    } catch (error) {
        console.error('[Moderation] Resolve report failed:', error);
        res.status(500).json({ error: 'Failed to update the report' });
    }
}

/** DELETE /api/admin/endorsements/:id: a moderator removes a recommendation. */
export async function adminDeleteEndorsement(req: Request, res: Response): Promise<void> {
    try {
        const endorsement = await prisma.directoryEndorsement.findUnique({
            where: { id: req.params.id },
            select: { id: true, listingId: true, userId: true, comment: true },
        });
        if (!endorsement) {
            res.status(404).json({ error: 'Recommendation not found' });
            return;
        }
        await prisma.directoryEndorsement.delete({ where: { id: endorsement.id } });
        await prisma.auditLog.create({
            data: {
                userId: req.user!.id,
                action: 'DIRECTORY_ENDORSEMENT_REMOVED',
                resource: `directory:${endorsement.listingId}`,
                metadata: JSON.stringify({ authorId: endorsement.userId, comment: endorsement.comment.slice(0, 200) }),
            },
        });
        recomputeListingScore(endorsement.listingId).catch((err) =>
            console.error('[Directory] Score recompute failed:', err));
        res.json({ ok: true });
    } catch (error) {
        console.error('[Moderation] Remove recommendation failed:', error);
        res.status(500).json({ error: 'Failed to remove the recommendation' });
    }
}
