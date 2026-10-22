/**
 * Give members with no BIES profile photo the picture on their Nostr profile
 * (kind 0), as a BIES copy: lists (Members, reviews, Recommended by) only
 * read the BIES photo, while a profile page falls back to the Nostr one, so
 * these members had a photo on their page and none anywhere else.
 *
 * The picture from BIES's relay comes first (a BIES-only profile), then the
 * newest from the public relays. It is fetched through safeGet (https only,
 * every address checked, 15 MB and 20 s at most), checked to be a photo from
 * its bytes, and made smaller like any upload, with its small copy for lists.
 * The upload is recorded as the member's own, so it goes with their account.
 * Only a photo that is still empty is set: a member who chose one keeps it.
 * Their Nostr profile is theirs and isn't changed.
 *
 * Dry run by default (lists what it would do); --apply makes the changes.
 * The running server caches lists for 2 minutes and profiles for 5.
 *
 *   docker exec bies-bies-server-1 node dist/src/scripts/fillAvatarsFromNostr.js [--apply]
 */
import sharp from 'sharp';
import type { Event as NostrEvent } from 'nostr-tools/pure';
import prisma from '../lib/prisma';
import { config } from '../config';
import { safeGet } from '../utils/safeFetch';
import { prepareMedia } from '../services/mediaProcessing';
import { uploadPublicFile } from '../services/storage.service';
import { makeThumbnail } from '../services/thumbnails.service';
import { recordUpload } from '../services/uploads.service';

// Where members' kind 0 lives (relay.nostr.band no longer answers).
const PUBLIC_RELAYS = ['wss://purplepag.es', 'wss://relay.primal.net', 'wss://relay.damus.io', 'wss://nos.lol'];
const QUERY_WAIT_MS = 8000;
const MAX_BYTES = 15 * 1024 * 1024;
const FORMATS: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

/** The https picture in a kind 0, or null. */
export function pictureOf(event: NostrEvent | undefined): string | null {
    if (!event) return null;
    try {
        const picture = JSON.parse(event.content)?.picture;
        if (typeof picture !== 'string') return null;
        const url = new URL(picture.trim());
        return url.protocol === 'https:' ? url.href : null;
    } catch {
        return null;
    }
}

/** Each pubkey's newest kind 0 among `events`. */
export function newestByAuthor(events: NostrEvent[]): Map<string, NostrEvent> {
    const newest = new Map<string, NostrEvent>();
    for (const e of events) {
        if (e.kind !== 0) continue;
        const seen = newest.get(e.pubkey);
        if (!seen || e.created_at > seen.created_at) newest.set(e.pubkey, e);
    }
    return newest;
}

async function main(): Promise<void> {
    const apply = process.argv.includes('--apply');
    const profiles = await prisma.profile.findMany({
        where: { avatar: '', user: { deletedAt: null, isBanned: false, nostrPubkey: { not: '' } } },
        select: { id: true, userId: true, user: { select: { nostrPubkey: true } } },
    });
    const pubkeys = [...new Set(profiles.map((p) => p.user.nostrPubkey).filter(Boolean))] as string[];
    console.log(`[Fill] ${profiles.length} member(s) with no BIES photo${apply ? '' : ' (dry run: nothing changes)'}`);
    if (pubkeys.length === 0) return;

    const { SimplePool } = await import('nostr-tools/pool');
    const pool = new SimplePool();
    const filter = { kinds: [0], authors: pubkeys };
    const [bies, open] = await Promise.all([
        config.nostrPrivateRelay ? pool.querySync([config.nostrPrivateRelay], filter, { maxWait: QUERY_WAIT_MS }).catch(() => []) : [],
        pool.querySync(PUBLIC_RELAYS, filter, { maxWait: QUERY_WAIT_MS }).catch(() => []),
    ]);
    pool.close([...(config.nostrPrivateRelay ? [config.nostrPrivateRelay] : []), ...PUBLIC_RELAYS]);
    const fromBies = newestByAuthor(bies);
    const fromPublic = newestByAuthor(open);

    let filled = 0;
    let none = 0;
    let failed = 0;
    for (const p of profiles) {
        const pubkey = p.user.nostrPubkey as string;
        const picture = pictureOf(fromBies.get(pubkey)) || pictureOf(fromPublic.get(pubkey));
        if (!picture) {
            none++;
            continue;
        }
        const res = await safeGet(picture, { timeoutMs: 20_000, maxBytes: MAX_BYTES });
        // What it is, from the bytes: never the host's say-so.
        const format = res ? (await sharp(res.body, { failOn: 'error' }).metadata().catch(() => null))?.format : undefined;
        const mimeType = format ? FORMATS[format] : undefined;
        if (!res || !mimeType) {
            failed++;
            console.log(`[Fill] profile ${p.id}: picture not fetched or not a photo, left empty`);
            continue;
        }
        if (!apply) {
            console.log(`[Fill] profile ${p.id}: would set a ${Math.round(res.body.length / 1024)} KB ${format} from ${new URL(picture).hostname}`);
            filled++;
            continue;
        }
        try {
            const media = await prepareMedia(res.body, mimeType);
            const { url, name } = await uploadPublicFile(media.buffer, media.mimeType);
            await recordUpload(p.userId, { name, mimeType: media.mimeType, size: media.buffer.length });
            await makeThumbnail(name, media.buffer);
            // Only if it's still empty: the member may have chosen one meanwhile.
            const changed = await prisma.profile.updateMany({ where: { id: p.id, avatar: '' }, data: { avatar: url } });
            if (changed.count === 1) {
                filled++;
                console.log(`[Fill] profile ${p.id}: set (${Math.round(media.buffer.length / 1024)} KB on BIES)`);
            }
        } catch (error) {
            failed++;
            console.log(`[Fill] profile ${p.id}: couldn't be processed (${(error as Error).message}), left empty`);
        }
    }
    console.log(`[Fill] ${apply ? 'set' : 'would set'} ${filled}, no Nostr picture ${none}, couldn't fetch ${failed}`);
}

if (require.main === module) {
    main().then(async () => { await prisma.$disconnect(); process.exit(0); }, async (error) => {
        console.error('[Fill] stopped:', error);
        await prisma.$disconnect();
        process.exit(1);
    });
}
