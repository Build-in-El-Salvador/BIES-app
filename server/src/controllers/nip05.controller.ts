import { Request, Response } from 'express';
import prisma from '../lib/prisma';

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
        // still show them as verified by BIES.
        const profile = await prisma.profile.findFirst({
            where: { nip05Name: normalizedName, user: { isBanned: false, deletedAt: null } },
            include: {
                user: { select: { nostrPubkey: true } },
            },
        });

        if (!profile || !profile.user?.nostrPubkey) {
            res.json({ names: {}, relays: {} });
            return;
        }

        const pubkey = profile.user.nostrPubkey;

        res.json({
            names: { [normalizedName]: pubkey },
            relays: { [pubkey]: ['wss://relay.buildinelsalvador.com'] },
        });
    } catch (error) {
        console.error('NIP-05 lookup error:', error);
        res.json({ names: {}, relays: {} });
    }
}
