import crypto from 'crypto';
import fs from 'fs';
import { Request, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import prisma from '../lib/prisma';
import path from 'path';
import { PROCESSING_DIR, privateFileFromLink, uploadPublicFile, uploadPrivateFile } from '../services/storage.service';
import {
    MAX_VIDEO_SECONDS, MediaAbortedError, prepareMedia, prepareVideoFile, UnreadableMediaError, VideoTooLargeError, VideoTooLongError,
} from '../services/mediaProcessing';
import { discardUploadNames, discardUploads, recordUpload } from '../services/uploads.service';

// ─── Multer config ───

// Photos and videos members add (feed posts, profile photos, albums,
// Talents): what phones and browsers make, including iPhone videos (QuickTime).
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

// A video goes to disk as it arrives: it may wait a while for its turn
// (mediaProcessing.ts makes one at a time), and shouldn't wait in memory.
// Photos and decks are kept in memory (req.file.buffer).
const inMemory = multer.memoryStorage();
const onDisk = multer.diskStorage({
    destination: PROCESSING_DIR,
    filename: (_req, _file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.upload`),
});
const storageFor = (file: Express.Multer.File) => (file.mimetype.startsWith('video/') ? onDisk : inMemory);
const storage: multer.StorageEngine = {
    _handleFile: (req, file, cb) => storageFor(file)._handleFile(req, file, cb),
    _removeFile: (req, file, cb) => storageFor(file)._removeFile(req, file, cb),
};

const upload = multer({
    storage,
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

// Videos wait for their turn (mediaProcessing.ts makes one at a time): as
// many of one member's as a post has attachments, and a dozen in all, so one
// member can't keep everyone else's waiting. More are turned away until
// those are done.
const VIDEOS_PER_MEMBER = 4;
const VIDEOS_AT_ONCE = 12;
const videosOf = new Map<string, number>();
let videosInAll = 0;

/** 'ok' (counted until doneWithVideo) when there's room for this member's video; else whose videos fill it. */
function takeVideoTurn(userId: string): 'ok' | 'yours' | 'all' {
    const mine = videosOf.get(userId) ?? 0;
    if (mine >= VIDEOS_PER_MEMBER) return 'yours';
    if (videosInAll >= VIDEOS_AT_ONCE) return 'all';
    videosOf.set(userId, mine + 1);
    videosInAll += 1;
    return 'ok';
}

function doneWithVideo(userId: string): void {
    const mine = (videosOf.get(userId) ?? 1) - 1;
    if (mine > 0) videosOf.set(userId, mine);
    else videosOf.delete(userId);
    videosInAll = Math.max(0, videosInAll - 1);
}

// ─── Controllers ───

/**
 * POST /upload/media?poster=1
 * Upload a public image/video. Photos are shrunk and lose their metadata;
 * videos are made again as a smaller MP4 without theirs, which takes a while
 * (services/mediaProcessing.ts). The upload is recorded as the member's
 * (services/uploads.service.ts). Returns the public URL, and what a Nostr
 * event's imeta tag says of the stored file: its type, size, SHA-256 and
 * size in pixels; for a video its length, and with ?poster=1 a still from
 * it (stored and recorded too), to show before it plays.
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

        const userId = req.user!.id;
        const video = req.file.mimetype.startsWith('video/');
        if (video) {
            const turn = takeVideoTurn(userId);
            if (turn !== 'ok') {
                res.status(429).json({
                    error: turn === 'yours'
                        ? 'Wait for your other videos to finish uploading'
                        : 'Lots of videos are being uploaded right now. Please try again in a minute',
                    reason: 'busy',
                });
                return;
            }
        }

        // The member leaves (the app closed, or nginx gave up waiting): a video
        // still waiting isn't made, one being made stops, and nothing is kept.
        const left = new AbortController();
        res.on('close', () => { if (!res.writableEnded) left.abort(); });

        let media;
        try {
            const options = { poster: req.query.poster === '1', workDir: PROCESSING_DIR, signal: left.signal };
            media = video
                ? await prepareVideoFile(req.file.path, req.file.mimetype, options)
                : await prepareMedia(req.file.buffer, req.file.mimetype, options);
        } catch (err) {
            if (err instanceof MediaAbortedError) return;
            if (err instanceof UnreadableMediaError) {
                res.status(400).json({ error: err.message });
                return;
            }
            if (err instanceof VideoTooLongError) {
                res.status(400).json({ error: err.message, reason: 'too_long', max: MAX_VIDEO_SECONDS });
                return;
            }
            if (err instanceof VideoTooLargeError) {
                res.status(400).json({ error: err.message, reason: 'too_large' });
                return;
            }
            throw err;
        } finally {
            if (video) doneWithVideo(userId);
        }

        if (left.signal.aborted) return;
        const { url, name } = await uploadPublicFile(media.buffer, media.mimeType);
        // ?shared=1: a GIF for the shared library (gifStore.js), which other
        // members' posts can show, so deleting a post leaves it.
        const shared = req.query.shared === '1' && media.mimeType === 'image/gif';
        await recordUpload(userId, { name, mimeType: media.mimeType, size: media.buffer.length, shared });

        let poster: string | undefined;
        if (media.poster) {
            const still = await uploadPublicFile(media.poster.buffer, media.poster.mimeType);
            await recordUpload(userId, { name: still.name, mimeType: media.poster.mimeType, size: media.poster.buffer.length });
            poster = still.url;
        }

        res.json({
            url,
            type: media.mimeType,
            size: media.buffer.length,
            sha256: crypto.createHash('sha256').update(media.buffer).digest('hex'),
            ...(media.width && media.height ? { width: media.width, height: media.height } : {}),
            ...(media.duration ? { duration: Math.round(media.duration * 10) / 10 } : {}),
            ...(poster ? { poster } : {}),
        });
    } catch (error) {
        console.error('Upload media error:', error);
        res.status(500).json({ error: 'Failed to upload media' });
    } finally {
        // A video's file from the upload (onDisk above), however it went.
        if (req.file?.path) await fs.promises.rm(req.file.path, { force: true }).catch(() => {});
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

/**
 * GET /upload/private/:name?exp=&sig=
 * A private file (a pitch deck) through the 15-minute link getProjectDeck
 * hands out (storage.service.ts getPresignedUrl): the link is the permission.
 */
export async function downloadPrivateFile(req: Request, res: Response): Promise<void> {
    try {
        const file = privateFileFromLink(req.params.name, String(req.query.exp ?? ''), String(req.query.sig ?? ''));
        if (!file) {
            res.status(404).json({ error: 'This link has expired' });
            return;
        }
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'private, no-store');
        res.download(file, `pitch-deck${path.extname(file)}`);
    } catch (error) {
        console.error('Download private file error:', error);
        res.status(404).json({ error: 'This link has expired' });
    }
}
