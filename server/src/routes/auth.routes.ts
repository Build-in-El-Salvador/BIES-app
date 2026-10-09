import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
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
router.post('/email/start', validate(emailStartSchema), startEmailLogin);
router.post('/email/verify', validate(emailVerifySchema), verifyEmailLogin);
router.get('/nostr-challenge', getNostrChallenge);
router.post('/nostr-login', nostrLogin);

// Protected routes
router.get('/me', authenticate, getMe);
router.post('/logout', authenticate, logout);

export default router;
