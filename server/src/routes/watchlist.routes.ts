import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
    getWatchlist,
    addToWatchlist,
    addToWatchlistSchema,
    removeFromWatchlist,
    updateWatchlistNote,
    watchlistNoteSchema,
    checkWatchlist,
} from '../controllers/watchlist.controller';

const router = Router();

router.use(authenticate);

router.get('/', getWatchlist);
router.post('/', validate(addToWatchlistSchema), addToWatchlist);
router.get('/check/:projectId', checkWatchlist);
router.delete('/:projectId', removeFromWatchlist);
router.put('/:projectId/note', validate(watchlistNoteSchema), updateWatchlistNote);

export default router;
