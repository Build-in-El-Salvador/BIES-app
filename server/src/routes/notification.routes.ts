import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../middleware/auth';
import { rateLimitKey } from '../utils/rateLimitKey';
import { validate } from '../middleware/validate';
import {
    listNotifications,
    getUnreadCount,
    markRead,
    markAllRead,
    deleteNotification,
    feedInteraction,
    getVapidPublicKey,
    subscribePush,
    unsubscribePush,
    registerDeviceToken,
    unregisterDeviceToken,
    registerDeviceTokenSchema,
} from '../controllers/notification.controller';

const router = Router();

router.use(authenticate);

// Push subscription routes (must be before /:id param routes)
router.get('/push/vapid-key', getVapidPublicKey);
router.post('/push/subscribe', subscribePush);
router.delete('/push/subscribe', unsubscribePush);

// Native push (APNs) device token routes
router.post('/device-token', validate(registerDeviceTokenSchema), registerDeviceToken);
router.delete('/device-token', unregisterDeviceToken);

router.get('/', listNotifications);
router.get('/count', getUnreadCount);
// A like, repost or reply notifies the post's author (and their phone):
// 60 an hour per member is plenty for real use.
const feedInteractionLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: rateLimitKey,
    message: { error: 'Too many notifications, please try again later' },
});
router.post('/feed-interaction', feedInteractionLimiter, feedInteraction);
router.put('/read-all', markAllRead);
router.put('/:id/read', markRead);
router.delete('/:id', deleteNotification);

export default router;
