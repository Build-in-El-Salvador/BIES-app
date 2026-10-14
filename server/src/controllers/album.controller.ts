/**
 * Photo albums: a member's (their profile's Photos tab), or a farm's or
 * business's (its listing page), to group photos, document growth, or show
 * different parts of a place.
 *
 * Who runs an album: a member runs their own; a listing's albums are run by
 * whoever runs the listing (its owner, as for editing it). BIES staff can run
 * any, for moderation. Who sees one: PUBLIC anyone, MEMBERS signed-in
 * members, ONLY_ME just its member (members' albums only). Photos are the
 * adder's own BIES uploads (POST /upload/media), never links to elsewhere,
 * and their files are deleted with them (services/uploads.service.ts).
 */

import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { blockedEitherWay } from '../services/moderation.service';
import { discardUploads, ownsUploads } from '../services/uploads.service';
import { objectionableField, objectionableResponse } from '../services/contentFilter';

export const ALBUM_VISIBILITY = ['PUBLIC', 'MEMBERS', 'ONLY_ME'] as const;
const MAX_ALBUMS_PER_OWNER = 50;
const MAX_PHOTOS_PER_ALBUM = 200;

const title = z.string().trim().min(1).max(80);
const description = z.string().trim().max(500);
const caption = z.string().trim().max(300);

export const createAlbumSchema = z.object({
    title,
    description: description.optional(),
    visibility: z.enum(ALBUM_VISIBILITY).optional(),
    listingId: z.string().min(1).max(64).optional(),
});

export const updateAlbumSchema = z.object({
    title: title.optional(),
    description: description.optional(),
    visibility: z.enum(ALBUM_VISIBILITY).optional(),
    coverPhotoId: z.string().min(1).max(64).nullable().optional(),
});

export const addPhotosSchema = z.object({
    photos: z.array(z.object({
        url: z.string().trim().min(1).max(1000),
        caption: caption.optional(),
        width: z.number().int().positive().max(20000).optional(),
        height: z.number().int().positive().max(20000).optional(),
    })).min(1).max(20),
});

export const updatePhotoSchema = z.object({ caption });

const isStaff = (req: Request) => !!req.user && (req.user.isAdmin || req.user.role === 'MOD');

type AlbumWithOwner = NonNullable<Awaited<ReturnType<typeof loadAlbum>>>;

function loadAlbum(id: string) {
    return prisma.album.findUnique({
        where: { id },
        include: {
            listing: { select: { id: true, name: true, type: true, ownerId: true, memberUserId: true, status: true } },
            user: { select: { id: true, deletedAt: true, profile: { select: { name: true, avatar: true } } } },
        },
    });
}

/** The member who answers for an album: its member, or its listing's. */
function albumMember(album: AlbumWithOwner): string | null {
    return album.userId ?? album.listing?.memberUserId ?? album.listing?.ownerId ?? null;
}

function canManage(req: Request, album: { userId: string | null; listing: { ownerId: string } | null }): boolean {
    if (!req.user) return false;
    if (isStaff(req)) return true;
    return album.userId ? album.userId === req.user.id : album.listing?.ownerId === req.user.id;
}

async function canView(req: Request, album: AlbumWithOwner): Promise<boolean> {
    if (canManage(req, album)) return true;
    if (album.user?.deletedAt) return false;
    if (album.listing && album.listing.status !== 'active') return false;
    if (album.visibility === 'ONLY_ME') return false;
    if (album.visibility === 'MEMBERS' && !req.user) return false;
    const member = albumMember(album);
    if (req.user && member && member !== req.user.id && await blockedEitherWay(req.user.id, member)) return false;
    return true;
}

const albumSummary = (album: { id: string; title: string; description: string; visibility: string; coverPhotoId: string | null; updatedAt: Date; photos: { id: string; url: string }[]; _count: { photos: number } }) => {
    const cover = album.photos.find((p) => p.id === album.coverPhotoId) ?? album.photos[0] ?? null;
    return {
        id: album.id,
        title: album.title,
        description: album.description,
        visibility: album.visibility,
        photoCount: album._count.photos,
        cover: cover ? { id: cover.id, url: cover.url } : null,
        updatedAt: album.updatedAt,
    };
};

/**
 * GET /albums?user=<userId> or ?listing=<listingId>
 * The albums this viewer may see, newest first, each with its cover and
 * count; `canManage` says whether the viewer can add albums here.
 */
export async function listAlbums(req: Request, res: Response): Promise<void> {
    try {
        const userId = typeof req.query.user === 'string' ? req.query.user : '';
        const listingId = typeof req.query.listing === 'string' ? req.query.listing : '';
        if (!userId === !listingId) { res.status(400).json({ error: 'Give a user or a listing' }); return; }

        let manage = false;
        let listing: { id: string; ownerId: string } | null = null;
        if (listingId) {
            listing = await prisma.directoryListing.findUnique({ where: { id: listingId }, select: { id: true, ownerId: true } });
            if (!listing) { res.status(404).json({ error: 'Listing not found' }); return; }
            manage = canManage(req, { userId: null, listing });
        } else {
            manage = canManage(req, { userId, listing: null });
        }

        const albums = await prisma.album.findMany({
            where: userId ? { userId } : { listingId },
            orderBy: { updatedAt: 'desc' },
            include: {
                listing: { select: { id: true, name: true, type: true, ownerId: true, memberUserId: true, status: true } },
                user: { select: { id: true, deletedAt: true, profile: { select: { name: true, avatar: true } } } },
                photos: { orderBy: { createdAt: 'asc' }, take: 1, select: { id: true, url: true } },
                _count: { select: { photos: true } },
            },
        });
        const covers = await prisma.albumPhoto.findMany({
            where: { id: { in: albums.map((a) => a.coverPhotoId).filter((id): id is string => !!id) } },
            select: { id: true, url: true },
        });

        const visible = [];
        for (const album of albums) {
            if (!(await canView(req, album))) continue;
            visible.push(albumSummary({ ...album, photos: [...covers.filter((c) => c.id === album.coverPhotoId), ...album.photos] }));
        }
        res.json({ data: visible, canManage: manage });
    } catch (error) {
        console.error('List albums error:', error);
        res.status(500).json({ error: 'Failed to list albums' });
    }
}

/** An album and its photos, oldest first, with whose it is and where it lives. */
function albumResponse(req: Request, album: AlbumWithOwner, photos: { id: string; url: string; caption: string; width: number | null; height: number | null; createdAt: Date }[]) {
    const listingPath = album.listing ? `${album.listing.type === 'FARM' ? '/farms' : '/trusted'}/${album.listing.id}` : null;
    return {
        id: album.id,
        title: album.title,
        description: album.description,
        visibility: album.visibility,
        coverPhotoId: album.coverPhotoId,
        createdAt: album.createdAt,
        updatedAt: album.updatedAt,
        owner: album.listing
            ? { type: 'listing', id: album.listing.id, name: album.listing.name, kind: album.listing.type, path: listingPath }
            : { type: 'user', id: album.userId, name: album.user?.profile?.name || '', avatar: album.user?.profile?.avatar || '', path: `/builder/${album.userId}` },
        photos,
        canManage: canManage(req, album),
    };
}

/** GET /albums/:id — 404 when the viewer may not see it. */
export async function getAlbum(req: Request, res: Response): Promise<void> {
    try {
        const album = await loadAlbum(req.params.id);
        if (!album || !(await canView(req, album))) { res.status(404).json({ error: 'Album not found' }); return; }
        const photos = await prisma.albumPhoto.findMany({
            where: { albumId: album.id },
            orderBy: { createdAt: 'asc' },
            select: { id: true, url: true, caption: true, width: true, height: true, createdAt: true },
        });
        res.json(albumResponse(req, album, photos));
    } catch (error) {
        console.error('Get album error:', error);
        res.status(500).json({ error: 'Failed to get album' });
    }
}

/** POST /albums — yours, or (listingId) the listing's you run. */
export async function createAlbum(req: Request, res: Response): Promise<void> {
    try {
        const body = req.body as z.infer<typeof createAlbumSchema>;
        let owner: { userId: string } | { listingId: string };
        if (body.listingId) {
            const listing = await prisma.directoryListing.findUnique({ where: { id: body.listingId }, select: { id: true, ownerId: true } });
            if (!listing) { res.status(404).json({ error: 'Listing not found' }); return; }
            if (!canManage(req, { userId: null, listing })) { res.status(403).json({ error: 'Only the people who run this listing can add albums' }); return; }
            if (body.visibility === 'ONLY_ME') { res.status(400).json({ error: 'A listing\'s album is for everyone or for members' }); return; }
            owner = { listingId: listing.id };
        } else {
            owner = { userId: req.user!.id };
        }
        if (await prisma.album.count({ where: owner }) >= MAX_ALBUMS_PER_OWNER) {
            res.status(400).json({ error: `Up to ${MAX_ALBUMS_PER_OWNER} albums` });
            return;
        }
        const album = await prisma.album.create({
            data: { ...owner, title: body.title, description: body.description ?? '', visibility: body.visibility ?? 'MEMBERS' },
        });
        res.status(201).json(album);
    } catch (error) {
        console.error('Create album error:', error);
        res.status(500).json({ error: 'Failed to create album' });
    }
}

/** The album, when the signed-in member runs it; otherwise answers and returns null. */
async function managedAlbum(req: Request, res: Response): Promise<AlbumWithOwner | null> {
    const album = await loadAlbum(req.params.id);
    if (!album) { res.status(404).json({ error: 'Album not found' }); return null; }
    if (!canManage(req, album)) { res.status(403).json({ error: 'Not your album' }); return null; }
    return album;
}

/** PATCH /albums/:id — title, description, who sees it, the cover. */
export async function updateAlbum(req: Request, res: Response): Promise<void> {
    try {
        const album = await managedAlbum(req, res);
        if (!album) return;
        const body = req.body as z.infer<typeof updateAlbumSchema>;
        if (body.visibility === 'ONLY_ME' && album.listingId) {
            res.status(400).json({ error: 'A listing\'s album is for everyone or for members' });
            return;
        }
        if (body.coverPhotoId) {
            const photo = await prisma.albumPhoto.findFirst({ where: { id: body.coverPhotoId, albumId: album.id }, select: { id: true } });
            if (!photo) { res.status(400).json({ error: 'That photo isn\'t in this album' }); return; }
        }
        const updated = await prisma.album.update({
            where: { id: album.id },
            data: {
                ...(body.title !== undefined ? { title: body.title } : {}),
                ...(body.description !== undefined ? { description: body.description } : {}),
                ...(body.visibility !== undefined ? { visibility: body.visibility } : {}),
                ...(body.coverPhotoId !== undefined ? { coverPhotoId: body.coverPhotoId } : {}),
            },
        });
        res.json(updated);
    } catch (error) {
        console.error('Update album error:', error);
        res.status(500).json({ error: 'Failed to update album' });
    }
}

/** DELETE /albums/:id — the album and its photos. */
export async function deleteAlbum(req: Request, res: Response): Promise<void> {
    try {
        const album = await managedAlbum(req, res);
        if (!album) return;
        const photos = await prisma.albumPhoto.findMany({ where: { albumId: album.id }, select: { url: true } });
        await prisma.album.delete({ where: { id: album.id } });
        await discardUploads(photos.map((p) => p.url));
        res.json({ deleted: true });
    } catch (error) {
        console.error('Delete album error:', error);
        res.status(500).json({ error: 'Failed to delete album' });
    }
}

/** POST /albums/:id/photos — up to 20 at a time, BIES uploads only. */
export async function addPhotos(req: Request, res: Response): Promise<void> {
    try {
        const album = await managedAlbum(req, res);
        if (!album) return;
        const { photos } = req.body as z.infer<typeof addPhotosSchema>;
        if (!(await ownsUploads(req.user!.id, photos.map((p) => p.url)))) {
            res.status(400).json({ error: 'Upload photos to BIES first' });
            return;
        }
        for (const p of photos) {
            const field = objectionableField({ caption: p.caption ?? '' });
            if (field) { res.status(422).json(objectionableResponse(field)); return; }
        }
        if (await prisma.albumPhoto.count({ where: { albumId: album.id } }) + photos.length > MAX_PHOTOS_PER_ALBUM) {
            res.status(400).json({ error: `Up to ${MAX_PHOTOS_PER_ALBUM} photos in an album` });
            return;
        }
        // One at a time, so the order they were picked in is the order kept.
        const created = [];
        for (const p of photos) {
            created.push(await prisma.albumPhoto.create({
                data: { albumId: album.id, url: p.url, caption: p.caption ?? '', width: p.width ?? null, height: p.height ?? null },
                select: { id: true, url: true, caption: true, width: true, height: true, createdAt: true },
            }));
        }
        await prisma.album.update({ where: { id: album.id }, data: { updatedAt: new Date() } });
        res.status(201).json({ data: created });
    } catch (error) {
        console.error('Add photos error:', error);
        res.status(500).json({ error: 'Failed to add photos' });
    }
}

/** PATCH /albums/:id/photos/:photoId — its caption. */
export async function updatePhoto(req: Request, res: Response): Promise<void> {
    try {
        const album = await managedAlbum(req, res);
        if (!album) return;
        const photo = await prisma.albumPhoto.findFirst({ where: { id: req.params.photoId, albumId: album.id }, select: { id: true } });
        if (!photo) { res.status(404).json({ error: 'Photo not found' }); return; }
        const updated = await prisma.albumPhoto.update({
            where: { id: photo.id },
            data: { caption: (req.body as z.infer<typeof updatePhotoSchema>).caption },
            select: { id: true, url: true, caption: true, width: true, height: true, createdAt: true },
        });
        res.json(updated);
    } catch (error) {
        console.error('Update photo error:', error);
        res.status(500).json({ error: 'Failed to update photo' });
    }
}

/** DELETE /albums/:id/photos/:photoId — the cover falls back to the first photo. */
export async function deletePhoto(req: Request, res: Response): Promise<void> {
    try {
        const album = await managedAlbum(req, res);
        if (!album) return;
        const photo = await prisma.albumPhoto.findFirst({ where: { id: req.params.photoId, albumId: album.id }, select: { id: true, url: true } });
        if (!photo) { res.status(404).json({ error: 'Photo not found' }); return; }
        await prisma.albumPhoto.delete({ where: { id: photo.id } });
        if (album.coverPhotoId === photo.id) await prisma.album.update({ where: { id: album.id }, data: { coverPhotoId: null } });
        await discardUploads([photo.url]);
        res.json({ deleted: true });
    } catch (error) {
        console.error('Delete photo error:', error);
        res.status(500).json({ error: 'Failed to delete photo' });
    }
}
