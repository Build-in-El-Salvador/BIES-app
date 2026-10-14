import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { signForApp, signRequestSchema, getSignatureLog } from '../controllers/signer.controller';

const router = Router();

// Per account, not per IP: signing needs a session, and members at one event
// share an IP. Relay sign-ins alone take one signature per connection. Each
// signature decrypts the key (PBKDF2), so this also bounds the server's work.
const signLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    keyGenerator: (req) => req.user!.id,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many signing requests, please slow down' },
});

router.post('/sign', authenticate, signLimiter, validate(signRequestSchema), signForApp);
router.get('/log', authenticate, getSignatureLog);

export default router;
