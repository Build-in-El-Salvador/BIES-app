/**
 * Voucher service — admin-issued relay-access voucher links.
 *
 * RELAY_ACCESS vouchers whitelist external Nostr pubkeys on the private
 * BIES relay (free or Lightning-paid via the creator's Coinos wallet).
 * ONBOARDING vouchers are multi-use signup-attribution codes: signup stays
 * open and continues to auto-whitelist; redemptions only record which
 * voucher brought the user in.
 */

import crypto from 'crypto';
import { Prisma, Voucher, VoucherRedemption } from '@prisma/client';
import prisma from '../lib/prisma';
import { cache } from './redis.service';
import { HEX_PUBKEY_RE, addToRelayWhitelist, removeFromRelayWhitelist } from './relayWhitelist.service';
import * as coinosService from './coinos.service';
import { createNotification } from './notification.service';
import { isUniqueViolation } from './points.service';

// Pending paid redemptions expire (and stop reserving capacity) after 1 hour.
const PENDING_TTL_MS = 60 * 60 * 1000;

export type VoucherInvalidReason = 'revoked' | 'expired' | 'exhausted';

export interface VoucherValidity {
    valid: boolean;
    reason?: VoucherInvalidReason;
}

/** Thrown for redemption failures the controller maps to 400 responses. */
export class VoucherError extends Error {
    constructor(message: string, public reason: string) {
        super(message);
        this.name = 'VoucherError';
    }
}

/**
 * A code doesn't let a suspended or deleted account back onto the relay:
 * sign-in refuses them, and so does this.
 */
async function refuseSuspended(pubkey: string): Promise<void> {
    const user = await prisma.user.findUnique({ where: { nostrPubkey: pubkey }, select: { isBanned: true, deletedAt: true } });
    if (user && (user.isBanned || user.deletedAt)) {
        throw new VoucherError("This code can't be used with this account", 'unavailable');
    }
}

// ─── Code generation & pubkey normalization ─────────────────────────────────

/** URL-safe random voucher code (~96 bits of entropy). */
export function generateCode(): string {
    return crypto.randomBytes(12).toString('base64url');
}

/**
 * Normalize a user-supplied pubkey: accepts 64-char hex or an npub1...
 * (decoded via nostr-tools). Returns lowercase hex, or null when invalid.
 */
export async function normalizePubkey(input: string): Promise<string | null> {
    if (typeof input !== 'string') return null;
    let candidate = input.trim().toLowerCase();
    if (!candidate) return null;

    if (candidate.startsWith('npub1')) {
        try {
            // nostr-tools is ESM-only (@noble/curves has no CJS build);
            // use dynamic import() so the compiled CJS output doesn't call require().
            const nip19 = await import('nostr-tools/nip19');
            const decoded = nip19.decode(candidate);
            if (decoded.type !== 'npub') return null;
            candidate = decoded.data;
        } catch {
            return null;
        }
    }

    return HEX_PUBKEY_RE.test(candidate) ? candidate : null;
}

// ─── Validity & capacity ─────────────────────────────────────────────────────

/**
 * Uses that count against capacity: COMPLETED redemptions only.
 *
 * Unpaid PENDING_PAYMENT rows deliberately do NOT reserve a slot — counting
 * them would let anyone with the public link exhaust a voucher by POSTing
 * throwaway pubkeys (no payment required), a free denial-of-service on
 * availability. Capacity is instead enforced atomically at completion time
 * (see reserveCapacity), so the last slot still can't be over-granted.
 */
async function countActiveUses(
    voucherId: string,
    db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<number> {
    return db.voucherRedemption.count({
        where: { voucherId, status: 'COMPLETED' },
    });
}

/**
 * Atomically claim one capacity slot on a voucher by incrementing useCount
 * only while useCount < maxUses. Returns true if a slot was claimed. For
 * unlimited vouchers (maxUses === 0) this always increments and returns true.
 * The conditional updateMany is the single source of truth for the cap under
 * concurrency — it holds on both SQLite and Postgres regardless of isolation
 * level, so distinct-pubkey races can't oversell the last slot.
 */
async function reserveCapacity(
    voucherId: string,
    maxUses: number,
    db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<boolean> {
    if (maxUses === 0) {
        await db.voucher.update({ where: { id: voucherId }, data: { useCount: { increment: 1 } } });
        return true;
    }
    const claimed = await db.voucher.updateMany({
        where: { id: voucherId, useCount: { lt: maxUses } },
        data: { useCount: { increment: 1 } },
    });
    return claimed.count === 1;
}

async function computeValidity(
    voucher: Voucher,
    db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<VoucherValidity> {
    if (voucher.status !== 'ACTIVE') return { valid: false, reason: 'revoked' };
    if (voucher.expiresAt && voucher.expiresAt.getTime() < Date.now()) {
        return { valid: false, reason: 'expired' };
    }
    if (voucher.maxUses !== 0) {
        const used = await countActiveUses(voucher.id, db);
        if (used >= voucher.maxUses) return { valid: false, reason: 'exhausted' };
    }
    return { valid: true };
}

/**
 * Look up a voucher by code and compute its current validity.
 * Returns null when the code doesn't exist.
 */
export async function getVoucherByCode(
    code: string,
): Promise<{ voucher: Voucher } & VoucherValidity | null> {
    const voucher = await prisma.voucher.findUnique({ where: { code } });
    if (!voucher) return null;
    const validity = await computeValidity(voucher);
    return { voucher, ...validity };
}

/**
 * Look up an existing COMPLETED redemption for a pubkey on a voucher.
 * Lets callers honor idempotency before rejecting on validity/capacity.
 */
export async function findCompletedRedemption(
    voucherId: string,
    pubkey: string,
): Promise<VoucherRedemption | null> {
    const existing = await prisma.voucherRedemption.findUnique({
        where: { voucherId_pubkey: { voucherId, pubkey } },
    });
    return existing?.status === 'COMPLETED' ? existing : null;
}

// ─── Notification ────────────────────────────────────────────────────────────

function notifyVoucherRedeemed(voucher: Voucher, pubkey: string): void {
    createNotification({
        userId: voucher.createdById,
        type: 'VOUCHER_REDEEMED',
        title: 'Relay voucher redeemed',
        body: `${voucher.label || voucher.code} was redeemed by ${pubkey.substring(0, 8)}...`,
        data: { voucherId: voucher.id },
    }).catch((err) => console.error('[Voucher] Redemption notification failed:', err));
}

// ─── Free redemption ─────────────────────────────────────────────────────────

/**
 * Redeem a free RELAY_ACCESS voucher for a pubkey. Idempotent: a pubkey
 * that already holds a COMPLETED redemption gets it back unchanged.
 * Throws VoucherError when the voucher is no longer redeemable.
 */
export async function redeemFree(
    voucher: Voucher,
    pubkey: string,
    ipAddress?: string | null,
): Promise<VoucherRedemption> {
    await refuseSuspended(pubkey);
    let alreadyRedeemed = false;

    let redemption: VoucherRedemption;
    try {
        redemption = await prisma.$transaction(async (tx) => {
            // Idempotency: an existing COMPLETED redemption wins over everything
            const existing = await tx.voucherRedemption.findUnique({
                where: { voucherId_pubkey: { voucherId: voucher.id, pubkey } },
            });
            if (existing?.status === 'COMPLETED') {
                alreadyRedeemed = true;
                return existing;
            }
            if (existing?.status === 'REVOKED') {
                throw new VoucherError('This redemption has been revoked', 'revoked');
            }

            // Re-check status/expiry/capacity inside the transaction
            const fresh = await tx.voucher.findUnique({ where: { id: voucher.id } });
            if (!fresh) throw new VoucherError('Voucher not found', 'revoked');
            const validity = await computeValidity(fresh, tx);
            if (!validity.valid) {
                throw new VoucherError(`Voucher is ${validity.reason}`, validity.reason!);
            }

            // Claim a capacity slot atomically before granting access. Blocks
            // distinct-pubkey concurrency from overselling the last slot.
            const claimed = await reserveCapacity(voucher.id, fresh.maxUses, tx);
            if (!claimed) throw new VoucherError('Voucher is exhausted', 'exhausted');

            const now = new Date();
            const completed = existing
                ? await tx.voucherRedemption.update({
                    where: { id: existing.id },
                    data: { status: 'COMPLETED', redeemedAt: now, ipAddress: ipAddress ?? null },
                })
                : await tx.voucherRedemption.create({
                    data: {
                        voucherId: voucher.id,
                        pubkey,
                        status: 'COMPLETED',
                        redeemedAt: now,
                        ipAddress: ipAddress ?? null,
                    },
                });

            return completed;
        });
    } catch (error) {
        // Concurrent redeem for the same (voucher, pubkey): treat as already redeemed
        if (isUniqueViolation(error)) {
            const existing = await prisma.voucherRedemption.findUnique({
                where: { voucherId_pubkey: { voucherId: voucher.id, pubkey } },
            });
            if (existing?.status === 'COMPLETED') {
                addToRelayWhitelist(pubkey);
                return existing;
            }
        }
        throw error;
    }

    addToRelayWhitelist(pubkey);
    if (!alreadyRedeemed) notifyVoucherRedeemed(voucher, pubkey);

    return redemption;
}

// ─── Paid redemption ─────────────────────────────────────────────────────────

/**
 * Start a paid redemption: create a Lightning invoice on the voucher
 * creator's Coinos wallet and a PENDING_PAYMENT redemption row.
 *
 * An existing PENDING_PAYMENT row for the same pubkey is ALWAYS reused (its
 * original invoice is returned unchanged) rather than re-invoiced — Coinos
 * bolt11 invoices stay valid until their own expiry, and re-invoicing on
 * every poll would let anyone spam fresh invoices on the creator's wallet and
 * perpetually renew a slot. A new invoice is only minted when there is no
 * pending row at all, or the previous one was already EXPIRED by a poll.
 */
export async function startPaidRedemption(
    voucher: Voucher,
    pubkey: string,
    ipAddress?: string | null,
): Promise<VoucherRedemption> {
    await refuseSuspended(pubkey);
    const existing = await prisma.voucherRedemption.findUnique({
        where: { voucherId_pubkey: { voucherId: voucher.id, pubkey } },
    });
    if (existing) {
        if (existing.status === 'COMPLETED') return existing;
        if (existing.status === 'REVOKED') {
            throw new VoucherError('This redemption has been revoked', 'revoked');
        }
        // Reuse any still-pending invoice; checkPaidRedemption owns expiry.
        if (existing.status === 'PENDING_PAYMENT' && existing.bolt11) {
            return existing;
        }
    }

    const validity = await computeValidity(voucher);
    if (!validity.valid) {
        throw new VoucherError(`Voucher is ${validity.reason}`, validity.reason!);
    }

    const memo = `BIES relay access — ${voucher.label || voucher.code}`;
    const invoice = await coinosService.createInvoice(voucher.createdById, voucher.priceSats, memo);

    const data = {
        status: 'PENDING_PAYMENT',
        invoiceHash: invoice.hash,
        bolt11: invoice.pr,
        amountSats: voucher.priceSats,
        ipAddress: ipAddress ?? null,
    };

    if (existing) {
        // Previous row was EXPIRED (unpaid, aged out): mint a fresh invoice and
        // restart the clock so the user can try again.
        return prisma.voucherRedemption.update({
            where: { id: existing.id },
            data: { ...data, redeemedAt: null, createdAt: new Date() },
        });
    }

    try {
        return await prisma.voucherRedemption.create({
            data: { ...data, voucherId: voucher.id, pubkey },
        });
    } catch (error) {
        // Concurrent start for the same (voucher, pubkey): return the winner's row
        if (isUniqueViolation(error)) {
            const winner = await prisma.voucherRedemption.findUnique({
                where: { voucherId_pubkey: { voucherId: voucher.id, pubkey } },
            });
            if (winner) return winner;
        }
        throw error;
    }
}

/**
 * Poll a paid redemption: expire stale pending rows, check the Coinos
 * invoice (with a short cache so status polling doesn't hammer Coinos),
 * and finalize + whitelist when paid. Returns the up-to-date row, or
 * null when the redemption doesn't exist.
 */
export async function checkPaidRedemption(redemptionId: string): Promise<VoucherRedemption | null> {
    const redemption = await prisma.voucherRedemption.findUnique({
        where: { id: redemptionId },
        include: { voucher: true },
    });
    if (!redemption) return null;

    // COMPLETED / EXPIRED / REVOKED are terminal
    if (redemption.status !== 'PENDING_PAYMENT') return redemption;
    if (!redemption.invoiceHash) return redemption;

    const aged = Date.now() - redemption.createdAt.getTime() > PENDING_TTL_MS;

    // ALWAYS check Coinos before considering expiry — a payment that landed
    // near/after the 1h mark (or a poll that resumed late from a suspended tab)
    // must still be honored, otherwise the user pays and gets nothing. Cache
    // the result ~3s so rapid status polls don't hammer Coinos.
    const invoiceCacheKey = `voucher:inv:${redemption.invoiceHash}`;
    let invoice = await cache.getJson<any>(invoiceCacheKey);
    if (!invoice) {
        try {
            invoice = await coinosService.getInvoice(redemption.invoiceHash);
            await cache.setJson(invoiceCacheKey, invoice, 3);
        } catch (err) {
            console.error('[Voucher] Coinos invoice check failed:', err);
            // Don't expire on an error path — we can't prove it's unpaid.
            return redemption;
        }
    }

    const expectedSats = typeof invoice?.amount === 'number' && invoice.amount > 0
        ? invoice.amount
        : redemption.amountSats;
    const paid =
        invoice?.paid === true ||
        (typeof invoice?.received === 'number' && expectedSats > 0 && invoice.received >= expectedSats);

    // Only expire once we've confirmed the invoice is BOTH unpaid AND aged out.
    if (!paid) {
        if (aged) {
            return prisma.voucherRedemption.update({
                where: { id: redemptionId },
                data: { status: 'EXPIRED' },
            });
        }
        return redemption;
    }

    // Finalize (same transactional shape as redeemFree). didFinalize guards
    // against a concurrent poll double-notifying. Paid redemptions reserve a
    // capacity slot but are honored even past the cap: the sats already landed,
    // so refusing access would keep the money and give nothing.
    let didFinalize = false;
    const finalized = await prisma.$transaction(async (tx) => {
        const row = await tx.voucherRedemption.findUnique({ where: { id: redemptionId } });
        if (!row || row.status !== 'PENDING_PAYMENT') return row;

        const claimed = await reserveCapacity(row.voucherId, redemption.voucher.maxUses, tx);
        if (!claimed) {
            // Over the cap but paid: honor it, still count the use, and warn.
            console.warn(
                `[Voucher] Paid redemption ${row.id} completed over maxUses on voucher ${row.voucherId}`,
            );
            await tx.voucher.update({
                where: { id: row.voucherId },
                data: { useCount: { increment: 1 } },
            });
        }
        const updated = await tx.voucherRedemption.update({
            where: { id: redemptionId },
            data: { status: 'COMPLETED', redeemedAt: new Date() },
        });
        didFinalize = true;
        return updated;
    });

    if (finalized?.status === 'COMPLETED' && finalized.pubkey) {
        // Suspended since it was paid: no relay access.
        const suspended = await refuseSuspended(finalized.pubkey).then(() => false, () => true);
        if (!suspended) addToRelayWhitelist(finalized.pubkey);
        if (didFinalize) notifyVoucherRedeemed(redemption.voucher, finalized.pubkey);
    }

    return finalized ?? redemption;
}

// ─── Onboarding attribution ──────────────────────────────────────────────────

/**
 * Record a signup against an ONBOARDING voucher. Best-effort: silently
 * no-ops on unknown/invalid/exhausted codes and never throws — signup
 * stays open regardless of voucher state.
 */
export async function recordOnboardingRedemption(
    code: string | null | undefined,
    userId: string,
    ipAddress?: string | null,
): Promise<void> {
    if (!code || typeof code !== 'string') return;

    try {
        const voucher = await prisma.voucher.findUnique({ where: { code: code.trim() } });
        if (!voucher || voucher.type !== 'ONBOARDING') return;

        const validity = await computeValidity(voucher);
        if (!validity.valid) return;

        await prisma.$transaction(async (tx) => {
            await tx.voucherRedemption.create({
                data: {
                    voucherId: voucher.id,
                    userId,
                    status: 'COMPLETED',
                    redeemedAt: new Date(),
                    ipAddress: ipAddress ?? null,
                },
            });
            await tx.voucher.update({
                where: { id: voucher.id },
                data: { useCount: { increment: 1 } },
            });
        });
    } catch (err) {
        console.error('[Voucher] Failed to record onboarding redemption:', err);
    }
}

// ─── Revocation ──────────────────────────────────────────────────────────────

/**
 * Remove a pubkey from the relay whitelist ONLY when nothing else still
 * grants it access: no BIES account uses it and no other non-revoked
 * voucher has a COMPLETED redemption for it.
 */
export async function maybeRemoveRelayAccess(pubkey: string): Promise<void> {
    const user = await prisma.user.findUnique({
        where: { nostrPubkey: pubkey },
        select: { id: true },
    });
    if (user) return;

    const otherGrant = await prisma.voucherRedemption.findFirst({
        where: {
            pubkey,
            status: 'COMPLETED',
            voucher: { status: { not: 'REVOKED' } },
        },
        select: { id: true },
    });
    if (otherGrant) return;

    removeFromRelayWhitelist(pubkey);
}

/**
 * Revoke a single redemption. Optionally removes the pubkey's relay
 * access (unless something else still grants it).
 */
export async function revokeRedemption(
    id: string,
    revokeAccess: boolean,
): Promise<VoucherRedemption | null> {
    const redemption = await prisma.voucherRedemption.findUnique({ where: { id } });
    if (!redemption) return null;

    const updated = await prisma.voucherRedemption.update({
        where: { id },
        data: { status: 'REVOKED' },
    });

    if (revokeAccess && redemption.pubkey) {
        await maybeRemoveRelayAccess(redemption.pubkey);
    }

    return updated;
}

/**
 * Revoke a voucher: no further redemptions, pending invoices voided.
 * Optionally removes relay access granted through it (unless something
 * else still grants it).
 */
export async function revokeVoucher(id: string, revokeAccess: boolean): Promise<Voucher | null> {
    const voucher = await prisma.voucher.findUnique({
        where: { id },
        include: { redemptions: true },
    });
    if (!voucher) return null;

    const updated = await prisma.voucher.update({
        where: { id },
        data: { status: 'REVOKED' },
    });

    await prisma.voucherRedemption.updateMany({
        where: { voucherId: id, status: 'PENDING_PAYMENT' },
        data: { status: 'REVOKED' },
    });

    if (revokeAccess) {
        for (const redemption of voucher.redemptions) {
            if (redemption.status === 'COMPLETED' && redemption.pubkey) {
                await maybeRemoveRelayAccess(redemption.pubkey);
            }
        }
    }

    return updated;
}
