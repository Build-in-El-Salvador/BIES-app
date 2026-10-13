import { Request, Response } from 'express';
import multer from 'multer';
import prisma from '../lib/prisma';
import { uploadPublicFile, uploadPrivateFile } from '../services/storage.service';

// ─── Multer config (memory storage — files stay in buffer) ───

// Photos and videos members add (feed posts, profile photos, albums): what
// phones and browsers make, including iPhone videos (QuickTime).
const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/quicktime', 'video/webm'];

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 50 * 1024 * 1024, // 50MB max
    },
    fileFilter: (_req, file, cb) => {
        // Allowed MIME types
        const allowedMedia = MEDIA_TYPES;
        const allowedDecks = ['application/pdf', 'application/vnd.ms-powerpoint',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation'];
        const allAllowed = [...allowedMedia, ...allowedDecks];

        if (allAllowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            const err: any = new Error(`File type ${file.mimetype || 'unknown'} not allowed. Please use JPG, PNG, or WEBP.`);
            err.statusCode = 400;
            cb(err);
        }
    },
});

export const uploadMiddleware = upload.single('file');

// ─── Controllers ───

/**
 * POST /upload/media
 * Upload a public image/video. Returns the public URL.
 */
export async function uploadMedia(req: Request, res: Response): Promise<void> {
    try {
        if (!req.file) {
            res.status(400).json({ error: 'No file provided' });
            return;
        }

        const allowedMedia = MEDIA_TYPES;
        if (!allowedMedia.includes(req.file.mimetype)) {
            res.status(400).json({ error: 'Only images and videos are allowed for media upload' });
            return;
        }

        const url = await uploadPublicFile(
            req.file.buffer,
            req.file.originalname,
            req.file.mimetype
        );

        res.json({ url });
    } catch (error) {
        console.error('Upload media error:', error);
        res.status(500).json({ error: 'Failed to upload media' });
    }
}

/**
 * POST /upload/deck
 * Upload a private pitch deck (PDF/PPT). Returns the S3 key.
 * Optionally associates with a project via ?projectId=xxx query param.
 */
export async function uploadDeck(req: Request, res: Response): Promise<void> {
    try {
        if (!req.file) {
            res.status(400).json({ error: 'No file provided' });
            return;
        }

        const allowedDecks = [
            'application/pdf',
            'application/vnd.ms-powerpoint',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        ];
        if (!allowedDecks.includes(req.file.mimetype)) {
            res.status(400).json({ error: 'Only PDF and PowerPoint files are allowed for deck upload' });
            return;
        }

        const key = await uploadPrivateFile(
            req.file.buffer,
            req.file.originalname,
            req.file.mimetype
        );

        // Associate with project if projectId is provided
        const projectId = req.query.projectId as string;
        if (projectId) {
            const project = await prisma.project.findUnique({
                where: { id: projectId },
                select: { ownerId: true },
            });

            if (project && project.ownerId === req.user!.id) {
                await prisma.project.update({
                    where: { id: projectId },
                    data: { deckKey: key },
                });
            }
        }

        res.json({ key, message: 'Deck uploaded successfully' });
    } catch (error) {
        console.error('Upload deck error:', error);
        res.status(500).json({ error: 'Failed to upload deck' });
    }
}
