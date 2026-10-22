/**
 * The files members upload, and deleting them with what showed them.
 *
 * Every upload is recorded with the member who sent it (upload.controller.ts),
 * so that:
 * - an album takes only photos its member uploaded (ownsUploads);
 * - deleting a photo, an album, a listing, a post or an account, or a
 *   moderator removing one, deletes its files too (discardUploads). Before
 *   records, a deleted thing's files stayed on the server, and opened from
 *   their links, for good.
 *
 * A file is deleted only when BIES has a record of it, nothing left in the
 * database shows it (REFERENCES), and its uploader is one of `uploadedBy`.
 * That last part is because anyone can put anyone's photo link in their own
 * profile or post: deleting theirs mustn't delete the other person's photo.
 * Album photos are checked on the way in (ownsUploads), so their files go
 * with them whoever uploaded them. Never throws: deleting what's left over is
 * cleanup after what was asked has been done.
 */

import prisma from '../lib/prisma';
import { config } from '../config';
import { deleteStoredFile } from './storage.service';

/** The shape storage.service.ts gives stored files: milliseconds-hex.ext. */
const UPLOAD_NAME = /^\d{13}-[0-9a-f]{32}(\.[A-Za-z0-9]{1,8})?$/;

/**
 * The name of the BIES upload a link points to: an /uploads/public/ file on
 * this server (as a path, or a link to the app or API), or a media/ object at
 * the S3 public URL. Null for anything else.
 */
export function uploadNameOf(raw: string): string | null {
    if (typeof raw !== 'string' || !raw) return null;
    const basePath = (process.env.BASE_PATH || '').replace(/\/+$/, '');
    const fromPath = (path: string) => {
        const prefix = `${basePath}/uploads/public/`;
        if (!path.startsWith(prefix)) return null;
        const name = path.slice(prefix.length);
        return UPLOAD_NAME.test(name) ? name : null;
    };
    if (raw.startsWith('/')) return raw.startsWith('//') ? null : fromPath(raw);
    let url: URL;
    try { url = new URL(raw); } catch { return null; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.search || url.hash || url.username || url.password) return null;
    const s3 = config.s3.publicUrl.replace(/\/+$/, '');
    if (s3 && raw.startsWith(`${s3}/media/`)) {
        const name = raw.slice(`${s3}/media/`.length);
        return UPLOAD_NAME.test(name) ? name : null;
    }
    const ownHosts = new Set([config.appPublicUrl, process.env.API_PUBLIC_URL || ''].filter(Boolean).map((u) => {
        try { return new URL(u).host; } catch { return ''; }
    }));
    return ownHosts.has(url.host) ? fromPath(url.pathname) : null;
}

/** The links in a post's text (Feed.jsx puts its photos' links there). */
export function linksIn(text: string): string[] {
    return text.match(/https?:\/\/[^\s<>"']+/g) ?? [];
}

export async function recordUpload(
    userId: string,
    file: { name: string; mimeType: string; size: number; isPrivate?: boolean; shared?: boolean },
): Promise<void> {
    await prisma.upload.create({
        data: { name: file.name, userId, mimeType: file.mimeType, size: file.size, isPrivate: !!file.isPrivate, shared: !!file.shared },
    });
}

/** Every link is to a BIES upload this member sent. */
export async function ownsUploads(userId: string, urls: string[]): Promise<boolean> {
    const names = urls.map(uploadNameOf);
    if (names.some((n) => !n)) return false;
    const unique = [...new Set(names as string[])];
    const mine = await prisma.upload.count({ where: { name: { in: unique }, userId } });
    return mine === unique.length;
}

// ─── What still shows a file ──────────────────────────────────────────────────

// Every column a stored file's link (or a deck's key) can be saved in: before
// a file goes, these are searched for its name. A new place that saves upload
// links goes here too, or its files can be deleted while it still shows them.
const REFERENCES: [model: string, fields: string[]][] = [
    ['profile', ['avatar', 'banner', 'biesProjects', 'customSections']],
    ['directoryListing', ['photo', 'logo', 'photos']],
    ['talentListing', ['photo', 'works']],
    ['albumPhoto', ['url']],
    ['event', ['thumbnail', 'customSections']],
    ['project', ['thumbnail', 'photos', 'deckKey', 'customSections', 'teamInfo']],
    ['projectUpdate', ['content']],
    ['course', ['coverImage']],
    ['lesson', ['content']],
    ['article', ['thumbnail', 'content']],
    ['video', ['thumbnail']],
    ['bountySubmission', ['content']],
    ['feedback', ['screenshot']],
];

type Finder = { findMany(args: { where: unknown; select: Record<string, true> }): Promise<Record<string, unknown>[]> };

/** Which of these files something in the database still shows. */
export async function stillShown(names: string[]): Promise<Set<string>> {
    const shown = new Set<string>();
    const CHUNK = 40;
    for (let i = 0; i < names.length; i += CHUNK) {
        const chunk = names.slice(i, i + CHUNK);
        for (const [model, fields] of REFERENCES) {
            const finder = (prisma as unknown as Record<string, Finder>)[model];
            const rows = await finder.findMany({
                where: { OR: fields.flatMap((field) => chunk.map((name) => ({ [field]: { contains: name } }))) },
                select: Object.fromEntries(fields.map((f) => [f, true])),
            });
            for (const row of rows) {
                const text = fields.map((f) => String(row[f] ?? '')).join('\n');
                for (const name of chunk) if (text.includes(name)) shown.add(name);
            }
        }
    }
    return shown;
}

// ─── Deleting ─────────────────────────────────────────────────────────────────

export interface DiscardOptions {
    /**
     * Whose uploads may go. Leave it out only where the links were checked
     * on the way in (album photos) or come from BIES's own records.
     */
    uploadedBy?: (string | null | undefined)[];
    /**
     * Also delete files in the shared GIF library, which other members'
     * posts can show and nothing here can see: only when their uploader's
     * account goes.
     */
    includeShared?: boolean;
}

/** Delete the files behind these links, when nothing else shows them. How many went. */
export async function discardUploads(urls: Iterable<string>, options: DiscardOptions = {}): Promise<number> {
    const names = [...urls].map(uploadNameOf).filter((n): n is string => !!n);
    return discardUploadNames(names, options);
}

/** As discardUploads, by file name (an account's uploads, a deck). */
export async function discardUploadNames(names: string[], { uploadedBy, includeShared = false }: DiscardOptions = {}): Promise<number> {
    try {
        const unique = [...new Set(names)];
        if (unique.length === 0) return 0;
        const owners = uploadedBy?.filter((id): id is string => !!id);
        if (owners && owners.length === 0) return 0;
        const records = await prisma.upload.findMany({
            where: { name: { in: unique }, ...(owners ? { userId: { in: owners } } : {}), ...(includeShared ? {} : { shared: false }) },
            select: { id: true, name: true, isPrivate: true },
        });
        if (records.length === 0) return 0;
        const shown = await stillShown(records.map((r) => r.name));
        let deleted = 0;
        for (const record of records) {
            if (shown.has(record.name)) continue;
            try {
                await deleteStoredFile(record.name, record.isPrivate);
                await prisma.upload.delete({ where: { id: record.id } });
                deleted++;
            } catch (err) {
                console.error(`[Uploads] Could not delete ${record.name}:`, err instanceof Error ? err.message : err);
            }
        }
        return deleted;
    } catch (err) {
        console.error('[Uploads] Discarding files failed:', err instanceof Error ? err.message : err);
        return 0;
    }
}

/**
 * Before an account is erased (account.service.ts): the files its deletion
 * should take. Its own uploads, and the photos in the albums that go with it
 * (its own, and its listings'). `everything` false (an admin emptying the
 * trash; a merged account's posts now belong to another) leaves out uploads
 * nothing in the database shows yet, which may be in those posts. Pass the
 * result to discardUploadNames once the account is gone: whatever still
 * shows a file then keeps it.
 */
export async function filesOfAccount(userId: string, { everything }: { everything: boolean }): Promise<string[]> {
    const own = (await prisma.upload.findMany({ where: { userId }, select: { name: true } })).map((u) => u.name);
    const kept = everything ? own : [...await stillShown(own)];
    const albumPhotos = await prisma.albumPhoto.findMany({
        where: { album: { OR: [{ userId }, { listing: { ownerId: userId } }] } },
        select: { url: true },
    });
    const inAlbums = albumPhotos.map((p) => uploadNameOf(p.url)).filter((n): n is string => !!n);
    return [...new Set([...kept, ...inAlbums])];
}
