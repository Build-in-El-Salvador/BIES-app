import { Router } from 'express';
import { validate } from '../middleware/validate';
import { requireKnownOrigin } from '../services/session.service';
import { checkInviteCode, checkInviteSchema, inviteStatus } from '../controllers/invite.controller';

const router = Router();

// Public: the app asks before anyone has an account. Checking a code doesn't
// use it up; guessing is limited in services/invite.service.ts.
router.get('/status', inviteStatus);
router.post('/check', requireKnownOrigin, validate(checkInviteSchema), checkInviteCode);

export default router;
