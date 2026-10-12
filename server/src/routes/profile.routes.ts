import { Router } from 'express';
import { authenticate, optionalAuth } from '../middleware/auth';
import { requireTerms, screenContent } from '../middleware/contentRules';
import { validate } from '../middleware/validate';
import {
    listProfiles,
    getProfile,
    getMyProfile,
    updateMyProfile,
    updateProfileSchema,
    checkNip05,
} from '../controllers/profile.controller';
import {
    followUser,
    unfollowUser,
    getFollowers,
    getFollowing,
} from '../controllers/follow.controller';

const router = Router();

const PROFILE_TEXT = [
    'name', 'bio', 'location', 'skills', 'company', 'title', 'tags', 'experience',
    'customSections', 'lookingFor', 'nip05Name', 'twitter', 'linkedin', 'github',
];

// NIP-05 availability check (before /:id to avoid being swallowed)
router.get('/check-nip05', optionalAuth, checkNip05);

// /me routes MUST come before /:id to avoid being swallowed as an id param
router.get('/me', authenticate, getMyProfile);
// Filtered, but not behind requireTerms: a Nostr sign-up copies the member's
// Nostr profile in before the app shows the terms.
router.put('/me', authenticate, validate(updateProfileSchema), screenContent(PROFILE_TEXT), updateMyProfile);

// Follow routes (before generic /:id)
router.post('/:id/follow', authenticate, requireTerms, followUser);
router.delete('/:id/follow', authenticate, unfollowUser);
router.get('/:id/followers', getFollowers);
router.get('/:id/following', getFollowing);

// Public routes
router.get('/', optionalAuth, listProfiles);
router.get('/:id', optionalAuth, getProfile);

export default router;
