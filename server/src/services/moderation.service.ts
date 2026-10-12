/**
 * Reports and blocks: what App Store guideline 1.2 asks of an app whose
 * members publish things, and what the terms of use promise (§4, §6): Report
 * any profile, listing or recommendation, reviewed within 24 hours; Block to
 * stop seeing someone.
 *
 * Reports go into the queue moderators work in Admin → Reports, and an email
 * goes to the moderation address: at most 20 emails a day, so a flood of
 * reports can't use up the email quota sign-in codes depend on. One open
 * report per member per thing, at most 20 a day per member. A moderator
 * doesn't see reports about themselves; an admin does. Closed reports are
 * deleted after 12 months, as the privacy notice says.
 *
 * Blocks: the blocker stops seeing the blocked member's profile, listings,
 * recommendations and posts. Neither can follow or message the other, and a
 * follow between them ends.
 */

import prisma from '../lib/prisma';
import { config } from '../config';
import { sendEmail } from './email.service';
import { cache } from './redis.service';
import { nip19 } from 'nostr-tools';
import { verifyEvent, type Event as NostrEvent } from 'nostr-tools/pure';

export const REPORT_TARGETS = ['user', 'listing', 'endorsement', 'event', 'note'] as const;
export const REPORT_REASONS = [
    'harassment',
    'sexual',
    'violence_illegal',
    'scam_spam',
    'impersonation',
    'private_info',
    'fake_recommendation',
    'inaccurate_listing',
    'other',
] as const;
export const REPORT_STATUSES = ['OPEN', 'ACTIONED', 'DISMISSED'] as const;

export type ReportTarget = (typeof REPORT_TARGETS)[number];
export type ReportReason = (typeof REPORT_REASONS)[number];
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REASON_LABELS: Record<ReportReason, string> = {
    harassment: 'Harassment, threats or hate',
    sexual: 'Sexual content or nudity',
    violence_illegal: 'Violence or something illegal',
    scam_spam: 'Scam, fraud or spam',
    impersonation: 'Impersonation',
    private_info: "Someone's personal data shared without permission",
    fake_recommendation: 'Fake, paid or traded recommendation',
    inaccurate_listing: 'Listing is wrong, or listed without permission',
    other: 'Something else',
};

const MAX_REPORTS_PER_DAY = 20;
const MAX_MODERATION_EMAILS_PER_DAY = 20;
const MAX_DETAILS = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;
const CLOSED_REPORT_RETENTION_MS = 365 * DAY_MS;

// ─── Reports ──────────────────────────────────────────────────────────────────

/**
 * Who answers for the reported thing: its member's id, null when that isn't
 * a BIES member (a note from elsewhere on Nostr), undefined when there is no
 * such thing.
 */
async function responsibleMember(type: ReportTarget, id: string, pubkey?: string | null): Promise<string | null | undefined> {
    switch (type) {
        case 'user':
            return (await prisma.user.findFirst({ where: { id, deletedAt: null }, select: { id: true } }))?.id;
        case 'listing': {
            // Its linked member when staff entered it for them (directory.controller.ts listingMember).
            const listing = await prisma.directoryListing.findUnique({ where: { id }, select: { ownerId: true, memberUserId: true } });
            return listing ? listing.memberUserId ?? listing.ownerId : undefined;
        }
        case 'endorsement':
            return (await prisma.directoryEndorsement.findUnique({ where: { id }, select: { userId: true } }))?.userId;
        case 'event':
            return (await prisma.event.findUnique({ where: { id }, select: { hostId: true } }))?.hostId;
        case 'note': {
            if (!pubkey) return null;
            const author = await prisma.user.findUnique({ where: { nostrPubkey: pubkey }, select: { id: true } });
            return author?.id ?? null;
        }
    }
}

export type ReportInput = {
    targetType: ReportTarget;
    targetId: string;
    /**
     * For a note: the signed event itself, which proves who wrote it and
     * keeps its text for moderators (it may be deleted later).
     */
    event?: NostrEvent;
    reason: ReportReason;
    details?: string;
};

export type ReportResult =
    | { ok: true; reportId: string; duplicate: boolean }
    | { ok: false; reason: 'not_found' | 'own_content' | 'too_many' | 'bad_event' };

export async function createReport(reporterId: string, input: ReportInput): Promise<ReportResult> {
    let author: string | null = null;
    let snapshot = '';
    if (input.targetType === 'note') {
        const event = input.event;
        if (!event || event.id !== input.targetId || event.kind !== 1 || !verifyEvent(event)) {
            return { ok: false, reason: 'bad_event' };
        }
        author = event.pubkey;
        snapshot = event.content.slice(0, MAX_DETAILS);
    }

    const targetUserId = await responsibleMember(input.targetType, input.targetId, author);
    if (targetUserId === undefined) return { ok: false, reason: 'not_found' };
    if (targetUserId === reporterId) return { ok: false, reason: 'own_content' };

    const open = await prisma.report.findFirst({
        where: { reporterId, targetType: input.targetType, targetId: input.targetId, status: 'OPEN' },
        select: { id: true },
    });
    if (open) return { ok: true, reportId: open.id, duplicate: true };

    const today = await prisma.report.count({ where: { reporterId, createdAt: { gte: new Date(Date.now() - DAY_MS) } } });
    if (today >= MAX_REPORTS_PER_DAY) return { ok: false, reason: 'too_many' };

    const report = await prisma.report.create({
        data: {
            reporterId,
            targetType: input.targetType,
            targetId: input.targetId,
            targetUserId,
            targetPubkey: author,
            reason: input.reason,
            details: (input.details ?? '').trim().slice(0, MAX_DETAILS),
            snapshot,
        },
    });

    // Email the moderators, up to a daily cap; past it, reports wait in the queue.
    const reportsToday = await prisma.report.count({ where: { createdAt: { gte: new Date(Date.now() - DAY_MS) } } });
    if (reportsToday <= MAX_MODERATION_EMAILS_PER_DAY) {
        emailModerators(report.id, reportsToday === MAX_MODERATION_EMAILS_PER_DAY).catch((err) =>
            console.error('[Moderation] Report email failed:', err instanceof Error ? err.message : err));
    }
    return { ok: true, reportId: report.id, duplicate: false };
}

/**
 * What was reported, for people: a line, and where it is in the app (a path,
 * or a web link for a note). No link when it has been removed.
 */
async function describeTarget(type: string, id: string, pubkey: string | null, snapshot = ''): Promise<{ text: string; link: string | null }> {
    switch (type) {
        case 'user': {
            const profile = await prisma.profile.findUnique({ where: { userId: id }, select: { name: true } });
            return { text: `Member profile: ${profile?.name || '(no name)'}`, link: profile ? `/builder/${id}` : null };
        }
        case 'listing': {
            const listing = await prisma.directoryListing.findUnique({ where: { id }, select: { name: true } });
            return { text: `Directory listing: ${listing?.name ?? '(deleted)'}`, link: listing ? `/discover/certified/${id}` : null };
        }
        case 'endorsement': {
            const e = await prisma.directoryEndorsement.findUnique({
                where: { id },
                select: { comment: true, listingId: true, listing: { select: { name: true } } },
            });
            return e
                ? { text: `Recommendation on ${e.listing.name}: "${e.comment}"`, link: `/discover/certified/${e.listingId}` }
                : { text: 'Recommendation (deleted)', link: null };
        }
        case 'event': {
            const event = await prisma.event.findUnique({ where: { id }, select: { title: true } });
            return { text: `Event: ${event?.title ?? '(deleted)'}`, link: event ? `/events/${id}` : null };
        }
        default: {
            let link: string | null = null;
            try { link = `https://njump.me/${nip19.noteEncode(id)}`; } catch { /* not a note id */ }
            const quoted = snapshot ? `: "${snapshot.length > 280 ? `${snapshot.slice(0, 280)}…` : snapshot}"` : '';
            return { text: `Post${pubkey ? ` by ${nip19.npubEncode(pubkey).slice(0, 16)}…` : ''}${quoted}`, link };
        }
    }
}

async function emailModerators(reportId: string, lastToday = false): Promise<void> {
    const report = await prisma.report.findUnique({
        where: { id: reportId },
        include: { reporter: { select: { profile: { select: { name: true } } } } },
    });
    if (!report) return;
    const label = REASON_LABELS[report.reason as ReportReason] ?? report.reason;
    const what = (await describeTarget(report.targetType, report.targetId, report.targetPubkey, report.snapshot)).text;
    const link = `${config.appPublicUrl}/admin/reports`;
    const lines = [
        `New report on BIES: ${label}.`,
        what,
        `Details: ${report.details || '(none)'}`,
        `Reported by: ${report.reporter?.profile?.name || 'a member'}`,
        `Review it within 24 hours (terms of use §6): ${link}`,
        ...(lastToday ? [`That's ${MAX_MODERATION_EMAILS_PER_DAY} reports in 24 hours: no more emails today. New ones wait in the queue.`] : []),
    ];
    const escape = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    await sendEmail({
        to: config.email.moderationAddress,
        subject: `BIES report: ${label}`,
        text: lines.join('\n\n') + '\n',
        html: `<!doctype html><html><body style="font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a;background:#ffffff;padding:24px;">${lines
            .map((l) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.5;">${escape(l)}</p>`)
            .join('')}</body></html>`,
    });
}

type Moderator = { id: string; isAdmin: boolean };

/** A moderator never handles reports about themselves; an admin may. */
const visibleTo = (viewer: Moderator) =>
    viewer.isAdmin ? {} : { OR: [{ targetUserId: null }, { targetUserId: { not: viewer.id } }] };

export async function listReports({ status, page = 1, limit = 20, viewer }: { status?: ReportStatus; page?: number; limit?: number; viewer: Moderator }) {
    const where = { ...(status ? { status } : {}), ...visibleTo(viewer) };
    const [rows, total, open] = await Promise.all([
        prisma.report.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * limit,
            take: limit,
            include: {
                reporter: { select: { id: true, nostrPubkey: true, profile: { select: { name: true } } } },
                handledBy: { select: { id: true, profile: { select: { name: true } } } },
            },
        }),
        prisma.report.count({ where }),
        prisma.report.count({ where: { status: 'OPEN', ...visibleTo(viewer) } }),
    ]);
    const targetUserIds = [...new Set(rows.map((r) => r.targetUserId).filter((id): id is string => !!id))];
    const targetUsers = await prisma.user.findMany({
        where: { id: { in: targetUserIds } },
        select: { id: true, isBanned: true, deletedAt: true, nostrPubkey: true, profile: { select: { name: true } } },
    });
    const byId = new Map(targetUsers.map((u) => [u.id, u]));
    const targetUser = (id: string | null) => {
        if (!id) return null;
        const u = byId.get(id);
        return u
            ? { id: u.id, name: u.profile?.name ?? '', nostrPubkey: u.nostrPubkey, isBanned: u.isBanned, deleted: !!u.deletedAt }
            : { id, name: '', nostrPubkey: null, isBanned: false, deleted: true };
    };
    const reports = await Promise.all(rows.map(async (r) => {
        const { text, link } = await describeTarget(r.targetType, r.targetId, r.targetPubkey, r.snapshot);
        return {
            id: r.id,
            targetType: r.targetType,
            targetId: r.targetId,
            targetPubkey: r.targetPubkey,
            target: text,
            link,
            targetUser: targetUser(r.targetUserId),
            reason: r.reason,
            reasonLabel: REASON_LABELS[r.reason as ReportReason] ?? r.reason,
            details: r.details,
            status: r.status,
            resolution: r.resolution,
            reporter: r.reporter ? { id: r.reporter.id, name: r.reporter.profile?.name ?? '', nostrPubkey: r.reporter.nostrPubkey } : null,
            handledBy: r.handledBy ? { id: r.handledBy.id, name: r.handledBy.profile?.name ?? '' } : null,
            handledAt: r.handledAt,
            createdAt: r.createdAt,
        };
    }));
    return { reports, total, open, page, limit };
}

/** A moderator closes (or reopens) a report, with a note on what was done. */
export async function resolveReport(id: string, moderator: Moderator, status: ReportStatus, resolution: string): Promise<boolean> {
    const closing = status !== 'OPEN';
    const { count } = await prisma.report.updateMany({
        where: { id, ...visibleTo(moderator) },
        data: {
            status,
            resolution: resolution.trim().slice(0, MAX_DETAILS),
            handledById: closing ? moderator.id : null,
            handledAt: closing ? new Date() : null,
        },
    });
    return count > 0;
}

/** Whether a moderator may act on this report (not one about themselves, unless an admin). */
export async function canHandleReport(id: string, moderator: Moderator): Promise<boolean> {
    return !!(await prisma.report.findFirst({ where: { id, ...visibleTo(moderator) }, select: { id: true } }));
}

/** Closed reports leave after 12 months (privacy notice). */
export async function deleteOldReports(): Promise<number> {
    const { count } = await prisma.report.deleteMany({
        where: { status: { not: 'OPEN' }, handledAt: { lt: new Date(Date.now() - CLOSED_REPORT_RETENTION_MS) } },
    });
    return count;
}

// ─── Blocks ───────────────────────────────────────────────────────────────────

export type BlockResult = 'ok' | 'self' | 'not_found';

export async function blockMember(blockerId: string, blockedId: string): Promise<BlockResult> {
    if (blockerId === blockedId) return 'self';
    const target = await prisma.user.findFirst({ where: { id: blockedId, deletedAt: null }, select: { id: true } });
    if (!target) return 'not_found';
    await prisma.$transaction([
        prisma.block.upsert({
            where: { blockerId_blockedId: { blockerId, blockedId } },
            create: { blockerId, blockedId },
            update: {},
        }),
        // A follow between them ends, both ways.
        prisma.follow.deleteMany({
            where: {
                OR: [
                    { followerId: blockerId, followingId: blockedId },
                    { followerId: blockedId, followingId: blockerId },
                ],
            },
        }),
    ]);
    // The follower lists of both (follow.controller.ts busts the same keys).
    await Promise.all([blockerId, blockedId].flatMap((id) => [
        cache.del(`followers:${id}`),
        cache.del(`following:${id}`),
        cache.delPattern(`followers:${id}:`),
        cache.delPattern(`following:${id}:`),
    ])).catch(() => {});
    return 'ok';
}

export async function unblockMember(blockerId: string, blockedId: string): Promise<void> {
    await prisma.block.deleteMany({ where: { blockerId, blockedId } });
}

/** The members this member blocked: their content is hidden from them. */
export async function blockedIds(userId: string | null | undefined): Promise<string[]> {
    if (!userId) return [];
    const rows = await prisma.block.findMany({ where: { blockerId: userId }, select: { blockedId: true } });
    return rows.map((r) => r.blockedId);
}

/** Whether this member blocked another, known by id or by Nostr pubkey. */
export async function hasBlocked(blockerId: string, other: { id?: string; pubkey?: string }): Promise<boolean> {
    if (!other.id && !other.pubkey) return false;
    const found = await prisma.block.findFirst({
        where: {
            blockerId,
            blocked: other.id ? { id: other.id } : { nostrPubkey: other.pubkey },
        },
        select: { blockerId: true },
    });
    return !!found;
}

/** Whether either member blocked the other: they can't follow or message each other. */
export async function blockedEitherWay(a: string, b: string): Promise<boolean> {
    const found = await prisma.block.findFirst({
        where: { OR: [{ blockerId: a, blockedId: b }, { blockerId: b, blockedId: a }] },
        select: { blockerId: true },
    });
    return !!found;
}

export async function listBlocks(userId: string) {
    const rows = await prisma.block.findMany({
        where: { blockerId: userId },
        orderBy: { createdAt: 'desc' },
        select: {
            createdAt: true,
            blocked: { select: { id: true, nostrPubkey: true, profile: { select: { name: true, avatar: true } } } },
        },
    });
    return rows.map((r) => ({
        id: r.blocked.id,
        nostrPubkey: r.blocked.nostrPubkey,
        name: r.blocked.profile?.name ?? '',
        avatar: r.blocked.profile?.avatar ?? '',
        blockedAt: r.createdAt,
    }));
}
