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
    lookupProfiles,
    lookupProfilesSchema,
} from '../controllers/profile.controller';
import {
    followUser,
    unfollowUser,
    getFollowers,
    getFollowing,
    getMyFollowingIds,
} from '../controllers/follow.controller';

const router = Router();

const PROFILE_TEXT = [
    'name', 'bio', 'location', 'skills', 'company', 'title', 'tags', 'experience',
    'customSections', 'lookingFor', 'nip05Name', 'twitter', 'linkedin', 'github',
    'website', 'lightningAddress', 'investmentFocus', 'investmentStage', 'biesProjects',
];

// NIP-05 availability check (before /:id to avoid being swallowed)
router.get('/check-nip05', optionalAuth, checkNip05);

// Members' names and photos by Nostr key, for the Feed (members only).
router.post('/lookup', authenticate, validate(lookupProfilesSchema), lookupProfiles);

// /me routes MUST come before /:id to avoid being swallowed as an id param
router.get('/me', authenticate, getMyProfile);
// A profile is public: the terms come first. (The app copies a new Nostr
// member's Nostr profile in only once they accept them.)
router.put('/me', authenticate, requireTerms, validate(updateProfileSchema), screenContent(PROFILE_TEXT), updateMyProfile);
// Everyone I follow, as ids (the Follow buttons on member lists).
router.get('/me/following-ids', authenticate, getMyFollowingIds);

// Follow routes (before generic /:id)
router.post('/:id/follow', authenticate, requireTerms, followUser);
router.delete('/:id/follow', authenticate, unfollowUser);
router.get('/:id/followers', authenticate, getFollowers);
router.get('/:id/following', authenticate, getFollowing);

// Public routes
router.get('/', optionalAuth, listProfiles);
router.get('/:id', optionalAuth, getProfile);

export default router;
