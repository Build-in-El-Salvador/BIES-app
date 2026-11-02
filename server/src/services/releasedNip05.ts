/**
 * BIES addresses given up or taken away (the released_nip05 table): held
 * so a name can't pass at once to someone else, whom other Nostr apps would
 * then show as the same verified person. See services/nip05.ts.
 */
import type { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { RELEASED_HOLD_MS, isHeldNip05 } from './nip05';

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Note a BIES address its owner no longer has: changed, removed, or the
 * account deleted (`pubkey` null: nothing of the account is kept). One an
 * admin took away is `blocked`: held for everyone until an admin deletes
 * the row. Held names whose time is up are dropped meanwhile.
 */
export async function recordReleasedNip05(db: Db, name: string, pubkey: string | null, { blocked = false } = {}): Promise<void> {
    const releasedAt = new Date();
    await db.releasedNip05.deleteMany({ where: { blocked: false, releasedAt: { lt: new Date(releasedAt.getTime() - RELEASED_HOLD_MS) } } });
    await db.releasedNip05.upsert({
        where: { name },
        create: { name, pubkey, releasedAt, blocked },
        // Taken away once, it stays taken away.
        update: { pubkey, releasedAt, ...(blocked ? { blocked: true } : {}) },
    });
}

/** Whether a name is held from this key (isHeldNip05). */
export async function nip05IsHeld(name: string, pubkey: string | null | undefined): Promise<boolean> {
    const released = await prisma.releasedNip05.findUnique({ where: { name } });
    return isHeldNip05(released, pubkey);
}
