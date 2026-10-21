/**
 * Make the small copies (thumbnails.service.ts) of public photos uploaded
 * before they existed. Safe to run again: photos that have one are skipped.
 * Reads only uploads/public (never private/); writes only uploads/public/t.
 *
 * In the running app container:
 *   docker exec bies-bies-server-1 node dist/src/scripts/makeThumbnails.js
 */
import fs from 'fs';
import path from 'path';
import { PUBLIC_DIR, THUMB_DIR, thumbFileName } from '../services/storage.service';
import { makeThumbnail } from '../services/thumbnails.service';

async function main(): Promise<void> {
    let made = 0;
    let had = 0;
    let failed = 0;
    for (const name of fs.readdirSync(PUBLIC_DIR)) {
        const thumb = thumbFileName(name);
        if (!thumb) continue; // videos and anything else
        if (fs.existsSync(path.join(THUMB_DIR, thumb))) { had++; continue; }
        const photo = await fs.promises.readFile(path.join(PUBLIC_DIR, name));
        if (await makeThumbnail(name, photo)) made++;
        else failed++;
    }
    console.log(`[Thumbnails] made ${made}, already had ${had}, failed ${failed}`);
}

main().then(() => process.exit(0), (error) => {
    console.error('[Thumbnails] stopped:', error);
    process.exit(1);
});
