import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { uploadMiddleware, uploadMedia, uploadDeck, discardMedia, discardMediaSchema, downloadPrivateFile } from '../controllers/upload.controller';

const router = Router();

// All upload routes require authentication
router.post('/media', authenticate, uploadMiddleware, uploadMedia);
router.post('/deck', authenticate, uploadMiddleware, uploadDeck);
router.post('/discard', authenticate, validate(discardMediaSchema), discardMedia);
// The signed link is the permission (storage.service.ts getPresignedUrl).
router.get('/private/:name', downloadPrivateFile);

export default router;
