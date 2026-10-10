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
    logout,
} from '../controllers/auth.controller';

const router = Router();

// Public routes
router.post('/email/start', authLimiter, validate(emailStartSchema), startEmailLogin);
router.post('/email/verify', authLimiter, validate(emailVerifySchema), verifyEmailLogin);
router.get('/nostr-challenge', authLimiter, getNostrChallenge);
router.post('/nostr-login', authLimiter, nostrLogin);

// Protected routes
router.get('/me', authenticate, getMe);
router.post('/logout', authenticate, logout);

export default router;
