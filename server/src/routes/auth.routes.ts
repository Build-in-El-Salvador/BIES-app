import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { authLimiter } from '../middleware/rateLimit';
import {
    startEmailLogin,
    emailStartSchema,
    verifyEmailLogin,
    emailVerifySchema,
    nostrLogin,
    getNostrChallenge,
    getMe,
    refresh,
    logout,
} from '../controllers/auth.controller';

const router = Router();

// Public routes
router.post('/email/start', authLimiter, validate(emailStartSchema), startEmailLogin);
router.post('/email/verify', authLimiter, validate(emailVerifySchema), verifyEmailLogin);
router.get('/nostr-challenge', authLimiter, getNostrChallenge);
router.post('/nostr-login', authLimiter, nostrLogin);

// Session renewal and sign-out. Neither needs a live access token: refresh
// runs because it has just expired, and logout must work regardless. The
// general limiter covers them, keyed per account (utils/rateLimitKey.ts),
// because refreshing is routine and authLimiter would lock out a room on one
// Wi-Fi. A refresh token can't be guessed.
router.post('/refresh', refresh);
router.post('/logout', logout);

// Protected routes
router.get('/me', authenticate, getMe);

export default router;
