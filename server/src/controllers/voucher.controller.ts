/**
 * Voucher controller — admin-issued relay-access voucher links.
 * Admin endpoints require isAdmin/MOD (create + revoke are admin-only);
 * the code/redemption endpoints are public (shared voucher links).
 */

import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { config } from '../config';
import * as voucherService from '../services/voucher.service';
import * as coinosService from '../services/coinos.service';
import { isUniqueViolation } from '../services/points.service';
import { isVanished } from '../services/relayWhitelist.service';

// ─── Validation ───────────────────────────────────────────────────────────────

const CUSTOM_CODE_RE = /^[a-zA-Z0-9_-]{6,32}$/;

export const createVoucherSchema = z.object({
    type: z.enum(['RELAY_ACCESS', 'ONBOARDING']).optional(),
    label: z.string().max(120).optional(),
    priceSats: z.number().int().min(0).max(100_000_000).optional(),
    maxUses: z.number().int().min(0).max(1_000_000).optional(),
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
    notes: z.string().max(2000).optional(),
    code: z.string().regex(CUSTOM_CODE_RE, 'Code must be 6-32 characters (letters, numbers, - and _)').optional(),
});

export const revokeVoucherSchema = z.object({
    revokeAccess: z.boolean().optional(),
});

export const redeemVoucherSchema = z.object({
    pubkey: z.string().min(1).max(200),
});

// ─── Admin: manage vouchers ───────────────────────────────────────────────────

/**
 * POST /vouchers
 * Create a voucher (admin only).
 */
export async function createVoucher(req: Request, res: Response): Promise<void> {
    try {
        // Creating vouchers is admin-only
        if (!req.user!.isAdmin) {
            res.status(403).json({ error: 'Only admins can create vouchers' }); return;
        }

        const {
            type = 'RELAY_ACCESS',
            label = '',
            priceSats = 0,
            expiresAt,
            notes = '',
            code,
        } = req.body;

        // ONBOARDING links are multi-use by design (one shared link, many
        // signups); default them to unlimited so blank Max Uses doesn't
        // silently drop attribution after the first signup. RELAY_ACCESS
        // defaults to single-use.
        const maxUses = req.body.maxUses ?? (type === 'ONBOARDING' ? 0 : 1);

        if (type === 'ONBOARDING' && priceSats > 0) {
            res.status(400).json({ error: 'Onboarding vouchers cannot require payment' }); return;
        }

        if (priceSats > 0 && !(await coinosService.hasWallet(req.user!.id))) {
            res.status(400).json({
                error: 'Connect a Coinos wallet before creating paid vouchers — payments are received on your wallet',
            });
            return;
        }

        if (code) {
            const existing = await prisma.voucher.findUnique({ where: { code } });
            if (existing) {
                res.status(409).json({ error: 'Voucher code already exists' }); return;
            }
        }

        const voucher = await prisma.voucher.create({
            data: {
                code: code || voucherService.generateCode(),
                type,
                label,
                priceSats,
                maxUses,
                expiresAt: expiresAt ? new Date(expiresAt) : null,
                notes,
                createdById: req.user!.id,
            },
        });

        res.status(201).json(voucher);
    } catch (error) {
        if (isUniqueViolation(error)) {
            res.status(409).json({ error: 'Voucher code already exists' }); return;
        }
        console.error('Create voucher error:', error);
        res.status(500).json({ error: 'Failed to create voucher' });
    }
}

/**
 * GET /vouchers
 * List all vouchers (newest first) with redemption counts by status.
 */
export async function listVouchers(_req: Request, res: Response): Promise<void> {
    try {
        const [vouchers, counts] = await Promise.all([
            prisma.voucher.findMany({
                orderBy: { createdAt: 'desc' },
                include: {
                    createdBy: { select: { id: true, profile: { select: { name: true } } } },
                },
            }),
            prisma.voucherRedemption.groupBy({
                by: ['voucherId', 'status'],
                _count: { _all: true },
            }),
        ]);

        const countsByVoucher: Record<string, Record<string, number>> = {};
        for (const row of counts) {
            (countsByVoucher[row.voucherId] ??= {})[row.status] = row._count._all;
        }

        res.json(vouchers.map((voucher) => ({
            ...voucher,
            redemptionCounts: countsByVoucher[voucher.id] || {},
        })));
    } catch (error) {
        console.error('List vouchers error:', error);
        res.status(500).json({ error: 'Failed to list vouchers' });
    }
}

/**
 * GET /vouchers/:id/redemptions
 * List a voucher's redemptions (newest first).
 */
export async function listVoucherRedemptions(req: Request, res: Response): Promise<void> {
    try {
        const voucher = await prisma.voucher.findUnique({ where: { id: req.params.id } });
        if (!voucher) {
            res.status(404).json({ error: 'Voucher not found' }); return;
        }

        const redemptions = await prisma.voucherRedemption.findMany({
            where: { voucherId: req.params.id },
            orderBy: { createdAt: 'desc' },
            include: {
                user: { select: { id: true, profile: { select: { name: true, avatar: true } } } },
            },
        });

        res.json(redemptions);
    } catch (error) {
        console.error('List voucher redemptions error:', error);
        res.status(500).json({ error: 'Failed to list redemptions' });
    }
}

/**
 * POST /vouchers/:id/revoke
 * Revoke a voucher (admin only). Optionally revokes relay access it granted.
 */
export async function revokeVoucher(req: Request, res: Response): Promise<void> {
    try {
        // Revoking vouchers is admin-only
        if (!req.user!.isAdmin) {
            res.status(403).json({ error: 'Only admins can revoke vouchers' }); return;
        }

        const voucher = await voucherService.revokeVoucher(
            req.params.id,
            req.body.revokeAccess === true,
        );
        if (!voucher) {
            res.status(404).json({ error: 'Voucher not found' }); return;
        }

        res.json(voucher);
    } catch (error) {
        console.error('Revoke voucher error:', error);
        res.status(500).json({ error: 'Failed to revoke voucher' });
    }
}

/**
 * POST /vouchers/redemptions/:id/revoke
 * Revoke a single redemption (admin only). Optionally revokes relay access.
 */
export async function revokeRedemption(req: Request, res: Response): Promise<void> {
    try {
        // Revoking redemptions is admin-only
        if (!req.user!.isAdmin) {
            res.status(403).json({ error: 'Only admins can revoke redemptions' }); return;
        }

        const redemption = await voucherService.revokeRedemption(
            req.params.id,
            req.body.revokeAccess === true,
        );
        if (!redemption) {
            res.status(404).json({ error: 'Redemption not found' }); return;
        }

        res.json(redemption);
    } catch (error) {
        console.error('Revoke redemption error:', error);
        res.status(500).json({ error: 'Failed to revoke redemption' });
    }
}

// ─── Public: voucher links ────────────────────────────────────────────────────

/**
 * GET /vouchers/code/:code
 * Public voucher info for the redeem page. Never leaks notes/creator.
 */
export async function getVoucherInfo(req: Request, res: Response): Promise<void> {
    try {
        const result = await voucherService.getVoucherByCode(req.params.code);
        if (!result) {
            res.status(404).json({ error: 'Not found' }); return;
        }

        const { voucher, valid, reason } = result;
        res.json({
            valid,
            ...(reason ? { reason } : {}),
            type: voucher.type,
            priceSats: voucher.priceSats,
            label: voucher.label,
        });
    } catch (error) {
        console.error('Voucher info error:', error);
        res.status(500).json({ error: 'Failed to load voucher' });
    }
}

/**
 * POST /vouchers/code/:code/redeem
 * Redeem a RELAY_ACCESS voucher for a Nostr pubkey (hex or npub).
 * Free vouchers whitelist immediately; paid ones return a Lightning invoice.
 */
export async function redeemVoucher(req: Request, res: Response): Promise<void> {
    try {
        const result = await voucherService.getVoucherByCode(req.params.code);
        if (!result) {
            res.status(404).json({ error: 'Not found' }); return;
        }

        const { voucher, valid, reason } = result;
        if (voucher.type !== 'RELAY_ACCESS') {
            res.status(400).json({ error: 'This voucher is not redeemable for relay access' }); return;
        }

        const pubkey = await voucherService.normalizePubkey(req.body.pubkey);
        if (!pubkey) {
            res.status(400).json({ error: 'Invalid pubkey — provide a 64-character hex key or npub' });
            return;
        }
        // A deleted account's key: only its holder can bring it back, by
        // signing in. A voucher proves nothing about who holds the key.
        if (isVanished(pubkey)) {
            res.status(403).json({ error: 'This key belonged to a deleted account. Sign in with it to rejoin.', reason: 'deleted_account' });
            return;
        }

        // Idempotency wins over validity: a pubkey that already completed this
        // voucher keeps getting success back even after it becomes exhausted,
        // expired, or revoked (its access was already granted).
        const existing = await voucherService.findCompletedRedemption(voucher.id, pubkey);
        if (existing) {
            res.json({ status: 'completed', relayUrl: config.nostrPublicRelay });
            return;
        }

        if (!valid) {
            res.status(400).json({ error: `Voucher is ${reason}`, reason }); return;
        }

        if (voucher.priceSats > 0) {
            const redemption = await voucherService.startPaidRedemption(voucher, pubkey, req.ip || null);
            if (redemption.status === 'COMPLETED') {
                res.json({ status: 'completed', relayUrl: config.nostrPublicRelay }); return;
            }
            res.json({
                status: 'pending_payment',
                redemptionId: redemption.id,
                bolt11: redemption.bolt11,
                amountSats: redemption.amountSats,
            });
            return;
        }

        await voucherService.redeemFree(voucher, pubkey, req.ip || null);
        res.json({ status: 'completed', relayUrl: config.nostrPublicRelay });
    } catch (error) {
        if (error instanceof voucherService.VoucherError) {
            res.status(400).json({ error: error.message, reason: error.reason }); return;
        }
        console.error('Redeem voucher error:', error);
        res.status(500).json({ error: 'Failed to redeem voucher' });
    }
}

/**
 * GET /vouchers/redemptions/:id/status
 * Poll a paid redemption. Checks the Lightning invoice and finalizes when paid.
 */
export async function getRedemptionStatus(req: Request, res: Response): Promise<void> {
    try {
        const redemption = await voucherService.checkPaidRedemption(req.params.id);
        if (!redemption) {
            res.status(404).json({ error: 'Not found' }); return;
        }

        res.json({
            status: redemption.status,
            ...(redemption.status === 'COMPLETED' ? { relayUrl: config.nostrPublicRelay } : {}),
        });
    } catch (error) {
        console.error('Redemption status error:', error);
        res.status(500).json({ error: 'Failed to check redemption status' });
    }
}
