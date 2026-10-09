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
import { decryptPrivateKey } from './crypto.service';

export type SignatureSource = 'app' | 'server';

const RELAY_AUTH_KIND = 22242;

/**
 * Sign an event with the member's hosted key. Returns null when BIES holds
 * no key for them (Nostr sign-in: they sign on their own device), and for
 * banned or deleted accounts. Pass a function to build the template from the
 * member's pubkey.
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
    if (user.isBanned || user.deletedAt) {
        console.warn(`[Signer] Refused to sign for banned or deleted user ${userId}`);
        return null;
    }

    const unsigned = typeof template === 'function' ? template(user.nostrPubkey) : template;
    const secretKey = hexToBytes(decryptPrivateKey(user.encryptedPrivkey));
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

export type SignRefusal = 'kind_not_allowed' | 'bad_time' | 'too_large' | 'bad_relay' | 'bad_expiration';

function normalizeRelayUrl(url: string): string | null {
    try {
        const u = new URL(url);
        if (u.protocol !== 'wss:' && u.protocol !== 'ws:') return null;
        return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
    } catch {
        return null;
    }
}

function tagValue(tags: string[][], name: string): string | undefined {
    return tags.find((t) => t[0] === name)?.[1];
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
    if (template.kind === RELAY_AUTH_KIND) {
        const relay = normalizeRelayUrl(tagValue(template.tags, 'relay') ?? '');
        const allowed = config.signer.authRelays.map(normalizeRelayUrl);
        if (!relay || !allowed.includes(relay) || !tagValue(template.tags, 'challenge')) return 'bad_relay';
    }

    // Blossom upload tokens: short-lived only.
    if (template.kind === 24242) {
        const expiration = Number(tagValue(template.tags, 'expiration'));
        if (!Number.isInteger(expiration) || expiration <= nowSeconds || expiration > nowSeconds + MAX_BLOSSOM_TOKEN_SECONDS) {
            return 'bad_expiration';
        }
    }

    return null;
}

function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return bytes;
}
