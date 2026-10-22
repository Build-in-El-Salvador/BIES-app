import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { z } from 'zod';
import { prepareMedia, UnreadableMediaError } from '../services/mediaProcessing';
import { getPresignedUrl, privateFileKey, uploadPrivateFile } from '../services/storage.service';
import { discardUploadNames, recordUpload } from '../services/uploads.service';

const VALID_STATUSES = ['NEW', 'IN_REVIEW', 'FIXED', 'WONT_FIX', 'PLANNED', 'DUPLICATE', 'CLOSED'];
const VALID_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

/** What a screenshot can be sent as: what phones and browsers make of one. */
export const SCREENSHOT_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const short = (max: number) => z.string().trim().max(max).optional().catch(undefined);

// What the app sends with a report (src/utils/deviceInfo.js). Anything else
// in it is dropped, and a report whose details don't read still goes in.
const deviceSchema = z.object({
    platform: z.enum(['web', 'ios', 'android']).optional().catch(undefined),
    appVersion: short(20),
    build: short(20),
    userAgent: short(400),
    screen: short(40),
    language: short(10),
    path: short(200),
});

const parseDevice = (raw: unknown) => {
    if (typeof raw !== 'string' || raw.length > 2000) return {};
    try {
        return deviceSchema.parse(JSON.parse(raw));
    } catch {
        return {};
    }
};

// Sent as a form (multipart), with the screenshot as its file, if there is one.
export const submitFeedbackSchema = z.object({
    type: z.enum(['BUG', 'FEATURE', 'LOVE', 'GENERAL']).default('GENERAL'),
    message: z.string().trim().min(5, 'Message must be at least 5 characters').max(5000),
    // An id from the form's page list (src/config/feedbackPages.js).
    page: z.union([z.string().regex(/^[a-z][a-z-]{0,39}$/), z.literal('')]).default(''),
    device: z.string().optional().transform(parseDevice),
});

/**
 * POST /feedback (multipart: type, message, page, device, and file)
 * A member's report or feedback, with a screenshot if they add one. The
 * screenshot is shrunk and saved again without its metadata
 * (mediaProcessing.ts), kept as a private file only admins open, and
 * recorded as the member's: it goes with the report, or with their account.
 */
export async function submitFeedback(req: Request, res: Response): Promise<void> {
    let screenshot = '';
    try {
        const { type, message, page, device } = req.body as z.infer<typeof submitFeedbackSchema>;
        const userId = req.user!.id;

        if (req.file) {
            let media;
            try {
                media = await prepareMedia(req.file.buffer, req.file.mimetype);
            } catch (err) {
                if (err instanceof UnreadableMediaError) {
                    res.status(400).json({ error: 'That screenshot couldn\'t be read. Try a PNG or JPG', reason: 'unreadable' });
                    return;
                }
                throw err;
            }
            const stored = await uploadPrivateFile(media.buffer, media.mimeType);
            screenshot = stored.name;
            await recordUpload(userId, { name: stored.name, mimeType: media.mimeType, size: media.buffer.length, isPrivate: true });
        }

        const feedback = await prisma.feedback.create({
            data: { userId, type, message, page, screenshot, device: JSON.stringify(device) },
        });

        res.status(201).json({ message: 'Thank you for your feedback!', id: feedback.id });
    } catch (error) {
        console.error('Feedback submit error:', error);
        // A screenshot stored for a report that didn't go in.
        if (screenshot) await discardUploadNames([screenshot]);
        res.status(500).json({ error: 'Failed to submit feedback' });
    }
}

const USER_FIELDS = {
    select: {
        id: true,
        email: true,
        nostrPubkey: true,
        profile: { select: { name: true, avatar: true } },
    },
} as const;

/**
 * A report as admins see it: what the app sent with it, read, and a
 * 15-minute link to its screenshot.
 */
async function forAdmin<T extends { screenshot: string; device: string }>(item: T) {
    let device = {};
    try { device = JSON.parse(item.device); } catch { /* none */ }
    const screenshotUrl = item.screenshot ? await getPresignedUrl(privateFileKey(item.screenshot)) : null;
    return { ...item, device, screenshotUrl };
}

/**
 * GET /admin/feedback
 * List all feedback with filters (admin only).
 */
export async function listFeedback(req: Request, res: Response): Promise<void> {
    try {
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 30));
        const type = req.query.type as string || '';
        const status = req.query.status as string || '';
        const priority = req.query.priority as string || '';
        const search = req.query.search as string || '';
        // The page a report is about (`page` is the page of the list).
        const onPage = req.query.onPage as string || '';

        const where: any = {};
        if (type) where.type = type;
        if (onPage) where.page = onPage;
        if (status) where.status = status;
        if (priority) where.priority = priority;
        if (search) {
            where.OR = [
                { message: { contains: search } },
                { adminNote: { contains: search } },
            ];
        }

        const [data, total, counts] = await Promise.all([
            prisma.feedback.findMany({
                where,
                include: { user: USER_FIELDS },
                orderBy: [
                    { priority: 'asc' }, // URGENT first (alphabetical: HIGH, LOW, NORMAL, URGENT — we sort client-side)
                    { createdAt: 'desc' },
                ],
                skip: (page - 1) * limit,
                take: limit,
            }),
            prisma.feedback.count({ where }),
            // Summary counts for the dashboard header
            Promise.all([
                prisma.feedback.count({ where: { status: 'NEW' } }),
                prisma.feedback.count({ where: { status: 'IN_REVIEW' } }),
                prisma.feedback.count({ where: { status: 'FIXED' } }),
                prisma.feedback.count(),
            ]).then(([newCount, inReview, fixed, all]) => ({ new: newCount, inReview, fixed, all })),
        ]);

        res.json({
            data: await Promise.all(data.map(forAdmin)),
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
            counts,
        });
    } catch (error) {
        console.error('List feedback error:', error);
        res.status(500).json({ error: 'Failed to list feedback' });
    }
}

/**
 * PUT /admin/feedback/:id
 * Update feedback fields — status, priority, adminNote (admin only).
 */
export async function updateFeedback(req: Request, res: Response): Promise<void> {
    try {
        const { id } = req.params;
        const { status, priority, adminNote } = req.body;

        const data: any = {};

        if (status !== undefined) {
            if (!VALID_STATUSES.includes(status)) {
                res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
                return;
            }
            data.status = status;
            // Auto-set resolvedAt when marking as resolved
            if (['FIXED', 'WONT_FIX', 'DUPLICATE', 'CLOSED'].includes(status)) {
                data.resolvedAt = new Date();
            } else {
                data.resolvedAt = null;
            }
        }

        if (priority !== undefined) {
            if (!VALID_PRIORITIES.includes(priority)) {
                res.status(400).json({ error: `Invalid priority. Must be one of: ${VALID_PRIORITIES.join(', ')}` });
                return;
            }
            data.priority = priority;
        }

        if (adminNote !== undefined) {
            data.adminNote = adminNote;
        }

        if (Object.keys(data).length === 0) {
            res.status(400).json({ error: 'No fields to update' });
            return;
        }

        const feedback = await prisma.feedback.update({
            where: { id },
            data,
            include: { user: USER_FIELDS },
        });

        res.json(await forAdmin(feedback));
    } catch (error) {
        console.error('Update feedback error:', error);
        res.status(500).json({ error: 'Failed to update feedback' });
    }
}

/**
 * DELETE /admin/feedback/:id
 * Delete feedback (admin only), and its screenshot.
 */
export async function deleteFeedback(req: Request, res: Response): Promise<void> {
    try {
        const { screenshot } = await prisma.feedback.delete({ where: { id: req.params.id }, select: { screenshot: true } });
        if (screenshot) await discardUploadNames([screenshot]);
        res.json({ message: 'Feedback deleted' });
    } catch (error) {
        console.error('Delete feedback error:', error);
        res.status(500).json({ error: 'Failed to delete feedback' });
    }
}
