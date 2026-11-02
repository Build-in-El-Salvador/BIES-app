/**
 * Zap Receipt Indexer — subscribes to kind:9735 events on public relays
 * and stores zap receipts in the database, updating project funding totals.
 * Only receipts that verify (zapReceipt.ts) are stored, so totals and bounty
 * payouts only ever follow real payments. A receipt is credited to a project
 * only when it pays the project's owner or a member of its team, and to a
 * course only when it pays the course's author; each payment is stored once.
 */

// nostr-tools is ESM-only (@noble/curves has no CJS build);
// use dynamic import() so the compiled CJS output doesn't call require().
import type { Filter } from 'nostr-tools/filter';
import type { Event } from 'nostr-tools/pure';
import { config } from '../config';
import prisma from '../lib/prisma';
import { notifyZapReceived } from './notification.service';
import { matchBountyPayout } from './bounty.service';
import { decodeInvoice, firstTag, getLnurlPayMetadata, verifyZapReceipt, type DecodedInvoice } from './zapReceipt';

let _pool: InstanceType<Awaited<typeof import('nostr-tools/pool')>['SimplePool']> | null = null;
async function getPool() {
    if (!_pool) {
        const { SimplePool } = await import('nostr-tools/pool');
        _pool = new SimplePool();
    }
    return _pool;
}

let activeSub: { close: () => void } | null = null;
let trackedPubkeys: Set<string> = new Set();

/**
 * Start the zap receipt indexer. Called once on server startup.
 * Subscribes to kind:9735 events where #p matches any BIES user pubkey.
 */
export async function startZapIndexer(): Promise<void> {
    try {
        const users = await prisma.user.findMany({
            select: { nostrPubkey: true },
        });

        trackedPubkeys = new Set(users.map((u) => u.nostrPubkey));

        if (trackedPubkeys.size === 0) {
            console.log('[Zap Indexer] No users to track, will start when users register');
            return;
        }

        subscribe();
        console.log(`[Zap Indexer] Started — tracking ${trackedPubkeys.size} pubkeys`);
    } catch (error) {
        console.error('[Zap Indexer] Failed to start:', error);
    }
}

/**
 * Refresh subscription when new users register.
 */
export async function refreshSubscription(): Promise<void> {
    try {
        const users = await prisma.user.findMany({
            select: { nostrPubkey: true },
        });

        const newPubkeys = new Set(users.map((u) => u.nostrPubkey));
        if (newPubkeys.size === trackedPubkeys.size) return;

        trackedPubkeys = newPubkeys;

        if (activeSub) {
            activeSub.close();
            activeSub = null;
        }

        if (trackedPubkeys.size > 0) {
            subscribe();
            console.log(`[Zap Indexer] Refreshed — tracking ${trackedPubkeys.size} pubkeys`);
        }
    } catch (error) {
        console.error('[Zap Indexer] Refresh failed:', error);
    }
}

/**
 * Get the total sats zapped to a project.
 */
export async function getProjectZapTotal(projectId: string): Promise<{
    totalSats: number;
    zapCount: number;
}> {
    const result = await prisma.zapReceipt.aggregate({
        where: { projectId },
        _sum: { amountSats: true },
        _count: true,
    });

    return {
        totalSats: result._sum.amountSats || 0,
        zapCount: result._count,
    };
}

// ─── Internal ────────────────────────────────────────────────────────────────

async function subscribe(): Promise<void> {
    const pubkeys = Array.from(trackedPubkeys);

    const filter: Filter = {
        kinds: [9735],
        '#p': pubkeys,
        since: Math.floor(Date.now() / 1000) - 86400, // last 24h on first connect
    };

    const pool = await getPool();
    activeSub = pool.subscribeMany(config.nostrRelays, filter, {
        onevent: (event: Event) => {
            processZapReceipt(event).catch((err) =>
                console.error('[Zap Indexer] Process error:', err)
            );
        },
        oneose: () => {
            console.log('[Zap Indexer] Caught up with relay history');
        },
    });
}

/** Store one kind-9735 receipt from the relays, if it verifies. Exported for tests (`decode` too). */
export async function processZapReceipt(event: Event, decode: (bolt11: string) => DecodedInvoice | null = decodeInvoice): Promise<void> {
    const eventId = event.id;

    // Dedup — skip if already stored
    const existing = await prisma.zapReceipt.findUnique({
        where: { eventId },
    });
    if (existing) return;

    // Only a receipt signed by its recipient's Lightning provider, for an
    // invoice bound to the zap request inside it, is stored or counted
    // (zapReceipt.ts). Anything else is ignored.
    const recipientPubkey = firstTag(event, 'p');
    if (!recipientPubkey) return;
    const recipientUser = await prisma.user.findUnique({
        where: { nostrPubkey: recipientPubkey },
        select: { id: true, profile: { select: { lightningAddress: true } } },
    });
    if (!recipientUser) return;
    const lnurl = await getLnurlPayMetadata(recipientUser.profile?.lightningAddress || '');
    if (!lnurl?.allowsNostr || !lnurl.nostrPubkey) return;
    const zap = await verifyZapReceipt(event, { zapperPubkey: lnurl.nostrPubkey, recipientPubkey }, decode);
    if (!zap) return;

    // Who paid, what they said and what they zapped: from their signed request.
    const { request } = zap;
    const senderPubkey = request.pubkey;
    const comment = request.content || '';
    const zappedEventId = firstTag(request, 'e');
    const requestATag = firstTag(request, 'a');
    const bolt11 = firstTag(event, 'bolt11') || '';
    // The invoice's amount.
    const amountMsats = zap.amountMsats;
    const amountSats = Number(amountMsats / 1000n);
    if (amountSats <= 0) return;

    // One payment, one receipt: another receipt for a payment already stored
    // isn't stored or counted. Receipts stored before payment hashes were
    // kept have their invoice to go by.
    const samePayment = await prisma.zapReceipt.findFirst({
        where: { OR: [{ paymentHash: zap.paymentHash }, ...(bolt11 ? [{ bolt11 }] : [])] },
        select: { id: true },
    });
    if (samePayment) return;

    // The zapped event is a project's note, and the zap pays its owner or a
    // member of its team (a zap can be split among them).
    let projectId: string | null = null;
    if (zappedEventId) {
        const project = await prisma.project.findFirst({
            where: {
                nostrEventId: zappedEventId,
                OR: [{ ownerId: recipientUser.id }, { teamMembers: { some: { userId: recipientUser.id } } }],
            },
            select: { id: true },
        });
        if (project) {
            projectId = project.id;
        }
    }

    // Match addressable-event zaps (a tag) to a course of the recipient's —
    // display/attribution only; entitlement verification happens in
    // coursePurchase.service.
    const aTag = requestATag || firstTag(event, 'a');
    const courseId = aTag ? await resolveCourseFromCoordinate(aTag, recipientPubkey) : null;

    // Store the zap receipt, and count it towards its project, together.
    let receipt;
    try {
        receipt = await prisma.$transaction(async (tx) => {
            const stored = await tx.zapReceipt.create({
                data: {
                    eventId,
                    senderPubkey,
                    recipientPubkey,
                    amountMsats,
                    amountSats,
                    comment,
                    zappedEventId,
                    projectId,
                    courseId,
                    bolt11,
                    paymentHash: zap.paymentHash,
                    // The zap's own timestamp — createdAt is insert time, which lies
                    // for receipts backfilled via the `since` window after downtime.
                    eventCreatedAt: new Date(event.created_at * 1000),
                },
            });
            if (projectId) {
                await tx.project.update({
                    where: { id: projectId },
                    data: { raisedAmount: { increment: amountSats } },
                });
            }
            return stored;
        });
    } catch (error: any) {
        // The same receipt or payment, stored meanwhile (relays send one
        // receipt several times): it counts once.
        if (error?.code === 'P2002') return;
        throw error;
    }

    // Fire-and-forget: a course zap from a known user may complete their
    // purchase (strictly verified inside the claim path). Receipts arriving
    // together make one check (scheduleAutoClaim). Lazy import breaks the
    // module cycle with coursePurchase.service.
    if (courseId && senderPubkey) {
        import('./coursePurchase.service.js')
            .then(({ scheduleAutoClaim }) => scheduleAutoClaim(senderPubkey, courseId))
            .catch(() => {});
    }

    // Fire-and-forget: match this receipt against an awarded sats bounty.
    // Must never break zap indexing.
    matchBountyPayout(receipt).catch((err) => {
        console.error('[Zap Indexer] Bounty payout match failed:', err);
    });

    // Notify the recipient
    let projectTitle: string | undefined;
    if (projectId) {
        const project = await prisma.project.findUnique({
            where: { id: projectId },
            select: { title: true },
        });
        projectTitle = project?.title;
    }
    await notifyZapReceived({
        recipientUserId: recipientUser.id,
        senderPubkey,
        amountSats,
        comment: comment || undefined,
        projectId: projectId || undefined,
        projectTitle,
    });

    console.log(`[Zap Indexer] Stored zap: ${amountSats} sats → ${recipientPubkey.slice(0, 8)}...${projectId ? ` (project ${projectId})` : ''}`);
}

/**
 * Resolve an addressable coordinate (kind:pubkey:dTag) to a course id.
 * 30004 = the course curation set (d = course id); 30402 = a paid lesson
 * teaser (d = lesson id). The pubkey must be the zap's recipient and the
 * course's author.
 */
async function resolveCourseFromCoordinate(coordinate: string, recipientPubkey: string): Promise<string | null> {
    const parts = coordinate.split(':');
    if (parts.length !== 3) return null;
    const [kind, pubkey, dTag] = parts;
    if (!dTag || !/^[0-9a-f]{64}$/i.test(pubkey)) return null;
    if (pubkey !== recipientPubkey) return null;

    if (kind === '30004') {
        const course = await prisma.course.findUnique({
            where: { id: dTag },
            select: { id: true, author: { select: { nostrPubkey: true } } },
        });
        return course && course.author.nostrPubkey === pubkey ? course.id : null;
    }
    if (kind === '30402') {
        const lesson = await prisma.lesson.findUnique({
            where: { id: dTag },
            select: { courseId: true, course: { select: { author: { select: { nostrPubkey: true } } } } },
        });
        return lesson && lesson.course.author.nostrPubkey === pubkey ? lesson.courseId : null;
    }
    return null;
}
