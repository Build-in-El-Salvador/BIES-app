import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { getPresignedUrl } from '../services/storage.service';
import { cache, cacheKey, TTL } from '../services/redis.service';
import { z } from 'zod';

// ─── Validation Schemas ───

export const createArticleSchema = z.object({
    title: z.string().min(1).max(300),
    slug: z.string().min(1).max(200),
    excerpt: z.string().max(500).optional(),
    content: z.string().min(1),
    category: z.enum(['NEWS', 'TUTORIAL', 'BIES_UPDATE', 'LEGAL', 'GUIDE']).default('NEWS'),
    thumbnail: z.string().url().optional().or(z.literal('')),
    authorName: z.string().optional(),
    isPublished: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
});

// Every field optional, and a field left out stays out: in zod 4, .partial()
// still fills in .default() values, which would reset what an edit didn't send.
export const updateArticleSchema = createArticleSchema.partial().extend({
    category: createArticleSchema.shape.category.removeDefault().optional(),
});

export const createVideoSchema = z.object({
    title: z.string().min(1).max(300),
    description: z.string().max(2000).optional(),
    url: z.string().url(),
    thumbnail: z.string().url().optional().or(z.literal('')),
    category: z.enum(['GENERAL', 'TUTORIAL', 'INTERVIEW', 'DEMO']).default('GENERAL'),
    duration: z.number().int().positive().optional(),
    isPublished: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
});

export const createResourceSchema = z.object({
    title: z.string().min(1).max(300),
    description: z.string().max(2000).optional(),
    category: z.enum(['GENERAL', 'TERMS', 'PRIVACY', 'COMPLIANCE', 'TEMPLATE']).default('GENERAL'),
    fileKey: z.string().min(1),
    fileName: z.string().optional(),
    isPublished: z.boolean().optional(),
});

// ─── Article Controllers ───

/**
 * GET /content/articles
 * List published articles with optional category/search filter.
 */
export async function listArticles(req: Request, res: Response): Promise<void> {
    try {
        const { category, search, page = '1', limit = '20' } = req.query;
        const skip = (parseInt(page as string, 10) - 1) * parseInt(limit as string, 10);
        const take = Math.min(parseInt(limit as string, 10), 50);

        const cKey = cacheKey.articles({
            category: category as string || '',
            search: search as string || '',
            page: page as string,
            limit: limit as string,
        });

        const cached = await cache.getJson<any>(cKey);
        if (cached) { res.setHeader('X-Cache', 'HIT'); res.json(cached); return; }

        const where: any = { isPublished: true };
        if (category && typeof category === 'string') where.category = category.toUpperCase();
        if (search && typeof search === 'string') {
            where.OR = [
                { title: { contains: search } },
                { excerpt: { contains: search } },
            ];
        }

        const [articles, total] = await Promise.all([
            prisma.article.findMany({
                where,
                skip,
                take,
                orderBy: { createdAt: 'desc' },
            }),
            prisma.article.count({ where }),
        ]);

        const result = {
            data: articles.map((a) => ({ ...a, tags: JSON.parse(a.tags || '[]') })),
            pagination: { page: parseInt(page as string, 10), limit: take, total, totalPages: Math.ceil(total / take) },
        };

        await cache.setJson(cKey, result, TTL.CONTENT_LIST);
        res.json(result);
    } catch (error) {
        console.error('List articles error:', error);
        res.status(500).json({ error: 'Failed to list articles' });
    }
}

/**
 * GET /content/articles/:id
 * Get a single article by ID or slug.
 */
export async function getArticle(req: Request, res: Response): Promise<void> {
    try {
        const cKey = cacheKey.articleDetail(req.params.id);
        const cached = await cache.getJson<any>(cKey);
        if (cached) { res.setHeader('X-Cache', 'HIT'); res.json(cached); return; }

        const article = await prisma.article.findFirst({
            where: {
                OR: [{ id: req.params.id }, { slug: req.params.id }],
                isPublished: true,
            },
        });

        if (!article) { res.status(404).json({ error: 'Article not found' }); return; }

        const result = { ...article, tags: JSON.parse(article.tags || '[]') };
        await cache.setJson(cKey, result, TTL.CONTENT_DETAIL);
        res.json(result);
    } catch (error) {
        console.error('Get article error:', error);
        res.status(500).json({ error: 'Failed to get article' });
    }
}

/**
 * POST /content/articles
 * Create an article (admin only).
 */
export async function createArticle(req: Request, res: Response): Promise<void> {
    try {
        const data: any = { ...req.body };
        if (data.tags) data.tags = JSON.stringify(data.tags);

        const article = await prisma.article.create({ data });
        await cache.delPattern('articles:');

        res.status(201).json({ ...article, tags: JSON.parse(article.tags || '[]') });
    } catch (error: any) {
        if (error?.code === 'P2002') {
            res.status(409).json({ error: 'An article with this slug already exists' }); return;
        }
        console.error('Create article error:', error);
        res.status(500).json({ error: 'Failed to create article' });
    }
}

/**
 * PUT /content/articles/:id
 * Update an article (admin only).
 */
export async function updateArticle(req: Request, res: Response): Promise<void> {
    try {
        const data: any = { ...req.body };
        if (data.tags) data.tags = JSON.stringify(data.tags);

        const article = await prisma.article.update({
            where: { id: req.params.id },
            data,
        });

        await Promise.all([
            cache.del(cacheKey.articleDetail(req.params.id)),
            cache.delPattern('articles:'),
        ]);

        res.json({ ...article, tags: JSON.parse(article.tags || '[]') });
    } catch (error) {
        console.error('Update article error:', error);
        res.status(500).json({ error: 'Failed to update article' });
    }
}

// ─── Video Controllers ───

/**
 * GET /content/videos
 * List published videos with optional category filter.
 */
export async function listVideos(req: Request, res: Response): Promise<void> {
    try {
        const { category, page = '1', limit = '20' } = req.query;
        const skip = (parseInt(page as string, 10) - 1) * parseInt(limit as string, 10);
        const take = Math.min(parseInt(limit as string, 10), 50);

        const cKey = cacheKey.videos({
            category: category as string || '',
            page: page as string,
            limit: limit as string,
        });

        const cached = await cache.getJson<any>(cKey);
        if (cached) { res.setHeader('X-Cache', 'HIT'); res.json(cached); return; }

        const where: any = { isPublished: true };
        if (category && typeof category === 'string') where.category = category.toUpperCase();

        const [videos, total] = await Promise.all([
            prisma.video.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
            prisma.video.count({ where }),
        ]);

        const result = {
            data: videos.map((v) => ({ ...v, tags: JSON.parse(v.tags || '[]') })),
            pagination: { page: parseInt(page as string, 10), limit: take, total, totalPages: Math.ceil(total / take) },
        };

        await cache.setJson(cKey, result, TTL.CONTENT_LIST);
        res.json(result);
    } catch (error) {
        console.error('List videos error:', error);
        res.status(500).json({ error: 'Failed to list videos' });
    }
}

/**
 * POST /content/videos
 * Create a video entry (admin only).
 */
export async function createVideo(req: Request, res: Response): Promise<void> {
    try {
        const data: any = { ...req.body };
        if (data.tags) data.tags = JSON.stringify(data.tags);

        const video = await prisma.video.create({ data });
        await cache.delPattern('videos:');

        res.status(201).json({ ...video, tags: JSON.parse(video.tags || '[]') });
    } catch (error) {
        console.error('Create video error:', error);
        res.status(500).json({ error: 'Failed to create video' });
    }
}

// ─── Legal Resource Controllers ───

/**
 * GET /content/resources
 * List published legal resources.
 */
export async function listResources(req: Request, res: Response): Promise<void> {
    try {
        const cKey = cacheKey.resources();
        const cached = await cache.getJson<any>(cKey);
        if (cached) { res.setHeader('X-Cache', 'HIT'); res.json(cached); return; }

        const resources = await prisma.legalResource.findMany({
            where: { isPublished: true },
            orderBy: { createdAt: 'desc' },
        });

        const result = { data: resources };
        await cache.setJson(cKey, result, TTL.CONTENT_LIST);
        res.json(result);
    } catch (error) {
        console.error('List resources error:', error);
        res.status(500).json({ error: 'Failed to list resources' });
    }
}

/**
 * GET /content/resources/:id/download
 * Get a presigned download URL for a legal resource.
 */
export async function downloadResource(req: Request, res: Response): Promise<void> {
    try {
        const resource = await prisma.legalResource.findUnique({
            where: { id: req.params.id },
        });

        if (!resource || !resource.isPublished) {
            res.status(404).json({ error: 'Resource not found' }); return;
        }

        const url = await getPresignedUrl(resource.fileKey);
        res.json({ url, fileName: resource.fileName, expiresIn: 900 });
    } catch (error) {
        console.error('Download resource error:', error);
        res.status(500).json({ error: 'Failed to get resource download URL' });
    }
}

/**
 * POST /content/resources
 * Create a legal resource entry (admin only).
 */
export async function createResource(req: Request, res: Response): Promise<void> {
    try {
        const resource = await prisma.legalResource.create({ data: req.body });
        await cache.del(cacheKey.resources());
        res.status(201).json(resource);
    } catch (error) {
        console.error('Create resource error:', error);
        res.status(500).json({ error: 'Failed to create resource' });
    }
}
