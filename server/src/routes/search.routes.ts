import { Router } from 'express';
import { optionalAuth } from '../middleware/auth';
import { search, getSuggestions } from '../controllers/search.controller';

const router = Router();

router.get('/', optionalAuth, search);
router.get('/suggestions', optionalAuth, getSuggestions);

export default router;
