/**
 * Read only: lists projects whose raised total isn't what its investments and
 * zaps add up to, as the server adds them: the amount of every COMPLETED
 * investment (investment.controller.ts) plus the sats of every zap receipt
 * credited to the project (zap.service.ts). Nothing is written.
 *
 * A difference isn't always a fault: a project's member can type its raised
 * amount in the project form, and that number stands until an investment or
 * zap moves it.
 *
 * Then, about the zap receipts credited so far:
 *   - those whose recipient isn't the project's owner or on its team, or
 *     isn't the course's author (receipts are credited only to those now)
 *   - payments carried by more than one receipt (counted once now)
 *
 *   docker exec bies-bies-server-1 node dist/src/scripts/checkRaisedAmounts.js
 */
import prisma from '../lib/prisma';
import { decodeInvoice } from '../services/zapReceipt';

// Float sums: a cent's worth of rounding isn't a difference.
const TOLERANCE = 0.005;

async function main(): Promise<void> {
    const projects = await prisma.project.findMany({
        select: {
            id: true, title: true, raisedAmount: true,
            owner: { select: { nostrPubkey: true } },
            teamMembers: { select: { user: { select: { nostrPubkey: true } } } },
        },
        orderBy: { createdAt: 'asc' },
    });
    const investments = await prisma.investment.groupBy({
        by: ['projectId'], where: { status: 'COMPLETED' }, _sum: { amount: true }, _count: true,
    });
    const zaps = await prisma.zapReceipt.groupBy({
        by: ['projectId'], where: { projectId: { not: null } }, _sum: { amountSats: true }, _count: true,
    });
    const invested = new Map(investments.map((i) => [i.projectId, { sum: i._sum.amount ?? 0, count: i._count }]));
    const zapped = new Map(zaps.map((z) => [z.projectId as string, { sum: z._sum.amountSats ?? 0, count: z._count }]));

    let differ = 0;
    console.log(`[Raised] ${projects.length} project(s): raised total vs COMPLETED investments + credited zaps`);
    for (const p of projects) {
        const inv = invested.get(p.id) ?? { sum: 0, count: 0 };
        const zap = zapped.get(p.id) ?? { sum: 0, count: 0 };
        const expected = inv.sum + zap.sum;
        if (Math.abs(p.raisedAmount - expected) <= TOLERANCE) continue;
        differ++;
        console.log(
            `[Raised] ${p.id} "${p.title}": raised ${p.raisedAmount}, adds up to ${expected} ` +
            `(${inv.count} investment(s) ${inv.sum}, ${zap.count} zap(s) ${zap.sum} sats), difference ${p.raisedAmount - expected}`,
        );
    }
    console.log(`[Raised] ${differ} project(s) differ`);

    // Receipts credited to a project, or a course, the recipient isn't on.
    const members = new Map(projects.map((p) => [p.id, new Set([p.owner.nostrPubkey, ...p.teamMembers.map((t) => t.user.nostrPubkey)])]));
    const projectReceipts = await prisma.zapReceipt.findMany({
        where: { projectId: { not: null } },
        select: { eventId: true, projectId: true, recipientPubkey: true, amountSats: true },
    });
    let outside = 0;
    for (const r of projectReceipts) {
        if (!r.recipientPubkey) continue; // the recipient's account was deleted
        if (members.get(r.projectId as string)?.has(r.recipientPubkey)) continue;
        outside++;
        console.log(`[Zaps] receipt ${r.eventId}: ${r.amountSats} sats credited to project ${r.projectId}, paid to ${r.recipientPubkey.slice(0, 12)}…, not its owner or team`);
    }
    const courseReceipts = await prisma.zapReceipt.findMany({
        where: { courseId: { not: null } },
        select: { eventId: true, courseId: true, recipientPubkey: true, amountSats: true, course: { select: { author: { select: { nostrPubkey: true } } } } },
    });
    for (const r of courseReceipts) {
        if (!r.recipientPubkey || r.recipientPubkey === r.course?.author.nostrPubkey) continue;
        outside++;
        console.log(`[Zaps] receipt ${r.eventId}: ${r.amountSats} sats credited to course ${r.courseId}, paid to ${r.recipientPubkey.slice(0, 12)}…, not its author`);
    }
    console.log(`[Zaps] ${outside} receipt(s) credited to a project or course their recipient isn't on`);

    // One payment, more than one receipt: by payment hash, or the invoice's
    // for receipts stored before the hash was kept.
    const receipts = await prisma.zapReceipt.findMany({
        select: { eventId: true, paymentHash: true, bolt11: true, amountSats: true, projectId: true },
    });
    const byPayment = new Map<string, typeof receipts>();
    for (const r of receipts) {
        const payment = r.paymentHash ?? (r.bolt11 ? decodeInvoice(r.bolt11)?.paymentHashHex : null) ?? null;
        if (!payment) continue;
        byPayment.set(payment, [...(byPayment.get(payment) ?? []), r]);
    }
    let repeated = 0;
    for (const [payment, same] of byPayment) {
        if (same.length < 2) continue;
        repeated++;
        console.log(`[Zaps] payment ${payment.slice(0, 16)}… in ${same.length} receipts: ${same.map((r) => `${r.eventId} (${r.amountSats} sats${r.projectId ? `, project ${r.projectId}` : ''})`).join(', ')}`);
    }
    console.log(`[Zaps] ${repeated} payment(s) in more than one receipt`);
}

if (require.main === module) {
    main().then(async () => { await prisma.$disconnect(); process.exit(0); }, async (error) => {
        console.error('[Raised] stopped:', error);
        await prisma.$disconnect();
        process.exit(1);
    });
}
