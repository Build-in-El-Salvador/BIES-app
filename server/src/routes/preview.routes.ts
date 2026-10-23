import { Router } from 'express';
import { getPreview, getPreviewOG } from '../controllers/preview.controller';

const router = Router();

// No sign-in: a shared link's preview, and its link card for crawlers.
router.get('/:section/:id', getPreview);
router.get('/:section/:id/og', getPreviewOG);

export default router;
