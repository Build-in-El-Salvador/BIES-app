import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { config } from '../config';
import { publicNostrOf } from '../services/publicNostrProfile';

/**
 * GET /.well-known/nostr.json?name=<username>
 * NIP-05 identity verification endpoint.
 * Returns { names: { username: pubkey }, relays: { pubkey: [relay_urls] } }
 */
export async function nostrJson(req: Request, res: Response): Promise<void> {
    try {
        const name = req.query.name as string;

        // NIP-05 requires CORS * so any Nostr client can verify
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'max-age=300');

        if (!name) {
            res.json({ names: {}, relays: {} });
            return;
        }

        const normalizedName = name.toLowerCase().trim();

        // Not for a suspended or deleted member: other Nostr clients would
        // still show them as verified by BIES. Only a name its member claimed
        // (Settings → Nostr): the ones sign-up handed out ("nostr-" and part of
        // the key) would only tell anyone holding a key that it's a member's.
        const profile = await prisma.profile.findFirst({
            where: { nip05Name: normalizedName, nip05ClaimedAt: { not: null }, user: { isBanned: false, deletedAt: null } },
            include: {
                user: { select: { nostrPubkey: true } },
            },
        });

        if (!profile || !profile.user?.nostrPubkey) {
            res.json({ names: {}, relays: {} });
            return;
        }

        const pubkey = profile.user.nostrPubkey;
        // Where other apps can find them: the public relays once they've
        // published a public profile (Settings → Nostr), otherwise BIES's
        // members' relay.
        const relays = publicNostrOf(profile.publicNostr).publishedAt
            ? config.nostrRelays
            : [config.nostrPublicRelay];

        res.json({
            names: { [normalizedName]: pubkey },
            relays: { [pubkey]: relays },
        });
    } catch (error) {
        console.error('NIP-05 lookup error:', error);
        res.json({ names: {}, relays: {} });
    }
}
