/**
 * Move members' profile photos from the two Nostr photo hosts the app used
 * before 13 Oct 2026 (blossom.primal.net, nostr.build) onto BIES: the same
 * picture, made smaller like any upload (mediaProcessing.ts), with its small
 * copy for lists. Those originals are unprocessed and often several MB, and
 * every viewer's phone fetched them from a third party.
 *
 * Only those hosts (no other address is ever fetched), through safeGet:
 * https only, every address checked, 15 MB and 20 s at most. The new upload
 * is recorded as the member's own, so it goes with their account. Their
 * Nostr profile (kind 0) is theirs and isn't changed.
 *
 * Dry run by default (lists what it would do); --apply makes the changes.
 * The running server caches lists for 2 minutes and profiles for 5.
 *
 *   docker exec bies-bies-server-1 node dist/src/scripts/rehostAvatars.js [--apply]
 */
import sharp from 'sharp';
import prisma from '../lib/prisma';
import { safeGet } from '../utils/safeFetch';
import { prepareMedia } from '../services/mediaProcessing';
import { uploadPublicFile } from '../services/storage.service';
import { makeThumbnail } from '../services/thumbnails.service';
import { recordUpload } from '../services/uploads.service';

const HOSTS = new Set(['blossom.primal.net', 'nostr.build', 'image.nostr.build', 'i.nostr.build', 'cdn.nostr.build']);
const MAX_BYTES = 15 * 1024 * 1024;
const FORMATS: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

function onOldHost(url: string): boolean {
    try {
        const u = new URL(url);
        return u.protocol === 'https:' && HOSTS.has(u.hostname.toLowerCase());
    } catch {
        return false;
    }
}

async function main(): Promise<void> {
    const apply = process.argv.includes('--apply');
    const profiles = (await prisma.profile.findMany({
        where: { avatar: { not: '' }, user: { deletedAt: null } },
        select: { id: true, userId: true, avatar: true },
    })).filter((p) => onOldHost(p.avatar));
    console.log(`[Rehost] ${profiles.length} profile photo(s) on ${[...HOSTS].join(', ')}${apply ? '' : ' (dry run: nothing changes)'}`);

    let moved = 0;
    let failed = 0;
    for (const p of profiles) {
        const res = await safeGet(p.avatar, { timeoutMs: 20_000, maxBytes: MAX_BYTES });
        // What it is, from the bytes: never the host's say-so.
        const format = res ? (await sharp(res.body, { failOn: 'error' }).metadata().catch(() => null))?.format : undefined;
        const mimeType = format ? FORMATS[format] : undefined;
        if (!res || !mimeType) {
            failed++;
            console.log(`[Rehost] profile ${p.id}: not fetched or not a photo, left as is`);
            continue;
        }
        if (!apply) {
            console.log(`[Rehost] profile ${p.id}: would move a ${Math.round(res.body.length / 1024)} KB ${format}`);
            continue;
        }
        try {
            const media = await prepareMedia(res.body, mimeType);
            const { url, name } = await uploadPublicFile(media.buffer, media.mimeType);
            await recordUpload(p.userId, { name, mimeType: media.mimeType, size: media.buffer.length });
            await makeThumbnail(name, media.buffer);
            // Only if it's still the same photo: the member may have changed it meanwhile.
            const changed = await prisma.profile.updateMany({ where: { id: p.id, avatar: p.avatar }, data: { avatar: url } });
            if (changed.count === 1) {
                moved++;
                console.log(`[Rehost] profile ${p.id}: ${Math.round(res.body.length / 1024)} KB → ${Math.round(media.buffer.length / 1024)} KB on BIES`);
            }
        } catch (error) {
            failed++;
            console.log(`[Rehost] profile ${p.id}: couldn't be processed (${(error as Error).message}), left as is`);
        }
    }
    console.log(`[Rehost] ${apply ? `moved ${moved}` : 'dry run'}, couldn't move ${failed}`);
}

main().then(async () => { await prisma.$disconnect(); process.exit(0); }, async (error) => {
    console.error('[Rehost] stopped:', error);
    await prisma.$disconnect();
    process.exit(1);
});
