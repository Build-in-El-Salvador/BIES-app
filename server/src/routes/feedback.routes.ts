import { NextFunction, Request, Response, Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { rateLimitKey } from '../utils/rateLimitKey';
import {
    submitFeedback,
    submitFeedbackSchema,
    listFeedback,
    updateFeedback,
    deleteFeedback,
    SCREENSHOT_TYPES,
} from '../controllers/feedback.controller';

const router = Router();

// Reports: 10 an hour per account, so a tester can send several in a session
// but nobody can fill the list (or the disk, with screenshots).
const feedbackLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'You\'ve sent a lot of reports this hour. Please try again later' },
    keyGenerator: rateLimitKey,
});

// The report's fields and at most one screenshot, kept in memory: it's a
// photo, shrunk before it's stored (feedback.controller.ts).
const screenshotUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024, files: 1, fields: 6, parts: 7, fieldNameSize: 100 },
    fileFilter: (_req, file, cb) => {
        if (SCREENSHOT_TYPES.includes(file.mimetype)) {
            cb(null, true);
            return;
        }
        const err: Error & { statusCode?: number } = new Error('A screenshot can be a PNG, JPG or WEBP picture');
        err.statusCode = 400;
        cb(err);
    },
}).single('file');

function takeScreenshot(req: Request, res: Response, next: NextFunction): void {
    screenshotUpload(req, res, (err: unknown) => {
        if (!err) {
            next();
            return;
        }
        if (err instanceof multer.MulterError) {
            const tooBig = err.code === 'LIMIT_FILE_SIZE';
            res.status(tooBig ? 413 : 400).json({
                error: tooBig ? 'That screenshot is too big (15 MB at most)' : 'Send one screenshot with the report',
                ...(tooBig ? { reason: 'too_large' } : {}),
            });
            return;
        }
        const { message, statusCode } = err as Error & { statusCode?: number };
        res.status(statusCode ?? 400).json({ error: message });
    });
}

// A signed-in member sends a report or feedback
router.post('/', authenticate, feedbackLimiter, takeScreenshot, validate(submitFeedbackSchema), submitFeedback);

export default router;

// Admin routes are mounted separately under /api/admin/feedback
export const adminFeedbackRouter = Router();
adminFeedbackRouter.get('/', listFeedback);
adminFeedbackRouter.put('/:id', updateFeedback);
adminFeedbackRouter.delete('/:id', deleteFeedback);
