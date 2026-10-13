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
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
const PUBLIC_DIR = path.join(UPLOAD_DIR, 'public');
const PRIVATE_DIR = path.join(UPLOAD_DIR, 'private');

// Ensure upload directories exist
[PUBLIC_DIR, PRIVATE_DIR].forEach((dir) => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

/**
 * Map of MIME types to safe extensions. Used instead of trusting user-provided filenames.
 */
const SAFE_EXTENSIONS: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    // Videos too: otherwise the uploader's own file name sets the extension,
    // and "x.html" would be served from our domain as a web page.
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
    'application/pdf': '.pdf',
    'application/vnd.ms-powerpoint': '.ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
};

/**
 * Generate a unique filename with a safe extension derived from MIME type.
 */
function generateFilename(originalName: string, mimeType?: string): string {
    // Derive extension from validated MIME type, falling back to original extension
    const ext = (mimeType && SAFE_EXTENSIONS[mimeType]) || path.extname(originalName);
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
 * Returns the public URL.
 */
export async function uploadPublicFile(
    fileBuffer: Buffer,
    originalName: string,
    mimeType: string
): Promise<string> {
    const filename = generateFilename(originalName, mimeType);
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

        return config.s3.publicUrl
            ? `${config.s3.publicUrl}/${key}`
            : `${config.s3.endpoint}/${config.s3.bucket}/${key}`;
    }

    // Local fallback
    const filePath = validatePath(PUBLIC_DIR, filename);
    fs.writeFileSync(filePath, fileBuffer);
    return `${BASE_PATH}/uploads/public/${filename}`;
}

/**
 * Upload a private file (pitch decks).
 * Returns the S3 key (NOT a URL — use getPresignedUrl to access).
 */
export async function uploadPrivateFile(
    fileBuffer: Buffer,
    originalName: string,
    mimeType: string
): Promise<string> {
    const filename = generateFilename(originalName, mimeType);
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

        return key;
    }

    // Local fallback
    const filePath = validatePath(PRIVATE_DIR, filename);
    fs.writeFileSync(filePath, fileBuffer);
    return `private/${filename}`;
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

    // Local fallback — just return the path (in dev mode, served as static)
    return `${BASE_PATH}/uploads/${key}`;
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
