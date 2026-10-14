import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { publishProject, publishProjectListing, publishAnnouncement } from '../services/nostr.service';
import { getPresignedUrl } from '../services/storage.service';
import { cache, cacheKey, TTL } from '../services/redis.service';
import { notifyProjectUpdate, notifyDeckRequest, notifyDeckApproved, notifyDeckDenied, notifyInvestmentInterest } from '../services/notification.service';
import { z } from 'zod';
import { withoutDeckKey } from '../utils/projectFields';
import { nestedProfileForViewer } from '../services/profilePrivacy';

// ─── Validation ───────────────────────────────────────────────────────────────

// http(s) links only.
const webLink = z.string().trim().max(2000)
    .refine((v) => v === '' || /^https?:\/\//i.test(v), { message: 'Links must start with https://' });

export const createProjectSchema = z.object({
    title: z.string().min(1).max(200),
    description: z.string().min(1),
    category: z.enum([
        'ENERGY', 'FINTECH', 'EDUCATION', 'AGRICULTURE',
        'REAL_ESTATE', 'INFRASTRUCTURE', 'TOURISM', 'TECHNOLOGY',
        'FITNESS', 'HEALTH', 'SAAS', 'ECOMMERCE', 'WEB3', 'ENTERTAINMENT', 'LOGISTICS', 'OTHER',
    ]).default('OTHER'),
    stage: z.enum(['IDEA', 'MVP', 'GROWTH', 'SCALING']).default('IDEA'),
    fundingGoal: z.number().positive().optional(),
    raisedAmount: z.number().min(0).optional(),
    thumbnail: z.string().optional().or(z.literal('')),
    // http(s) only: zod's url() lets javascript: through.
    demoUrl: webLink.optional(),
    websiteUrl: webLink.optional(),
    tags: z.array(z.string()).optional(),
    customSections: z.array(z.any()).optional(),
    teamInfo: z.array(z.object({ name: z.string(), position: z.string().optional(), avatar: z.string().optional() })).optional(),
    useOfFunds: z.array(z.object({ label: z.string(), percentage: z.union([z.string(), z.number()]) })).optional(),
    ownerRole: z.string().optional(),
    isPublished: z.boolean().optional(),
    requiresDeckApproval: z.boolean().optional(),
});

export const updateProjectSchema = createProjectSchema.partial();

export const deckRequestSchema = z.object({
    message: z.string().max(500).optional(),
});

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * GET /projects
 * List published projects with filtering, sorting, and caching.
 */
export async function listProjects(req: Request, res: Response): Promise<void> {
    try {
        const {
            category, stage, ownerId, search, featured,
            minFunding, maxFunding,
            page = '1', limit = '20',
            sort = 'newest',
        } = req.query;

        const skip = (parseInt(page as string, 10) - 1) * parseInt(limit as string, 10);
        const take = Math.min(parseInt(limit as string, 10), 50);

        // Try cache for non-owner, non-authenticated requests
        const cKey = cacheKey.projects({
            category: category as string || '',
            stage: stage as string || '',
            search: search as string || '',
            featured: featured as string || '',
            minFunding: minFunding as string || '',
            maxFunding: maxFunding as string || '',
            sort: sort as string,
            page: page as string,
            limit: limit as string,
        });

        if (!ownerId) {
            const cached = await cache.getJson<any>(cKey);
            if (cached) { res.setHeader('X-Cache', 'HIT'); res.json(cached); return; }
        }

        const where: any = { isPublished: true };

        if (category && typeof category === 'string') where.category = category.toUpperCase();
        if (stage && typeof stage === 'string') where.stage = stage.toUpperCase();
        if (ownerId && typeof ownerId === 'string') {
            where.ownerId = ownerId;
            // When viewing own projects, show all statuses
            if (req.user && req.user.id === ownerId) {
                delete where.isPublished;
                delete where.status;
            }
        }
        if (featured === 'true') where.isFeatured = true;
        if (search && typeof search === 'string') {
            where.OR = [
                { title: { contains: search } },
                { description: { contains: search } },
            ];
        }

        if (minFunding !== undefined || maxFunding !== undefined) {
            where.fundingGoal = {};
            if (minFunding !== undefined) {
                const min = parseInt(minFunding as string, 10);
                if (!isNaN(min)) where.fundingGoal.gte = min;
            }
            if (maxFunding !== undefined) {
                const max = parseInt(maxFunding as string, 10);
                if (!isNaN(max)) where.fundingGoal.lte = max;
            }
        }

        let orderBy: any = { createdAt: 'desc' };
        if (sort === 'oldest') orderBy = { createdAt: 'asc' };
        if (sort === 'title') orderBy = { title: 'asc' };
        if (sort === 'popular') orderBy = { viewCount: 'desc' };
        if (sort === 'funded') orderBy = { raisedAmount: 'desc' };

        const [projects, total] = await Promise.all([
            prisma.project.findMany({
                where,
                include: {
                    owner: {
                        select: {
                            id: true, nostrPubkey: true, role: true,
                            profile: { select: { name: true, avatar: true, company: true } },
                        },
                    },
                    _count: { select: { watchlisted: true, investments: true } },
                },
                skip,
                take,
                orderBy,
            }),
            prisma.project.count({ where }),
        ]);

        const parsed = projects.map((p) => ({
            ...withoutDeckKey(p),
            tags: JSON.parse(p.tags || '[]'),
            customSections: JSON.parse(p.customSections || '[]'),
            teamInfo: JSON.parse(p.teamInfo || '[]'),
            useOfFunds: JSON.parse(p.useOfFunds || '[]'),
        }));

        const result = {
            data: parsed,
            pagination: {
                page: parseInt(page as string, 10),
                limit: take,
                total,
                totalPages: Math.ceil(total / take),
            },
        };

        if (!ownerId) {
            await cache.setJson(cKey, result, TTL.PROJECT_LIST);
        }

        res.json(result);
    } catch (error) {
        console.error('List projects error:', error);
        res.status(500).json({ error: 'Failed to list projects' });
    }
}

/**
 * GET /projects/:id
 * Get a single project (cached).
 */
export async function getProject(req: Request, res: Response): Promise<void> {
    try {
        const cKey = cacheKey.projectDetail(req.params.id);
        const cached = await cache.getJson<any>(cKey);
        // An unpublished project is for its owner and admins, cached or not.
        const mayView = (p: { isPublished: boolean; ownerId: string }) =>
            p.isPublished || (!!req.user && (p.ownerId === req.user.id || req.user.isAdmin));
        // The owner's bio as their Settings → Privacy allows, per viewer.
        const shownTo = (p: any) => ({ ...p, owner: nestedProfileForViewer(p.owner, req.user?.id) });
        if (cached) {
            if (!mayView(cached)) { res.status(404).json({ error: 'Project not found' }); return; }
            res.setHeader('X-Cache', 'HIT'); res.json(shownTo(cached)); return;
        }

        const project = await prisma.project.findUnique({
            where: { id: req.params.id },
            include: {
                owner: {
                    select: {
                        id: true, nostrPubkey: true, role: true,
                        profile: { select: { name: true, avatar: true, company: true, bio: true, privacy: true } },
                    },
                },
                teamMembers: {
                    include: {
                        user: {
                            select: {
                                id: true, nostrPubkey: true,
                                profile: { select: { name: true, avatar: true, title: true } },
                            },
                        },
                    },
                },
                updates: {
                    orderBy: { createdAt: 'desc' },
                    take: 5,
                },
                _count: { select: { watchlisted: true, investments: true, views: true } },
            },
        });

        if (!project) {
            res.status(404).json({ error: 'Project not found' });
            return;
        }

        // Only allow owner/admin to view unpublished projects
        if (!mayView(project)) {
            res.status(404).json({ error: 'Project not found' });
            return;
        }

        const result = { ...withoutDeckKey(project), tags: JSON.parse(project.tags || '[]'), customSections: JSON.parse(project.customSections || '[]'), teamInfo: JSON.parse(project.teamInfo || '[]'), useOfFunds: JSON.parse(project.useOfFunds || '[]') };
        await cache.setJson(cKey, result, TTL.PROJECT_DETAIL);
        res.json(shownTo(result));
    } catch (error) {
        console.error('Get project error:', error);
        res.status(500).json({ error: 'Failed to get project' });
    }
}

/**
 * POST /projects
 * Create a project. Busts list cache. Syncs to Nostr.
 */
export async function createProject(req: Request, res: Response): Promise<void> {
    try {
        // Explicitly pick allowed fields — never allow isPublished, status, isFeatured, etc.
        const allowedFields = ['title', 'description', 'category', 'stage', 'fundingGoal', 'thumbnail', 'demoUrl', 'websiteUrl', 'tags', 'customSections', 'teamInfo', 'useOfFunds', 'requiresDeckApproval'];
        const data: any = {};
        for (const field of allowedFields) {
            if (req.body[field] !== undefined) data[field] = req.body[field];
        }
        if (data.tags) data.tags = JSON.stringify(data.tags);
        if (data.customSections) data.customSections = JSON.stringify(data.customSections);
        if (data.teamInfo) data.teamInfo = JSON.stringify(data.teamInfo);
        if (data.useOfFunds) data.useOfFunds = JSON.stringify(data.useOfFunds);

        const project = await prisma.project.create({
            data: { ...data, ownerId: req.user!.id, status: 'draft', isPublished: true },
            include: {
                owner: {
                    select: {
                        id: true, nostrPubkey: true,
                        profile: { select: { name: true } },
                    },
                },
            },
        });

        await cache.delPattern('projects:');

        // Publish to Nostr and store the event IDs
        const nostrPayload = {
            id: project.id,
            title: project.title,
            description: project.description,
            category: project.category,
            stage: project.stage,
            thumbnail: project.thumbnail,
        };

        publishProject(req.user!.id, nostrPayload).then(async (eventId) => {
            if (eventId) {
                await prisma.project.update({ where: { id: project.id }, data: { nostrEventId: eventId } });
            }
        }).catch((err) => console.error('[Nostr] Project sync failed:', err));

        // Publish NIP-99 classified listing (kind:30402)
        publishProjectListing(req.user!.id, {
            ...nostrPayload,
            fundingGoal: project.fundingGoal,
        }).then(async (listingEventId) => {
            if (listingEventId) {
                await prisma.project.update({ where: { id: project.id }, data: { nostrListingEventId: listingEventId } });
            }
        }).catch((err) => console.error('[Nostr] Project listing sync failed:', err));

        // Announce new project on the BIES feed
        const ownerName = project.owner?.profile?.name || 'A builder';
        publishAnnouncement(req.user!.id, `${ownerName} just created a new project: "${project.title}" in ${project.category}. Check it out on BIES!`, [['t', 'new-project']]).catch((err) =>
            console.error('[Nostr] Project announcement failed:', err)
        );

        res.status(201).json({ ...project, tags: JSON.parse(project.tags || '[]'), customSections: JSON.parse(project.customSections || '[]'), teamInfo: JSON.parse(project.teamInfo || '[]'), useOfFunds: JSON.parse(project.useOfFunds || '[]') });
    } catch (error) {
        console.error('Create project error:', error);
        res.status(500).json({ error: 'Failed to create project' });
    }
}

/**
 * PUT /projects/:id
 * Update a project (owner only). Busts caches.
 */
export async function updateProject(req: Request, res: Response): Promise<void> {
    try {
        const existing = await prisma.project.findUnique({
            where: { id: req.params.id },
            select: { ownerId: true },
        });

        if (!existing) { res.status(404).json({ error: 'Project not found' }); return; }
        if (existing.ownerId !== req.user!.id && !req.user!.isAdmin) {
            res.status(403).json({ error: 'Not authorized to update this project' }); return;
        }

        // Explicitly pick allowed fields — never allow isPublished, status, isFeatured, ownerId, etc.
        const allowedFields = ['title', 'description', 'category', 'stage', 'fundingGoal', 'raisedAmount', 'thumbnail', 'demoUrl', 'websiteUrl', 'tags', 'customSections', 'teamInfo', 'useOfFunds', 'ownerRole', 'requiresDeckApproval'];
        const data: any = {};
        for (const field of allowedFields) {
            if (req.body[field] !== undefined) data[field] = req.body[field];
        }
        if (data.tags) data.tags = JSON.stringify(data.tags);
        if (data.customSections) data.customSections = JSON.stringify(data.customSections);
        if (data.teamInfo) data.teamInfo = JSON.stringify(data.teamInfo);
        if (data.useOfFunds) data.useOfFunds = JSON.stringify(data.useOfFunds);

        const project = await prisma.project.update({
            where: { id: req.params.id },
            data,
        });

        await Promise.all([
            cache.del(cacheKey.projectDetail(req.params.id)),
            cache.delPattern('projects:'),
        ]);

        // Publish to Nostr and store the event IDs
        const nostrPayload = {
            id: project.id,
            title: project.title,
            description: project.description,
            category: project.category,
            stage: project.stage,
            thumbnail: project.thumbnail,
        };

        publishProject(req.user!.id, nostrPayload).then(async (eventId) => {
            if (eventId) {
                await prisma.project.update({ where: { id: project.id }, data: { nostrEventId: eventId } });
            }
        }).catch((err) => console.error('[Nostr] Project sync failed:', err));

        // Publish NIP-99 classified listing (kind:30402)
        publishProjectListing(req.user!.id, {
            ...nostrPayload,
            fundingGoal: project.fundingGoal,
        }).then(async (listingEventId) => {
            if (listingEventId) {
                await prisma.project.update({ where: { id: project.id }, data: { nostrListingEventId: listingEventId } });
            }
        }).catch((err) => console.error('[Nostr] Project listing sync failed:', err));

        res.json({ ...project, tags: JSON.parse(project.tags || '[]'), customSections: JSON.parse(project.customSections || '[]'), teamInfo: JSON.parse(project.teamInfo || '[]'), useOfFunds: JSON.parse(project.useOfFunds || '[]') });
    } catch (error) {
        console.error('Update project error:', error);
        res.status(500).json({ error: 'Failed to update project' });
    }
}

/**
 * DELETE /projects/:id
 * Soft-delete (owner only).
 */
export async function deleteProject(req: Request, res: Response): Promise<void> {
    try {
        const existing = await prisma.project.findUnique({
            where: { id: req.params.id },
            select: { ownerId: true },
        });

        if (!existing) { res.status(404).json({ error: 'Project not found' }); return; }
        if (existing.ownerId !== req.user!.id && !req.user!.isAdmin) {
            res.status(403).json({ error: 'Not authorized to delete this project' }); return;
        }

        await prisma.project.delete({
            where: { id: req.params.id },
        });

        await Promise.all([
            cache.del(cacheKey.projectDetail(req.params.id)),
            cache.delPattern('projects:'),
        ]);

        res.json({ message: 'Project deleted' });
    } catch (error) {
        console.error('Delete project error:', error);
        res.status(500).json({ error: 'Failed to delete project' });
    }
}

/**
 * POST /projects/:id/updates
 * Post a project update (builder only).
 */
export async function postProjectUpdate(req: Request, res: Response): Promise<void> {
    try {
        const project = await prisma.project.findUnique({
            where: { id: req.params.id },
            select: { ownerId: true, title: true },
        });

        if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
        if (project.ownerId !== req.user!.id && !req.user!.isAdmin) {
            res.status(403).json({ error: 'Not authorized' }); return;
        }

        const { title, content } = req.body;
        if (!title || !content) {
            res.status(400).json({ error: 'title and content are required' }); return;
        }

        const update = await prisma.projectUpdate.create({
            data: { projectId: req.params.id, title, content },
        });

        // Notify watchers
        const watchers = await prisma.watchlistItem.findMany({
            where: { projectId: req.params.id },
            select: { userId: true },
        });
        if (watchers.length > 0) {
            await notifyProjectUpdate({
                projectId: req.params.id,
                projectTitle: project.title,
                updateTitle: title,
                watcherIds: watchers.map((w) => w.userId),
            });
        }

        await cache.del(cacheKey.projectDetail(req.params.id));
        res.status(201).json(update);
    } catch (error) {
        console.error('Post project update error:', error);
        res.status(500).json({ error: 'Failed to post update' });
    }
}

/**
 * GET /projects/:id/deck
 * Presigned URL for pitch deck. Owner/admin always have access.
 * Investors must have an approved DeckRequest.
 */
export async function getProjectDeck(req: Request, res: Response): Promise<void> {
    try {
        const project = await prisma.project.findUnique({
            where: { id: req.params.id },
            select: { deckKey: true, ownerId: true, requiresDeckApproval: true },
        });

        if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
        if (!project.deckKey) { res.status(404).json({ error: 'No pitch deck uploaded for this project' }); return; }

        const isOwner = project.ownerId === req.user!.id;
        const isAdmin = req.user!.isAdmin;
        const isInvestor = req.user!.role === 'INVESTOR';

        // Owner and admin always have access
        // If approval isn't required, any investor can access it instantly
        if (isOwner || isAdmin || (!project.requiresDeckApproval && isInvestor)) {
            const url = await getPresignedUrl(project.deckKey);
            res.json({ url, expiresIn: 900 });
            return;
        }

        // Investors need an approved DeckRequest
        if (isInvestor) {
            const approvedRequest = await prisma.deckRequest.findUnique({
                where: {
                    projectId_investorId: {
                        projectId: req.params.id,
                        investorId: req.user!.id,
                    },
                },
            });

            if (!approvedRequest || approvedRequest.status !== 'APPROVED') {
                res.status(403).json({
                    error: 'Deck access not approved. Please request access first.',
                    requestStatus: approvedRequest?.status || null,
                });
                return;
            }

            const url = await getPresignedUrl(project.deckKey);
            res.json({ url, expiresIn: 900 });
            return;
        }

        res.status(403).json({ error: 'Only investors can view pitch decks' });
    } catch (error) {
        console.error('Get deck error:', error);
        res.status(500).json({ error: 'Failed to get pitch deck' });
    }
}

/**
 * POST /projects/:id/deck/request
 * Investor requests access to a project's pitch deck.
 */
export async function requestDeckAccess(req: Request, res: Response): Promise<void> {
    try {
        const projectId = req.params.id;
        const investorId = req.user!.id;

        const project = await prisma.project.findUnique({
            where: { id: projectId },
            select: { ownerId: true, title: true, deckKey: true },
        });

        if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
        if (!project.deckKey) { res.status(404).json({ error: 'No pitch deck available for this project' }); return; }
        if (project.ownerId === investorId) { res.status(400).json({ error: 'You own this project' }); return; }

        const existingRequest = await prisma.deckRequest.findUnique({
            where: {
                projectId_investorId: {
                    projectId,
                    investorId,
                },
            },
        });

        if (existingRequest) {
            res.status(400).json({ error: 'Deck request already exists' });
            return;
        }

        const deckRequest = await prisma.deckRequest.create({
            data: {
                projectId,
                investorId,
                message: req.body.message || '',
            },
        });

        // Notify builder
        const investor = await prisma.user.findUnique({
            where: { id: investorId },
            include: { profile: { select: { name: true } } },
        });
        await notifyDeckRequest({
            builderId: project.ownerId,
            investorName: investor?.profile?.name || 'An investor',
            projectTitle: project.title,
            projectId,
            requestId: deckRequest.id,
            message: req.body.message || '',
        });

        res.status(201).json(deckRequest);
    } catch (error: any) {
        if (error?.code === 'P2002') {
            res.status(409).json({ error: 'You have already requested this deck' });
            return;
        }
        console.error('Request deck access error:', error);
        res.status(500).json({ error: 'Failed to request deck access' });
    }
}

/**
 * GET /projects/:id/deck/requests
 * Builder sees pending deck requests for their project.
 */
export async function listDeckRequests(req: Request, res: Response): Promise<void> {
    try {
        const projectId = req.params.id;
        const project = await prisma.project.findUnique({
            where: { id: projectId },
            select: { ownerId: true },
        });

        if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
        if (project.ownerId !== req.user!.id && !req.user!.isAdmin) {
            res.status(403).json({ error: 'Not authorized' }); return;
        }

        const requests = await prisma.deckRequest.findMany({
            where: { projectId },
            orderBy: { createdAt: 'desc' },
            include: {
                investor: {
                    select: {
                        id: true, nostrPubkey: true,
                        profile: { select: { name: true, avatar: true, company: true, title: true } },
                    },
                },
            },
        });

        res.json({ data: requests });
    } catch (error) {
        console.error('List deck requests error:', error);
        res.status(500).json({ error: 'Failed to list deck requests' });
    }
}

/**
 * GET /projects/builder/deck-requests
 * Builder sees all pending and past deck requests across all their projects.
 */
export async function listAllDeckRequests(req: Request, res: Response): Promise<void> {
    try {
        const ownerId = req.user!.id;

        const requests = await prisma.deckRequest.findMany({
            where: {
                project: {
                    ownerId: ownerId
                }
            },
            orderBy: { createdAt: 'desc' },
            include: {
                project: {
                    select: { id: true, title: true }
                },
                investor: {
                    select: {
                        id: true, nostrPubkey: true,
                        profile: { select: { name: true, avatar: true, company: true, title: true } },
                    },
                },
            },
        });

        res.json({ data: requests });
    } catch (error) {
        console.error('List all deck requests error:', error);
        res.status(500).json({ error: 'Failed to list all deck requests' });
    }
}

/**
 * PUT /projects/:id/deck/requests/:requestId
 * Builder approves or denies a deck request.
 */
export async function reviewDeckRequest(req: Request, res: Response): Promise<void> {
    try {
        const { id: projectId, requestId } = req.params;
        const { status } = req.body;

        if (!['APPROVED', 'DENIED'].includes(status)) {
            res.status(400).json({ error: 'Status must be APPROVED or DENIED' }); return;
        }

        const project = await prisma.project.findUnique({
            where: { id: projectId },
            select: { ownerId: true, title: true },
        });

        if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
        if (project.ownerId !== req.user!.id && !req.user!.isAdmin) {
            res.status(403).json({ error: 'Not authorized' }); return;
        }

        // Only a request for this project: the owner check above is for it.
        const existingRequest = await prisma.deckRequest.findFirst({ where: { id: requestId, projectId }, select: { id: true } });
        if (!existingRequest) { res.status(404).json({ error: 'Request not found' }); return; }

        const deckRequest = await prisma.deckRequest.update({
            where: { id: existingRequest.id },
            data: { status, reviewedAt: new Date() },
        });

        // Notify investor
        if (status === 'APPROVED') {
            await notifyDeckApproved({
                investorId: deckRequest.investorId,
                projectTitle: project.title,
                projectId,
            });
        } else {
            await notifyDeckDenied({
                investorId: deckRequest.investorId,
                projectTitle: project.title,
                projectId,
            });
        }

        res.json(deckRequest);
    } catch (error) {
        console.error('Review deck request error:', error);
        res.status(500).json({ error: 'Failed to review deck request' });
    }
}

/**
 * PUT /projects/:id/submit
 * Submit a project for admin review (owner only).
 * Changes status from draft to pending-review.
 */
export async function submitProject(req: Request, res: Response): Promise<void> {
    try {
        const project = await prisma.project.findUnique({
            where: { id: req.params.id },
            select: { ownerId: true, status: true, title: true },
        });

        if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
        if (project.ownerId !== req.user!.id) {
            res.status(403).json({ error: 'Not authorized' }); return;
        }
        if (project.status === 'pending-review') {
            res.status(400).json({ error: 'Project is already pending review' }); return;
        }
        if (project.status === 'active') {
            res.status(400).json({ error: 'Project is already approved' }); return;
        }

        const updated = await prisma.project.update({
            where: { id: req.params.id },
            data: { status: 'pending-review' },
        });

        await cache.delPattern('projects:');

        // Notify admins
        const admins = await prisma.user.findMany({
            where: { isAdmin: true },
            select: { id: true },
        });
        for (const admin of admins) {
            await prisma.notification.create({
                data: {
                    userId: admin.id,
                    type: 'SYSTEM',
                    title: 'New Project Submission',
                    body: `"${project.title}" has been submitted for review.`,
                    data: JSON.stringify({ projectId: req.params.id }),
                },
            });
        }

        res.json({ id: updated.id, status: updated.status });
    } catch (error) {
        console.error('Submit project error:', error);
        res.status(500).json({ error: 'Failed to submit project' });
    }
}

/**
 * POST /projects/:id/interest
 * Investor expresses interest in a project. Automatically adds to watchlist and notifies Builder.
 */
export async function expressInterest(req: Request, res: Response): Promise<void> {
    try {
        const projectId = req.params.id;
        const investorId = req.user!.id;

        if (req.user!.role !== 'INVESTOR') {
            res.status(403).json({ error: 'Only investors can express interest' });
            return;
        }

        const project = await prisma.project.findUnique({
            where: { id: projectId },
            select: { ownerId: true, title: true, id: true },
        });

        if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
        if (project.ownerId === investorId) { res.status(400).json({ error: 'You own this project' }); return; }

        // Always ensure project is watchlisted if they express interest
        await prisma.watchlistItem.upsert({
            where: {
                userId_projectId: {
                    userId: investorId,
                    projectId: projectId,
                }
            },
            create: { userId: investorId, projectId: projectId, note: 'Expressed Interest' },
            update: {}, // Do nothing if it already exists
        });

        // Notify builder
        const investor = await prisma.user.findUnique({
            where: { id: investorId },
            include: { profile: { select: { name: true } } },
        });

        await notifyInvestmentInterest({
            builderId: project.ownerId,
            investorName: investor?.profile?.name || 'An investor',
            projectTitle: project.title,
            projectId: project.id,
        });

        res.status(200).json({ message: 'Interest expressed successfully' });
    } catch (error) {
        console.error('Express interest error:', error);
        res.status(500).json({ error: 'Failed to express interest' });
    }
}
