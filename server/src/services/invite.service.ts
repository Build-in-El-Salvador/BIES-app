/**
 * Invite-only sign-up (Admin Panel → Invites).
 *
 * While the switch is on (SiteSettings.inviteOnly), a new account needs an
 * invite code: one an admin made, for one person, for a few days. Members who
 * already have an account sign in as before. The switch starts off; codes
 * still work then, and record who invited whom.
 *
 * The codes:
 *   - 8 characters from crypto.randomInt over 31 letters and digits with the
 *     look-alikes left out (no 0/O, 1/I/L): 31^8 ≈ 8.5 × 10^11 codes. Shown
 *     as BIES-XXXX-XXXX; capitals, spaces and dashes don't matter when typed.
 *   - Never stored. `codeHash` is an HMAC-SHA256 under a key derived from
 *     ENCRYPTION_SECRET, which the database doesn't hold, so a copy of the
 *     table can't be turned back into codes, even by trying all of them (a
 *     plain hash of 8 characters could be). `codeSealed` is the code
 *     encrypted (AES-256-GCM), for admins to share an open code again; it's
 *     wiped once the code is used, revoked or expired.
 *   - Used up in the same transaction that creates the account, so one code
 *     makes one account even when two people try it at once, and a code that
 *     fails leaves no account behind.
 *   - Only valid while the admin who made it still is one.
 *   - Guessing is capped: 20 tries an hour from one address (IPv6 counted
 *     by /64, so one machine can't rotate through its block), counted
 *     before the code is looked at so tries sent at the same moment count
 *     too, and a code that works is given back. Past 1,000 wrong codes an
 *     hour from everyone together, an address that has already got one
 *     wrong this hour waits; one that hasn't can still try, so a flood
 *     doesn't lock out the people with real codes. With 100 codes open,
 *     each guess has about a 1 in 8.5 billion chance. A wrong guess is
 *     answered the same way whatever the reason (never made, used, expired,
 *     revoked), so it tells the guesser nothing.
 *   - Kept out of logs: links carry the code after `#`, which browsers never
 *     send to a server, and the API only takes it in request bodies, which
 *     the audit log doesn't record.
 */

import crypto from 'crypto';
import type { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { config } from '../config';

// ─── The code ────────────────────────────────────────────────────────────────

/** 31 characters: digits 2–9 and A–Z without I, L and O. */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LENGTH = 8;
const PREFIX = 'BIES';

/** How long a new code works. One number, easy to change (INVITE_CODE_DAYS). */
export const INVITE_DAYS = Math.min(30, Math.max(1, parseInt(process.env.INVITE_CODE_DAYS || '7', 10) || 7));
/** Open codes at once, across all admins. */
export const MAX_OPEN_INVITES = 100;
export const NOTE_MAX = 80;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The 8 characters of a code as typed or pasted, or null if it can't be one.
 * Case, spaces, dashes and the BIES- in front don't matter.
 */
export function normalizeInviteCode(input: unknown): string | null {
    if (typeof input !== 'string' || input.length > 64) return null;
    let body = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (body.length === PREFIX.length + CODE_LENGTH && body.startsWith(PREFIX)) body = body.slice(PREFIX.length);
    if (body.length !== CODE_LENGTH) return null;
    for (const ch of body) if (!CODE_ALPHABET.includes(ch)) return null;
    return body;
}

/** BIES-K7M4-Q9TX, for people. */
export function formatInviteCode(body: string): string {
    return `${PREFIX}-${body.slice(0, 4)}-${body.slice(4)}`;
}

function newCodeBody(): string {
    let body = '';
    for (let i = 0; i < CODE_LENGTH; i++) body += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    return body;
}

// One key per use, derived from ENCRYPTION_SECRET (which is never rotated: it
// also protects the Nostr keys BIES holds), so open codes survive a JWT_SECRET
// rotation.
function derivedKey(info: string): Buffer {
    return Buffer.from(crypto.hkdfSync('sha256', config.encryptionSecret, 'bies-invite-codes', info, 32));
}
let keys: { hash: Buffer; seal: Buffer; ticket: Buffer } | null = null;
function key(name: 'hash' | 'seal' | 'ticket'): Buffer {
    keys ??= { hash: derivedKey('code-hash-v1'), seal: derivedKey('code-seal-v1'), ticket: derivedKey('signup-ticket-v1') };
    return keys[name];
}

export function hashInviteCode(body: string): string {
    return crypto.createHmac('sha256', key('hash')).update(body).digest('hex');
}

function seal(body: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key('seal'), iv);
    const ciphertext = Buffer.concat([cipher.update(body, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

function unseal(sealed: string | null): string | null {
    if (!sealed) return null;
    try {
        const raw = Buffer.from(sealed, 'base64');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key('seal'), raw.subarray(0, 12));
        decipher.setAuthTag(raw.subarray(12, 28));
        return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    } catch {
        return null;
    }
}

// ─── The switch ──────────────────────────────────────────────────────────────

/** Whether new accounts need an invite code. Read fresh every time: never a stale "off". */
export async function isInviteOnly(): Promise<boolean> {
    const settings = await prisma.siteSettings.findUnique({ where: { id: 'default' }, select: { inviteOnly: true } });
    return settings?.inviteOnly === true;
}

export async function inviteGate() {
    const settings = await prisma.siteSettings.findUnique({
        where: { id: 'default' },
        select: { inviteOnly: true, inviteOnlyChangedAt: true, inviteOnlyChangedBy: true },
    });
    const by = settings?.inviteOnlyChangedBy
        ? await prisma.user.findUnique({ where: { id: settings.inviteOnlyChangedBy }, select: { id: true, profile: { select: { name: true } } } })
        : null;
    return {
        inviteOnly: settings?.inviteOnly === true,
        changedAt: settings?.inviteOnlyChangedAt ?? null,
        changedBy: by ? { id: by.id, name: by.profile?.name || '' } : null,
    };
}

export async function setInviteOnly(inviteOnly: boolean, adminId: string) {
    const data = { inviteOnly, inviteOnlyChangedAt: new Date(), inviteOnlyChangedBy: adminId };
    await prisma.siteSettings.upsert({ where: { id: 'default' }, create: { id: 'default', ...data }, update: data });
    return inviteGate();
}

// ─── Guessing ────────────────────────────────────────────────────────────────

// In memory, like the other sign-up limits: the server is one process, and a
// restart (a deploy) only starts the count again.
const HOUR_MS = 60 * 60 * 1000;
const TRIES_PER_IP_PER_HOUR = 20;
const FAILS_PER_HOUR = 1000;
const WARN_FAILS_PER_HOUR = 100;
const triesByIp = new Map<string, { count: number; resetAt: number }>();
let failsAll = { count: 0, resetAt: 0, warned: false };

/** IPv4 as it is; IPv6 by its /64, which one machine usually holds whole. */
export function limitKey(ip: string | null | undefined): string {
    if (!ip) return 'unknown';
    const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
    if (v4) return v4[1];
    if (!ip.includes(':')) return ip;
    const [head, tail] = ip.split('%')[0].toLowerCase().split('::');
    const front = head ? head.split(':') : [];
    const back = tail === undefined ? null : tail ? tail.split(':') : [];
    const groups = back === null ? front : [...front, ...Array(Math.max(0, 8 - front.length - back.length)).fill('0'), ...back];
    return `${groups.slice(0, 4).map((g) => (parseInt(g || '0', 16) || 0).toString(16)).join(':')}::/64`;
}

const seconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000));

/**
 * Take one try at a code from this address: 0 if it may go ahead, or the
 * seconds to wait. Counted now, before the code is looked at, so tries made
 * at the same moment all count; giveBackInviteTry once it turns out right.
 */
export function takeInviteTry(ip: string | null | undefined, now = Date.now()): number {
    const k = limitKey(ip);
    let mine = triesByIp.get(k);
    if (!mine || mine.resetAt <= now) {
        mine = { count: 0, resetAt: now + HOUR_MS };
        triesByIp.set(k, mine);
    }
    if (failsAll.resetAt <= now) failsAll = { count: 0, resetAt: now + HOUR_MS, warned: false };
    if (mine.count >= TRIES_PER_IP_PER_HOUR) return seconds(mine.resetAt - now);
    if (failsAll.count >= FAILS_PER_HOUR && mine.count > 0) return seconds(Math.min(mine.resetAt, failsAll.resetAt) - now);
    mine.count += 1;
    countFailure();
    if (triesByIp.size > 10_000) for (const [key, v] of triesByIp) if (v.resetAt <= now) triesByIp.delete(key);
    return 0;
}

/** The code was right: that try doesn't count. */
export function giveBackInviteTry(ip: string | null | undefined, now = Date.now()): void {
    const mine = triesByIp.get(limitKey(ip));
    if (mine && mine.resetAt > now && mine.count > 0) mine.count -= 1;
    if (failsAll.resetAt > now && failsAll.count > 0) failsAll.count -= 1;
}

/** A code that passed the check but couldn't be used after all (taken a moment before). */
export function recordInviteFailure(ip: string | null | undefined, now = Date.now()): void {
    const k = limitKey(ip);
    const mine = triesByIp.get(k);
    if (!mine || mine.resetAt <= now) triesByIp.set(k, { count: 1, resetAt: now + HOUR_MS });
    else mine.count += 1;
    if (failsAll.resetAt <= now) failsAll = { count: 0, resetAt: now + HOUR_MS, warned: false };
    countFailure();
}

function countFailure(): void {
    failsAll.count += 1;
    if (failsAll.count > WARN_FAILS_PER_HOUR && !failsAll.warned) {
        failsAll.warned = true;
        console.warn(`[Invites] More than ${WARN_FAILS_PER_HOUR} wrong invite codes in the last hour`);
    }
}

/** Tests only. */
export function resetInviteLimits(): void {
    triesByIp.clear();
    failsAll = { count: 0, resetAt: 0, warned: false };
}

// ─── Checking and using a code ───────────────────────────────────────────────

const creatorSelect = { isAdmin: true, isBanned: true, deletedAt: true } as const;
type Creator = { isAdmin: boolean; isBanned: boolean; deletedAt: Date | null } | null;
const creatorStillAdmin = (c: Creator) => !!c && c.isAdmin && !c.isBanned && !c.deletedAt;

/**
 * Whether a code would let a new account in now. Doesn't use it up: that
 * happens only when the account is made (createAccount).
 */
export async function checkInvite(code: unknown, now = new Date()): Promise<{ ok: true; expiresAt: Date } | { ok: false }> {
    const body = normalizeInviteCode(code);
    if (!body) return { ok: false };
    const row = await prisma.inviteCode.findUnique({
        where: { codeHash: hashInviteCode(body) },
        select: { expiresAt: true, usedAt: true, revokedAt: true, createdBy: { select: creatorSelect } },
    });
    if (!row || row.usedAt || row.revokedAt || row.expiresAt <= now || !creatorStillAdmin(row.createdBy)) return { ok: false };
    return { ok: true, expiresAt: row.expiresAt };
}

/** The code didn't work: the account wasn't made. */
export class InviteRejected extends Error {
    constructor() {
        super('Invite code not accepted');
        this.name = 'InviteRejected';
    }
}

/**
 * Make a new account, and use up the invite code in the same transaction.
 * `required` (the switch is on): without a code that works, nothing is made
 * and this throws InviteRejected. Otherwise a code that works is used up
 * (recording who invited whom) and one that doesn't is ignored.
 */
export async function createAccount<T extends { id: string }>(
    create: (tx: Prisma.TransactionClient) => Promise<T>,
    invite: { code?: unknown; required: boolean },
    now = new Date(),
): Promise<T> {
    const body = normalizeInviteCode(invite.code);
    if (invite.required && !body) throw new InviteRejected();
    return prisma.$transaction(async (tx) => {
        const user = await create(tx);
        if (!body) return user;
        const row = await tx.inviteCode.findUnique({
            where: { codeHash: hashInviteCode(body) },
            select: { id: true, createdBy: { select: creatorSelect } },
        });
        // Only while it's open: the condition is the claim, so a second
        // account can't use the same code even at the same moment.
        const claimed = row && creatorStillAdmin(row.createdBy)
            ? await tx.inviteCode.updateMany({
                where: { id: row.id, usedAt: null, revokedAt: null, expiresAt: { gt: now } },
                data: { usedAt: now, usedById: user.id, codeSealed: null },
            })
            : { count: 0 };
        if (claimed.count !== 1 && invite.required) throw new InviteRejected();
        return user;
    });
}

// ─── Email sign-up without a second code ─────────────────────────────────────

const TICKET_TTL_MS = 15 * 60 * 1000;

function ticketSignature(email: string, expires: number): Buffer {
    return crypto.createHmac('sha256', key('ticket')).update(`${email}\n${expires}`).digest();
}

/**
 * Proof, for 15 minutes, that this device just entered the email code for
 * `email`, so it can come back with an invite code without asking for
 * another email. Only good for making a new account (verifyEmailLogin).
 */
export function issueSignupTicket(email: string, now = Date.now()): string {
    const expires = now + TICKET_TTL_MS;
    return `${expires}.${ticketSignature(email, expires).toString('base64url')}`;
}

export function signupTicketValid(email: string, ticket: unknown, now = Date.now()): boolean {
    if (typeof ticket !== 'string' || ticket.length > 128) return false;
    const [expiresText, signature, extra] = ticket.split('.');
    if (extra !== undefined || !/^\d{13}$/.test(expiresText ?? '') || !signature) return false;
    const expires = Number(expiresText);
    if (expires <= now || expires > now + TICKET_TTL_MS) return false;
    const expected = ticketSignature(email, expires);
    const given = Buffer.from(signature, 'base64url');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// ─── Admin Panel → Invites ───────────────────────────────────────────────────

export class InviteLimitReached extends Error {
    constructor() {
        super(`There are already ${MAX_OPEN_INVITES} open invites`);
        this.name = 'InviteLimitReached';
    }
}

type Status = 'open' | 'used' | 'expired' | 'revoked';

const listSelect = {
    id: true, codeSealed: true, note: true, createdAt: true, expiresAt: true, usedAt: true, revokedAt: true,
    createdBy: { select: { id: true, profile: { select: { name: true } } } },
    usedBy: { select: { id: true, profile: { select: { name: true } } } },
} as const;

type ListRow = Prisma.InviteCodeGetPayload<{ select: typeof listSelect }>;

function statusOf(row: { usedAt: Date | null; revokedAt: Date | null; expiresAt: Date }, now: Date): Status {
    if (row.usedAt) return 'used';
    if (row.revokedAt) return 'revoked';
    return row.expiresAt <= now ? 'expired' : 'open';
}

function forAdmins(row: ListRow, now: Date) {
    const status = statusOf(row, now);
    const body = status === 'open' ? unseal(row.codeSealed) : null;
    return {
        id: row.id,
        status,
        // The code only while it's open; afterwards nobody needs it.
        code: body ? formatInviteCode(body) : null,
        note: row.note,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        usedAt: row.usedAt,
        revokedAt: row.revokedAt,
        createdBy: { id: row.createdBy.id, name: row.createdBy.profile?.name || '' },
        // Used, and the account since deleted: no one.
        usedBy: row.usedBy ? { id: row.usedBy.id, name: row.usedBy.profile?.name || '' } : null,
        accountDeleted: status === 'used' && !row.usedBy,
    };
}

const openWhere = (now: Date) => ({ usedAt: null, revokedAt: null, expiresAt: { gt: now } });

/**
 * Before listing or counting: expired codes lose their encrypted copy (nobody
 * can share them again), and open codes whose admin no longer is one, which
 * already don't work, are revoked for good.
 */
async function tidyInvites(now: Date): Promise<void> {
    await prisma.inviteCode.updateMany({ where: { codeSealed: { not: null }, expiresAt: { lte: now } }, data: { codeSealed: null } });
    await prisma.inviteCode.updateMany({
        where: { ...openWhere(now), createdBy: { is: { OR: [{ isAdmin: false }, { isBanned: true }, { deletedAt: { not: null } }] } } },
        data: { revokedAt: now, codeSealed: null },
    });
}

export async function createInvite(adminId: string, note = '', now = new Date()) {
    await tidyInvites(now);
    if (await prisma.inviteCode.count({ where: openWhere(now) }) >= MAX_OPEN_INVITES) throw new InviteLimitReached();
    const expiresAt = new Date(now.getTime() + INVITE_DAYS * DAY_MS);
    // A clash between two random codes is about one in a billion; try again if so.
    for (let attempt = 0; attempt < 5; attempt++) {
        const body = newCodeBody();
        try {
            const row = await prisma.inviteCode.create({
                data: { codeHash: hashInviteCode(body), codeSealed: seal(body), note: note.trim().slice(0, NOTE_MAX), createdById: adminId, createdAt: now, expiresAt },
                select: listSelect,
            });
            return forAdmins(row, now);
        } catch (err) {
            if ((err as { code?: string }).code !== 'P2002') throw err;
        }
    }
    throw new Error('Could not make a unique invite code');
}

/** Every open invite and the newest 200 others, newest first, and the switch. */
export async function listInvites(now = new Date()) {
    await tidyInvites(now);
    const [open, closed] = await Promise.all([
        prisma.inviteCode.findMany({ where: openWhere(now), orderBy: { createdAt: 'desc' }, select: listSelect }),
        prisma.inviteCode.findMany({ where: { NOT: openWhere(now) }, orderBy: { createdAt: 'desc' }, take: 200, select: listSelect }),
    ]);
    const rows = [...open, ...closed].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return { ...(await inviteGate()), invites: rows.map((row) => forAdmins(row, now)), openCount: open.length, maxOpen: MAX_OPEN_INVITES, days: INVITE_DAYS };
}

/** Stop an open code working at once. False if it wasn't open. */
export async function revokeInvite(id: string, now = new Date()): Promise<boolean> {
    const { count } = await prisma.inviteCode.updateMany({
        where: { id, ...openWhere(now) },
        data: { revokedAt: now, codeSealed: null },
    });
    return count === 1;
}

export async function setInviteNote(id: string, note: string, now = new Date()) {
    const row = await prisma.inviteCode.update({ where: { id }, data: { note: note.trim().slice(0, NOTE_MAX) }, select: listSelect }).catch(() => null);
    return row ? forAdmins(row, now) : null;
}
