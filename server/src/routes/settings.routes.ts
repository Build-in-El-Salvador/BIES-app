import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
    getSettings,
    updateNotificationSettings,
    updateNotificationSettingsSchema,
    updateRelays,
    updateRelaysSchema,
    getMediaRead,
    updateMediaRead,
    updateMediaReadSchema,
    toggleMediaRead,
    toggleMediaReadSchema,
    bulkMediaRead,
    bulkMediaReadSchema,
    getPreferences,
    updatePreferences,
    updatePreferencesSchema,
    getPrivacy,
    updatePrivacy,
    updatePrivacySchema,
} from '../controllers/settings.controller';
import {
    getPublicNostr,
    updatePublicNostr,
    updatePublicNostrSchema,
    publishPublicNostr,
    publishPublicNostrSchema,
} from '../controllers/publicNostr.controller';

const router = Router();

router.use(authenticate);

router.get('/', getSettings);
router.put('/notifications', validate(updateNotificationSettingsSchema), updateNotificationSettings);
router.get('/privacy', getPrivacy);
router.put('/privacy', validate(updatePrivacySchema), updatePrivacy);
// Settings → Nostr: each publish reaches several public relays, so a few a minute.
const publishLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    keyGenerator: (req) => req.user!.id,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many publishes, please wait a minute' },
});
// Opening the page reads several public relays: a few dozen times a minute is plenty.
const readLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    keyGenerator: (req) => req.user!.id,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please wait a minute' },
});
router.get('/nostr', readLimiter, getPublicNostr);
router.put('/nostr', validate(updatePublicNostrSchema), updatePublicNostr);
router.post('/nostr/publish', publishLimiter, validate(publishPublicNostrSchema), publishPublicNostr);
router.put('/relays', validate(updateRelaysSchema), updateRelays);
router.get('/media-read', getMediaRead);
router.put('/media-read', validate(updateMediaReadSchema), updateMediaRead);
router.post('/media-read/toggle', validate(toggleMediaReadSchema), toggleMediaRead);
router.post('/media-read/bulk', validate(bulkMediaReadSchema), bulkMediaRead);
router.get('/preferences', getPreferences);
router.put('/preferences', validate(updatePreferencesSchema), updatePreferences);

export default router;
