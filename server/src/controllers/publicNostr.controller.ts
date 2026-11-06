import { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import type { Event as NostrEvent, EventTemplate } from 'nostr-tools/pure';
import prisma from '../lib/prisma';
import { fetchPublicProfile, publishToPublicRelays, type PublicProfileRead } from '../services/nostr.service';
import { signAsHostedUser } from '../services/hostedSigner.service';
import { isClaimedNip05 } from '../services/nip05';
import {
    PUBLIC_PARTS, allowedParts, buildPublicProfile, chosenParts, defaultParts, hiddenByPrivacy, publicLimitsOf, publicNostrOf, sameProfile,
    type PublicNostr, type PublicPart, type PublishedValues,
} from '../services/publicNostrProfile';

/**
 * Settings → Nostr: the member's profile on public Nostr
 * (services/publicNostrProfile.ts). For a key BIES holds, BIES signs and
 * sends it. For a key on the member's device, BIES returns the profile to
 * sign (`template`), and the app sends back the signed one for BIES to send.
 *
 * Two kinds of publish: the member's own (Publish), with the parts they
 * ticked, and follow-ups, after they change their BIES profile or Privacy
 * or an admin removes their BIES address, with the parts that Publish
 * showed. Both apply Settings → Privacy.
 */

const PROFILE_FIELDS = {
    name: true, bio: true, avatar: true, banner: true, website: true, nip05Name: true, nip05ClaimedAt: true,
    lightningAddress: true, bolt12Offer: true, privacy: true, hiddenSections: true, publicNostr: true,
} as const;

async function memberOf(userId: string) {
    return prisma.user.findUnique({
        where: { id: userId },
        select: { nostrPubkey: true, encryptedPrivkey: true, profile: { select: PROFILE_FIELDS } },
    });
}
type Member = NonNullable<Awaited<ReturnType<typeof memberOf>>>;
type MemberProfile = NonNullable<Member['profile']>;

class PublishError extends Error {
    constructor(public status: number, public reason: string) { super(reason); }
}

/** Whether the member's public profile follows changes now: switched on, and published since. */
export function isFollowing(settings: PublicNostr): settings is PublicNostr & { publishedParts: PublicPart[] } {
    return settings.on && !!settings.publishedParts;
}

// ─── The settings, changed one save at a time ─────────────────────────────────

/**
 * Change some keys of the stored settings (Profile.publicNostr), read and
 * written in one transaction, so a change and a publish finishing at the
 * same moment don't undo each other: each writes only its own keys.
 */
async function changePublicNostr(userId: string, change: (now: PublicNostr) => Partial<PublicNostr>): Promise<PublicNostr> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await prisma.$transaction(async (tx) => {
                const profile = await tx.profile.findUnique({ where: { userId }, select: { publicNostr: true } });
                const now = publicNostrOf(profile?.publicNostr);
                const next = { ...now, ...change(now) };
                await tx.profile.update({ where: { userId }, data: { publicNostr: JSON.stringify(next) } });
                return next;
            }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        } catch (error) {
            const conflict = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
            if (!conflict || attempt >= 3) throw error;
            await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
        }
    }
}

type Built = { content: Record<string, unknown>; values: PublishedValues; parts: PublicPart[]; createdAt: number };

/**
 * Note what was published. A follow-up keeps the parts as they were; a
 * Publish sets them, unless the member switched it off meanwhile (then no
 * follow-ups until the next Publish). One older than what's noted already
 * (another publish finished first) changes nothing.
 */
async function savePublished(userId: string, built: Built, followUp: boolean) {
    return changePublicNostr(userId, (now) => {
        if (now.publishedCreatedAt && built.createdAt < now.publishedCreatedAt) return {};
        return {
            publishedAt: new Date().toISOString(),
            publishedCreatedAt: built.createdAt,
            publishedValues: built.values,
            publishedParts: !now.on ? null : followUp ? now.publishedParts : built.parts,
        };
    });
}

// ─── Building it ─────────────────────────────────────────────────────────────

/**
 * The profile to publish now: the one on public relays with the parts from
 * BIES, as Privacy allows. `followUp`: with the parts last published, else
 * with the ticked ones. `seenAt`: when the profile the member saw in the
 * preview was made (null: the preview showed none). Building from nothing,
 * or from an older copy than the member saw, would wipe what they set in
 * other apps, so when too few relays answer, or they don't give back at
 * least that, nothing is published (503). A follow-up never builds on an
 * older profile than BIES last published, and sends nothing when nothing
 * would change: null.
 */
async function nextProfile(member: Member, settings: PublicNostr, { seenAt, followUp = false }: { seenAt?: number | null; followUp?: boolean }): Promise<Built | null> {
    const profile = member.profile as MemberProfile;
    const { found, reachable } = await fetchPublicProfile(member.nostrPubkey);
    if (!reachable) throw new PublishError(503, 'relays_unreachable');
    // BIES published one before, or the member saw one: the relays didn't give it back.
    if (!found && (settings.publishedAt || typeof seenAt === 'number')) throw new PublishError(503, 'relays_unreachable');
    if (found && typeof seenAt === 'number' && found.createdAt < seenAt) throw new PublishError(503, 'relays_unreachable');
    if (followUp && settings.publishedCreatedAt && (!found || found.createdAt < settings.publishedCreatedAt)) {
        console.log('[Nostr] Public profile follow-up skipped: the relays gave back an older profile than BIES last published');
        return null;
    }

    const privacy = publicLimitsOf(profile);
    const parts = allowedParts(followUp ? settings.publishedParts ?? [] : chosenParts(settings, profile, privacy), privacy);
    const { content, values } = buildPublicProfile(found?.content ?? null, profile, parts, settings.publishedValues);
    if (followUp && found && sameProfile(found.content, content)) return null;
    // Newer than the one it replaces, even if that one's clock ran ahead.
    const createdAt = Math.max(Math.floor(Date.now() / 1000), (found?.createdAt ?? 0) + 1);
    return { content, values, parts, createdAt };
}

const kind0 = (built: Built): EventTemplate => ({
    kind: 0,
    created_at: built.createdAt,
    tags: [],
    content: JSON.stringify(built.content),
});

/** Sign it with the key BIES holds and send it. */
async function publishHosted(userId: string, built: Built, followUp: boolean): Promise<boolean> {
    const signed = await signAsHostedUser(userId, kind0(built), 'server');
    if (!signed) return false;
    if (await publishToPublicRelays(signed) === 0) throw new PublishError(502, 'relays_refused');
    await savePublished(userId, built, followUp);
    return true;
}

/**
 * Publish the member's public profile now with the key BIES holds, with
 * the parts they ticked. False for a key on the member's device (the app
 * publishes those) or when the public profile is off.
 */
export async function publishHostedPublicProfile(userId: string, seenAt?: number | null): Promise<boolean> {
    const member = await memberOf(userId);
    if (!member?.nostrPubkey || !member.encryptedPrivkey || !member.profile) return false;
    const settings = publicNostrOf(member.profile.publicNostr);
    if (!settings.on) return false;
    const built = await nextProfile(member, settings, { seenAt });
    return !!built && publishHosted(userId, built, false);
}

/** A follow-up with the key BIES holds, if the public profile follows changes. */
async function followUpHosted(userId: string): Promise<void> {
    const member = await memberOf(userId);
    if (!member?.nostrPubkey || !member.encryptedPrivkey || !member.profile) return;
    const settings = publicNostrOf(member.profile.publicNostr);
    if (!isFollowing(settings)) return;
    const built = await nextProfile(member, settings, { followUp: true });
    if (built) await publishHosted(userId, built, true);
}

/**
 * Settings → Privacy now hides these parts: follow-ups stop keeping them
 * up to date, and take off what BIES published for them. Showing them again
 * later doesn't bring them back: that takes a Publish. Whether the public
 * profile follows changes.
 */
export async function hideFromPublicProfile(userId: string, hidden: PublicPart[]): Promise<boolean> {
    const settings = await changePublicNostr(userId, (now) => (
        now.publishedParts ? { publishedParts: now.publishedParts.filter((p) => !hidden.includes(p)) } : {}
    ));
    return isFollowing(settings);
}

// ─── Follow-ups, at most one a minute ────────────────────────────────────────

let followUpGapMs = 60_000;
/** Tests only: the least time between two follow-ups for one member. */
export function setFollowUpGapForTests(ms: number): void { followUpGapMs = ms; }

type FollowUps = { running: boolean; again: boolean; last: number; timer: NodeJS.Timeout | null };
const followUps = new Map<string, FollowUps>();

/**
 * Bring the member's public profile up to date after a change, for a key
 * BIES holds, if it follows changes. One at a time for each member, and at
 * most one a minute: changes made meanwhile go out together, once, with the
 * profile as it is then. Never throws.
 */
export function followPublicProfile(userId: string): void {
    let f = followUps.get(userId);
    if (!f) {
        f = { running: false, again: false, last: -Infinity, timer: null };
        followUps.set(userId, f);
    }
    if (f.running) { f.again = true; return; }
    if (f.timer) return; // the one waiting reads the profile when it runs
    const entry = f;
    const wait = entry.last + followUpGapMs - Date.now();
    if (wait > 0) entry.timer = setTimeout(() => { void runFollowUp(userId, entry); }, wait);
    else void runFollowUp(userId, entry);
}

async function runFollowUp(userId: string, f: FollowUps): Promise<void> {
    f.timer = null;
    f.running = true;
    f.again = false;
    f.last = Date.now();
    try {
        await followUpHosted(userId);
    } catch (error) {
        console.error('[Nostr] Public profile follow-up failed:', error instanceof Error ? error.message : error);
    } finally {
        f.running = false;
        const wait = Math.max(0, f.last + followUpGapMs - Date.now());
        if (f.again) {
            f.timer = setTimeout(() => { void runFollowUp(userId, f); }, wait);
        } else {
            // Forgotten once the gap is over and nothing more came.
            setTimeout(() => {
                if (followUps.get(userId) === f && !f.running && !f.timer) followUps.delete(userId);
            }, wait).unref();
        }
    }
}

// ─── Profiles to sign on the member's device ─────────────────────────────────

// The profiles BIES gave each member to sign, for ten minutes: a signed
// profile is sent on only if it is one of them, unchanged.
const TEMPLATE_TTL_MS = 10 * 60 * 1000;
const TEMPLATES_KEPT = 3;
type Pending = { content: string; built: Built; followUp: boolean; expires: number };
const pendingTemplates = new Map<string, Pending[]>();

function rememberTemplate(userId: string, pending: Pending) {
    const now = Date.now();
    for (const [id, list] of pendingTemplates) {
        const live = list.filter((p) => p.expires > now);
        if (live.length) pendingTemplates.set(id, live);
        else pendingTemplates.delete(id);
    }
    pendingTemplates.set(userId, [...(pendingTemplates.get(userId) ?? []), pending].slice(-TEMPLATES_KEPT));
}

/** The template this content came from; null if BIES gave none like it (or it expired). */
function findTemplate(userId: string, content: string): Pending | null {
    return (pendingTemplates.get(userId) ?? []).find((p) => p.content === content && p.expires > Date.now()) ?? null;
}

/** A template used: off the list. */
function dropTemplate(userId: string, pending: Pending) {
    const list = (pendingTemplates.get(userId) ?? []).filter((p) => p !== pending);
    if (list.length) pendingTemplates.set(userId, list);
    else pendingTemplates.delete(userId);
}

// ─── Routes ──────────────────────────────────────────────────────────────────

function state(member: Member, settings: PublicNostr, read: PublicProfileRead | null, next: Record<string, unknown> | null) {
    const profile = member.profile as MemberProfile;
    const privacy = publicLimitsOf(profile);
    return {
        on: settings.on,
        parts: chosenParts(settings, profile, privacy),
        // Parts Settings → Privacy keeps off public Nostr, ticked or not.
        hiddenParts: hiddenByPrivacy(privacy),
        publishedAt: settings.publishedAt,
        // Whether changes to the BIES profile follow (not after switching it off, until the next Publish).
        following: isFollowing(settings),
        current: read?.found?.content ?? null,
        currentAt: read?.found?.createdAt ?? null, // send back as `seenAt` with Publish
        // false: too few public relays answered to tell what's there now.
        reachable: read ? read.reachable : null,
        hosted: !!member.encryptedPrivkey,
        nip05Name: profile.nip05Name ?? null,
        verified: isClaimedNip05(profile),
        next,
    };
}

function failed(res: Response, error: unknown, what: string) {
    if (error instanceof PublishError) {
        res.status(error.status).json({ error: error.reason, reason: error.reason });
        return;
    }
    console.error(`${what} error:`, error);
    res.status(500).json({ error: `Failed to ${what.toLowerCase()}` });
}

/**
 * GET /settings/nostr[?preview=0]
 * The switch and ticked parts (and those Privacy hides), the member's BIES
 * address, and their public profile as it is now (`current`, made at
 * `currentAt`) and as Publish would make it (`next`). `reachable: false`:
 * too few relays answered to tell, so there's no `next`. `preview=0`
 * leaves the profiles out (null) and skips reading the public relays: the
 * phone apps don't show them.
 */
export async function getPublicNostr(req: Request, res: Response): Promise<void> {
    try {
        const member = await memberOf(req.user!.id);
        if (!member?.nostrPubkey || !member.profile) { res.status(404).json({ error: 'Profile not found' }); return; }
        const settings = publicNostrOf(member.profile.publicNostr);
        if (req.query.preview === '0') { res.json(state(member, settings, null, null)); return; }
        const read = await fetchPublicProfile(member.nostrPubkey);
        const privacy = publicLimitsOf(member.profile);
        const parts = allowedParts(chosenParts(settings, member.profile, privacy), privacy);
        const next = read.reachable
            ? buildPublicProfile(read.found?.content ?? null, member.profile, parts, settings.publishedValues).content
            : null;
        res.json(state(member, settings, read, next));
    } catch (error) {
        failed(res, error, 'Load public profile');
    }
}

export const updatePublicNostrSchema = z.object({
    on: z.boolean().optional(),
    parts: z.array(z.enum(PUBLIC_PARTS)).max(PUBLIC_PARTS.length).optional(),
});

/**
 * PUT /settings/nostr
 * Switch the public profile on or off, or change the ticked parts. Saving
 * publishes nothing: the app asks for that (POST /settings/nostr/publish).
 * Off stops the follow-ups until the next Publish; what is on public relays
 * stays. Switched on with no parts chosen yet, the defaults are kept.
 */
export async function updatePublicNostr(req: Request, res: Response): Promise<void> {
    try {
        const body = req.body as z.infer<typeof updatePublicNostrSchema>;
        const member = await memberOf(req.user!.id);
        if (!member?.nostrPubkey || !member.profile) { res.status(404).json({ error: 'Profile not found' }); return; }
        const profile = member.profile;
        const settings = await changePublicNostr(req.user!.id, (now) => {
            const changes: Partial<PublicNostr> = {};
            if (body.on !== undefined) changes.on = body.on;
            if (body.on === false) changes.publishedParts = null;
            if (body.parts !== undefined) changes.parts = PUBLIC_PARTS.filter((p) => body.parts!.includes(p));
            else if (body.on && !now.parts) changes.parts = defaultParts(profile, publicLimitsOf(profile));
            return changes;
        });
        res.json(state(member, settings, null, null));
    } catch (error) {
        failed(res, error, 'Save public profile');
    }
}

export const publishPublicNostrSchema = z.object({
    // When the public profile the member saw in the preview was made (GET's currentAt).
    seenAt: z.number().int().nonnegative().nullable().optional(),
    // A follow-up after a change (the app does these for a key on the device): the parts last published.
    followUp: z.boolean().optional(),
    event: z.object({
        id: z.string().regex(/^[0-9a-f]{64}$/),
        pubkey: z.string().regex(/^[0-9a-f]{64}$/),
        created_at: z.number().int(),
        kind: z.literal(0),
        tags: z.array(z.array(z.string().max(1000)).max(10)).max(20),
        content: z.string().max(64_000),
        sig: z.string().regex(/^[0-9a-f]{128}$/),
    }).optional(),
});

const SIGNED_WITHIN_S = 10 * 60;

/**
 * POST /settings/nostr/publish { seenAt, followUp?, event? }
 * Publish the public profile now. With a key BIES holds, BIES signs and
 * sends it. With a key on the member's device: without `event`, the answer
 * is the profile to sign (`template`); with the signed `event`, BIES checks
 * it is that profile, unchanged and signed by this member, and sends it to
 * the public relays. `followUp`: bring a published profile up to date
 * instead; the answer may be `skipped` (nothing to send).
 */
export async function publishPublicNostr(req: Request, res: Response): Promise<void> {
    try {
        const userId = req.user!.id;
        const member = await memberOf(userId);
        if (!member?.nostrPubkey || !member.profile) { res.status(404).json({ error: 'Profile not found' }); return; }
        const settings = publicNostrOf(member.profile.publicNostr);
        if (!settings.on) { res.status(409).json({ error: 'public_profile_off', reason: 'public_profile_off' }); return; }

        const body = req.body as z.infer<typeof publishPublicNostrSchema>;
        const followUp = body.followUp === true;
        if (followUp && !isFollowing(settings)) { res.json({ published: false, skipped: true }); return; }

        if (member.encryptedPrivkey) {
            const built = await nextProfile(member, settings, { seenAt: body.seenAt, followUp });
            if (!built) { res.json({ published: false, skipped: true }); return; }
            if (!await publishHosted(userId, built, followUp)) throw new PublishError(500, 'not_published');
            const fresh = await memberOf(userId);
            res.json({ published: true, ...state(fresh!, publicNostrOf(fresh!.profile!.publicNostr), null, null) });
            return;
        }

        const event = body.event as NostrEvent | undefined;
        if (!event) {
            const built = await nextProfile(member, settings, { seenAt: body.seenAt, followUp });
            if (!built) { res.json({ published: false, skipped: true }); return; }
            const template = kind0(built);
            rememberTemplate(userId, { content: template.content, built, followUp, expires: Date.now() + TEMPLATE_TTL_MS });
            res.json({ published: false, template });
            return;
        }

        const { verifyEvent } = await import('nostr-tools/pure');
        const recent = Math.abs(Math.floor(Date.now() / 1000) - event.created_at) <= SIGNED_WITHIN_S;
        if (event.pubkey !== member.nostrPubkey || !recent || event.tags.length !== 0 || !verifyEvent({ ...event })) {
            res.status(400).json({ error: 'invalid_event', reason: 'invalid_event' });
            return;
        }
        // Only a profile BIES gave this member to sign, as it gave it.
        const pending = findTemplate(userId, event.content);
        if (!pending) { res.status(400).json({ error: 'invalid_event', reason: 'invalid_event' }); return; }
        if (await publishToPublicRelays(event) === 0) throw new PublishError(502, 'relays_refused');
        dropTemplate(userId, pending);
        const saved = await savePublished(userId, { ...pending.built, createdAt: event.created_at }, pending.followUp);
        res.json({ published: true, ...state(member, saved, null, null) });
    } catch (error) {
        failed(res, error, 'Publish public profile');
    }
}
