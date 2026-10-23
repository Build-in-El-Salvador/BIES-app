/**
 * Opportunities: what members post for other members to take up. A project
 * (what a member is building and who they'd like to meet), a business for
 * sale, a job, a partnership, or a grant or program. The model and these
 * routes (/api/projects) keep the name they had when every one was a project
 * raising money; those are the `investment` type, shown as Projects since
 * 2026-10-19: no raise, terms or amounts, as BIES connects people and doesn't
 * arrange investments. Their pitch decks stay, shared one member at a time.
 *
 * Members only: a member's WhatsApp and email are on it. Its member posts it,
 * changes it, and closes it once it's taken; staff can remove it (a report).
 * It's open until then, or until its closing day ends in El Salvador. Its
 * photos are the member's own BIES uploads (POST /upload/media), and they go
 * when they're taken off it or it goes (services/uploads.service.ts).
 */

import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { getPresignedUrl } from '../services/storage.service';
import { notifyDeckRequest, notifyDeckApproved, notifyDeckDenied } from '../services/notification.service';
import { z } from 'zod';
import { withoutDeckKey } from '../utils/projectFields';
import { nestedProfileForViewer } from '../services/profilePrivacy';
import { blockedIds, hasBlocked, hiddenFromIds, isStaffUser } from '../services/moderation.service';
import { discardUploadNames, discardUploads, ownsUploads, uploadNameOf } from '../services/uploads.service';
import { alphabetical, inIdOrder, inOrder, missingLast, newestFirst, pageIds } from '../utils/listOrder';

// ─── Lists ────────────────────────────────────────────────────────────────────

/** What an opportunity is (labels: opportunities.types.* in the app). */
export const OPPORTUNITY_TYPES = ['investment', 'business-for-sale', 'job', 'partnership', 'program'] as const;
export type OpportunityType = (typeof OPPORTUNITY_TYPES)[number];

/**
 * The kinds within each type (labels: opportunities.kinds.<type>.*): who a
 * project is looking for, a job's hours, who a partnership is looking for,
 * what a program is. A business for sale has none. Older projects' deals
 * (equity, loan…) aren't kinds any more; an edit that leaves the kind alone
 * still saves.
 */
export const OPPORTUNITY_KINDS: Record<OpportunityType, readonly string[]> = {
    investment: ['investors', 'co-founder', 'team', 'mentors', 'partners', 'other'],
    'business-for-sale': [],
    job: ['full-time', 'part-time', 'contract', 'internship', 'volunteer'],
    partnership: ['co-founder', 'partner', 'distributor', 'supplier', 'sponsor', 'other'],
    program: ['grant', 'accelerator', 'competition', 'other'],
};

/** The types that must say their kind; who a project is looking for is optional. */
const KIND_REQUIRED: readonly OpportunityType[] = ['job', 'partnership', 'program'];

/** Industries (labels: opportunities.industries.*). */
export const INDUSTRIES = [
    'AGRICULTURE', 'CONSTRUCTION', 'EDUCATION', 'ENERGY', 'ENTERTAINMENT', 'FINTECH', 'FOOD', 'HEALTH',
    'INFRASTRUCTURE', 'LOGISTICS', 'REAL_ESTATE', 'RETAIL', 'SERVICES', 'TECHNOLOGY', 'TOURISM', 'OTHER',
] as const;

/** A project's stage (labels: opportunities.stages.*). */
export const STAGES = ['IDEA', 'MVP', 'GROWTH', 'SCALING'] as const;

export const MAX_PHOTOS = 6;
/** Opportunities a member can have open at once; closed ones don't count. */
export const MAX_OPEN_PER_MEMBER = 10;

/** What every opportunity has. */
const COMMON_FIELDS = ['title', 'description', 'category', 'kind', 'location', 'photos', 'whatsapp', 'email', 'websiteUrl', 'closesOn'];

/**
 * What each type has as well; anything else sent for it is left out. A
 * project has no amounts: older ones' raise columns stay as they were, unshown.
 */
const TYPE_FIELDS: Record<OpportunityType, readonly string[]> = {
    investment: ['stage', 'requiresDeckApproval'],
    'business-for-sale': ['price', 'revenue', 'btcAccepted'],
    job: ['pay', 'remote', 'btcAccepted'],
    partnership: ['remote'],
    program: ['price', 'remote'],
};

// ─── Validation ───────────────────────────────────────────────────────────────

const phoneRegex = /^[+0-9\s()-]*$/;

// http(s) links only.
const webLink = z.string().trim().max(2000)
    .refine((v) => v === '' || /^https?:\/\//i.test(v), { message: 'Links must start with https://' });

/** A day on the calendar, as YYYY-MM-DD. */
const calendarDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => {
    const day = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(day.getTime()) && day.toISOString().startsWith(v);
}, { message: 'Not a date' });

const dollars = z.number().min(0).max(1e12);

const opportunityFields = z.object({
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(5000),
    category: z.enum(INDUSTRIES),
    kind: z.string().max(40),
    stage: z.enum(STAGES),
    fundingGoal: z.number().positive().max(1e12).nullable(),
    raisedAmount: dollars,
    price: z.number().positive().max(1e12).nullable(),
    revenue: dollars.nullable(),
    pay: z.string().trim().max(120),
    location: z.string().trim().max(120),
    remote: z.boolean(),
    btcAccepted: z.boolean(),
    photos: z.array(z.string().min(1).max(500)).max(MAX_PHOTOS),
    whatsapp: z.string().trim().max(30).regex(phoneRegex),
    email: z.string().trim().max(254).email().or(z.literal('')),
    // A link to read more or to apply.
    websiteUrl: webLink,
    closesOn: calendarDay.or(z.literal('')),
    // A pitch deck only members it's shared with can open.
    requiresDeckApproval: z.boolean(),
}).partial();

export const createProjectSchema = opportunityFields.extend({
    type: z.enum(OPPORTUNITY_TYPES),
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(5000),
});

// Its type stays what it was posted as.
export const updateProjectSchema = opportunityFields.extend({
    // Taken (a job filled, a business sold, a raise done), or open again.
    closed: z.boolean().optional(),
});

export const deckRequestSchema = z.object({
    message: z.string().max(500).optional(),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
    try {
        const value = JSON.parse(raw || '');
        return Array.isArray(value) ? value as T : fallback;
    } catch {
        return fallback;
    }
}

const typeOf = (type: string): OpportunityType =>
    ((OPPORTUNITY_TYPES as readonly string[]).includes(type) ? type : 'investment') as OpportunityType;

/** Today in El Salvador (UTC−6 all year), as YYYY-MM-DD. */
export function elSalvadorToday(now = new Date()): string {
    return new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Open: not closed by its member, and its closing day, if it has one, not over in El Salvador. A where clause. */
export function openNow() {
    return { closedAt: null, OR: [{ closesOn: '' }, { closesOn: { gte: elSalvadorToday() } }] };
}

export function isOpen(project: { closedAt: Date | null; closesOn: string }): boolean {
    return !project.closedAt && (!project.closesOn || project.closesOn >= elSalvadorToday());
}

/** A closing day that is already over in El Salvador. */
const hasPassed = (day: unknown): boolean => typeof day === 'string' && day !== '' && day < elSalvadorToday();

const passedDay = (res: Response) => res.status(400).json({ error: 'That closing day has passed', reason: 'invalid', field: 'closesOn' });

/** The columns to write for an opportunity of this type, from a validated body: only its type's. */
function opportunityData(type: OpportunityType, body: Record<string, any>): Record<string, any> {
    const data: Record<string, any> = {};
    for (const field of [...COMMON_FIELDS, ...TYPE_FIELDS[type]]) {
        if (body[field] !== undefined) data[field] = body[field];
    }
    if (Array.isArray(body.photos)) {
        const photos = [...new Set(body.photos as string[])];
        data.photos = JSON.stringify(photos);
        data.thumbnail = photos[0] ?? '';
    }
    return data;
}

/**
 * What's wrong with an opportunity of this type as it would be saved, or
 * null. `changed` limits the checks to what an edit changes, so an older
 * project can still be edited or closed as it is.
 */
function problemWith(type: OpportunityType, o: Record<string, any>, changed?: string[]): { field: string; error: string } | null {
    const checks = (...fields: string[]) => !changed || fields.some((f) => changed.includes(f));
    const kinds = OPPORTUNITY_KINDS[type];
    if (checks('kind')) {
        if (o.kind && !kinds.includes(o.kind)) return { field: 'kind', error: `"${o.kind}" isn't a kind of ${type}` };
        if (!o.kind && KIND_REQUIRED.includes(type)) return { field: 'kind', error: 'Say what kind it is' };
    }
    if (checks('whatsapp', 'email', 'websiteUrl') && !o.whatsapp && !o.email && !o.websiteUrl) {
        return { field: 'contact', error: 'Add a way to reach you: WhatsApp, email or a link' };
    }
    return null;
}

/** The names of an opportunity's stored files: its photos and its pitch deck. */
export function opportunityFileNames(project: { photos: string; thumbnail: string; deckKey: string | null }): string[] {
    const photos = [...parseJson<string[]>(project.photos, []), project.thumbnail].map(uploadNameOf);
    const deck = project.deckKey?.split('/').pop() ?? null;
    return [...new Set([...photos, deck].filter((name): name is string => !!name))];
}

/** Once an opportunity is deleted, its files go (unless something else still shows them). */
export async function discardOpportunityFiles(project: { ownerId: string; photos: string; thumbnail: string; deckKey: string | null }): Promise<void> {
    const names = opportunityFileNames(project);
    if (names.length) await discardUploadNames(names, { uploadedBy: [project.ownerId] });
}

const ownerSelect = {
    select: {
        id: true, nostrPubkey: true, isBanned: true, deletedAt: true,
        profile: { select: { name: true, avatar: true } },
    },
};

/** As the app gets it: without its deck's key, lists parsed, whether it's open, and only its member's name and photo. */
function shaped(project: any): Record<string, any> {
    const { owner, ...rest } = withoutDeckKey(project);
    return {
        ...rest,
        photos: parseJson(project.photos, []),
        tags: parseJson(project.tags, []),
        customSections: parseJson(project.customSections, []),
        teamInfo: parseJson(project.teamInfo, []),
        useOfFunds: parseJson(project.useOfFunds, []),
        isOpen: isOpen(project),
        owner: owner && {
            id: owner.id,
            nostrPubkey: owner.nostrPubkey,
            profile: { name: owner.profile?.name ?? '', avatar: owner.profile?.avatar ?? '' },
        },
    };
}

/** In a list, without the member's WhatsApp and email: those come only with one opportunity. */
function listed(project: any) {
    const { whatsapp: _whatsapp, email: _email, ...rest } = shaped(project);
    return rest;
}

// One staff took down doesn't count.
const openCount = (ownerId: string, notId?: string) =>
    prisma.project.count({ where: { ownerId, isPublished: true, ...(notId ? { id: { not: notId } } : {}), ...openNow() } });

const tooMany = (res: Response) => res.status(409).json({
    error: `You can have up to ${MAX_OPEN_PER_MEMBER} open opportunities. Close one that's taken first.`,
    reason: 'too_many',
    max: MAX_OPEN_PER_MEMBER,
});

/** A price filter: { gte, lte } from ?minAmount&maxAmount, or null. */
function amountRange(min: unknown, max: unknown): { gte?: number; lte?: number } | null {
    const range: { gte?: number; lte?: number } = {};
    const low = typeof min === 'string' ? Number(min) : NaN;
    const high = typeof max === 'string' ? Number(max) : NaN;
    if (min !== '' && Number.isFinite(low)) range.gte = low;
    if (max !== '' && Number.isFinite(high)) range.lte = high;
    return Object.keys(range).length ? range : null;
}

// ─── Controllers ──────────────────────────────────────────────────────────────

// Opportunities' orders other than the newest, sorted in code (utils/listOrder.ts):
// closing days and prices can be missing, and those go last. Ties, newest first.
type OpportunitySortKeys = { id: string; title: string; closesOn: string; price: number | null; createdAt: Date };
const newestOpportunity = newestFirst<OpportunitySortKeys>((o) => o.createdAt);
const OPPORTUNITY_ORDERS_IN_CODE: Record<string, (a: OpportunitySortKeys, b: OpportunitySortKeys) => number> = {
    closing: inOrder(missingLast((o) => o.closesOn, 1), newestOpportunity),
    name: inOrder(alphabetical((o) => o.title), newestOpportunity),
    'price-low': inOrder(missingLast((o) => o.price, 1), newestOpportunity),
    'price-high': inOrder(missingLast((o) => o.price, -1), newestOpportunity),
};

/**
 * GET /projects?type&kind&category&stage&search&btc&remote&minAmount&maxAmount&ownerId&saved&sort&page&limit
 * Open opportunities, featured then newest; or ?sort=closing (the soonest
 * closing day first), name (A–Z), price-low or price-high (a business's
 * price, the most a program gives; those without one last). A member's own (?ownerId=<them>)
 * come closed or not; the ones they saved (?saved=true) too. Never those of
 * suspended or deleted members, nor of members blocked either way.
 */
export async function listProjects(req: Request, res: Response): Promise<void> {
    try {
        const viewer = req.user!;
        const { type, types, kind, category, stage, search, btc, remote, minAmount, maxAmount, ownerId, saved, featured } = req.query;
        const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
        const take = Math.min(Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20), 50);

        const own = typeof ownerId === 'string' && ownerId === viewer.id;
        const savedOnly = saved === 'true';
        const where: any = { owner: { isBanned: false, deletedAt: null } };
        const and: any[] = [];
        if (!own) where.isPublished = true;
        if (!own && !savedOnly) and.push(openNow());
        if (typeof ownerId === 'string' && ownerId) where.ownerId = ownerId;
        if (savedOnly) where.watchlisted = { some: { userId: viewer.id } };

        const theType = typeof type === 'string' && (OPPORTUNITY_TYPES as readonly string[]).includes(type) ? type as OpportunityType : null;
        if (theType) {
            where.type = theType;
            if (typeof kind === 'string' && OPPORTUNITY_KINDS[theType].includes(kind)) where.kind = kind;
            if (theType === 'investment' && typeof stage === 'string' && (STAGES as readonly string[]).includes(stage)) where.stage = stage;
        }
        // Only the types the asker shows (?types=job,program): the phone app can leave some out.
        if (typeof types === 'string' && types) {
            and.push({ type: { in: types.split(',').filter((ty) => (OPPORTUNITY_TYPES as readonly string[]).includes(ty)) } });
        }
        if (typeof category === 'string' && (INDUSTRIES as readonly string[]).includes(category)) where.category = category;
        // Projects don't say (older ones may still have it stored).
        if (btc === 'true') { where.btcAccepted = true; and.push({ type: { not: 'investment' } }); }
        if (remote === 'true') where.remote = true;
        if (featured === 'true') where.isFeatured = true;

        // Its price (a business) or the most it gives (a program); projects have no amounts.
        const range = amountRange(minAmount, maxAmount);
        if (range) {
            if (theType === 'business-for-sale' || theType === 'program') where.price = range;
            else if (!theType) and.push({ type: { in: ['business-for-sale', 'program'] }, price: range });
        }

        if (typeof search === 'string' && search.trim()) {
            const q = search.trim().slice(0, 100);
            and.push({
                OR: [
                    { title: { contains: q } },
                    { description: { contains: q } },
                    { location: { contains: q } },
                    { pay: { contains: q } },
                    { owner: { profile: { is: { name: { contains: q } } } } },
                ],
            });
        }

        const hidden = await hiddenFromIds(viewer.id, { staff: isStaffUser(viewer) });
        if (hidden.length) and.push({ ownerId: { notIn: hidden } });
        if (and.length) where.AND = and;

        const inCode = typeof req.query.sort === 'string' ? OPPORTUNITY_ORDERS_IN_CODE[req.query.sort] : undefined;
        let projects: any[];
        let total: number;
        if (inCode) {
            const keys = await prisma.project.findMany({
                where,
                select: { id: true, title: true, closesOn: true, price: true, createdAt: true },
            });
            const ids = pageIds(keys, inCode, (page - 1) * take, take);
            projects = inIdOrder(ids, await prisma.project.findMany({ where: { id: { in: ids } }, include: { owner: ownerSelect } }));
            total = keys.length;
        } else {
            [projects, total] = await Promise.all([
                prisma.project.findMany({
                    where,
                    include: { owner: ownerSelect },
                    orderBy: [{ isFeatured: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
                    skip: (page - 1) * take,
                    take,
                }),
                prisma.project.count({ where }),
            ]);
        }

        res.json({
            data: projects.map(listed),
            pagination: { page, limit: take, total, totalPages: Math.ceil(total / take) },
        });
    } catch (error) {
        console.error('List opportunities error:', error);
        res.status(500).json({ error: 'Failed to list opportunities' });
    }
}

/**
 * GET /projects/:id
 * One opportunity, with how to reach its member, whether the viewer saved
 * it, and where the viewer stands with its pitch deck (deckAccess).
 */
export async function getProject(req: Request, res: Response): Promise<void> {
    try {
        const viewer = req.user!;
        const project = await prisma.project.findUnique({
            where: { id: req.params.id },
            include: {
                owner: {
                    select: {
                        id: true, nostrPubkey: true, isBanned: true, deletedAt: true,
                        profile: { select: { name: true, avatar: true, company: true, bio: true, privacy: true } },
                    },
                },
            },
        });
        const own = !!project && project.ownerId === viewer.id;
        const staff = isStaffUser(viewer);
        if (!project || ((!project.isPublished || project.owner.isBanned || project.owner.deletedAt) && !own && !staff)) {
            res.status(404).json({ error: 'Opportunity not found' });
            return;
        }
        // A member the viewer blocked: their opportunities are gone for the viewer.
        if ((await blockedIds(viewer.id)).includes(project.ownerId)) {
            res.status(404).json({ error: 'You blocked this member', reason: 'blocked' });
            return;
        }
        // The member blocked the viewer: it isn't there for them.
        if (!own && !staff && await hasBlocked(project.ownerId, { id: viewer.id })) {
            res.status(404).json({ error: 'Opportunity not found' });
            return;
        }

        const [savedItem, deckRequest] = await Promise.all([
            prisma.watchlistItem.findUnique({ where: { userId_projectId: { userId: viewer.id, projectId: project.id } }, select: { id: true } }),
            project.deckKey && !own && project.requiresDeckApproval
                ? prisma.deckRequest.findUnique({ where: { projectId_investorId: { projectId: project.id, investorId: viewer.id } }, select: { status: true } })
                : null,
        ]);
        // own | open (no asking needed) | approved | pending | denied | ask; null without a deck.
        const deckAccess = !project.deckKey ? null
            : own ? 'own'
                : !project.requiresDeckApproval ? 'open'
                    : deckRequest ? deckRequest.status.toLowerCase() : 'ask';

        const { owner, ...rest } = project;
        res.json({
            ...shaped({ ...rest, owner }),
            // The member's bio as their Settings → Privacy allows.
            owner: nestedProfileForViewer({
                id: owner.id,
                nostrPubkey: owner.nostrPubkey,
                profile: { name: owner.profile?.name ?? '', avatar: owner.profile?.avatar ?? '', company: owner.profile?.company ?? '', bio: owner.profile?.bio ?? '', privacy: owner.profile?.privacy },
            }, viewer.id),
            saved: !!savedItem,
            deckAccess,
        });
    } catch (error) {
        console.error('Get opportunity error:', error);
        res.status(500).json({ error: 'Failed to get opportunity' });
    }
}

/** POST /projects: a member posts an opportunity. It's up at once. */
export async function createProject(req: Request, res: Response): Promise<void> {
    try {
        const userId = req.user!.id;
        const type = req.body.type as OpportunityType;
        const data = opportunityData(type, req.body);
        const problem = problemWith(type, data);
        if (problem) {
            res.status(400).json({ error: problem.error, reason: 'invalid', field: problem.field });
            return;
        }
        if (hasPassed(data.closesOn)) { passedDay(res); return; }
        if (await openCount(userId) >= MAX_OPEN_PER_MEMBER) { tooMany(res); return; }
        const photos = parseJson<string[]>(data.photos, []);
        if (photos.length && !(await ownsUploads(userId, photos))) {
            res.status(400).json({ error: 'Add photos by uploading them here', reason: 'not_your_photo' });
            return;
        }

        const project = await prisma.project.create({
            data: { ...data, type, ownerId: userId, status: 'active', isPublished: true } as any,
            include: { owner: ownerSelect },
        });
        // Counted again: requests sent at once all passed the count above.
        if (await openCount(userId) > MAX_OPEN_PER_MEMBER) {
            await prisma.project.delete({ where: { id: project.id } });
            tooMany(res);
            return;
        }
        res.status(201).json(shaped(project));
    } catch (error) {
        console.error('Create opportunity error:', error);
        res.status(500).json({ error: 'Failed to post the opportunity' });
    }
}

/** PUT /projects/:id: only the member who posted it. `closed` closes it, or opens it again. */
export async function updateProject(req: Request, res: Response): Promise<void> {
    try {
        const existing = await prisma.project.findUnique({ where: { id: req.params.id } });
        if (!existing) { res.status(404).json({ error: 'Opportunity not found' }); return; }
        if (existing.ownerId !== req.user!.id) {
            res.status(403).json({ error: 'Only the member who posted it can change it' });
            return;
        }

        const type = typeOf(existing.type);
        const data = opportunityData(type, req.body);
        // Only what it changes is checked: an older project's deal (equity…), sent back as it was, still saves.
        const changed = Object.keys(data).filter((field) => data[field] !== (existing as Record<string, unknown>)[field]);
        const problem = problemWith(type, { ...existing, ...data }, changed);
        if (problem) {
            res.status(400).json({ error: problem.error, reason: 'invalid', field: problem.field });
            return;
        }
        // A closing day that's over can stay as it was, but not be set now.
        if (hasPassed(data.closesOn) && (data.closesOn !== existing.closesOn || req.body.closed === false)) { passedDay(res); return; }
        if (req.body.closed === true && !existing.closedAt) data.closedAt = new Date();
        if (req.body.closed === false) {
            data.closedAt = null;
            // Opened again: a closing day that has passed goes too, unless a new one came with it.
            if (data.closesOn === undefined && existing.closesOn && existing.closesOn < elSalvadorToday()) data.closesOn = '';
        }
        // Open again (or a later closing day): it counts towards the limit again.
        const opening = !isOpen(existing) && isOpen({ ...existing, ...data });
        if (opening && await openCount(existing.ownerId, existing.id) >= MAX_OPEN_PER_MEMBER) {
            tooMany(res);
            return;
        }

        const before = parseJson<string[]>(existing.photos, []);
        const after = data.photos !== undefined ? parseJson<string[]>(data.photos, []) : before;
        const added = after.filter((url) => !before.includes(url));
        if (added.length && !(await ownsUploads(existing.ownerId, added))) {
            res.status(400).json({ error: 'Add photos by uploading them here', reason: 'not_your_photo' });
            return;
        }

        const project = await prisma.project.update({
            where: { id: req.params.id },
            data,
            include: { owner: ownerSelect },
        });

        // Photos taken off it go.
        const removed = before.filter((url) => !after.includes(url));
        if (removed.length) await discardUploads(removed, { uploadedBy: [existing.ownerId] });

        // Counted again: requests sent at once all passed the count above. It
        // goes back to closed; the rest of the change stays.
        if (opening && await openCount(existing.ownerId) > MAX_OPEN_PER_MEMBER) {
            await prisma.project.update({ where: { id: existing.id }, data: { closedAt: existing.closedAt, closesOn: existing.closesOn } });
            tooMany(res);
            return;
        }

        res.json(shaped(project));
    } catch (error) {
        console.error('Update opportunity error:', error);
        res.status(500).json({ error: 'Failed to update the opportunity' });
    }
}

/** DELETE /projects/:id: its member, or staff (a report). Its photos and pitch deck go with it. */
export async function deleteProject(req: Request, res: Response): Promise<void> {
    try {
        const existing = await prisma.project.findUnique({
            where: { id: req.params.id },
            select: { ownerId: true, title: true, photos: true, thumbnail: true, deckKey: true },
        });
        if (!existing) { res.status(404).json({ error: 'Opportunity not found' }); return; }
        const own = existing.ownerId === req.user!.id;
        if (!own && !isStaffUser(req.user)) {
            res.status(403).json({ error: 'Not authorized to delete this opportunity' });
            return;
        }

        await prisma.project.delete({ where: { id: req.params.id } });
        if (!own) {
            await prisma.auditLog.create({
                data: {
                    userId: req.user!.id,
                    action: 'OPPORTUNITY_REMOVED',
                    resource: `project:${req.params.id}`,
                    metadata: JSON.stringify({ memberId: existing.ownerId, title: existing.title.slice(0, 200) }),
                },
            });
        }
        await discardOpportunityFiles(existing);

        res.json({ message: 'Opportunity deleted' });
    } catch (error) {
        console.error('Delete opportunity error:', error);
        res.status(500).json({ error: 'Failed to delete the opportunity' });
    }
}

const deckOwnerSelect = { select: { isBanned: true, deletedAt: true } };

/**
 * Whether a member may see this opportunity's pitch deck page at all: it's
 * up, its member isn't suspended or gone, and they haven't blocked each
 * other. Its member and admins always may.
 */
async function mayAskForDeck(
    viewer: NonNullable<Request['user']>,
    project: { ownerId: string; isPublished: boolean; owner: { isBanned: boolean; deletedAt: Date | null } },
): Promise<boolean> {
    if (project.ownerId === viewer.id || viewer.isAdmin) return true;
    if (!project.isPublished || project.owner.isBanned || project.owner.deletedAt) return false;
    return !(await hiddenFromIds(viewer.id)).includes(project.ownerId);
}

/**
 * GET /projects/:id/deck
 * A 15-minute link to the pitch deck. Its member and admins always get one;
 * other members once their request is approved, or at once when the deck is
 * shared with every member (requiresDeckApproval off).
 */
export async function getProjectDeck(req: Request, res: Response): Promise<void> {
    try {
        const viewer = req.user!;
        const project = await prisma.project.findUnique({
            where: { id: req.params.id },
            select: { deckKey: true, ownerId: true, requiresDeckApproval: true, isPublished: true, owner: deckOwnerSelect },
        });

        if (!project || !(await mayAskForDeck(viewer, project))) { res.status(404).json({ error: 'Opportunity not found' }); return; }
        if (!project.deckKey) { res.status(404).json({ error: 'No pitch deck uploaded for this opportunity' }); return; }

        if (project.ownerId === viewer.id || viewer.isAdmin || !project.requiresDeckApproval) {
            res.json({ url: await getPresignedUrl(project.deckKey), expiresIn: 900 });
            return;
        }

        const request = await prisma.deckRequest.findUnique({
            where: { projectId_investorId: { projectId: req.params.id, investorId: viewer.id } },
        });
        if (request?.status === 'APPROVED') {
            res.json({ url: await getPresignedUrl(project.deckKey), expiresIn: 900 });
            return;
        }
        res.status(403).json({
            error: 'Ask for the pitch deck first',
            requestStatus: request?.status || null,
        });
    } catch (error) {
        console.error('Get deck error:', error);
        res.status(500).json({ error: 'Failed to get pitch deck' });
    }
}

/**
 * POST /projects/:id/deck/request
 * A member asks for an opportunity's pitch deck; its member says yes or no.
 */
export async function requestDeckAccess(req: Request, res: Response): Promise<void> {
    try {
        const projectId = req.params.id;
        const viewer = req.user!;

        const project = await prisma.project.findUnique({
            where: { id: projectId },
            select: { ownerId: true, title: true, deckKey: true, isPublished: true, owner: deckOwnerSelect },
        });

        if (!project || !(await mayAskForDeck(viewer, project))) { res.status(404).json({ error: 'Opportunity not found' }); return; }
        if (!project.deckKey) { res.status(404).json({ error: 'No pitch deck available for this opportunity' }); return; }
        if (project.ownerId === viewer.id) { res.status(400).json({ error: 'This is your opportunity' }); return; }

        const existingRequest = await prisma.deckRequest.findUnique({
            where: { projectId_investorId: { projectId, investorId: viewer.id } },
        });
        if (existingRequest) {
            res.status(400).json({ error: 'Deck request already exists' });
            return;
        }

        const deckRequest = await prisma.deckRequest.create({
            data: {
                projectId,
                investorId: viewer.id,
                message: req.body.message || '',
            },
        });

        // Tell its member.
        const asker = await prisma.user.findUnique({
            where: { id: viewer.id },
            include: { profile: { select: { name: true } } },
        });
        await notifyDeckRequest({
            builderId: project.ownerId,
            investorId: viewer.id,
            investorName: asker?.profile?.name || 'A member',
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

        // Not from members blocked either way, suspended or deleted: as elsewhere.
        const hidden = await hiddenFromIds(project.ownerId);
        const requests = await prisma.deckRequest.findMany({
            where: { projectId, investorId: { notIn: hidden }, investor: { isBanned: false, deletedAt: null } },
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
        const existingRequest = await prisma.deckRequest.findFirst({ where: { id: requestId, projectId } });
        if (!existingRequest) { res.status(404).json({ error: 'Request not found' }); return; }
        // Already answered that way: nothing changes, and they aren't told again.
        if (existingRequest.status === status) { res.json(existingRequest); return; }

        const deckRequest = await prisma.deckRequest.update({
            where: { id: existingRequest.id },
            data: { status, reviewedAt: new Date() },
        });

        // Tell the member who asked, once: the first answer (unless they've
        // blocked each other since). The app answers only a waiting request;
        // a change after that is told to no one, so it can't be used to spam.
        if (existingRequest.status === 'PENDING') {
            const told = { investorId: deckRequest.investorId, ownerId: project.ownerId, projectTitle: project.title, projectId };
            if (status === 'APPROVED') await notifyDeckApproved(told);
            else await notifyDeckDenied(told);
        }

        res.json(deckRequest);
    } catch (error) {
        console.error('Review deck request error:', error);
        res.status(500).json({ error: 'Failed to review deck request' });
    }
}
