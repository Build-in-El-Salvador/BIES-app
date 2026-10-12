/**
 * Zap Receipt Indexer — subscribes to kind:9735 events on public relays
 * and stores zap receipts in the database, updating project funding totals.
 */

// nostr-tools is ESM-only (@noble/curves has no CJS build);
// use dynamic import() so the compiled CJS output doesn't call require().
import type { Filter } from 'nostr-tools/filter';
import type { Event } from 'nostr-tools/pure';
import { config } from '../config';
import prisma from '../lib/prisma';
import { notifyZapReceived } from './notification.service';
import { matchBountyPayout } from './bounty.service';

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

async function processZapReceipt(event: Event): Promise<void> {
    const eventId = event.id;

    // Dedup — skip if already stored
    const existing = await prisma.zapReceipt.findUnique({
        where: { eventId },
    });
    if (existing) return;

    // Extract recipient pubkey from 'p' tag
    const pTag = event.tags.find((t) => t[0] === 'p');
    if (!pTag || !pTag[1]) return;
    const recipientPubkey = pTag[1];

    // Extract zapped event ID from 'e' tag
    const eTag = event.tags.find((t) => t[0] === 'e');
    const zappedEventId = eTag?.[1] || null;

    // Parse the kind:9734 zap request from the 'description' tag
    const descTag = event.tags.find((t) => t[0] === 'description');
    let senderPubkey = '';
    let comment = '';
    let requestATag: string | null = null;
    if (descTag?.[1]) {
        try {
            const zapRequest = JSON.parse(descTag[1]) as Event;
            senderPubkey = zapRequest.pubkey || '';
            comment = zapRequest.content || '';
            requestATag = zapRequest.tags?.find((t) => t[0] === 'a')?.[1] || null;
        } catch {
            // Malformed description — use event pubkey as fallback
            senderPubkey = event.pubkey;
        }
    } else {
        senderPubkey = event.pubkey;
    }

    // Parse amount from bolt11 or bolt12 tag, with amount tag as fallback
    const bolt11Tag = event.tags.find((t) => t[0] === 'bolt11');
    const bolt11 = bolt11Tag?.[1] || '';
    const bolt12Tag = event.tags.find((t) => t[0] === 'bolt12');
    const bolt12 = bolt12Tag?.[1] || '';

    let amountMsats: bigint;
    if (bolt11) {
        amountMsats = decodeBolt11Amount(bolt11);
    } else {
        // Bolt12 receipts or non-standard: use the 'amount' tag from the zap request
        const amountTag = event.tags.find((t) => t[0] === 'amount');
        amountMsats = amountTag?.[1] ? BigInt(amountTag[1]) : 0n;
    }
    if (amountMsats === 0n) return; // No valid amount

    const amountSats = Number(amountMsats / 1000n);

    // Match zapped event to a project
    let projectId: string | null = null;
    if (zappedEventId) {
        const project = await prisma.project.findFirst({
            where: { nostrEventId: zappedEventId },
            select: { id: true, title: true },
        });
        if (project) {
            projectId = project.id;
        }
    }

    // Match addressable-event zaps (a tag) to a course — display/attribution
    // only; entitlement verification happens in coursePurchase.service.
    const aTag = event.tags.find((t) => t[0] === 'a')?.[1] || requestATag;
    const courseId = aTag ? await resolveCourseFromCoordinate(aTag) : null;

    // Store the zap receipt
    const receipt = await prisma.zapReceipt.create({
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
            bolt12,
            // The zap's own timestamp — createdAt is insert time, which lies
            // for receipts backfilled via the `since` window after downtime.
            eventCreatedAt: new Date(event.created_at * 1000),
        },
    });

    // Fire-and-forget: a course zap from a known user may complete their
    // purchase (strictly verified inside the claim path). Lazy import breaks
    // the module cycle with coursePurchase.service.
    if (courseId && senderPubkey) {
        import('./coursePurchase.service.js')
            .then(({ attemptAutoClaim }) => attemptAutoClaim(senderPubkey, courseId))
            .catch(() => {});
    }

    // Increment project funding total
    if (projectId) {
        await prisma.project.update({
            where: { id: projectId },
            data: { raisedAmount: { increment: amountSats } },
        });
    }

    // Fire-and-forget: match this receipt against an awarded sats bounty.
    // Must never break zap indexing.
    matchBountyPayout(receipt).catch((err) => {
        console.error('[Zap Indexer] Bounty payout match failed:', err);
    });

    // Notify the recipient if they are a BIES user
    const recipientUser = await prisma.user.findUnique({
        where: { nostrPubkey: recipientPubkey },
        select: { id: true },
    });

    if (recipientUser) {
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
    }

    console.log(`[Zap Indexer] Stored zap: ${amountSats} sats → ${recipientPubkey.slice(0, 8)}...${projectId ? ` (project ${projectId})` : ''}`);
}

/**
 * Resolve an addressable coordinate (kind:pubkey:dTag) to a course id.
 * 30004 = the course curation set (d = course id); 30402 = a paid lesson
 * teaser (d = lesson id). The pubkey must match the course author.
 */
async function resolveCourseFromCoordinate(coordinate: string): Promise<string | null> {
    const parts = coordinate.split(':');
    if (parts.length !== 3) return null;
    const [kind, pubkey, dTag] = parts;
    if (!dTag || !/^[0-9a-f]{64}$/i.test(pubkey)) return null;

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

/**
 * Minimal bolt11 amount decoder.
 * Bolt11 invoices encode amount after 'ln' prefix and before the separator '1'.
 * Format: ln<network><amount><multiplier>1<data>
 * Multipliers: m = milli (10^-3), u = micro (10^-6), n = nano (10^-9), p = pico (10^-12)
 */
export function decodeBolt11Amount(bolt11: string): bigint {
    if (!bolt11) return 0n;

    const lower = bolt11.toLowerCase();
    // Match ln + network (bc/tb/tbs/bcrt) + amount + multiplier
    const match = lower.match(/^ln(?:bc|tb|tbs|bcrt)(\d+)([munp]?)1/);
    if (!match) return 0n;

    const num = BigInt(match[1]);
    const multiplier = match[2] || '';

    // Convert to msats (1 BTC = 100_000_000_000 msats)
    const BTC_TO_MSATS = 100_000_000_000n;
    switch (multiplier) {
        case 'm': return num * (BTC_TO_MSATS / 1_000n);       // milli-BTC
        case 'u': return num * (BTC_TO_MSATS / 1_000_000n);   // micro-BTC
        case 'n': return num * (BTC_TO_MSATS / 1_000_000_000n); // nano-BTC
        case 'p': return num / 10n;                             // pico-BTC (10 pico = 1 msat)
        default:  return num * BTC_TO_MSATS;                    // full BTC
    }
}
