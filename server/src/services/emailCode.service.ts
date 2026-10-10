/**
 * One-time email codes: issue, send and verify.
 *
 * Used for sign-in today; confirming account deletion and key export will use
 * the same codes with a different `purpose`, so a code sent for one can never
 * be spent on another.
 *
 * Rules:
 * - 6 digits, valid for 10 minutes from when the email goes out (not
 *   before), 5 tries per code. A new code replaces the previous one once it
 *   has been sent.
 * - Per address: one code a minute, 5 an hour, 10 a day. This also caps
 *   guessing: at most 50 tries a day against any one account. The flip side:
 *   someone who requests 10 codes for an address blocks new email sign-ins
 *   for it for a day. Sessions already signed in are unaffected.
 * - Per IP: 50 an hour. Kept generous on purpose: event Wi-Fi and mobile
 *   carriers put many people behind one address.
 * - In total: config.email.maxCodesPerDay, so a flood can't use up the Resend
 *   quota that pretix tickets share.
 * - Codes, addresses and IPs are stored only as HMACs, and rows are deleted
 *   after 24 hours.
 * - The App Review address (config.reviewLogin) gets the fixed code from the
 *   server's environment instead of an email. Every other rule still applies.
 */

import crypto from 'crypto';
import prisma from '../lib/prisma';
import { config } from '../config';
import { sendEmail, type OutgoingEmail } from './email.service';

export type EmailCodePurpose = 'login';
export type EmailLang = 'en' | 'es';

export const CODE_TTL_SECONDS = 10 * 60;
export const RESEND_COOLDOWN_SECONDS = 60;
export const MAX_ATTEMPTS = 5;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const PER_EMAIL_LIMITS = [
    { windowMs: RESEND_COOLDOWN_SECONDS * 1000, max: 1 },
    { windowMs: HOUR, max: 5 },
    { windowMs: DAY, max: 10 },
];
const MAX_PER_IP_PER_HOUR = 50;
const RETENTION_MS = DAY;

const REVIEW_CODE_RE = /^\d{6}$/;
if (config.reviewLogin.email && !REVIEW_CODE_RE.test(config.reviewLogin.code)) {
    console.warn('[EmailCode] REVIEW_LOGIN_EMAIL is set but REVIEW_LOGIN_CODE is not 6 digits; review sign-in is off');
}

// ─── Hashing ──────────────────────────────────────────────────────────────────

// One key per use, derived from JWT_SECRET. Without the secret, a copy of the
// table can't be brute-forced offline (6 digits is only a million guesses),
// and the hashed addresses can't be matched against a list of emails.
function hmac(label: string, value: string): string {
    const key = crypto.createHash('sha256').update(`bies-email-code:${label}:${config.jwtSecret}`).digest();
    return crypto.createHmac('sha256', key).update(value).digest('hex');
}

export function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

function hashCode(purpose: EmailCodePurpose, emailHash: string, code: string): string {
    return hmac('code', `${purpose}:${emailHash}:${code}`);
}

function isReviewAddress(email: string): boolean {
    return (
        !!config.reviewLogin.email &&
        REVIEW_CODE_RE.test(config.reviewLogin.code) &&
        email === config.reviewLogin.email
    );
}

/**
 * Milliseconds until another code may go to this address (0 = now), given the
 * send times (ms, ascending) of its codes from the last day.
 */
function waitForAddressLimits(sentAt: number[], now: number): number {
    let wait = 0;
    for (const { windowMs, max } of PER_EMAIL_LIMITS) {
        const inWindow = sentAt.filter((t) => t > now - windowMs);
        if (inWindow.length >= max) {
            // A slot frees up when the oldest send that still counts ages out.
            wait = Math.max(wait, inWindow[inWindow.length - max] + windowMs - now);
        }
    }
    return wait;
}

// ─── Email content ────────────────────────────────────────────────────────────

// Only the code goes into the email, never anything the requester typed, so
// the sign-in form can't be used to send other text from the BIES address.
const COPY: Record<EmailLang, { subject: string; intro: string; body: string }> = {
    en: {
        subject: 'Your BIES sign-in code',
        intro: 'Your code to sign in to BIES:',
        body: "It expires in 10 minutes. BIES will never ask you for this code. If you didn't request it, ignore this email: nobody can sign in without it.",
    },
    es: {
        subject: 'Su código para iniciar sesión en BIES',
        intro: 'Su código para iniciar sesión en BIES:',
        body: 'Vence en 10 minutos. BIES nunca le pedirá este código. Si usted no lo solicitó, ignore este correo: nadie puede entrar sin el código.',
    },
};

export function renderCodeEmail(to: string, code: string, lang: EmailLang = 'en'): OutgoingEmail {
    const t = COPY[lang] ?? COPY.en;
    return {
        to,
        subject: `${t.subject}: ${code}`,
        text: `${t.intro}\n\n${code}\n\n${t.body}\n\nBuild in El Salvador\nhttps://buildinelsalvador.com\n`,
        html: `<!doctype html>
<html lang="${lang}"><body style="margin:0;padding:24px;background:#ffffff;color:#1a1a1a;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<p style="margin:0 0 16px;font-size:16px;">${t.intro}</p>
<p style="margin:0 0 16px;font-size:32px;font-weight:700;letter-spacing:6px;font-family:Menlo,Consolas,monospace;">${code}</p>
<p style="margin:0 0 24px;font-size:14px;line-height:1.5;color:#444444;">${t.body}</p>
<p style="margin:0;font-size:13px;color:#777777;">Build in El Salvador · <a href="https://buildinelsalvador.com" style="color:#121E5A;">buildinelsalvador.com</a></p>
</body></html>`,
    };
}

// ─── Issue ────────────────────────────────────────────────────────────────────

export type IssueResult =
    | { ok: true }
    | { ok: false; reason: 'rate_limited' | 'busy'; retryAfterSeconds: number }
    | { ok: false; reason: 'send_failed' };

// Checking the limits and reserving a row happen as one step: otherwise
// parallel requests all pass the limits before any of them has inserted its
// row. The server runs as a single process (SQLite), so an in-process queue
// is enough.
let reserveQueue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
    const run = reserveQueue.then(task, task);
    reserveQueue = run.catch(() => undefined);
    return run;
}

// A reserved code expires at the epoch, so it can't be verified until its
// email has gone out: nobody can guess at it while the send is in flight,
// and a failed send leaves nothing usable behind.
const NOT_YET_SENT = new Date(0);

type Reservation =
    | { ok: true; id: string; createdAt: Date }
    | { ok: false; reason: 'rate_limited' | 'busy'; retryAfterSeconds: number };

async function reserveCode(
    emailHash: string,
    purpose: EmailCodePurpose,
    codeHash: string,
    ipHash: string | null,
    review: boolean,
): Promise<Reservation> {
    const now = Date.now();
    await prisma.emailCode.deleteMany({ where: { createdAt: { lt: new Date(now - RETENTION_MS) } } });

    // Per-address limits count every purpose: they protect the inbox.
    const recent = await prisma.emailCode.findMany({
        where: { emailHash, createdAt: { gte: new Date(now - DAY) } },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
    });
    const wait = waitForAddressLimits(recent.map((r) => r.createdAt.getTime()), now);
    if (wait > 0) {
        return { ok: false, reason: 'rate_limited', retryAfterSeconds: Math.ceil(wait / 1000) };
    }

    if (ipHash) {
        const fromIp = await prisma.emailCode.count({
            where: { ipHash, createdAt: { gte: new Date(now - HOUR) } },
        });
        if (fromIp >= MAX_PER_IP_PER_HOUR) {
            return { ok: false, reason: 'rate_limited', retryAfterSeconds: 15 * 60 };
        }
    }

    // The review address sends no email, so it doesn't count against the
    // daily total; App Review must still get in on a busy day.
    if (!review) {
        const sentToday = await prisma.emailCode.count({
            where: { createdAt: { gte: new Date(now - DAY) } },
        });
        if (sentToday >= config.email.maxCodesPerDay) {
            console.error(`[EmailCode] Daily ceiling of ${config.email.maxCodesPerDay} codes reached; email sign-in is refusing new codes`);
            return { ok: false, reason: 'busy', retryAfterSeconds: 60 * 60 };
        }
    }

    const row = await prisma.emailCode.create({
        data: { emailHash, purpose, codeHash, expiresAt: NOT_YET_SENT, ipHash },
        select: { id: true, createdAt: true },
    });
    return { ok: true, id: row.id, createdAt: row.createdAt };
}

/**
 * Create a code for this address and email it. The response to the caller
 * must not depend on whether an account exists, so nothing here looks at
 * users.
 */
export async function issueEmailCode(
    email: string,
    purpose: EmailCodePurpose,
    opts: { ip?: string | null; lang?: EmailLang } = {},
): Promise<IssueResult> {
    const address = normalizeEmail(email);
    const emailHash = hmac('email', address);
    const ipHash = opts.ip ? hmac('ip', opts.ip) : null;
    const review = isReviewAddress(address);
    const code = review ? config.reviewLogin.code : crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');

    const reserved = await oneAtATime(() =>
        reserveCode(emailHash, purpose, hashCode(purpose, emailHash, code), ipHash, review));
    if (!reserved.ok) return reserved;

    if (review) {
        console.log('[EmailCode] App Review address: fixed code issued, no email sent');
    } else {
        try {
            await sendEmail(renderCodeEmail(address, code, opts.lang));
        } catch (err) {
            console.error('[EmailCode] Send failed:', err instanceof Error ? err.message : err);
            // A failed send doesn't count against the limits, and the code
            // the person may already have keeps working.
            await prisma.emailCode.delete({ where: { id: reserved.id } }).catch(() => {});
            return { ok: false, reason: 'send_failed' };
        }
    }

    // Sent: the code works from now. Earlier codes for this address and
    // purpose stop working; any reserved after this one are left alone.
    await prisma.emailCode.update({
        where: { id: reserved.id },
        data: { expiresAt: new Date(Date.now() + CODE_TTL_SECONDS * 1000) },
    });
    await prisma.emailCode.updateMany({
        where: { emailHash, purpose, consumedAt: null, createdAt: { lt: reserved.createdAt } },
        data: { consumedAt: new Date() },
    });
    return { ok: true };
}

// ─── Verify ───────────────────────────────────────────────────────────────────

export type VerifyResult =
    | { ok: true; email: string }
    | { ok: false; reason: 'invalid'; attemptsLeft: number }
    | { ok: false; reason: 'expired' };

/**
 * Check a code. On success the code is used up and the normalized address is
 * returned. "expired" covers a missing, expired, used or exhausted code.
 */
export async function verifyEmailCode(
    email: string,
    purpose: EmailCodePurpose,
    code: string,
): Promise<VerifyResult> {
    const address = normalizeEmail(email);
    const emailHash = hmac('email', address);

    const row = await prisma.emailCode.findFirst({
        where: { emailHash, purpose, consumedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
    });
    if (!row) return { ok: false, reason: 'expired' };

    // Spend one try before comparing, atomically, so parallel guesses can't
    // get more than MAX_ATTEMPTS comparisons out of one code.
    const claimed = await prisma.emailCode.updateMany({
        where: { id: row.id, consumedAt: null, attempts: { lt: MAX_ATTEMPTS } },
        data: { attempts: { increment: 1 } },
    });
    if (claimed.count === 0) return { ok: false, reason: 'expired' };

    const expected = Buffer.from(row.codeHash, 'hex');
    const actual = Buffer.from(hashCode(purpose, emailHash, code), 'hex');
    const matches = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);

    if (!matches) {
        const attemptsLeft = Math.max(0, MAX_ATTEMPTS - (row.attempts + 1));
        if (attemptsLeft === 0) {
            await prisma.emailCode.updateMany({
                where: { id: row.id, consumedAt: null },
                data: { consumedAt: new Date() },
            });
        }
        return { ok: false, reason: 'invalid', attemptsLeft };
    }

    // Use it up. If two correct submissions race, only one gets through.
    const used = await prisma.emailCode.updateMany({
        where: { id: row.id, consumedAt: null },
        data: { consumedAt: new Date() },
    });
    if (used.count === 0) return { ok: false, reason: 'expired' };

    return { ok: true, email: address };
}
