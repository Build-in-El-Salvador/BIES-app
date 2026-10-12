import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { block, blockSchema, getBlocks, report, reportSchema, unblock } from '../controllers/moderation.controller';

/**
 * Report and Block (terms of use §6). Neither needs the terms accepted: a
 * member must always be able to report or block. Mounted at /api. Reports
 * are capped per member per day (services/moderation.service.ts).
 */
const router = Router();

router.post('/reports', authenticate, validate(reportSchema), report);

router.get('/blocks', authenticate, getBlocks);
router.post('/blocks', authenticate, validate(blockSchema), block);
router.delete('/blocks/:userId', authenticate, unblock);

export default router;
