/**
 * Coinos Service — server-side wrapper for the Coinos custodial wallet API.
 *
 * Handles account creation, balance checks, invoice generation, and payments.
 * Tokens are stored encrypted in the Profile table.
 */

import crypto from 'crypto';
import { config } from '../config';
import prisma from '../lib/prisma';

const API = config.coinosApiUrl;
const ALGO = 'aes-256-gcm';
const TIMEOUT_MS = 15_000;

// ─── Token encryption helpers ────────────────────────────────────────────────

function deriveKey(): Buffer {
    return crypto.scryptSync(config.encryptionSecret, 'coinos-token-salt', 32);
}

export function encryptToken(token: string): string {
    const key = deriveKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv.toString('hex'), tag.toString('hex'), encrypted.toString('hex')].join(':');
}

export function decryptToken(blob: string): string {
    const [ivHex, tagHex, dataHex] = blob.split(':');
    const key = deriveKey();
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(Buffer.from(dataHex, 'hex')) + decipher.final('utf8');
}

// ─── Coinos API helpers ──────────────────────────────────────────────────────

async function coinosFetch(path: string, opts: RequestInit = {}): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let res: Response;
    try {
        res = await fetch(`${API}${path}`, {
            ...opts,
            headers: {
                'Content-Type': 'application/json',
                ...opts.headers,
            },
            signal: controller.signal,
        });
    } catch (e: any) {
        // Transport failure (timeout / connection reset): the request may or
        // may not have reached Coinos, so callers MUST treat this as
        // outcome-unknown — status 502 is the indeterminate marker (same
        // convention as the other wallet services had), never a definitive rejection.
        const err: any = new Error(e?.name === 'AbortError' ? 'Coinos API timed out' : 'Coinos API unreachable');
        err.status = 502;
        throw err;
    } finally {
        clearTimeout(timer);
    }

    if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err: any = new Error(`Coinos API ${res.status}: ${body}`);
        err.status = res.status; // lets routes map upstream 401 (expired JWT) to a stable client code
        throw err;
    }

    try {
        return await res.json();
    } catch {
        // 2xx received but the body was unreadable (truncated mid-stream) —
        // Coinos DID process the request, so this is also outcome-unknown.
        const err: any = new Error('Coinos API returned an unreadable response');
        err.status = 502;
        throw err;
    }
}

function authHeaders(token: string) {
    return { Authorization: `Bearer ${token}` };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Register a new Coinos account and persist the encrypted token.
 * Returns the Coinos username and Lightning address.
 */
export async function createWallet(userId: string, username: string): Promise<{
    coinosUsername: string;
    lightningAddress: string;
}> {
    const data = await coinosFetch('/users', {
        method: 'POST',
        body: JSON.stringify({ user: { username } }),
    });

    const token = data.token;
    if (!token) throw new Error('Coinos did not return a token');

    const encrypted = encryptToken(token);

    await prisma.profile.update({
        where: { userId },
        data: {
            coinosUsername: username,
            coinosToken: encrypted,
            lightningAddress: `${username}@coinos.io`,
        },
    });

    return {
        coinosUsername: username,
        lightningAddress: `${username}@coinos.io`,
    };
}

/**
 * Connect an existing Coinos account by logging in with username + password.
 */
export async function connectWallet(userId: string, username: string, password: string): Promise<{
    coinosUsername: string;
    lightningAddress: string;
}> {
    const data = await coinosFetch('/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
    });

    const token = data.token;
    if (!token) throw new Error('Invalid Coinos credentials');

    const encrypted = encryptToken(token);

    await prisma.profile.update({
        where: { userId },
        data: {
            coinosUsername: username,
            coinosToken: encrypted,
            lightningAddress: `${username}@coinos.io`,
        },
    });

    return {
        coinosUsername: username,
        lightningAddress: `${username}@coinos.io`,
    };
}

/**
 * Disconnect the Coinos wallet from the user's profile.
 *
 * Also clears the profile lightningAddress when it is the one this wallet
 * set (`<coinosUsername>@coinos.io`) — leaving it would keep advertising a
 * receive address for an orphaned custodial account whose token is being
 * destroyed. User-typed addresses are left alone.
 */
export async function disconnectWallet(userId: string): Promise<void> {
    const profile = await prisma.profile.findUnique({
        where: { userId },
        select: { coinosUsername: true, lightningAddress: true },
    });

    const clearAddress = !!profile?.coinosUsername
        && profile.lightningAddress === `${profile.coinosUsername}@coinos.io`;

    await prisma.profile.update({
        where: { userId },
        data: {
            coinosUsername: null,
            coinosToken: null,
            // Schema default is '' (non-nullable) — the client treats '' as "no address"
            ...(clearAddress ? { lightningAddress: '' } : {}),
        },
    });
}

/**
 * Get the decrypted Coinos JWT for a user. Returns null if not connected.
 */
async function getToken(userId: string): Promise<string | null> {
    const profile = await prisma.profile.findUnique({
        where: { userId },
        select: { coinosToken: true },
    });
    if (!profile?.coinosToken) return null;
    return decryptToken(profile.coinosToken);
}

/**
 * Get wallet balance in sats.
 */
export async function getBalance(userId: string): Promise<number> {
    const token = await getToken(userId);
    if (!token) throw new Error('No Coinos wallet connected');

    const data = await coinosFetch('/me', {
        headers: authHeaders(token),
    });

    return Math.floor(data.balance ?? 0); // Coinos /me reports `balance` in sats already
}

/**
 * Pay a BOLT-11 Lightning invoice from the user's Coinos wallet.
 * `preimage` is surfaced when the Coinos response carries a plausible one
 * (64-hex) — response shapes vary by version, so read it defensively and
 * never let settlement depend on it (a 2xx here already means paid).
 */
export async function payInvoice(userId: string, bolt11: string): Promise<{ hash: string; preimage?: string }> {
    const token = await getToken(userId);
    if (!token) throw new Error('No Coinos wallet connected');

    const data = await coinosFetch('/payments', {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ payreq: bolt11 }),
    });

    const preimage = typeof data?.preimage === 'string' && /^[0-9a-fA-F]{64}$/.test(data.preimage)
        ? data.preimage.toLowerCase()
        : undefined;

    return { hash: data.hash, ...(preimage ? { preimage } : {}) };
}

/**
 * Create a Lightning invoice on the user's Coinos wallet.
 */
export async function createInvoice(userId: string, amountSats: number, memo?: string): Promise<{ pr: string; hash: string }> {
    const token = await getToken(userId);
    if (!token) throw new Error('No Coinos wallet connected');

    const data = await coinosFetch('/invoice', {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({
            invoice: {
                amount: amountSats,
                type: 'lightning',
                ...(memo ? { memo } : {}),
            },
        }),
    });

    // Coinos response shapes vary by version — never let an undefined bolt11
    // through to the client (it would crash the Receive modal's QR render).
    if (typeof data?.text !== 'string' || !data.text) {
        throw new Error('Coinos did not return an invoice');
    }

    return { pr: data.text, hash: data.hash };
}

/**
 * Fetch an invoice by its payment hash (to poll payment status).
 * Returns the raw Coinos invoice JSON. The paid check is
 * `received >= amount || paid === true` (Coinos reports `received` in sats).
 * Coinos serves GET /invoice/:hash without auth for API-created invoices;
 * if the endpoint ever requires auth, pass the creator's token.
 */
export async function getInvoice(hash: string, token?: string): Promise<any> {
    return coinosFetch(`/invoice/${encodeURIComponent(hash)}`, token ? { headers: authHeaders(token) } : {});
}

/**
 * List recent payments (incoming + outgoing) from the user's Coinos wallet.
 * Normalizes the Coinos response to a stable transaction shape, sorted newest-first.
 * Defensive: Coinos returns either a bare array or `{ payments: [...] }` depending
 * on version; amounts are signed sats (negative = sent); `created` may be ms or seconds.
 */
export async function listPayments(userId: string, limit = 20): Promise<Array<{
    type: 'incoming' | 'outgoing';
    amountSats: number;
    createdAt: string;
    memo: string | null;
    hash: string | null;
}>> {
    const token = await getToken(userId);
    if (!token) throw new Error('No Coinos wallet connected');

    const data = await coinosFetch(`/payments?limit=${encodeURIComponent(String(limit))}`, {
        headers: authHeaders(token),
    });

    const raw = Array.isArray(data) ? data : Array.isArray(data?.payments) ? data.payments : [];

    return raw
        .filter((p: any) => p && typeof p === 'object')
        .map((p: any) => {
            const amount = Number(p.amount) || 0;
            const createdRaw = Number(p.created ?? p.createdAt ?? 0);
            const createdMs = createdRaw > 1e12 ? createdRaw : createdRaw > 0 ? createdRaw * 1000 : Date.now();
            return {
                type: (amount < 0 ? 'outgoing' : 'incoming') as 'incoming' | 'outgoing',
                amountSats: Math.abs(Math.trunc(amount)),
                createdAt: new Date(createdMs).toISOString(),
                memo: typeof p.memo === 'string' && p.memo ? p.memo : null,
                hash: typeof p.hash === 'string' ? p.hash : null,
            };
        })
        .sort((a: { createdAt: string }, b: { createdAt: string }) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, limit);
}

/**
 * Check if a user has a Coinos wallet connected.
 */
export async function hasWallet(userId: string): Promise<boolean> {
    const profile = await prisma.profile.findUnique({
        where: { userId },
        select: { coinosUsername: true },
    });
    return !!profile?.coinosUsername;
}
