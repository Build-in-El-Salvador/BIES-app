/**
 * Courses controller — Nostr-integrated LMS (courses → ordered lessons).
 *
 * Server-first: the DB is authoritative; Nostr mirroring (kind 30004/30023/
 * 30402) is best-effort and wired at the marked seams. Paid lesson content
 * is only ever released through the entitlement-gated `getLesson`.
 */

import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { z } from 'zod';
import { cache, cacheKey, TTL } from '../services/redis.service';
import { createNotification } from '../services/notification.service';
import { config } from '../config';
import {
    gradeQuiz,
    serializeCourse,
    serializeLessonMeta,
    sanitizeLessonForLearner,
    canAccessLesson,
    checkCourseCompletion,
    QuizContent,
    QuizAnswerKey,
} from '../services/courses.service';
import { claimZapPurchase } from '../services/coursePurchase.service';
import { mirrorCourseToNostr, unpublishCourseFromNostr } from '../services/courses.service';
import { nestedProfileForViewer } from '../services/profilePrivacy';

// ─── Constants / helpers ─────────────────────────────────────────────────────

const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

const QUIZ_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const QUIZ_ATTEMPTS_PER_WINDOW = 5;

// Course staff powers (any course's drafts, edits, deletion and paid lessons)
// are admin-only: moderators handle reports and the directory.
function isCourseAdmin(req: Request): boolean {
    return Boolean(req.user?.isAdmin);
}

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

function getCanonicalBaseUrl(): string {
    const origin = config.corsOrigin.split(',')[0].trim().replace(/\/$/, '');
    return origin || 'https://bies.app';
}

/** YouTube/Vimeo embeds or direct https .mp4/.webm (incl. local /uploads). */
const EMBED_HOST_RE = /^https:\/\/(www\.)?(youtube\.com|youtu\.be|youtube-nocookie\.com|vimeo\.com|player\.vimeo\.com)\//i;
const DIRECT_VIDEO_RE = /^(https:\/\/\S+\.(mp4|webm)(\?\S*)?|\/uploads\/\S+\.(mp4|webm))$/i;

export function isAllowedVideoUrl(url: string): boolean {
    return EMBED_HOST_RE.test(url) || DIRECT_VIDEO_RE.test(url);
}

// ─── Validation ──────────────────────────────────────────────────────────────

export const createCourseSchema = z.object({
    title: z.string().min(1).max(200),
    summary: z.string().max(300).optional(),
    description: z.string().max(50_000).optional(),
    category: z
        .enum(['BITCOIN', 'LIGHTNING', 'NOSTR', 'FINTECH', 'BUSINESS', 'TECHNOLOGY', 'OTHER'])
        .default('OTHER'),
    level: z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED']).default('BEGINNER'),
    format: z.enum(['SELF_PACED', 'VIDEO', 'LIVE', 'TEXT', 'WORKSHOP']).default('SELF_PACED'),
    coverImage: z.string().max(500).optional().or(z.literal('')),
    tags: z.array(z.string().max(40)).max(10).optional(),
    priceSats: z.number().int().min(0).max(100_000_000).default(0),
    nostrPublish: z.enum(['none', 'bies', 'public', 'both']).default('bies'),
});

// Every field optional, and a field left out stays out: in zod 4, .partial()
// still fills in .default() values, which would reset what an edit didn't send.
export const updateCourseSchema = createCourseSchema.partial().extend({
    category: createCourseSchema.shape.category.removeDefault().optional(),
    level: createCourseSchema.shape.level.removeDefault().optional(),
    format: createCourseSchema.shape.format.removeDefault().optional(),
    priceSats: createCourseSchema.shape.priceSats.removeDefault().optional(),
    nostrPublish: createCourseSchema.shape.nostrPublish.removeDefault().optional(),
});

const quizQuestionSchema = z
    .object({
        prompt: z.string().min(1).max(1000),
        options: z.array(z.string().min(1).max(300)).min(2).max(6),
        correctIndex: z.number().int().min(0),
    })
    .refine((q) => q.correctIndex < q.options.length, {
        message: 'correctIndex out of range',
    });

export const lessonSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('VIDEO'),
        title: z.string().min(1).max(200),
        videoUrl: z.string().max(1000).refine(isAllowedVideoUrl, {
            message: 'Video URL must be a YouTube/Vimeo link or a direct https .mp4/.webm file',
        }),
        caption: z.string().max(2000).optional(),
        durationSec: z.number().int().min(0).max(86_400).optional().nullable(),
        isFreePreview: z.boolean().optional(),
    }),
    z.object({
        type: z.literal('TEXT'),
        title: z.string().min(1).max(200),
        markdown: z.string().min(1).max(100_000),
        durationSec: z.number().int().min(0).max(86_400).optional().nullable(),
        isFreePreview: z.boolean().optional(),
    }),
    z.object({
        type: z.literal('QUIZ'),
        title: z.string().min(1).max(200),
        passPct: z.number().int().min(1).max(100).default(70),
        questions: z.array(quizQuestionSchema).min(1).max(50),
        durationSec: z.number().int().min(0).max(86_400).optional().nullable(),
        isFreePreview: z.boolean().optional(),
    }),
]);

export const createLessonSchema = lessonSchema;
export const updateLessonSchema = lessonSchema;

export const reorderLessonsSchema = z.object({
    order: z.array(z.string().regex(SAFE_ID_RE)).min(1).max(200),
});

export const progressSchema = z.object({
    completed: z.literal(true),
    meta: z.record(z.string(), z.unknown()).optional(),
});

export const quizSubmitSchema = z.object({
    answers: z.record(z.string().max(20), z.number().int().min(0).max(20)),
});

export const nostrRefsSchema = z.object({
    courseEventId: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    lessons: z
        .array(
            z.object({
                lessonId: z.string().regex(SAFE_ID_RE),
                eventId: z.string().regex(/^[0-9a-f]{64}$/),
            })
        )
        .max(200)
        .optional(),
});

/**
 * Split a validated lesson body into DB columns. Quiz answers go to the
 * server-only `quizAnswerKey` column; `content` stays learner-safe.
 */
function lessonBodyToColumns(body: z.infer<typeof lessonSchema>): {
    title: string;
    type: string;
    content: string;
    quizAnswerKey: string | null;
    durationSec: number | null;
    isFreePreview: boolean;
} {
    const base = {
        title: body.title,
        type: body.type,
        durationSec: body.durationSec ?? null,
        isFreePreview: body.isFreePreview ?? false,
    };
    if (body.type === 'VIDEO') {
        return {
            ...base,
            content: JSON.stringify({ videoUrl: body.videoUrl, caption: body.caption ?? '' }),
            quizAnswerKey: null,
        };
    }
    if (body.type === 'TEXT') {
        return {
            ...base,
            content: JSON.stringify({ markdown: body.markdown }),
            quizAnswerKey: null,
        };
    }
    // QUIZ — deterministic server-assigned question ids.
    const questions = body.questions.map((q, i) => ({
        id: `q${i}`,
        prompt: q.prompt,
        options: q.options,
    }));
    const answerKey: QuizAnswerKey = {};
    body.questions.forEach((q, i) => {
        answerKey[`q${i}`] = q.correctIndex;
    });
    return {
        ...base,
        content: JSON.stringify({ passPct: body.passPct, questions }),
        quizAnswerKey: JSON.stringify(answerKey),
    };
}

/**
 * Author edits to an ACTIVE course go back through moderation; staff edits
 * do not. Returns the status patch to merge into the update.
 */
function moderationResetPatch(
    course: { status: string },
    req: Request
): { status?: string } {
    if (course.status === 'active' && !isCourseAdmin(req)) {
        return { status: 'pending-review' };
    }
    return {};
}

async function invalidateCourseCache(): Promise<void> {
    await cache.delPattern('courses:');
}

/** Author/staff guard shared by all authoring endpoints. */
async function loadOwnedCourse(
    req: Request,
    res: Response,
    select: Record<string, boolean> = {}
): Promise<{ id: string; authorId: string; status: string; [key: string]: unknown } | null> {
    const course = await prisma.course.findUnique({
        where: { id: req.params.id },
        select: { id: true, authorId: true, status: true, ...select },
    });
    if (!course) {
        res.status(404).json({ error: 'Course not found' });
        return null;
    }
    if (course.authorId !== req.user!.id && !isCourseAdmin(req)) {
        res.status(403).json({ error: 'Not authorized' });
        return null;
    }
    return course;
}

// ─── Catalog / detail ────────────────────────────────────────────────────────

/**
 * GET /courses
 * Public catalog — active, published courses. Metadata only.
 */
export async function listCourses(req: Request, res: Response): Promise<void> {
    try {
        const { category, level, priced, search, sort, page = '1', limit = '20' } = req.query;
        const skip = (parseInt(page as string, 10) - 1) * parseInt(limit as string, 10);
        const take = Math.min(parseInt(limit as string, 10), 50);

        const cKey = cacheKey.courses({
            category: (category as string) || '',
            level: (level as string) || '',
            priced: (priced as string) || '',
            search: (search as string) || '',
            sort: (sort as string) || '',
            page: page as string,
            limit: limit as string,
        });
        const cached = await cache.getJson<any>(cKey);
        if (cached) {
            res.json(cached);
            return;
        }

        const where: any = { status: 'active', isPublished: true };
        if (category && typeof category === 'string') where.category = category.toUpperCase();
        if (level && typeof level === 'string') where.level = level.toUpperCase();
        if (priced === 'free') where.priceSats = 0;
        if (priced === 'paid') where.priceSats = { gt: 0 };
        if (search && typeof search === 'string') {
            where.OR = [
                { title: { contains: search } },
                { summary: { contains: search } },
                { description: { contains: search } },
            ];
        }

        const orderBy: any =
            sort === 'popular'
                ? [{ isFeatured: 'desc' }, { viewCount: 'desc' }]
                : [{ isFeatured: 'desc' }, { createdAt: 'desc' }];

        const [courses, total] = await Promise.all([
            prisma.course.findMany({
                where,
                orderBy,
                skip,
                take,
                select: {
                    id: true,
                    title: true,
                    summary: true,
                    category: true,
                    level: true,
                    format: true,
                    coverImage: true,
                    tags: true,
                    priceSats: true,
                    isFeatured: true,
                    viewCount: true,
                    createdAt: true,
                    author: {
                        select: {
                            id: true,
                            nostrPubkey: true,
                            profile: { select: { name: true, avatar: true } },
                        },
                    },
                    _count: { select: { lessons: true, enrollments: true } },
                },
            }),
            prisma.course.count({ where }),
        ]);

        const result = {
            data: courses.map((c) => ({
                ...serializeCourse(c),
                lessonCount: c._count.lessons,
                studentCount: c._count.enrollments,
            })),
            pagination: {
                page: parseInt(page as string, 10),
                limit: take,
                total,
                totalPages: Math.ceil(total / take),
            },
        };

        await cache.setJson(cKey, result, TTL.EVENT_LIST);
        res.json(result);
    } catch (error) {
        console.error('List courses error:', error);
        res.status(500).json({ error: 'Failed to list courses' });
    }
}

/**
 * GET /courses/my
 * Author's own courses, all statuses.
 */
export async function listMyCourses(req: Request, res: Response): Promise<void> {
    try {
        const courses = await prisma.course.findMany({
            where: { authorId: req.user!.id },
            orderBy: { createdAt: 'desc' },
            include: { _count: { select: { lessons: true, enrollments: true } } },
        });
        res.json({
            data: courses.map((c) => ({
                ...serializeCourse(c),
                lessonCount: c._count.lessons,
                studentCount: c._count.enrollments,
            })),
        });
    } catch (error) {
        console.error('List my courses error:', error);
        res.status(500).json({ error: 'Failed to list your courses' });
    }
}

/**
 * GET /courses/enrolled
 * Current user's enrollments with progress summary.
 */
export async function listEnrolledCourses(req: Request, res: Response): Promise<void> {
    try {
        const enrollments = await prisma.enrollment.findMany({
            where: { userId: req.user!.id },
            orderBy: { createdAt: 'desc' },
            include: {
                course: {
                    select: {
                        id: true,
                        title: true,
                        summary: true,
                        category: true,
                        level: true,
                        coverImage: true,
                        tags: true,
                        priceSats: true,
                        status: true,
                        author: {
                            select: { id: true, profile: { select: { name: true, avatar: true } } },
                        },
                        _count: { select: { lessons: true } },
                    },
                },
                _count: { select: { progress: true } },
            },
        });

        res.json({
            data: enrollments.map((e) => ({
                ...serializeCourse(e.course),
                lessonCount: e.course._count.lessons,
                completedLessons: e._count.progress,
                enrolledAt: e.createdAt,
                completedAt: e.completedAt,
                certificateEventId: e.certificateEventId,
            })),
        });
    } catch (error) {
        console.error('List enrolled courses error:', error);
        res.status(500).json({ error: 'Failed to list enrolled courses' });
    }
}

/**
 * GET /courses/:id
 * Course detail + ordered lesson METADATA (no content, no answer keys).
 * Draft/pending/rejected courses are 404 for everyone but author/staff.
 */
export async function getCourse(req: Request, res: Response): Promise<void> {
    try {
        const course = await prisma.course.findUnique({
            where: { id: req.params.id },
            include: {
                author: {
                    select: {
                        id: true,
                        nostrPubkey: true,
                        profile: {
                            select: { name: true, avatar: true, lightningAddress: true, privacy: true },
                        },
                    },
                },
                lessons: {
                    orderBy: { position: 'asc' },
                    select: {
                        id: true,
                        title: true,
                        type: true,
                        position: true,
                        durationSec: true,
                        isFreePreview: true,
                        nostrEventId: true,
                    },
                },
                _count: { select: { enrollments: true } },
            },
        });

        if (!course) {
            res.status(404).json({ error: 'Course not found' });
            return;
        }

        const userId = req.user?.id ?? null;
        const isOwner = userId === course.authorId;
        if (course.status !== 'active' && !isOwner && !isCourseAdmin(req)) {
            res.status(404).json({ error: 'Course not found' });
            return;
        }

        // Viewer-specific enrollment/purchase summary
        let myEnrollment: Record<string, unknown> | null = null;
        let purchased = false;
        if (userId) {
            const [enrollment, purchase] = await Promise.all([
                prisma.enrollment.findUnique({
                    where: { courseId_userId: { courseId: course.id, userId } },
                    include: { progress: { select: { lessonId: true } } },
                }),
                prisma.coursePurchase.findUnique({
                    where: { courseId_userId: { courseId: course.id, userId } },
                    select: { id: true, amountSats: true, createdAt: true },
                }),
            ]);
            purchased = Boolean(purchase);
            if (enrollment) {
                myEnrollment = {
                    enrolledAt: enrollment.createdAt,
                    completedAt: enrollment.completedAt,
                    certificateEventId: enrollment.certificateEventId,
                    completedLessonIds: enrollment.progress.map((p) => p.lessonId),
                };
            }
        }

        // Fire-and-forget view count (not for the author's own visits)
        if (!isOwner) {
            prisma.course
                .update({ where: { id: course.id }, data: { viewCount: { increment: 1 } } })
                .catch(() => {});
        }

        const { lessons, _count, ...courseFields } = course;
        res.json({
            // The author's Lightning address as their Settings → Privacy allows.
            ...serializeCourse({ ...courseFields, author: nestedProfileForViewer(courseFields.author, req.user?.id) ?? courseFields.author }),
            lessons: lessons.map(serializeLessonMeta),
            lessonCount: lessons.length,
            studentCount: _count.enrollments,
            enrolled: Boolean(myEnrollment),
            purchased,
            myEnrollment,
        });
    } catch (error) {
        console.error('Get course error:', error);
        res.status(500).json({ error: 'Failed to get course' });
    }
}

/**
 * GET /courses/:id/og
 * OG meta page for link previews (no auth — crawlers can't send tokens).
 */
export async function getCourseOG(req: Request, res: Response): Promise<void> {
    const rawId = req.params.id;
    if (!rawId || !SAFE_ID_RE.test(rawId)) {
        res.status(400).json({ error: 'Invalid course ID' });
        return;
    }

    const baseUrl = getCanonicalBaseUrl();
    const courseUrl = `${baseUrl}/courses/${rawId}`;
    let ogTitle = 'BIES | Build in El Salvador';
    let ogDescription = 'Learn from the BIES community';
    let ogImage = `${baseUrl}/icons/icon-512.png`;

    try {
        const course = await prisma.course.findUnique({
            where: { id: rawId },
            select: {
                title: true,
                summary: true,
                coverImage: true,
                status: true,
                isPublished: true,
                author: { select: { profile: { select: { name: true } } } },
            },
        });
        if (course && course.status === 'active' && course.isPublished) {
            ogTitle = escapeHtml(course.title.slice(0, 70));
            const parts: string[] = [];
            if (course.summary) parts.push(escapeHtml(course.summary.slice(0, 150)));
            if (course.author?.profile?.name) {
                parts.push(`By ${escapeHtml(course.author.profile.name)}`);
            }
            if (parts.length > 0) ogDescription = parts.join(' · ');
            if (course.coverImage) {
                const url = course.coverImage.startsWith('http')
                    ? course.coverImage
                    : `${baseUrl}${course.coverImage}`;
                ogImage = escapeHtml(url);
            }
        }
    } catch (error) {
        console.error('Course OG fetch error:', error);
    }

    res.set('Cache-Control', 'public, max-age=600');
    res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta property="og:title" content="${ogTitle}" />
  <meta property="og:description" content="${ogDescription}" />
  <meta property="og:image" content="${ogImage}" />
  <meta property="og:url" content="${courseUrl}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="BIES" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${ogTitle}" />
  <meta name="twitter:description" content="${ogDescription}" />
  <meta name="twitter:image" content="${ogImage}" />
  <meta http-equiv="refresh" content="0;url=/courses/${rawId}" />
  <title>${ogTitle}</title>
</head>
<body>
  <p>Redirecting to <a href="/courses/${rawId}">${ogTitle}</a>&hellip;</p>
  <script>window.location.replace("/courses/${rawId}");</script>
</body>
</html>`);
}

// ─── Authoring ───────────────────────────────────────────────────────────────

/**
 * POST /courses
 * Create a draft course. Any member may author (moderated before publish).
 */
export async function createCourse(req: Request, res: Response): Promise<void> {
    try {
        const body = req.body as z.infer<typeof createCourseSchema>;
        const course = await prisma.course.create({
            data: {
                authorId: req.user!.id,
                title: body.title,
                summary: body.summary ?? '',
                description: body.description ?? '',
                category: body.category,
                level: body.level,
                format: body.format,
                coverImage: body.coverImage ?? '',
                tags: JSON.stringify(body.tags ?? []),
                priceSats: body.priceSats,
                nostrPublish: body.nostrPublish,
                status: 'draft',
            },
        });
        res.status(201).json(serializeCourse(course));
    } catch (error) {
        console.error('Create course error:', error);
        res.status(500).json({ error: 'Failed to create course' });
    }
}

/**
 * PUT /courses/:id
 * Author/staff update via allowlisted fields. Author edits to an active
 * course reset it to pending-review (moderation integrity).
 */
export async function updateCourse(req: Request, res: Response): Promise<void> {
    try {
        const existing = await loadOwnedCourse(req, res);
        if (!existing) return;

        const body = req.body as z.infer<typeof updateCourseSchema>;
        const data: any = {};
        for (const field of [
            'title',
            'summary',
            'description',
            'category',
            'level',
            'format',
            'coverImage',
            'priceSats',
            'nostrPublish',
        ] as const) {
            if (body[field] !== undefined) data[field] = body[field];
        }
        if (body.tags !== undefined) data.tags = JSON.stringify(body.tags);
        Object.assign(data, moderationResetPatch(existing, req));

        const course = await prisma.course.update({ where: { id: existing.id }, data });
        await invalidateCourseCache();

        // Staff edits keep the course active — refresh the Nostr mirror
        // (replaceable events, same d-tags). Author edits went back to
        // pending-review and re-mirror on re-approval instead.
        if (course.status === 'active') {
            mirrorCourseToNostr(course.id).catch(() => {});
        }
        res.json(serializeCourse(course));
    } catch (error) {
        console.error('Update course error:', error);
        res.status(500).json({ error: 'Failed to update course' });
    }
}

/**
 * DELETE /courses/:id
 * Author/staff delete.
 */
export async function deleteCourse(req: Request, res: Response): Promise<void> {
    try {
        const existing = await loadOwnedCourse(req, res, { nostrEventId: true, nostrPublish: true });
        if (!existing) return;

        await unpublishCourseFromNostr(existing.id);
        await prisma.course.delete({ where: { id: existing.id } });
        await invalidateCourseCache();
        res.json({ message: 'Course deleted' });
    } catch (error) {
        console.error('Delete course error:', error);
        res.status(500).json({ error: 'Failed to delete course' });
    }
}

/**
 * POST /courses/:id/submit
 * Author submits a draft/rejected course for staff review. Validates the
 * course is complete enough to review.
 */
export async function submitCourse(req: Request, res: Response): Promise<void> {
    try {
        const existing = await loadOwnedCourse(req, res, { priceSats: true });
        if (!existing) return;
        if (existing.status !== 'draft' && existing.status !== 'rejected') {
            res.status(400).json({ error: `Cannot submit a course with status "${existing.status}"` });
            return;
        }

        const lessons = await prisma.lesson.findMany({
            where: { courseId: existing.id },
            select: { id: true, type: true, quizAnswerKey: true, content: true },
        });
        if (lessons.length === 0) {
            res.status(400).json({ error: 'Add at least one lesson before submitting' });
            return;
        }
        for (const lesson of lessons) {
            if (lesson.type !== 'QUIZ') continue;
            let complete = false;
            try {
                const content = JSON.parse(lesson.content) as QuizContent;
                const key = JSON.parse(lesson.quizAnswerKey || '{}') as QuizAnswerKey;
                complete =
                    Array.isArray(content.questions) &&
                    content.questions.length > 0 &&
                    content.questions.every((q) => key[q.id] !== undefined);
            } catch {
                complete = false;
            }
            if (!complete) {
                res.status(400).json({ error: 'A quiz lesson is missing its answer key' });
                return;
            }
        }

        if ((existing.priceSats as number) > 0) {
            const profile = await prisma.profile.findUnique({
                where: { userId: existing.authorId },
                select: { lightningAddress: true },
            });
            if (!profile?.lightningAddress) {
                res.status(400).json({
                    error: 'Paid courses require a Lightning address on your profile',
                });
                return;
            }
        }

        const course = await prisma.course.update({
            where: { id: existing.id },
            data: { status: 'pending-review' },
        });
        res.json(serializeCourse(course));
    } catch (error) {
        console.error('Submit course error:', error);
        res.status(500).json({ error: 'Failed to submit course' });
    }
}

/**
 * POST /courses/:id/nostr-refs
 * Nostr-native authors report client-published event ids so zap matching
 * and re-publish detection work.
 */
export async function setNostrRefs(req: Request, res: Response): Promise<void> {
    try {
        const existing = await loadOwnedCourse(req, res);
        if (!existing) return;

        const body = req.body as z.infer<typeof nostrRefsSchema>;
        if (body.courseEventId) {
            await prisma.course.update({
                where: { id: existing.id },
                data: { nostrEventId: body.courseEventId },
            });
        }
        if (body.lessons && body.lessons.length > 0) {
            for (const ref of body.lessons) {
                await prisma.lesson.updateMany({
                    where: { id: ref.lessonId, courseId: existing.id },
                    data: { nostrEventId: ref.eventId },
                });
            }
        }
        res.json({ message: 'Nostr references stored' });
    } catch (error) {
        console.error('Set nostr refs error:', error);
        res.status(500).json({ error: 'Failed to store Nostr references' });
    }
}

// ─── Lessons (authoring) ─────────────────────────────────────────────────────

/**
 * POST /courses/:id/lessons
 * Append a lesson. Quiz answers are split into the server-only column.
 */
export async function createLesson(req: Request, res: Response): Promise<void> {
    try {
        const existing = await loadOwnedCourse(req, res);
        if (!existing) return;

        const columns = lessonBodyToColumns(req.body as z.infer<typeof lessonSchema>);
        const max = await prisma.lesson.aggregate({
            where: { courseId: existing.id },
            _max: { position: true },
        });

        const lesson = await prisma.lesson.create({
            data: {
                courseId: existing.id,
                position: (max._max.position ?? -1) + 1,
                ...columns,
            },
        });
        await prisma.course.update({
            where: { id: existing.id },
            data: moderationResetPatch(existing, req),
        });
        await invalidateCourseCache();

        res.status(201).json(sanitizeLessonForLearner(lesson));
    } catch (error) {
        console.error('Create lesson error:', error);
        res.status(500).json({ error: 'Failed to create lesson' });
    }
}

/**
 * PUT /courses/:id/lessons/:lessonId
 * Full-replace edit of a lesson (author/staff).
 */
export async function updateLesson(req: Request, res: Response): Promise<void> {
    try {
        const existing = await loadOwnedCourse(req, res);
        if (!existing) return;

        const lesson = await prisma.lesson.findFirst({
            where: { id: req.params.lessonId, courseId: existing.id },
            select: { id: true },
        });
        if (!lesson) {
            res.status(404).json({ error: 'Lesson not found' });
            return;
        }

        const columns = lessonBodyToColumns(req.body as z.infer<typeof lessonSchema>);
        const updated = await prisma.lesson.update({ where: { id: lesson.id }, data: columns });
        await prisma.course.update({
            where: { id: existing.id },
            data: moderationResetPatch(existing, req),
        });
        await invalidateCourseCache();

        // Staff edit on an active course → refresh the mirror (author edits
        // reset to pending-review and re-mirror on re-approval).
        if (existing.status === 'active' && isCourseAdmin(req)) {
            mirrorCourseToNostr(existing.id).catch(() => {});
        }
        res.json(sanitizeLessonForLearner(updated));
    } catch (error) {
        console.error('Update lesson error:', error);
        res.status(500).json({ error: 'Failed to update lesson' });
    }
}

/**
 * PUT /courses/:id/lessons/reorder
 * Transactional position rewrite from an ordered id list.
 */
export async function reorderLessons(req: Request, res: Response): Promise<void> {
    try {
        const existing = await loadOwnedCourse(req, res);
        if (!existing) return;

        const { order } = req.body as z.infer<typeof reorderLessonsSchema>;
        const lessons = await prisma.lesson.findMany({
            where: { courseId: existing.id },
            select: { id: true },
        });
        const ids = new Set(lessons.map((l) => l.id));
        if (order.length !== ids.size || !order.every((id) => ids.has(id))) {
            res.status(400).json({ error: 'Order must contain every lesson id exactly once' });
            return;
        }

        await prisma.$transaction(
            order.map((id, position) =>
                prisma.lesson.update({ where: { id }, data: { position } })
            )
        );
        await prisma.course.update({
            where: { id: existing.id },
            data: moderationResetPatch(existing, req),
        });
        await invalidateCourseCache();

        res.json({ message: 'Lessons reordered' });
    } catch (error) {
        console.error('Reorder lessons error:', error);
        res.status(500).json({ error: 'Failed to reorder lessons' });
    }
}

/**
 * DELETE /courses/:id/lessons/:lessonId
 * Delete + resequence positions.
 */
export async function deleteLesson(req: Request, res: Response): Promise<void> {
    try {
        const existing = await loadOwnedCourse(req, res);
        if (!existing) return;

        const lesson = await prisma.lesson.findFirst({
            where: { id: req.params.lessonId, courseId: existing.id },
            select: { id: true },
        });
        if (!lesson) {
            res.status(404).json({ error: 'Lesson not found' });
            return;
        }

        // PR4 seam: NIP-09 delete of the lesson's Nostr event goes here.
        await prisma.lesson.delete({ where: { id: lesson.id } });

        const remaining = await prisma.lesson.findMany({
            where: { courseId: existing.id },
            orderBy: { position: 'asc' },
            select: { id: true },
        });
        await prisma.$transaction(
            remaining.map((l, position) =>
                prisma.lesson.update({ where: { id: l.id }, data: { position } })
            )
        );
        await prisma.course.update({
            where: { id: existing.id },
            data: moderationResetPatch(existing, req),
        });
        await invalidateCourseCache();

        res.json({ message: 'Lesson deleted' });
    } catch (error) {
        console.error('Delete lesson error:', error);
        res.status(500).json({ error: 'Failed to delete lesson' });
    }
}

// ─── Learning ────────────────────────────────────────────────────────────────

/**
 * GET /courses/:id/lessons/:lessonId
 * THE gated content endpoint. Full lesson content only for entitled viewers;
 * 402 with paywall info otherwise. Author/staff also receive the quiz
 * answer key (for the editor).
 */
export async function getLesson(req: Request, res: Response): Promise<void> {
    try {
        const course = await prisma.course.findUnique({
            where: { id: req.params.id },
            select: { id: true, authorId: true, priceSats: true, status: true, title: true },
        });
        if (!course) {
            res.status(404).json({ error: 'Course not found' });
            return;
        }

        const lesson = await prisma.lesson.findFirst({
            where: { id: req.params.lessonId, courseId: course.id },
        });
        if (!lesson) {
            res.status(404).json({ error: 'Lesson not found' });
            return;
        }

        const userId = req.user?.id ?? null;
        if (!userId) {
            res.status(401).json({ error: 'Authentication required' });
            return;
        }

        const [enrollment, purchase] = await Promise.all([
            prisma.enrollment.findUnique({
                where: { courseId_userId: { courseId: course.id, userId } },
                select: { id: true },
            }),
            prisma.coursePurchase.findUnique({
                where: { courseId_userId: { courseId: course.id, userId } },
                select: { id: true },
            }),
        ]);

        const allowed = canAccessLesson({
            course,
            lesson,
            userId,
            isAdmin: isCourseAdmin(req),
            enrolled: Boolean(enrollment),
            purchased: Boolean(purchase),
        });
        if (!allowed) {
            res.status(402).json({
                error: 'Purchase required',
                paywall: true,
                priceSats: course.priceSats,
                courseId: course.id,
            });
            return;
        }

        // Paid/gated content must never be cached by intermediaries.
        res.set('Cache-Control', 'no-store');

        const payload = sanitizeLessonForLearner(lesson);
        const isOwner = userId === course.authorId || isCourseAdmin(req);
        if (isOwner && lesson.type === 'QUIZ' && lesson.quizAnswerKey) {
            // Editor needs the answers back — author/staff only.
            (payload as any).answerKey = JSON.parse(lesson.quizAnswerKey);
        }
        res.json(payload);
    } catch (error) {
        console.error('Get lesson error:', error);
        res.status(500).json({ error: 'Failed to get lesson' });
    }
}

/**
 * POST /courses/:id/enroll
 * Free course: enroll directly. Paid course: requires a purchase.
 */
export async function enrollCourse(req: Request, res: Response): Promise<void> {
    try {
        const userId = req.user!.id;
        const course = await prisma.course.findUnique({
            where: { id: req.params.id },
            select: {
                id: true,
                authorId: true,
                title: true,
                priceSats: true,
                status: true,
                isPublished: true,
            },
        });
        if (!course || course.status !== 'active' || !course.isPublished) {
            res.status(404).json({ error: 'Course not found' });
            return;
        }
        if (course.authorId === userId) {
            res.status(400).json({ error: 'You are the author of this course' });
            return;
        }

        if (course.priceSats > 0) {
            const purchase = await prisma.coursePurchase.findUnique({
                where: { courseId_userId: { courseId: course.id, userId } },
                select: { id: true },
            });
            if (!purchase) {
                res.status(402).json({
                    error: 'Purchase required',
                    paywall: true,
                    priceSats: course.priceSats,
                });
                return;
            }
        }

        const existing = await prisma.enrollment.findUnique({
            where: { courseId_userId: { courseId: course.id, userId } },
        });
        if (existing) {
            res.json(existing);
            return;
        }

        const enrollment = await prisma.enrollment.create({
            data: { courseId: course.id, userId },
        });

        const student = await prisma.user.findUnique({
            where: { id: userId },
            select: { profile: { select: { name: true } } },
        });
        createNotification({
            userId: course.authorId,
            type: 'SYSTEM',
            title: 'New student enrolled',
            body: `${student?.profile?.name || 'A BIES member'} enrolled in "${course.title}".`,
            data: { courseId: course.id },
        }).catch(() => {});

        res.status(201).json(enrollment);
    } catch (error) {
        console.error('Enroll error:', error);
        res.status(500).json({ error: 'Failed to enroll' });
    }
}

/**
 * DELETE /courses/:id/enroll
 * Unenroll (cascades progress).
 */
export async function unenrollCourse(req: Request, res: Response): Promise<void> {
    try {
        await prisma.enrollment.deleteMany({
            where: { courseId: req.params.id, userId: req.user!.id },
        });
        res.json({ message: 'Unenrolled' });
    } catch (error) {
        console.error('Unenroll error:', error);
        res.status(500).json({ error: 'Failed to unenroll' });
    }
}

/**
 * GET /courses/:id/progress
 * Per-lesson completion map + completion state.
 */
export async function getProgress(req: Request, res: Response): Promise<void> {
    try {
        const enrollment = await prisma.enrollment.findUnique({
            where: {
                courseId_userId: { courseId: req.params.id, userId: req.user!.id },
            },
            include: {
                progress: { select: { lessonId: true, completedAt: true } },
                quizAttempts: {
                    orderBy: { createdAt: 'desc' },
                    take: 20,
                    select: { lessonId: true, scorePct: true, passed: true, createdAt: true },
                },
            },
        });
        if (!enrollment) {
            res.status(404).json({ error: 'Not enrolled' });
            return;
        }
        res.json({
            enrolledAt: enrollment.createdAt,
            completedAt: enrollment.completedAt,
            certificateEventId: enrollment.certificateEventId,
            lessons: enrollment.progress,
            quizAttempts: enrollment.quizAttempts,
        });
    } catch (error) {
        console.error('Get progress error:', error);
        res.status(500).json({ error: 'Failed to get progress' });
    }
}

/**
 * PUT /courses/:id/lessons/:lessonId/progress
 * Mark a VIDEO/TEXT lesson complete. QUIZ lessons are rejected — they
 * complete only through a passing attempt (quiz integrity).
 */
export async function upsertProgress(req: Request, res: Response): Promise<void> {
    try {
        const userId = req.user!.id;
        const course = await prisma.course.findUnique({
            where: { id: req.params.id },
            select: { id: true, authorId: true, priceSats: true, status: true },
        });
        if (!course) {
            res.status(404).json({ error: 'Course not found' });
            return;
        }

        const lesson = await prisma.lesson.findFirst({
            where: { id: req.params.lessonId, courseId: course.id },
            select: { id: true, type: true, isFreePreview: true },
        });
        if (!lesson) {
            res.status(404).json({ error: 'Lesson not found' });
            return;
        }
        if (lesson.type === 'QUIZ') {
            res.status(400).json({ error: 'Quiz lessons complete by passing the quiz' });
            return;
        }

        const [enrollment, purchase] = await Promise.all([
            prisma.enrollment.findUnique({
                where: { courseId_userId: { courseId: course.id, userId } },
                select: { id: true },
            }),
            prisma.coursePurchase.findUnique({
                where: { courseId_userId: { courseId: course.id, userId } },
                select: { id: true },
            }),
        ]);
        if (!enrollment) {
            res.status(400).json({ error: 'Enroll in the course first' });
            return;
        }
        const allowed = canAccessLesson({
            course,
            lesson: { isFreePreview: lesson.isFreePreview },
            userId,
            isAdmin: isCourseAdmin(req),
            enrolled: true,
            purchased: Boolean(purchase),
        });
        if (!allowed) {
            res.status(402).json({ error: 'Purchase required', paywall: true });
            return;
        }

        const body = req.body as z.infer<typeof progressSchema>;
        await prisma.lessonProgress.upsert({
            where: {
                enrollmentId_lessonId: { enrollmentId: enrollment.id, lessonId: lesson.id },
            },
            update: { meta: JSON.stringify(body.meta ?? {}) },
            create: {
                enrollmentId: enrollment.id,
                lessonId: lesson.id,
                meta: JSON.stringify(body.meta ?? {}),
            },
        });

        const completion = await checkCourseCompletion(enrollment.id);
        const enrollmentAfter = completion.justCompleted
            ? await prisma.enrollment.findUnique({
                  where: { id: enrollment.id },
                  select: { certificateEventId: true },
              })
            : null;

        res.json({
            lessonId: lesson.id,
            completed: true,
            courseCompleted: completion.completed,
            justCompleted: completion.justCompleted,
            certificateEventId: enrollmentAfter?.certificateEventId ?? null,
        });
    } catch (error) {
        console.error('Upsert progress error:', error);
        res.status(500).json({ error: 'Failed to update progress' });
    }
}

/**
 * POST /courses/:id/lessons/:lessonId/quiz
 * Server-side grading. Response never contains correct indices — only
 * per-question booleans. Attempt-capped per window against brute force.
 */
export async function submitQuiz(req: Request, res: Response): Promise<void> {
    try {
        const userId = req.user!.id;
        const course = await prisma.course.findUnique({
            where: { id: req.params.id },
            select: { id: true, authorId: true, priceSats: true, status: true },
        });
        if (!course) {
            res.status(404).json({ error: 'Course not found' });
            return;
        }

        const lesson = await prisma.lesson.findFirst({
            where: { id: req.params.lessonId, courseId: course.id },
        });
        if (!lesson || lesson.type !== 'QUIZ') {
            res.status(404).json({ error: 'Quiz not found' });
            return;
        }

        const [enrollment, purchase] = await Promise.all([
            prisma.enrollment.findUnique({
                where: { courseId_userId: { courseId: course.id, userId } },
                select: { id: true },
            }),
            prisma.coursePurchase.findUnique({
                where: { courseId_userId: { courseId: course.id, userId } },
                select: { id: true },
            }),
        ]);
        if (!enrollment) {
            res.status(400).json({ error: 'Enroll in the course first' });
            return;
        }
        const allowed = canAccessLesson({
            course,
            lesson: { isFreePreview: lesson.isFreePreview },
            userId,
            isAdmin: isCourseAdmin(req),
            enrolled: true,
            purchased: Boolean(purchase),
        });
        if (!allowed) {
            res.status(402).json({ error: 'Purchase required', paywall: true });
            return;
        }

        // Attempt cap: N attempts per rolling window per (user, quiz).
        const windowStart = new Date(Date.now() - QUIZ_ATTEMPT_WINDOW_MS);
        const recentAttempts = await prisma.quizAttempt.count({
            where: {
                enrollmentId: enrollment.id,
                lessonId: lesson.id,
                createdAt: { gte: windowStart },
            },
        });
        if (recentAttempts >= QUIZ_ATTEMPTS_PER_WINDOW) {
            res.status(429).json({ error: 'Too many attempts — try again in a few minutes' });
            return;
        }

        const content = JSON.parse(lesson.content) as QuizContent;
        const answerKey = JSON.parse(lesson.quizAnswerKey || '{}') as QuizAnswerKey;
        const body = req.body as z.infer<typeof quizSubmitSchema>;
        const grade = gradeQuiz(content, answerKey, body.answers);

        await prisma.quizAttempt.create({
            data: {
                enrollmentId: enrollment.id,
                lessonId: lesson.id,
                answers: JSON.stringify(body.answers),
                scorePct: grade.scorePct,
                passed: grade.passed,
            },
        });

        let completion = { completed: false, justCompleted: false };
        if (grade.passed) {
            await prisma.lessonProgress.upsert({
                where: {
                    enrollmentId_lessonId: { enrollmentId: enrollment.id, lessonId: lesson.id },
                },
                update: {},
                create: { enrollmentId: enrollment.id, lessonId: lesson.id },
            });
            completion = await checkCourseCompletion(enrollment.id);
        }

        res.set('Cache-Control', 'no-store');
        res.json({
            scorePct: grade.scorePct,
            passed: grade.passed,
            correctCount: grade.correctCount,
            total: grade.total,
            results: grade.results,
            courseCompleted: completion.completed,
            justCompleted: completion.justCompleted,
        });
    } catch (error) {
        console.error('Submit quiz error:', error);
        res.status(500).json({ error: 'Failed to submit quiz' });
    }
}

// ─── Purchase (status; claim lands with the payments slice) ─────────────────

/**
 * POST /courses/:id/purchase/claim
 * Verify the buyer's zap receipts (strict NIP-57 verification — signature,
 * zapper-key identity, bolt11 description-hash binding, coordinate match)
 * and create the purchase when the verified total covers the price.
 */
export async function claimPurchase(req: Request, res: Response): Promise<void> {
    try {
        const result = await claimZapPurchase(req.user!.id, req.params.id);
        res.set('Cache-Control', 'no-store');
        res.json(result);
    } catch (error: any) {
        if (error?.statusCode) {
            res.status(error.statusCode).json({ error: error.message });
            return;
        }
        console.error('Claim purchase error:', error);
        res.status(500).json({ error: 'Failed to claim purchase' });
    }
}

/**
 * GET /courses/:id/purchase
 * Purchase status + payment instructions for the unlock flow.
 */
export async function getPurchaseStatus(req: Request, res: Response): Promise<void> {
    try {
        const course = await prisma.course.findUnique({
            where: { id: req.params.id },
            select: {
                id: true,
                priceSats: true,
                status: true,
                nostrEventId: true,
                author: {
                    select: {
                        nostrPubkey: true,
                        profile: { select: { lightningAddress: true } },
                    },
                },
            },
        });
        if (!course || course.status !== 'active') {
            res.status(404).json({ error: 'Course not found' });
            return;
        }

        const purchase = await prisma.coursePurchase.findUnique({
            where: {
                courseId_userId: { courseId: course.id, userId: req.user!.id },
            },
            select: { amountSats: true, method: true, createdAt: true },
        });

        res.json({
            purchased: Boolean(purchase),
            purchase: purchase ?? null,
            priceSats: course.priceSats,
            authorPubkey: course.author.nostrPubkey,
            lightningAddress: course.author.profile?.lightningAddress || null,
            zapCoordinate: `30004:${course.author.nostrPubkey}:${course.id}`,
            courseEventId: course.nostrEventId,
        });
    } catch (error) {
        console.error('Purchase status error:', error);
        res.status(500).json({ error: 'Failed to get purchase status' });
    }
}
