import { Request, Response } from 'express';
import { z } from 'zod';
import type { Event as NostrEvent, EventTemplate } from 'nostr-tools/pure';
import prisma from '../lib/prisma';
import { fetchPublicProfile, publishToPublicRelays } from '../services/nostr.service';
import { signAsHostedUser } from '../services/hostedSigner.service';
import { isClaimedNip05 } from '../services/nip05';
import { PUBLIC_PARTS, publicNostrOf, publicProfileContent, type PublicNostr } from '../services/publicNostrProfile';

/**
 * Settings → Nostr: the member's profile on public Nostr
 * (services/publicNostrProfile.ts). For a key BIES holds, BIES signs and
 * sends it. For a key on the member's device, BIES returns the profile to
 * sign (`template`), and the app sends back the signed one for BIES to send.
 */

const PROFILE_FIELDS = {
    name: true, bio: true, avatar: true, banner: true, website: true,
    nip05Name: true, lightningAddress: true, bolt12Offer: true, publicNostr: true,
} as const;

async function memberOf(userId: string) {
    return prisma.user.findUnique({
        where: { id: userId },
        select: { nostrPubkey: true, encryptedPrivkey: true, profile: { select: PROFILE_FIELDS } },
    });
}
type Member = NonNullable<Awaited<ReturnType<typeof memberOf>>>;

class PublishError extends Error {
    constructor(public status: number, public reason: string) { super(reason); }
}

/** The profile to publish now: the one on public relays with the ticked parts from BIES. */
async function nextProfile(member: Member, settings: PublicNostr) {
    const current = await fetchPublicProfile(member.nostrPubkey!);
    // BIES published one before, so there is one: the relays didn't answer.
    // Building from nothing would wipe what the member set in other apps.
    if (!current && settings.publishedAt) throw new PublishError(503, 'relays_unreachable');
    return { current, next: publicProfileContent(current, member.profile!, settings.parts) };
}

async function savePublished(userId: string, settings: PublicNostr) {
    const publishedAt = new Date().toISOString();
    await prisma.profile.update({
        where: { userId },
        data: { publicNostr: JSON.stringify({ on: settings.on, parts: settings.parts, publishedAt }) },
    });
    return publishedAt;
}

/**
 * Publish the member's public profile with the key BIES holds. Returns false
 * for a key on the member's device (the app publishes those) or when the
 * public profile is off.
 */
export async function publishHostedPublicProfile(userId: string): Promise<boolean> {
    const member = await memberOf(userId);
    if (!member?.nostrPubkey || !member.encryptedPrivkey || !member.profile) return false;
    const settings = publicNostrOf(member.profile.publicNostr);
    if (!settings.on) return false;
    const { next } = await nextProfile(member, settings);
    const signed = await signAsHostedUser(userId, kind0(next), 'server');
    if (!signed) return false;
    if (await publishToPublicRelays(signed) === 0) throw new PublishError(502, 'relays_refused');
    await savePublished(userId, settings);
    return true;
}

const kind0 = (content: Record<string, unknown>): EventTemplate => ({
    kind: 0,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: JSON.stringify(content),
});

function state(member: Member, settings: PublicNostr, current: Record<string, unknown> | null, next: Record<string, unknown> | null) {
    return {
        ...settings,
        hosted: !!member.encryptedPrivkey,
        nip05Name: member.profile?.nip05Name ?? null,
        verified: isClaimedNip05(member.profile?.nip05Name),
        current,
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
 * GET /settings/nostr
 * The switch and ticked parts, the member's BIES address, and their public
 * profile as it is now and as BIES would publish it.
 */
export async function getPublicNostr(req: Request, res: Response): Promise<void> {
    try {
        const member = await memberOf(req.user!.id);
        if (!member?.nostrPubkey || !member.profile) { res.status(404).json({ error: 'Profile not found' }); return; }
        const settings = publicNostrOf(member.profile.publicNostr);
        const current = await fetchPublicProfile(member.nostrPubkey);
        res.json(state(member, settings, current, publicProfileContent(current, member.profile, settings.parts)));
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
 * Off stops updates; what is on public relays stays.
 */
export async function updatePublicNostr(req: Request, res: Response): Promise<void> {
    try {
        const body = req.body as z.infer<typeof updatePublicNostrSchema>;
        const member = await memberOf(req.user!.id);
        if (!member?.nostrPubkey || !member.profile) { res.status(404).json({ error: 'Profile not found' }); return; }
        const settings = publicNostrOf(member.profile.publicNostr);
        if (body.on !== undefined) settings.on = body.on;
        if (body.parts !== undefined) settings.parts = PUBLIC_PARTS.filter((p) => body.parts!.includes(p));
        await prisma.profile.update({ where: { userId: req.user!.id }, data: { publicNostr: JSON.stringify(settings) } });
        res.json(state(member, settings, null, null));
    } catch (error) {
        failed(res, error, 'Save public profile');
    }
}

export const publishPublicNostrSchema = z.object({
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
 * POST /settings/nostr/publish
 * Publish the public profile now. With a key BIES holds, BIES signs and
 * sends it. With a key on the member's device: without `event`, the answer
 * is the profile to sign (`template`); with the signed `event`, BIES checks
 * it is this member's profile and sends it to the public relays.
 */
export async function publishPublicNostr(req: Request, res: Response): Promise<void> {
    try {
        const userId = req.user!.id;
        const member = await memberOf(userId);
        if (!member?.nostrPubkey || !member.profile) { res.status(404).json({ error: 'Profile not found' }); return; }
        const settings = publicNostrOf(member.profile.publicNostr);
        if (!settings.on) { res.status(409).json({ error: 'public_profile_off', reason: 'public_profile_off' }); return; }

        if (member.encryptedPrivkey) {
            await publishHostedPublicProfile(userId);
            const fresh = await memberOf(userId);
            res.json({ published: true, ...state(fresh!, publicNostrOf(fresh!.profile!.publicNostr), null, null) });
            return;
        }

        const event = (req.body as z.infer<typeof publishPublicNostrSchema>).event as NostrEvent | undefined;
        if (!event) {
            const { next } = await nextProfile(member, settings);
            res.json({ published: false, template: kind0(next) });
            return;
        }

        const { verifyEvent } = await import('nostr-tools/pure');
        let content: unknown = null;
        try { content = JSON.parse(event.content); } catch { /* checked below */ }
        const recent = Math.abs(Math.floor(Date.now() / 1000) - event.created_at) <= SIGNED_WITHIN_S;
        if (event.pubkey !== member.nostrPubkey || !recent || !content || typeof content !== 'object' || Array.isArray(content) || !verifyEvent({ ...event })) {
            res.status(400).json({ error: 'invalid_event', reason: 'invalid_event' });
            return;
        }
        if (await publishToPublicRelays(event) === 0) throw new PublishError(502, 'relays_refused');
        const publishedAt = await savePublished(userId, settings);
        res.json({ published: true, ...state(member, { ...settings, publishedAt }, null, null) });
    } catch (error) {
        failed(res, error, 'Publish public profile');
    }
}
