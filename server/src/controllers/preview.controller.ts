import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { config } from '../config';
import { cache, TTL } from '../services/redis.service';
import { isEnabled } from '../services/featureFlags.service';
import { removeTags } from '../middleware/sanitize';
import { isOpen } from './project.controller';

/**
 * Public previews of a shared page, for people who aren't signed in to BIES:
 * the business, farm, opportunity or talent at the link, with enough to want
 * the rest, then "See all details" to sign in (src/pages/SharePreview.jsx).
 * GET /preview/:section/:id is that teaser; GET /preview/:section/:id/og is
 * the link card WhatsApp, iMessage and others draw (nginx sends their
 * crawlers there). No contact details, no member names, no amounts and no
 * reviews' words: what's behind sign-in is only named ("How to contact them").
 */

export const SECTIONS = ['trusted', 'farms', 'opportunities', 'talents'] as const;
export type Section = typeof SECTIONS[number];

const FLAG = { trusted: 'directories', farms: 'directories', opportunities: 'projects', talents: 'talent' } as const;

const SAFE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const ACTIVE = { isBanned: false, deletedAt: null };
const ACTIVE_FIELDS = { isBanned: true, deletedAt: true } as const;
const SUMMARY_LENGTH = 240;

const parseJson = <T>(value: string | null | undefined, fallback: T): T => {
    try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
};

/** Plain text, cut at a word near `length`, with … when cut. */
export function summary(text: string, length = SUMMARY_LENGTH): { text: string; cut: boolean } {
    const plain = removeTags(text || '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    if (plain.length <= length) return { text: plain, cut: false };
    const space = plain.lastIndexOf(' ', length);
    return { text: `${plain.slice(0, space > length * 0.6 ? space : length).replace(/[\s,.;:–-]+$/, '')}…`, cut: true };
}

async function listingTeaser(id: string) {
    const listing = await prisma.directoryListing.findUnique({
        where: { id },
        include: {
            owner: { select: ACTIVE_FIELDS },
            memberUser: { select: ACTIVE_FIELDS },
            endorsements: { where: { user: ACTIVE }, select: { comment: true } },
        },
    });
    if (!listing || listing.status !== 'active' || !listing.isPublished) return null;
    const runner = listing.memberUser ?? listing.owner;
    if (!runner || runner.isBanned || runner.deletedAt) return null;

    const photos = parseJson<string[]>(listing.photos, []);
    const cover = listing.photo || photos[0] || listing.logo || '';
    const about = summary(listing.about);
    const isFarm = listing.type === 'FARM';
    return {
        section: (isFarm ? 'farms' : 'trusted') as Section,
        id: listing.id,
        type: listing.type,
        name: listing.name,
        category: listing.category,
        products: isFarm ? parseJson<{ label?: string }[]>(listing.products, []).map((p) => p?.label).filter(Boolean) : [],
        skills: isFarm ? [] : parseJson<string[]>(listing.skills, []),
        location: listing.location,
        photo: cover,
        about: about.text,
        vouchCount: listing.vouchCount,
        isCertified: listing.isCertified,
        btcAccepted: listing.btcAccepted,
        pricing: isFarm ? '' : listing.pricing,
        // Named on the preview, shown after sign-in.
        members: {
            contact: !!(listing.phone || listing.whatsapp || listing.email),
            links: !!(listing.website || listing.instagram),
            hours: !!listing.hours,
            map: !!listing.mapUrl,
            morePhotos: photos.filter((p) => p !== cover).length,
            reviews: listing.endorsements.filter((e) => e.comment.trim()).length,
            fullText: about.cut,
        },
    };
}

async function opportunityTeaser(id: string) {
    const project = await prisma.project.findUnique({
        where: { id },
        include: { owner: { select: ACTIVE_FIELDS } },
    });
    if (!project || !project.isPublished || project.owner.isBanned || project.owner.deletedAt) return null;
    const photos = parseJson<string[]>(project.photos, []);
    const cover = project.thumbnail || photos[0] || '';
    const text = summary(project.description);
    return {
        section: 'opportunities' as Section,
        id: project.id,
        type: project.type,
        kind: project.kind,
        name: project.title,
        category: project.category,
        location: project.location,
        remote: project.remote,
        btcAccepted: project.type !== 'investment' && project.btcAccepted,
        photo: cover,
        about: text.text,
        closesOn: project.closesOn,
        isOpen: isOpen(project),
        members: {
            contact: !!(project.whatsapp || project.email),
            links: !!(project.websiteUrl || project.demoUrl),
            deck: !!project.deckKey,
            morePhotos: photos.filter((p) => p !== cover).length,
            fullText: text.cut,
        },
    };
}

async function talentTeaser(id: string) {
    const talent = await prisma.talentListing.findUnique({
        where: { id },
        include: { user: { select: ACTIVE_FIELDS } },
    });
    if (!talent || talent.user.isBanned || talent.user.deletedAt) return null;
    const works = parseJson<{ media?: { url: string; poster?: string }[] }[]>(talent.works, []);
    const firstMedia = works.flatMap((w) => w.media || [])[0];
    const text = summary(talent.about);
    return {
        section: 'talents' as Section,
        id: talent.id,
        name: talent.title,
        category: talent.category,
        skills: parseJson<string[]>(talent.skills, []),
        location: talent.location,
        remote: talent.remote,
        available: talent.available,
        btcAccepted: talent.btcAccepted,
        photo: talent.photo || firstMedia?.poster || (firstMedia && /\.(jpe?g|png|gif|webp)$/i.test(firstMedia.url) ? firstMedia.url : '') || '',
        about: text.text,
        members: {
            contact: !!(talent.whatsapp || talent.email || talent.website),
            rate: !!talent.rate,
            works: works.length,
            fullText: text.cut,
        },
    };
}

export type Teaser = NonNullable<Awaited<ReturnType<typeof listingTeaser | typeof opportunityTeaser | typeof talentTeaser>>>;

/** The teaser for a shared page, or null when it isn't there (or its part of BIES is switched off). */
export async function teaser(section: Section, id: string): Promise<Teaser | null> {
    if (!SAFE_ID_RE.test(id) || !await isEnabled(FLAG[section])) return null;
    const key = `preview:${section}:${id}`;
    const cached = await cache.getJson<Teaser | { missing: true }>(key);
    if (cached) return 'missing' in cached ? null : cached;
    const found = section === 'opportunities' ? await opportunityTeaser(id)
        : section === 'talents' ? await talentTeaser(id)
            : await listingTeaser(id);
    await cache.setJson(key, found ?? { missing: true }, TTL.PROJECT_DETAIL);
    return found;
}

const sectionOf = (value: string): Section | null => (SECTIONS as readonly string[]).includes(value) ? value as Section : null;

/** GET /preview/:section/:id — no sign-in needed. */
export async function getPreview(req: Request, res: Response): Promise<void> {
    try {
        const section = sectionOf(req.params.section);
        const found = section && await teaser(section, req.params.id);
        if (!found) {
            res.status(404).json({ error: 'Not found' });
            return;
        }
        res.json(found);
    } catch (error) {
        console.error('Preview error:', error);
        res.status(500).json({ error: 'Failed to load the preview' });
    }
}

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

const OPPORTUNITY_TYPES: Record<string, string> = {
    investment: 'Project', 'business-for-sale': 'Business for sale', job: 'Job', partnership: 'Partnership', program: 'Grant or program',
};

/** The link card's words: what it is and where, then its own words. */
export function cardText(found: Teaser): { title: string; description: string } {
    const parts: string[] = [];
    if (found.section === 'opportunities' && 'type' in found) parts.push(OPPORTUNITY_TYPES[found.type] || 'Opportunity');
    if (found.section === 'talents') parts.push('Talent');
    if (found.location) parts.push(found.location);
    if ('vouchCount' in found && found.vouchCount > 0) {
        parts.push(`Recommended by ${found.vouchCount} ${found.vouchCount === 1 ? 'member' : 'members'}`);
    }
    const lead = parts.join(' · ');
    const about = summary(found.about, 160).text;
    return { title: `${found.name} | BIES`, description: [lead, about].filter(Boolean).join(' — ') || 'On BIES, Build in El Salvador' };
}

/**
 * GET /preview/:section/:id/og — the page link-preview crawlers read, as
 * GET /events/:id/og does for events. Not for search engines (noindex): a
 * shared link previews; it doesn't publish the listing.
 */
export async function getPreviewOG(req: Request, res: Response): Promise<void> {
    const section = sectionOf(req.params.section);
    const id = req.params.id;
    if (!section || !SAFE_ID_RE.test(id)) {
        res.status(400).json({ error: 'Invalid link' });
        return;
    }
    const base = config.appPublicUrl;
    const page = `${base}/${section}/${id}`;
    let title = 'BIES | Build in El Salvador';
    let description = 'Trusted businesses and farms, opportunities and talent, recommended by members of Build in El Salvador.';
    let image = `${base}/icons/icon-512.png`;
    try {
        const found = await teaser(section, id);
        if (found) {
            ({ title, description } = cardText(found));
            if (found.photo) image = /^https?:\/\//i.test(found.photo) ? found.photo : `${base}${found.photo.startsWith('/') ? '' : '/'}${found.photo}`;
        }
    } catch (error) {
        console.error('Preview card error:', error);
    }
    const [t, d, i, u] = [title, description, image, page].map(escapeHtml);
    res.set('Cache-Control', 'public, max-age=600');
    res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="robots" content="noindex" />
  <meta property="og:title" content="${t}" />
  <meta property="og:description" content="${d}" />
  <meta property="og:image" content="${i}" />
  <meta property="og:url" content="${u}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="BIES" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${t}" />
  <meta name="twitter:description" content="${d}" />
  <meta name="twitter:image" content="${i}" />
  <meta http-equiv="refresh" content="0;url=${u}" />
  <title>${t}</title>
</head>
<body>
  <p><a href="${u}">${t}</a></p>
</body>
</html>`);
}
