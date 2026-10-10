/**
 * Deleting an account, and handing an email account its Nostr key.
 *
 * Neither can be undone, so both are confirmed afresh:
 * - email accounts (BIES holds their key) with an emailed code;
 * - Nostr accounts with a signature from their own key over a one-time
 *   challenge (issueChallenge / checkSignedChallenge).
 *
 * Deleting an account:
 * 1. prepares what can't be undone without doing it: for an email account,
 *    a NIP-62 request to vanish and NIP-09 deletion requests are signed with
 *    the key BIES holds, while it still exists;
 * 2. erases, in one transaction: the user row and its cascade (sessions, push
 *    registrations, the hosted key, ...), and what other rows keep about the
 *    person (IP addresses, names, notifications to others, zap receipts).
 *    Until this commits nothing has changed, so if it fails the member is
 *    still signed in and can try again;
 * 3. only then: sockets close, relay access goes, BIES's relay deletes the
 *    events, the signed requests go to the public relays. Nothing here
 *    throws: the account is already gone;
 * 4. emails a confirmation that says what was done.
 * An admin emptying the trash erases without step 3's relay work (a merged
 * account's events now belong to the account it was merged into), unless
 * carrying out a member's request.
 *
 * Taking the key (email accounts): BIES shows the key once, after an email
 * code. The member proves they saved it by signing a challenge with it, and
 * BIES deletes its copy. The account keeps its identity and signs in with
 * Nostr from then on; its sessions on other devices end.
 *
 * Backups still hold the deleted data until they expire, within 90 days
 * (APP-DEPLOY-RUNBOOK.md, "Backups"). The emails say so.
 */

import crypto from 'crypto';
import type { Event as NostrEvent } from 'nostr-tools/pure';
import prisma from '../lib/prisma';
import { config } from '../config';
import { sendEmail, type OutgoingEmail } from './email.service';
import type { EmailLang } from './emailCode.service';
import { exportHostedKey } from './hostedSigner.service';
import { publishRetraction, signRetraction } from './nostr.service';
import { cache, cacheKey } from './redis.service';
import { markVanished, removeFromRelayWhitelist, requestRelayPurge } from './relayWhitelist.service';
import { revokeOtherSessions, revokeUserSessions } from './session.service';

// ─── Confirming with a signature ──────────────────────────────────────────────

export type SignedPurpose = 'delete_account' | 'take_key';

/** The kind of the event the app signs: the challenge and purpose go in tags. */
export const CONFIRMATION_KIND = 27235;

const CHALLENGE_TTL_MS: Record<SignedPurpose, number> = {
    delete_account: 10 * 60 * 1000,
    // Time to save the key somewhere, then bring it back.
    take_key: 30 * 60 * 1000,
};
const MAX_CLOCK_SKEW_SECONDS = 10 * 60;

// One live challenge per account and purpose. Kept in memory: the server is a
// single process, and after a restart the app just asks again.
const challenges = new Map<string, { challenge: string; expiresAt: number }>();

export function issueChallenge(userId: string, purpose: SignedPurpose): string {
    const now = Date.now();
    for (const [key, entry] of challenges) {
        if (entry.expiresAt <= now) challenges.delete(key);
    }
    const challenge = crypto.randomBytes(32).toString('hex');
    challenges.set(`${purpose}:${userId}`, { challenge, expiresAt: now + CHALLENGE_TTL_MS[purpose] });
    return challenge;
}

export type ChallengeCheck = 'ok' | 'challenge_expired' | 'bad_signature';

/** Exactly one tag of this name, with exactly one value. */
function onlyTag(tags: unknown[], name: string): string | null {
    const found = tags.filter((t) => Array.isArray(t) && t[0] === name);
    return found.length === 1 && (found[0] as unknown[]).length === 2 ? String((found[0] as unknown[])[1]) : null;
}

/**
 * Check a signed confirmation: made by the account's own key, recently, for
 * this purpose, over the live challenge. The challenge is used up on success.
 * A sign-in event (the challenge is its content, no tags) never passes.
 */
export async function checkSignedChallenge(
    userId: string,
    pubkey: string,
    purpose: SignedPurpose,
    event: NostrEvent,
): Promise<ChallengeCheck> {
    const key = `${purpose}:${userId}`;
    const stored = challenges.get(key);
    if (!stored || stored.expiresAt <= Date.now()) {
        challenges.delete(key);
        return 'challenge_expired';
    }

    const now = Math.floor(Date.now() / 1000);
    if (
        event.kind !== CONFIRMATION_KIND ||
        event.pubkey !== pubkey ||
        Math.abs(event.created_at - now) > MAX_CLOCK_SKEW_SECONDS ||
        onlyTag(event.tags, 'purpose') !== purpose
    ) {
        return 'bad_signature';
    }
    // Signed over an older challenge (another tab or device started again
    // since): the app starts over rather than retrying a dead end.
    if (onlyTag(event.tags, 'challenge') !== stored.challenge) return 'challenge_expired';

    const { verifyEvent } = await import('nostr-tools/pure');
    let valid = false;
    try {
        valid = verifyEvent({ ...event });
    } catch {
        valid = false;
    }
    if (!valid) return 'bad_signature';

    // A parallel request with the same signature may have used it meanwhile.
    if (challenges.get(key) !== stored) return 'challenge_expired';
    challenges.delete(key);
    return 'ok';
}

// ─── Deleting an account ──────────────────────────────────────────────────────

// How long the deletion waits for relays: to find the events to retract
// (before the erase) and to take the requests (after it).
const PREPARE_TIMEOUT_MS = 15_000;
const PUBLISH_TIMEOUT_MS = 10_000;

export interface DeletionOptions {
    lang?: EmailLang;
    /** Email the member a confirmation (their own request). */
    notify?: boolean;
    /**
     * Have relays forget the account: BIES's relay deletes its events, and
     * for an email account the public relays are asked to. On for a member's
     * own request, or an admin carrying one out; off when an admin just
     * empties the trash.
     */
    retract?: boolean;
}

export interface DeletionResult {
    keyDestroyed: boolean;
    relayPurgeRequested: boolean;
    /** At least one public relay took a deletion request. */
    retracted: boolean;
    emailed: boolean;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Audit metadata without what names the person: names and pubkeys. */
function withoutPerson(metadata: string): string {
    try {
        const data = JSON.parse(metadata) as Record<string, unknown>;
        for (const key of Object.keys(data)) {
            if (/(name|pubkey)$/i.test(key)) delete data[key];
        }
        return JSON.stringify(data);
    } catch {
        return '{}';
    }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(resolve, ms, null); });
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Delete an account for good. The caller has confirmed it is the owner's
 * wish, or is an admin. Throws only if nothing was deleted.
 */
export async function deleteAccount(
    userId: string,
    { lang = 'en', notify = true, retract = true }: DeletionOptions = {},
): Promise<DeletionResult> {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, nostrPubkey: true, encryptedPrivkey: true, profile: { select: { id: true } } },
    });
    if (!user) throw new Error(`No account ${userId}`);
    const pubkey = user.nostrPubkey;
    const hosted = !!user.encryptedPrivkey;

    // 1. Prepare the retraction while the hosted key exists; send nothing yet.
    let retraction: NostrEvent[] = [];
    if (retract && hosted) {
        try {
            retraction = (await withTimeout(signRetraction(userId, pubkey), PREPARE_TIMEOUT_MS)) ?? [];
        } catch (err) {
            console.error('[Account] Could not sign the retraction:', errorText(err));
        }
    }

    // 2. Erase. Audit rows about the person keep what happened, but not their
    // name or pubkey (admin actions recorded both); rows kept for others lose
    // the account's IP addresses; other members' notifications about them
    // ("followed you", a message preview) go.
    const aboutThem = await prisma.auditLog.findMany({
        where: {
            OR: [
                { resource: `user:${userId}` },
                { metadata: { contains: userId } },
                { metadata: { contains: pubkey } },
            ],
        },
        select: { id: true, metadata: true },
    });
    const erased = await prisma.$transaction([
        prisma.auditLog.updateMany({ where: { userId }, data: { ipAddress: null, userAgent: null } }),
        ...aboutThem.map(({ id, metadata }) =>
            prisma.auditLog.update({ where: { id }, data: { metadata: withoutPerson(metadata) } })),
        prisma.projectView.updateMany({ where: { userId }, data: { ipAddress: null } }),
        prisma.voucherRedemption.updateMany({
            where: { OR: [{ userId }, { pubkey }] },
            data: { ipAddress: null, pubkey: null },
        }),
        prisma.zapReceipt.updateMany({ where: { senderPubkey: pubkey }, data: { senderPubkey: '', comment: '' } }),
        prisma.zapReceipt.updateMany({ where: { recipientPubkey: pubkey }, data: { recipientPubkey: '' } }),
        prisma.notification.deleteMany({
            where: { OR: [{ data: { contains: userId } }, { data: { contains: pubkey } }] },
        }),
        prisma.user.delete({ where: { id: userId } }),
        // The record that it was done, with nothing that identifies the person.
        prisma.auditLog.create({
            data: {
                userId: null,
                action: 'ACCOUNT_DELETED',
                resource: `user:${userId}`,
                metadata: JSON.stringify({ hostedKey: hosted, retract }),
            },
        }),
    ]);
    const record = erased[erased.length - 1] as { id: string };

    // 3. The account is gone; nothing below may throw.
    const result: DeletionResult = { keyDestroyed: hosted, relayPurgeRequested: false, retracted: false, emailed: false };

    // Its sockets close (the cascade took its sessions and push registrations).
    await revokeUserSessions(userId, 'deleted').catch((err) => console.error('[Account] Closing sockets:', errorText(err)));
    removeFromRelayWhitelist(pubkey);

    if (retract) {
        markVanished(pubkey);
        result.relayPurgeRequested = requestRelayPurge(pubkey);
        if (!result.relayPurgeRequested) {
            // Nothing else keeps the pubkey: this log line is how it gets done.
            console.error(`[Account] Could not ask the relay to delete a deleted account's events. Do it by hand in bies-relay: /app/strfry --config=/etc/strfry.conf delete --filter '{"authors":["${pubkey}"]}'`);
        }
        if (retraction.length > 0) {
            try {
                result.retracted = ((await withTimeout(publishRetraction(retraction), PUBLISH_TIMEOUT_MS)) ?? 0) > 0;
            } catch (err) {
                console.error('[Account] Publishing the retraction failed:', errorText(err));
            }
        }
    }

    await Promise.all([
        cache.del(cacheKey.profileDetail(userId)),
        cache.del(cacheKey.profileDetail(pubkey)),
        user.profile ? cache.del(cacheKey.profileDetail(user.profile.id)) : Promise.resolve(),
        cache.delPattern('profiles:'),
        cache.delPattern('followers:'),
        cache.delPattern('projects:'),
        cache.delPattern('events:'),
    ]).catch(() => {});

    // 4. Confirm, saying only what was done.
    if (notify && user.email) {
        try {
            await sendEmail(renderAccountDeletedEmail(user.email, lang, result));
            result.emailed = true;
        } catch (err) {
            console.error('[Account] Deletion email failed:', errorText(err));
        }
    }

    await prisma.auditLog.update({
        where: { id: record.id },
        data: { metadata: JSON.stringify({ hostedKey: hosted, retract, ...result }) },
    }).catch(() => {});
    return result;
}

// ─── Taking the key ───────────────────────────────────────────────────────────

/**
 * The key, for the member to save, and the challenge they must sign with it
 * to finish. Null when BIES holds no key for the account.
 */
export async function exportKey(userId: string): Promise<{ secretKey: string; challenge: string } | null> {
    const secretKey = await exportHostedKey(userId);
    if (!secretKey) return null;
    return { secretKey, challenge: issueChallenge(userId, 'take_key') };
}

/**
 * BIES deletes its copy of the key. Sessions on other devices end: they
 * signed through BIES, and must sign in with Nostr now. False if BIES held
 * no key (already taken).
 */
export async function releaseKey(userId: string, keepSessionId: string, lang: EmailLang = 'en'): Promise<boolean> {
    const { count } = await prisma.user.updateMany({
        where: { id: userId, encryptedPrivkey: { not: null } },
        data: { encryptedPrivkey: null },
    });
    if (count === 0) return false;

    await revokeOtherSessions(userId, keepSessionId, 'key_taken');

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (user?.email) {
        try {
            await sendEmail(renderKeyTakenEmail(user.email, lang));
        } catch (err) {
            console.error('[Account] Key email failed:', err instanceof Error ? err.message : err);
        }
    }
    return true;
}

// ─── Emails ───────────────────────────────────────────────────────────────────

function today(lang: EmailLang): string {
    return new Intl.DateTimeFormat(lang === 'es' ? 'es-SV' : 'en-US', {
        dateStyle: 'long',
        timeZone: 'America/El_Salvador',
    }).format(new Date());
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A short notice: a few paragraphs, as text and as plain HTML. */
function notice(to: string, lang: EmailLang, subject: string, paragraphs: string[]): OutgoingEmail {
    return {
        to,
        subject,
        replyTo: config.email.supportAddress,
        text: `${paragraphs.join('\n\n')}\n\nBuild in El Salvador\nhttps://buildinelsalvador.com\n`,
        html: `<!doctype html>
<html lang="${lang}"><body style="margin:0;padding:24px;background:#ffffff;color:#1a1a1a;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
${paragraphs.map((p) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.5;">${escapeHtml(p)}</p>`).join('\n')}
<p style="margin:24px 0 0;font-size:13px;color:#777777;">Build in El Salvador · <a href="https://buildinelsalvador.com" style="color:#121E5A;">buildinelsalvador.com</a></p>
</body></html>`,
    };
}

export function renderAccountDeletedEmail(
    to: string,
    lang: EmailLang,
    done: Pick<DeletionResult, 'keyDestroyed' | 'relayPurgeRequested' | 'retracted'>,
): OutgoingEmail {
    const date = today(lang);
    if (lang === 'es') {
        const deleted = done.relayPurgeRequested
            ? 'Borramos su perfil, sus fichas del directorio y sus recomendaciones, sus mensajes y sus publicaciones en el relay de BIES.'
            : 'Borramos su perfil, sus fichas del directorio y sus recomendaciones, y sus mensajes.';
        const key = done.keyDestroyed
            ? done.retracted
                ? ' También destruimos la clave de Nostr que guardábamos para usted, y pedimos a otros relays de Nostr que borren lo que se publicó con ella. Cada relay de terceros decide por su cuenta.'
                : ' También destruimos la clave de Nostr que guardábamos para usted.'
            : '';
        return notice(to, lang, 'Su cuenta de BIES fue eliminada', [
            `Como usted lo pidió, eliminamos su cuenta de BIES el ${date}.`,
            deleted + key,
            'Las copias en nuestros respaldos se borran a medida que estos vencen, en un plazo de 90 días.',
            'Si usted no lo pidió, responda a este correo.',
        ]);
    }
    const deleted = done.relayPurgeRequested
        ? 'We deleted your profile, your directory listings and recommendations, your messages, and your posts on the BIES relay.'
        : 'We deleted your profile, your directory listings and recommendations, and your messages.';
    const key = done.keyDestroyed
        ? done.retracted
            ? ' We also destroyed the Nostr key we held for you, and asked other Nostr relays to delete what was published with it. Relays run by others decide for themselves.'
            : ' We also destroyed the Nostr key we held for you.'
        : '';
    return notice(to, lang, 'Your BIES account has been deleted', [
        `As you asked, we deleted your BIES account on ${date}.`,
        deleted + key,
        'Copies in our backups are deleted as the backups expire, within 90 days.',
        "If you didn't ask for this, reply to this email.",
    ]);
}

export function renderKeyTakenEmail(to: string, lang: EmailLang): OutgoingEmail {
    const date = today(lang);
    if (lang === 'es') {
        return notice(to, lang, 'Ahora usted guarda su clave de Nostr', [
            `El ${date}, BIES borró su copia de su clave de Nostr. Su identidad, su perfil y sus fichas siguen iguales.`,
            'De ahora en adelante, inicie sesión en BIES con Nostr: con su clave o con una app firmadora que la guarde. El inicio de sesión por correo ya no funciona para esta cuenta.',
            'BIES no puede recuperar su clave si usted la pierde. Guarde bien su copia.',
            'Nuestros respaldos todavía contienen la clave cifrada hasta que vencen, en un plazo de 90 días.',
            'Si usted no hizo esto, responda a este correo.',
        ]);
    }
    return notice(to, lang, 'You now hold your Nostr key', [
        `On ${date}, BIES deleted its copy of your Nostr key. Your identity, profile and listings stay the same.`,
        'From now on, sign in to BIES with Nostr: with your key, or a signer app that holds it. Signing in by email no longer works for this account.',
        "BIES can't recover your key if you lose it. Keep your copy safe.",
        'Our backups still hold the key, encrypted, until they expire within 90 days.',
        "If you didn't do this, reply to this email.",
    ]);
}
