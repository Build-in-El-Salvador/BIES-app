/**
 * Wallet routes — Coinos custodial wallet management.
 */

import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { moneyLimiter } from '../middleware/rateLimit';
import * as coinosService from '../services/coinos.service';

const router = Router();

// All wallet routes require authentication
router.use(authenticate);

/**
 * Map errors from token-authenticated Coinos calls to a client-safe payload.
 * An upstream Coinos 401 means the stored JWT expired — surface a stable code
 * the client can act on ("reconnect your wallet"). Kept at HTTP 400: a 401
 * from our API would nuke the whole app session in the client's api.js.
 */
function sendWalletError(res: Response, err: any, fallback: string) {
    if (err?.status === 401) {
        res.status(400).json({ error: 'wallet_token_expired' });
        return;
    }
    res.status(400).json({ error: err?.message || fallback });
}

/**
 * POST /api/wallet/coinos/create
 * Auto-provision a new Coinos wallet for the authenticated user.
 * Body: { username: string }
 */
router.post('/coinos/create', moneyLimiter, async (req: Request, res: Response) => {
    try {
        const username = req.body.username?.trim();
        if (!username || username.length < 2 || username.length > 24 || !/^[a-zA-Z0-9]+$/.test(username)) {
            res.status(400).json({ error: 'Username must be 2-24 alphanumeric characters' });
            return;
        }

        const result = await coinosService.createWallet(req.user!.id, username);
        res.json(result);
    } catch (err: any) {
        const msg = err.message || 'Failed to create Coinos wallet';
        const status = msg.includes('409') || msg.includes('already') ? 409 : 500;
        res.status(status).json({ error: msg });
    }
});

/**
 * POST /api/wallet/coinos/connect
 * Connect an existing Coinos account.
 * Body: { username: string, password: string }
 */
router.post('/coinos/connect', moneyLimiter, async (req: Request, res: Response) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            res.status(400).json({ error: 'Username and password are required' });
            return;
        }

        const result = await coinosService.connectWallet(req.user!.id, username, password);
        res.json(result);
    } catch (err: any) {
        // Never emit 401 from wallet routes — the client's api.js treats any
        // 401 outside /auth/ as an expired BIES session and logs the user out.
        res.status(err?.status === 502 ? 502 : 400).json({ error: err?.message || 'Failed to connect Coinos wallet' });
    }
});

/**
 * POST /api/wallet/coinos/disconnect
 * Disconnect the Coinos wallet.
 */
router.post('/coinos/disconnect', async (req: Request, res: Response) => {
    try {
        await coinosService.disconnectWallet(req.user!.id);
        res.json({ ok: true });
    } catch (err: any) {
        res.status(500).json({ error: err.message || 'Failed to disconnect' });
    }
});

/**
 * GET /api/wallet/coinos/balance
 * Get the current wallet balance in sats.
 */
router.get('/coinos/balance', async (req: Request, res: Response) => {
    try {
        const sats = await coinosService.getBalance(req.user!.id);
        res.json({ sats });
    } catch (err: any) {
        sendWalletError(res, err, 'Failed to fetch balance');
    }
});

/**
 * POST /api/wallet/coinos/pay
 * Pay a BOLT-11 invoice from the Coinos wallet.
 * Body: { bolt11: string }
 */
router.post('/coinos/pay', moneyLimiter, async (req: Request, res: Response) => {
    try {
        const { bolt11 } = req.body;
        if (!bolt11) {
            res.status(400).json({ error: 'bolt11 invoice is required' });
            return;
        }

        const result = await coinosService.payInvoice(req.user!.id, bolt11);
        res.json(result);
    } catch (err: any) {
        sendWalletError(res, err, 'Payment failed');
    }
});

/**
 * POST /api/wallet/coinos/invoice
 * Create a Lightning invoice on the user's Coinos wallet.
 * Body: { amountSats: number, memo?: string }
 * Returns: { pr: string, hash: string }
 */
router.post('/coinos/invoice', moneyLimiter, async (req: Request, res: Response) => {
    try {
        const amountSats = req.body.amountSats;
        if (!Number.isInteger(amountSats) || amountSats < 1 || amountSats > 100_000_000) {
            res.status(400).json({ error: 'amountSats must be an integer between 1 and 100,000,000' });
            return;
        }

        const memo = typeof req.body.memo === 'string' ? req.body.memo.trim().slice(0, 200) : undefined;

        const result = await coinosService.createInvoice(req.user!.id, amountSats, memo || undefined);
        res.json(result);
    } catch (err: any) {
        sendWalletError(res, err, 'Failed to create invoice');
    }
});

/**
 * GET /api/wallet/coinos/transactions?limit=20
 * List recent wallet transactions, newest first.
 * Returns: { transactions: [{ type, amountSats, createdAt, memo, hash }] }
 */
router.get('/coinos/transactions', async (req: Request, res: Response) => {
    try {
        const parsed = parseInt(String(req.query.limit ?? ''), 10);
        const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 50) : 20;

        const transactions = await coinosService.listPayments(req.user!.id, limit);
        res.json({ transactions });
    } catch (err: any) {
        sendWalletError(res, err, 'Failed to fetch transactions');
    }
});

export default router;
