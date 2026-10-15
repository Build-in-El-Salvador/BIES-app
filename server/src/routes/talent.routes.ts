import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { requireTerms, screenContent } from '../middleware/contentRules';
import { validate } from '../middleware/validate';
import {
    listTalent,
    getTalent,
    createTalent,
    createTalentSchema,
    updateTalent,
    updateTalentSchema,
    deleteTalent,
} from '../controllers/talent.controller';

const router = Router();

const TALENT_TEXT = ['title', 'about', 'skills', 'location', 'rate', 'languages', 'works'];

// Members only: a person's WhatsApp and email are on it.
router.get('/', authenticate, listTalent);
router.get('/:id', authenticate, getTalent);

router.post('/', authenticate, requireTerms, validate(createTalentSchema), screenContent(TALENT_TEXT), createTalent);
router.put('/:id', authenticate, requireTerms, validate(updateTalentSchema), screenContent(TALENT_TEXT), updateTalent);
router.delete('/:id', authenticate, deleteTalent);

export default router;
