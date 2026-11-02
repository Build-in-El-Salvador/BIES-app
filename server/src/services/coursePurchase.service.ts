/**
 * Course purchase via zap-and-claim (NIP-57).
 *
 * The passive zap indexer is NEVER trusted for entitlement — receipts it
 * stores are display data. A purchase is only created here, after strict
 * verification of the actual kind-9735 events fetched from relays:
 *
 *   1. receipt signature valid AND signed by the author's LNURL provider's
 *      advertised zapper key (NIP-57 Appendix F) — kills self-signed fakes
 *   2. embedded kind-9734 zap request signature valid AND signed by the
 *      claiming buyer — kills cross-user replay
 *   3. bolt11 present; its description_hash commits to the exact 9734 JSON
 *      (payment is cryptographically bound to the request) and its amount
 *      is the amount credited — the client-supplied `amount` tag is ignored
 *   4. the request targets this course's addressable coordinate
 *
 * Sum of verified receipts >= priceSats → CoursePurchase + Enrollment in
 * one transaction. Unique constraints make claims idempotent.
 */

import type { Event } from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools/filter';
import prisma from '../lib/prisma';
import { config } from '../config';
import { createNotification } from './notification.service';
import { decodeInvoice, firstTag, getLnurlPayMetadata, verifyZapReceipt, type DecodedInvoice } from './zapReceipt';

// Where they live now; imported from here before.
export { decodeInvoice, getLnurlPayMetadata } from './zapReceipt';
export type { DecodedInvoice, LnurlPayMetadata } from './zapReceipt';

const RELAY_QUERY_TIMEOUT_MS = 8000;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ReceiptVerifyContext {
    /** Course author's Nostr pubkey (the zap recipient). */
    authorPubkey: string;
    /** The claiming buyer's Nostr pubkey (must have signed the 9734). */
    buyerPubkey: string;
    /** The author's LNURL provider zapper key — the only valid receipt signer. */
    zapperPubkey: string;
    /** Addressable coordinates that count as "this course". */
    coordinates: Set<string>;
}

export interface ClaimResult {
    purchased: boolean;
    verifiedSats: number;
    priceSats: number;
    receiptsChecked: number;
}

// ─── Receipt verification (pure-ish core, decode injectable for tests) ──────

/**
 * Verify one kind-9735 receipt against the claim context. Returns the
 * verified amount in sats, or 0 if the receipt fails ANY check.
 */
export async function verifyZapReceiptForPurchase(
    receipt: Event,
    ctx: ReceiptVerifyContext,
    decode: (bolt11: string) => DecodedInvoice | null = decodeInvoice
): Promise<number> {
    try {
        // 1–3 (zapReceipt.ts): the zapper's signature, the request's, the invoice binding.
        const zap = await verifyZapReceipt(receipt, { zapperPubkey: ctx.zapperPubkey, recipientPubkey: ctx.authorPubkey }, decode);
        if (!zap) return 0;

        // The request was signed by the claiming buyer…
        if (zap.request.pubkey.toLowerCase() !== ctx.buyerPubkey.toLowerCase()) return 0;
        // …and targets this course's coordinate.
        const coordinate = firstTag(zap.request, 'a') ?? firstTag(receipt, 'a');
        if (!coordinate || !ctx.coordinates.has(coordinate)) return 0;

        return Number(zap.amountMsats / 1000n);
    } catch {
        return 0;
    }
}

// ─── Claim flow ──────────────────────────────────────────────────────────────

/** Course coordinates a zap may target: the 30004 list or any 30402 lesson teaser. */
export function courseCoordinates(
    authorPubkey: string,
    courseId: string,
    lessonIds: string[]
): Set<string> {
    const set = new Set<string>([`30004:${authorPubkey}:${courseId}`]);
    for (const lessonId of lessonIds) set.add(`30402:${authorPubkey}:${lessonId}`);
    return set;
}

/** Fetch candidate 9735 events from relays (indexer may not have seen them). */
async function fetchCandidateReceipts(
    zapperPubkey: string,
    authorPubkey: string,
    coordinates: Set<string>,
    knownEventIds: string[]
): Promise<Event[]> {
    const relays = [
        ...config.nostrRelays,
        config.nostrPublicRelay,
        config.nostrPrivateRelay,
    ].filter(Boolean);

    const filters: Filter[] = [
        {
            kinds: [9735],
            authors: [zapperPubkey],
            '#p': [authorPubkey],
            '#a': Array.from(coordinates),
            limit: 50,
        },
    ];
    if (knownEventIds.length > 0) {
        filters.push({ ids: knownEventIds.slice(0, 50) });
    }

    try {
        const { SimplePool } = await import('nostr-tools/pool');
        const pool = new SimplePool();
        const results = await Promise.all(
            filters.map((filter) =>
                pool
                    .querySync(relays, filter, { maxWait: RELAY_QUERY_TIMEOUT_MS })
                    .catch(() => [] as Event[])
            )
        );
        pool.destroy();
        const byId = new Map<string, Event>();
        for (const event of results.flat()) byId.set(event.id, event);
        return Array.from(byId.values());
    } catch {
        return [];
    }
}

/**
 * Verify the buyer's zaps for a course and create the purchase when the
 * verified total covers the price. Idempotent — an existing purchase is
 * returned as-is.
 */
export async function claimZapPurchase(userId: string, courseId: string): Promise<ClaimResult> {
    const course = await prisma.course.findUnique({
        where: { id: courseId },
        select: {
            id: true,
            title: true,
            authorId: true,
            priceSats: true,
            status: true,
            author: {
                select: { nostrPubkey: true, profile: { select: { lightningAddress: true } } },
            },
            lessons: { select: { id: true } },
        },
    });
    if (!course || course.status !== 'active') {
        throw Object.assign(new Error('Course not found'), { statusCode: 404 });
    }
    if (course.priceSats <= 0) {
        throw Object.assign(new Error('This course is free'), { statusCode: 400 });
    }
    if (course.authorId === userId) {
        throw Object.assign(new Error('You are the author of this course'), { statusCode: 400 });
    }

    const buyer = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, nostrPubkey: true, profile: { select: { name: true } } },
    });
    if (!buyer?.nostrPubkey) {
        throw Object.assign(new Error('No Nostr pubkey on your account'), { statusCode: 400 });
    }

    const existing = await prisma.coursePurchase.findUnique({
        where: { courseId_userId: { courseId, userId } },
    });
    if (existing) {
        return {
            purchased: true,
            verifiedSats: existing.amountSats,
            priceSats: course.priceSats,
            receiptsChecked: 0,
        };
    }

    const lightningAddress = course.author.profile?.lightningAddress || '';
    const lnurl = await getLnurlPayMetadata(lightningAddress);
    if (!lnurl?.allowsNostr || !lnurl.nostrPubkey) {
        throw Object.assign(
            new Error('The instructor\'s Lightning address does not support verifiable zaps'),
            { statusCode: 409 }
        );
    }

    const coordinates = courseCoordinates(
        course.author.nostrPubkey,
        course.id,
        course.lessons.map((l) => l.id)
    );

    // Candidates: receipts the indexer already matched to this course from
    // this buyer, plus a live relay sweep to close indexing races.
    const knownRows = await prisma.zapReceipt.findMany({
        where: { courseId, senderPubkey: buyer.nostrPubkey },
        select: { eventId: true },
        take: 50,
    });
    const candidates = await fetchCandidateReceipts(
        lnurl.nostrPubkey,
        course.author.nostrPubkey,
        coordinates,
        knownRows.map((r) => r.eventId)
    );

    const ctx: ReceiptVerifyContext = {
        authorPubkey: course.author.nostrPubkey,
        buyerPubkey: buyer.nostrPubkey,
        zapperPubkey: lnurl.nostrPubkey,
        coordinates,
    };

    let verifiedSats = 0;
    const usedReceiptIds: string[] = [];
    for (const receipt of candidates) {
        const sats = await verifyZapReceiptForPurchase(receipt, ctx);
        if (sats > 0) {
            verifiedSats += sats;
            usedReceiptIds.push(receipt.id);
        }
    }

    if (verifiedSats < course.priceSats) {
        return {
            purchased: false,
            verifiedSats,
            priceSats: course.priceSats,
            receiptsChecked: candidates.length,
        };
    }

    try {
        await prisma.$transaction([
            prisma.coursePurchase.create({
                data: {
                    courseId,
                    userId,
                    amountSats: verifiedSats,
                    method: 'ZAP',
                    zapReceiptIds: JSON.stringify(usedReceiptIds),
                },
            }),
            prisma.enrollment.upsert({
                where: { courseId_userId: { courseId, userId } },
                update: {},
                create: { courseId, userId },
            }),
        ]);
    } catch (error: any) {
        // Concurrent claim — the unique constraint means someone (us) won.
        if (error?.code !== 'P2002') throw error;
    }

    createNotification({
        userId: course.authorId,
        type: 'SYSTEM',
        title: 'Course purchased',
        body: `${buyer.profile?.name || 'A BIES member'} purchased "${course.title}" for ${verifiedSats.toLocaleString()} sats.`,
        data: { courseId },
    }).catch(() => {});
    createNotification({
        userId,
        type: 'SYSTEM',
        title: 'Course unlocked',
        body: `Your purchase of "${course.title}" is confirmed. Happy learning!`,
        data: { courseId },
    }).catch(() => {});

    return {
        purchased: true,
        verifiedSats,
        priceSats: course.priceSats,
        receiptsChecked: candidates.length,
    };
}

/**
 * Fire-and-forget hook for the zap indexer: when a receipt matched to a
 * course arrives from a known user without a purchase, try to auto-claim so
 * external-wallet payers unlock without pressing a button. Never throws.
 */
export async function attemptAutoClaim(senderPubkey: string, courseId: string): Promise<void> {
    try {
        const user = await prisma.user.findUnique({
            where: { nostrPubkey: senderPubkey },
            select: { id: true },
        });
        if (!user) return;
        const existing = await prisma.coursePurchase.findUnique({
            where: { courseId_userId: { courseId, userId: user.id } },
            select: { id: true },
        });
        if (existing) return;
        const result = await claimZapPurchase(user.id, courseId);
        if (result.purchased) {
            console.log(`[Courses] Auto-claimed purchase: course ${courseId} by ${senderPubkey.slice(0, 8)}...`);
        }
    } catch {
        // best-effort only
    }
}
