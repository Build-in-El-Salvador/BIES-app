import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { uploadMiddleware, uploadMedia, uploadDeck, discardMedia, discardMediaSchema } from '../controllers/upload.controller';

const router = Router();

// All upload routes require authentication
router.post('/media', authenticate, uploadMiddleware, uploadMedia);
router.post('/deck', authenticate, uploadMiddleware, uploadDeck);
router.post('/discard', authenticate, validate(discardMediaSchema), discardMedia);

export default router;
