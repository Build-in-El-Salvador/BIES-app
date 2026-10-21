import {
    S3Client,
    PutObjectCommand,
    DeleteObjectCommand,
    GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const BASE_PATH = process.env.BASE_PATH || '';

// ─── S3 Client (only initialized if credentials are provided) ───

let s3Client: S3Client | null = null;

if (config.s3.endpoint && config.s3.accessKey) {
    s3Client = new S3Client({
        endpoint: config.s3.endpoint,
        region: config.s3.region,
        credentials: {
            accessKeyId: config.s3.accessKey,
            secretAccessKey: config.s3.secretKey,
        },
        forcePathStyle: true, // Required for R2 / MinIO
    });
    console.log('[Storage] S3 client initialized');
} else {
    console.log('[Storage] No S3 credentials — using local file storage');
}

// ─── Local fallback directory ───
// UPLOAD_DIR is for tests; the app keeps them next to the code (Dockerfile).
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads');
export const PUBLIC_DIR = path.join(UPLOAD_DIR, 'public');
/** Small copies of public photos, for lists (thumbnails.service.ts). */
export const THUMB_DIR = path.join(PUBLIC_DIR, 't');
const PRIVATE_DIR = path.join(UPLOAD_DIR, 'private');
/**
 * Where a video waits while it's made smaller (mediaProcessing.ts): on the
 * uploads volume, as /tmp in the container is memory. Never served.
 */
export const PROCESSING_DIR = path.join(UPLOAD_DIR, 'processing');

// Ensure upload directories exist
[PUBLIC_DIR, THUMB_DIR, PRIVATE_DIR, PROCESSING_DIR].forEach((dir) => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// What a restart left half made. Only files an hour old: another copy of the
// server (a test run) may be making one now.
for (const name of fs.readdirSync(PROCESSING_DIR)) {
    const file = path.join(PROCESSING_DIR, name);
    try {
        if (Date.now() - fs.statSync(file).mtimeMs > 60 * 60_000) fs.rmSync(file, { force: true });
    } catch { /* gone already */ }
}

/**
 * Map of MIME types to safe extensions. Used instead of trusting user-provided filenames.
 */
const SAFE_EXTENSIONS: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
    'application/pdf': '.pdf',
    'application/vnd.ms-powerpoint': '.ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
};

/**
 * Generate a unique filename with a safe extension derived from MIME type.
 * Never the uploader's own extension.
 * The name's shape is what uploads.service.ts recognises (UPLOAD_NAME).
 */
function generateFilename(mimeType: string): string {
    const ext = SAFE_EXTENSIONS[mimeType] || '';
    const hash = crypto.randomBytes(16).toString('hex');
    return `${Date.now()}-${hash}${ext}`;
}

/**
 * Validate that a resolved path stays within the allowed directory (prevent path traversal).
 */
function validatePath(basedir: string, key: string): string {
    const fullPath = path.resolve(basedir, key);
    if (!fullPath.startsWith(path.resolve(basedir))) {
        throw new Error('Invalid file path: path traversal detected');
    }
    return fullPath;
}

/**
 * Upload a public file (images, avatars).
 * Returns the public URL, and the file's name (for deletePublicFile).
 */
export async function uploadPublicFile(
    fileBuffer: Buffer,
    mimeType: string
): Promise<{ url: string; name: string }> {
    const filename = generateFilename(mimeType);
    const key = `media/${filename}`;

    if (s3Client) {
        await s3Client.send(
            new PutObjectCommand({
                Bucket: config.s3.bucket,
                Key: key,
                Body: fileBuffer,
                ContentType: mimeType,
                ACL: 'public-read',
            })
        );

        const url = config.s3.publicUrl
            ? `${config.s3.publicUrl}/${key}`
            : `${config.s3.endpoint}/${config.s3.bucket}/${key}`;
        return { url, name: filename };
    }

    // Local fallback
    const filePath = validatePath(PUBLIC_DIR, filename);
    fs.writeFileSync(filePath, fileBuffer);
    return { url: `${BASE_PATH}/uploads/public/${filename}`, name: filename };
}

/**
 * Upload a private file (pitch decks).
 * Returns the S3 key (NOT a URL — use getPresignedUrl to access).
 */
export async function uploadPrivateFile(
    fileBuffer: Buffer,
    mimeType: string
): Promise<{ key: string; name: string }> {
    const filename = generateFilename(mimeType);
    const key = `decks/${filename}`;

    if (s3Client) {
        await s3Client.send(
            new PutObjectCommand({
                Bucket: config.s3.bucket,
                Key: key,
                Body: fileBuffer,
                ContentType: mimeType,
                // No ACL = private by default
            })
        );

        return { key, name: filename };
    }

    // Local fallback
    const filePath = validatePath(PRIVATE_DIR, filename);
    fs.writeFileSync(filePath, fileBuffer);
    return { key: `private/${filename}`, name: filename };
}

/**
 * Generate a presigned URL for a private file (valid for 15 minutes).
 */
export async function getPresignedUrl(key: string): Promise<string> {
    if (s3Client) {
        const command = new GetObjectCommand({
            Bucket: config.s3.bucket,
            Key: key,
        });

        return getSignedUrl(s3Client, command, { expiresIn: 900 }); // 15 minutes
    }

    // Local fallback: a link to the API that works for 15 minutes, like S3's.
    // The uploads folder itself never serves private/ (nginx, index.ts).
    const name = key.split('/').pop() || '';
    const exp = Date.now() + 15 * 60 * 1000;
    return `${BASE_PATH}/api/upload/private/${name}?exp=${exp}&sig=${signPrivateLink(name, exp)}`;
}

function signPrivateLink(name: string, exp: number): string {
    return crypto.createHmac('sha256', config.jwtSecret).update(`private-file:${name}:${exp}`).digest('hex');
}

/**
 * The private file a getPresignedUrl link names (local storage), if the link
 * is genuine and hasn't expired; otherwise null.
 */
export function privateFileFromLink(name: string, exp: string, sig: string): string | null {
    if (!/^\d{13}-[0-9a-f]{32}\.(pdf|pptx?)$/i.test(name)) return null;
    const expires = Number(exp);
    if (!Number.isSafeInteger(expires) || expires < Date.now()) return null;
    if (typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sig)) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(signPrivateLink(name, expires), 'hex'))) return null;
    const file = validatePath(PRIVATE_DIR, name);
    return fs.existsSync(file) ? file : null;
}

/**
 * Delete a file from storage.
 */
export async function deleteFile(key: string): Promise<void> {
    if (s3Client) {
        await s3Client.send(
            new DeleteObjectCommand({
                Bucket: config.s3.bucket,
                Key: key,
            })
        );
        return;
    }

    // Local fallback — validate path to prevent directory traversal
    const fullPath = validatePath(UPLOAD_DIR, key);
    if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
    }
}

/**
 * Delete an uploaded file by its name (uploadPublicFile / uploadPrivateFile),
 * wherever it is kept.
 */
export async function deleteStoredFile(name: string, isPrivate = false): Promise<void> {
    if (s3Client) return deleteFile(`${isPrivate ? 'decks' : 'media'}/${name}`);
    await deleteFile(`${isPrivate ? 'private' : 'public'}/${name}`);
    // A public photo's small copy goes with it.
    const thumb = isPrivate ? null : thumbFileName(name);
    if (thumb) await deleteFile(`public/t/${thumb}`);
}

/** Whether uploads go to object storage (S3) rather than this server's disk. */
export function usesObjectStorage(): boolean {
    return !!s3Client;
}

/**
 * The small copy's file name for a public photo's name, or null for anything
 * else: the same name, as a JPEG, in public/t/.
 */
export function thumbFileName(name: string): string | null {
    const match = /^(\d{13}-[0-9a-f]{32})\.(jpe?g|png|gif|webp)$/i.exec(name);
    return match ? `${match[1]}.jpg` : null;
}
