import crypto from 'crypto';
import { Request, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { uploadPublicFile, uploadPrivateFile } from '../services/storage.service';
import { prepareMedia, UnreadableMediaError } from '../services/mediaProcessing';
import { discardUploadNames, discardUploads, recordUpload } from '../services/uploads.service';

// ─── Multer config (memory storage — files stay in buffer) ───

// Photos and videos members add (feed posts, profile photos, albums): what
// phones and browsers make, including iPhone videos (QuickTime).
const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/quicktime', 'video/webm'];

// One file and nothing else. The last two are multer 2's own limits, which
// @types/multer doesn't know yet.
const limits = {
    fileSize: 50 * 1024 * 1024, // 50MB max
    files: 1,
    fields: 5,
    parts: 6,
    fieldNameSize: 100,
    fieldNestingDepth: 0,
    fieldArrayIndexLimit: 0,
};

const upload = multer({
    storage: multer.memoryStorage(),
    limits,
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
 * Upload a public image/video. Photos are shrunk and lose their metadata,
 * videos their location (services/mediaProcessing.ts); the upload is
 * recorded as the member's (services/uploads.service.ts). Returns the public
 * URL, and what a Nostr event's imeta tag says of the stored file: its type,
 * size, SHA-256 and, for a photo, its size in pixels.
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

        let media;
        try {
            media = await prepareMedia(req.file.buffer, req.file.mimetype);
        } catch (err) {
            if (err instanceof UnreadableMediaError) {
                res.status(400).json({ error: err.message });
                return;
            }
            throw err;
        }

        const { url, name } = await uploadPublicFile(media.buffer, media.mimeType);
        await recordUpload(req.user!.id, { name, mimeType: media.mimeType, size: media.buffer.length });

        res.json({
            url,
            type: media.mimeType,
            size: media.buffer.length,
            sha256: crypto.createHash('sha256').update(media.buffer).digest('hex'),
            ...(media.width && media.height ? { width: media.width, height: media.height } : {}),
        });
    } catch (error) {
        console.error('Upload media error:', error);
        res.status(500).json({ error: 'Failed to upload media' });
    }
}

export const discardMediaSchema = z.object({
    urls: z.array(z.string().max(1000)).min(1).max(20),
});

/**
 * POST /upload/discard
 * Delete the member's own uploads behind these links, when nothing on BIES
 * still shows them: the app sends a post's photos when the member deletes the
 * post. Others' uploads are left alone.
 */
export async function discardMedia(req: Request, res: Response): Promise<void> {
    try {
        const { urls } = req.body as z.infer<typeof discardMediaSchema>;
        const deleted = await discardUploads(urls, { uploadedBy: [req.user!.id] });
        res.json({ deleted });
    } catch (error) {
        console.error('Discard media error:', error);
        res.status(500).json({ error: 'Failed to delete the files' });
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

        const { key, name } = await uploadPrivateFile(req.file.buffer, req.file.mimetype);
        await recordUpload(req.user!.id, { name, mimeType: req.file.mimetype, size: req.file.size, isPrivate: true });

        // Associate with project if projectId is provided
        const projectId = req.query.projectId as string;
        if (projectId) {
            const project = await prisma.project.findUnique({
                where: { id: projectId },
                select: { ownerId: true, deckKey: true },
            });

            if (project && project.ownerId === req.user!.id) {
                await prisma.project.update({
                    where: { id: projectId },
                    data: { deckKey: key },
                });
                // The deck it replaces goes.
                const old = project.deckKey?.split('/').pop();
                if (old) await discardUploadNames([old], { uploadedBy: [req.user!.id] });
            }
        }

        res.json({ key, message: 'Deck uploaded successfully' });
    } catch (error) {
        console.error('Upload deck error:', error);
        res.status(500).json({ error: 'Failed to upload deck' });
    }
}
