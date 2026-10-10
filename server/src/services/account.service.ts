/**
 * Deleting an account, and handing an email account its Nostr key.
 *
 * Neither can be undone, so both are confirmed afresh:
 * - email accounts (BIES holds their key) with an emailed code;
 * - Nostr accounts with a signature from their own key over a one-time
 *   challenge (issueChallenge / checkSignedChallenge).
 *
 * Deleting an account:
 * 1. stops it at once: deletedAt is set, every session ends, push
 *    registrations and relay access go;
 * 2. retracts what it published. For an email account, BIES signs a NIP-62
 *    request to vanish and NIP-09 deletion requests and sends them to the
 *    public relays. For every account, BIES's own relay deletes its events;
 * 3. deletes the user row and everything that cascades from it, the hosted
 *    key included. Rows kept for other members' records lose the account's
 *    IP addresses first;
 * 4. emails a confirmation, if the account has an address.
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
import { retractAllEvents } from './nostr.service';
import { removePushTargets } from './notification.service';
import { cache } from './redis.service';
import { removeFromRelayWhitelist, requestRelayPurge } from './relayWhitelist.service';
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
        onlyTag(event.tags, 'challenge') !== stored.challenge ||
        onlyTag(event.tags, 'purpose') !== purpose
    ) {
        return 'bad_signature';
    }

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

// Retraction talks to relays run by others; the deletion doesn't wait longer.
const RETRACT_TIMEOUT_MS = 20_000;

export interface DeletionResult {
    /** Deletion requests went out to the public relays (email accounts). */
    retracted: boolean;
    /** BIES's relay was asked to delete the account's events. */
    relayPurgeRequested: boolean;
    emailed: boolean;
}

/** Audit metadata without the names it may carry (admin actions name the member). */
function withoutNames(metadata: string): string {
    try {
        const data = JSON.parse(metadata) as Record<string, unknown>;
        for (const key of Object.keys(data)) {
            if (/name$/i.test(key)) delete data[key];
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
 * wish, or an admin is purging it (`notify: false`: the admin answers the
 * person themselves, if at all).
 */
export async function deleteAccount(
    userId: string,
    lang: EmailLang = 'en',
    { notify = true }: { notify?: boolean } = {},
): Promise<DeletionResult> {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, nostrPubkey: true, encryptedPrivkey: true },
    });
    if (!user) throw new Error(`No account ${userId}`);
    const hosted = !!user.encryptedPrivkey;

    // 1. Stop it. From here nothing can sign in as the account or act for it.
    await prisma.user.update({ where: { id: userId }, data: { deletedAt: new Date() } });
    await revokeUserSessions(userId, 'deleted');
    await removePushTargets(userId);
    removeFromRelayWhitelist(user.nostrPubkey);

    // 2. Retract what it published, while the hosted key still exists.
    let retracted = false;
    if (hosted) {
        try {
            retracted = !!(await withTimeout(retractAllEvents(userId, user.nostrPubkey), RETRACT_TIMEOUT_MS));
        } catch (err) {
            console.error('[Account] Retraction failed:', err instanceof Error ? err.message : err);
        }
    }
    const relayPurgeRequested = requestRelayPurge(user.nostrPubkey);

    // 3. Erase. The cascade takes the profile, listings, messages, sessions,
    // and the hosted key with the user row. Rows that stay for other members
    // (audit trail, project views, voucher redemptions) lose the account's
    // addresses; the cascade unlinks them from it. Admin actions about the
    // account keep their record, but not the member's name.
    const aboutIt = await prisma.auditLog.findMany({
        where: { resource: `user:${userId}` },
        select: { id: true, metadata: true },
    });
    await prisma.$transaction([
        prisma.auditLog.updateMany({ where: { userId }, data: { ipAddress: null, userAgent: null } }),
        ...aboutIt.map(({ id, metadata }) =>
            prisma.auditLog.update({ where: { id }, data: { metadata: withoutNames(metadata) } })),
        prisma.projectView.updateMany({ where: { userId }, data: { ipAddress: null } }),
        prisma.voucherRedemption.updateMany({
            where: { OR: [{ userId }, { pubkey: user.nostrPubkey }] },
            data: { ipAddress: null, pubkey: null },
        }),
        prisma.user.delete({ where: { id: userId } }),
        // The record that the request was carried out, with nothing that
        // identifies the person.
        prisma.auditLog.create({
            data: {
                userId: null,
                action: 'ACCOUNT_DELETED',
                resource: `user:${userId}`,
                metadata: JSON.stringify({ hostedKey: hosted, retracted, relayPurgeRequested }),
            },
        }),
    ]);
    await Promise.all([
        cache.delPattern('profiles:'),
        cache.delPattern('projects:'),
        cache.delPattern('events:'),
    ]).catch(() => {});

    // 4. Confirm.
    let emailed = false;
    if (notify && user.email) {
        try {
            await sendEmail(renderAccountDeletedEmail(user.email, lang, hosted));
            emailed = true;
        } catch (err) {
            console.error('[Account] Deletion email failed:', err instanceof Error ? err.message : err);
        }
    }
    return { retracted, relayPurgeRequested, emailed };
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

export function renderAccountDeletedEmail(to: string, lang: EmailLang, hadHostedKey: boolean): OutgoingEmail {
    const date = today(lang);
    if (lang === 'es') {
        return notice(to, lang, 'Su cuenta de BIES fue eliminada', [
            `Como usted lo pidió, eliminamos su cuenta de BIES el ${date}.`,
            'Borramos su perfil, sus fichas del directorio y sus recomendaciones, sus mensajes y sus publicaciones en el relay de BIES.' +
                (hadHostedKey
                    ? ' También destruimos la clave de Nostr que guardábamos para usted, y pedimos a otros relays de Nostr que borren lo que se publicó con ella. Cada relay de terceros decide por su cuenta.'
                    : ''),
            'Las copias en nuestros respaldos se borran a medida que estos vencen, en un plazo de 90 días.',
            'Si usted no lo pidió, responda a este correo.',
        ]);
    }
    return notice(to, lang, 'Your BIES account has been deleted', [
        `As you asked, we deleted your BIES account on ${date}.`,
        'We deleted your profile, your directory listings and recommendations, your messages, and your posts on the BIES relay.' +
            (hadHostedKey
                ? ' We also destroyed the Nostr key we held for you, and asked other Nostr relays to delete what was published with it. Relays run by others decide for themselves.'
                : ''),
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
