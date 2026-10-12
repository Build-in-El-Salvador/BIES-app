import { Router } from 'express';
import { authenticate, optionalAuth } from '../middleware/auth';
import { requireTerms, screenContent } from '../middleware/contentRules';
import { validate } from '../middleware/validate';
import {
    listListings,
    getListing,
    createListing,
    createDirectoryListingSchema,
    updateListing,
    updateDirectoryListingSchema,
    deleteListing,
    endorseListing,
    endorseSchema,
    removeEndorsement,
} from '../controllers/directory.controller';

const router = Router();

const LISTING_TEXT = ['name', 'about', 'location', 'instagram', 'products', 'skills', 'bestFor', 'pricing', 'comment'];

// Public routes
router.get('/', optionalAuth, listListings);
router.get('/:id', optionalAuth, getListing);

// Member routes
router.post('/', authenticate, requireTerms, validate(createDirectoryListingSchema), screenContent(LISTING_TEXT), createListing);
router.put('/:id', authenticate, requireTerms, validate(updateDirectoryListingSchema), screenContent(LISTING_TEXT), updateListing);
router.delete('/:id', authenticate, deleteListing);
router.post('/:id/endorse', authenticate, requireTerms, validate(endorseSchema), screenContent(['comment']), endorseListing);
router.delete('/:id/endorse', authenticate, removeEndorsement);

export default router;
