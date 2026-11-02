import { Router } from 'express';
import { getEventCard, getPreview, getPreviewOG } from '../controllers/preview.controller';

const router = Router();

// No sign-in: a shared link's preview, and its link card for crawlers.
router.get('/:section/:id', getPreview);
router.get('/:section/:id/og', getPreviewOG);
// The picture on a shared event's link card.
router.get('/events/:id/card.jpg', getEventCard);

export default router;
