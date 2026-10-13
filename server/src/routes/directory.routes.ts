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
    saveListing,
    unsaveListing,
} from '../controllers/directory.controller';
import {
    claimListing,
    claimSchema,
    offerListing,
    offerSchema,
    acceptTransfer,
    declineTransfer,
    cancelTransfer,
} from '../controllers/listingTransfer.controller';

const router = Router();

const LISTING_TEXT = ['name', 'hours', 'about', 'location', 'instagram', 'website', 'languages', 'products', 'skills', 'bestFor', 'pricing', 'comment', 'review'];

// Public routes
router.get('/', optionalAuth, listListings);
router.get('/:id', optionalAuth, getListing);

// Handing a listing to the member who runs it
router.post('/transfers/:transferId/accept', authenticate, acceptTransfer);
router.post('/transfers/:transferId/decline', authenticate, declineTransfer);
router.post('/transfers/:transferId/cancel', authenticate, cancelTransfer);
router.post('/:id/claim', authenticate, requireTerms, validate(claimSchema), screenContent(['message']), claimListing);
router.post('/:id/transfer', authenticate, requireTerms, validate(offerSchema), screenContent(['message']), offerListing);

// Member routes
router.post('/', authenticate, requireTerms, validate(createDirectoryListingSchema), screenContent(LISTING_TEXT), createListing);
router.put('/:id', authenticate, requireTerms, validate(updateDirectoryListingSchema), screenContent(LISTING_TEXT), updateListing);
router.delete('/:id', authenticate, deleteListing);
router.post('/:id/endorse', authenticate, requireTerms, validate(endorseSchema), screenContent(['comment']), endorseListing);
router.delete('/:id/endorse', authenticate, removeEndorsement);
router.post('/:id/save', authenticate, saveListing);
router.delete('/:id/save', authenticate, unsaveListing);

export default router;
