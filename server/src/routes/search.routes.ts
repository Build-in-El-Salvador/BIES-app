import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { search, getSuggestions } from '../controllers/search.controller';

const router = Router();

// Members only: results carry members' names, events' addresses and the
// like. The app searches only when signed in.
router.get('/', authenticate, search);
router.get('/suggestions', authenticate, getSuggestions);

export default router;
