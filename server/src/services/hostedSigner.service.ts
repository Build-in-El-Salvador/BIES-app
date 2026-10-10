/**
 * Signing with the Nostr keys BIES holds for email accounts.
 *
 * The only place a hosted key is decrypted. The key is wiped as soon as the
 * event is signed, and every signature is recorded in hosted_signatures
 * before it is handed out (except relay sign-in challenges, see the schema),
 * so members can see what was signed in their name.
 *
 * Two callers:
 * - the server, publishing on a member's behalf (nostr.service.ts), and
 * - the member's own app, through POST /api/signer/sign. The app may only ask
 *   for what checkAppSignRequest() allows.
 */

import type { Event as NostrEvent, EventTemplate } from 'nostr-tools/pure';
import prisma from '../lib/prisma';
import { config } from '../config';
import { decryptPrivateKeyAsync } from './crypto.service';

export type SignatureSource = 'app' | 'server';

const RELAY_AUTH_KIND = 22242;

/**
 * Sign an event with the member's hosted key. Returns null when BIES holds
 * no key for them (Nostr sign-in: they sign on their own device), and for
 * banned or deleted accounts, except that the server can still retract their
 * events. Pass a function to build the template from the member's pubkey.
 */
export async function signAsHostedUser(
    userId: string,
    template: EventTemplate | ((pubkey: string) => EventTemplate),
    source: SignatureSource,
): Promise<NostrEvent | null> {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { encryptedPrivkey: true, nostrPubkey: true, isBanned: true, deletedAt: true },
    });
    if (!user?.encryptedPrivkey) return null;

    const unsigned = typeof template === 'function' ? template(user.nostrPubkey) : template;

    // Suspended accounts can't sign, with one exception: the server
    // retracting their events (kind 5). When an admin deletes a banned
    // member's event or course, it must still disappear from relays, and only
    // this key can retract it.
    if ((user.isBanned || user.deletedAt) && !(source === 'server' && unsigned.kind === 5)) {
        console.warn(`[Signer] Refused to sign kind ${unsigned.kind} for banned or deleted user ${userId}`);
        return null;
    }

    const secretKey = hexToBytes(await decryptPrivateKeyAsync(user.encryptedPrivkey));
    let signed: NostrEvent;
    try {
        const { finalizeEvent } = await import('nostr-tools/pure');
        signed = finalizeEvent({ ...unsigned }, secretKey);
    } finally {
        secretKey.fill(0);
    }

    if (signed.pubkey !== user.nostrPubkey) {
        throw new Error(`Hosted key of user ${userId} does not match their pubkey`);
    }

    // No record, no signature: if this write fails, the event is never released.
    if (signed.kind !== RELAY_AUTH_KIND) {
        await prisma.hostedSignature.create({
            data: { userId, kind: signed.kind, eventId: signed.id, source },
        });
    }
    return signed;
}

// ─── What the app may ask for ─────────────────────────────────────────────────

/**
 * The kinds the app asks remote signers to approve (AMBER_PERMISSIONS and
 * NIP46_PERMS in the client's src/services), minus:
 * - 13, DM seals: they need NIP-44 encryption with the hosted key, which
 *   isn't built yet (DMs aren't in the first store release);
 * - 27235, HTTP auth: email accounts never need it to sign in to BIES, and
 *   it would let a stolen session sign in to other services as the member;
 * - 31777, passkey key backups: there is no key on the device to back up.
 */
export const APP_SIGNABLE_KINDS = new Set([
    0, 1, 3, 5, 6, 7, 1984, 9734, 10002, 22242, 24242, 30402, 31923, 31925,
]);

const MAX_PAST_SECONDS = 60 * 60;
// A future-dated replaceable event (profile, contact list, listing) would
// block every later update to it until that date.
const MAX_FUTURE_SECONDS = 10 * 60;
const MAX_CONTENT_BYTES = 64 * 1024;
const MAX_TAGS = 10_000; // contact lists can be long
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_BLOSSOM_TOKEN_SECONDS = 24 * 60 * 60;
const MAX_CHALLENGE_LENGTH = 256;

export type SignRefusal = 'kind_not_allowed' | 'bad_time' | 'too_large' | 'bad_relay' | 'bad_upload_token';

function normalizeRelayUrl(url: string): string | null {
    try {
        const u = new URL(url);
        if (u.protocol !== 'wss:' && u.protocol !== 'ws:') return null;
        if (u.username || u.password || u.search || u.hash) return null;
        return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
    } catch {
        return null;
    }
}

/** The value of the only `name` tag, or null if there are none, several, or extra fields. */
function onlyTag(tags: string[][], name: string): string | null {
    const found = tags.filter((t) => t[0] === name);
    return found.length === 1 && found[0].length === 2 ? found[0][1] : null;
}

/**
 * A NIP-42 sign-in for BIES's own relay, and nothing more: exactly one relay
 * tag and one challenge tag, no content. Relays disagree about which relay
 * tag counts (strfry accepts any match, nostr-rs-relay takes the last), so a
 * second one could carry another relay's URL.
 */
function isBiesRelayAuth(template: EventTemplate): boolean {
    if (template.content !== '' || template.tags.length !== 2) return false;
    const challenge = onlyTag(template.tags, 'challenge');
    if (!challenge || challenge.length > MAX_CHALLENGE_LENGTH) return false;
    const relay = normalizeRelayUrl(onlyTag(template.tags, 'relay') ?? '');
    return !!relay && config.signer.authRelays.map(normalizeRelayUrl).includes(relay);
}

/**
 * A Blossom upload permission (BUD-02) for one file, expiring within a day:
 * exactly one `t=upload`, one sha256 `x` and one decimal `expiration`. No
 * delete or list permissions.
 */
function isBlossomUploadToken(template: EventTemplate, nowSeconds: number): boolean {
    if (onlyTag(template.tags, 't') !== 'upload') return false;
    if (!/^[0-9a-f]{64}$/.test(onlyTag(template.tags, 'x') ?? '')) return false;
    const expiration = onlyTag(template.tags, 'expiration') ?? '';
    if (!/^\d{1,12}$/.test(expiration)) return false;
    const expiresAt = Number(expiration);
    return expiresAt > nowSeconds && expiresAt <= nowSeconds + MAX_BLOSSOM_TOKEN_SECONDS;
}

/**
 * Why the app can't have this event signed, or null if it can.
 */
export function checkAppSignRequest(template: EventTemplate, nowSeconds = Math.floor(Date.now() / 1000)): SignRefusal | null {
    if (!APP_SIGNABLE_KINDS.has(template.kind)) return 'kind_not_allowed';

    if (template.created_at < nowSeconds - MAX_PAST_SECONDS || template.created_at > nowSeconds + MAX_FUTURE_SECONDS) {
        return 'bad_time';
    }

    if (
        Buffer.byteLength(template.content, 'utf8') > MAX_CONTENT_BYTES ||
        template.tags.length > MAX_TAGS ||
        Buffer.byteLength(JSON.stringify(template), 'utf8') > MAX_EVENT_BYTES
    ) {
        return 'too_large';
    }

    // Relay sign-in (NIP-42): only for BIES's own relay, so a stolen session
    // can't use it to sign in to other relays as the member.
    if (template.kind === RELAY_AUTH_KIND && !isBiesRelayAuth(template)) return 'bad_relay';

    // Blossom: short-lived upload permissions only.
    if (template.kind === 24242 && !isBlossomUploadToken(template, nowSeconds)) return 'bad_upload_token';

    return null;
}

function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return bytes;
}
