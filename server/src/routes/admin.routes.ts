import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { adminFeedbackRouter } from './feedback.routes';
import { adminBountyRouter } from './bounty.routes';
import {
    listUsers,
    banUser,
    setUserRole,
    verifyUser,
    deleteUser,
    listTrashedUsers,
    restoreUser,
    purgeUser,
    syncAccounts,
    featureProject,
    hardDeleteProject,
    moveProjectOwnership,
    listAdminProjects,
    reviewProject,
    listAdminEvents,
    featureEvent,
    getAuditLogs,
    broadcastMessage,
    clearCache,
    listInvestorRequests,
    reviewInvestorRequest,
    setUserAdmin,
    adjustPoints,
    adjustPointsSchema,
    listPointEvents,
    recomputePoints,
    grantBadge,
    grantBadgeSchema,
    revokeBadge,
    listAdminDirectory,
    reviewDirectoryListing,
    reviewDirectoryListingSchema,
    featureDirectoryListing,
    featureDirectoryListingSchema,
    recomputeDirectoryScores,
    deleteDirectoryListing,
    listAdminCourses,
    reviewCourse,
    reviewCourseSchema,
    featureCourse,
    featureCourseSchema,
    deleteAdminCourse,
} from '../controllers/admin.controller';
import { updateFeatureFlags, updateFlagsSchema } from '../controllers/featureFlags.controller';
import { listOpenTransfers, staffMoveListing, staffMoveSchema } from '../controllers/listingTransfer.controller';
import {
    adminDeleteEndorsement,
    adminListReports,
    adminRemoveReportedNote,
    adminResolveReport,
    resolveReportSchema,
} from '../controllers/moderation.controller';

const router = Router();

// All admin routes require isAdmin flag or MOD role
router.use(authenticate, requireRole('MOD'));

// Users
router.get('/users', listUsers);
router.get('/users/trash', listTrashedUsers);           // ADMIN only (enforced in controller)
router.put('/users/:id/ban', banUser);
router.put('/users/:id/role', setUserRole);
router.put('/users/:id/admin', setUserAdmin);
router.put('/users/:id/verify', verifyUser);
router.put('/users/:id/restore', restoreUser);          // ADMIN only (enforced in controller)
router.delete('/users/:id', deleteUser);                // ADMIN only (enforced in controller)
router.delete('/users/:id/purge', purgeUser);           // ADMIN only (enforced in controller)
router.post('/users/sync', syncAccounts);               // ADMIN only (enforced in controller)

// Projects
router.get('/investor-requests', listInvestorRequests);
router.put('/investor-requests/:id/review', reviewInvestorRequest);

router.get('/projects', listAdminProjects);
router.put('/projects/:id/feature', featureProject);
router.put('/projects/:id/review', reviewProject);
router.put('/projects/:id/owner', moveProjectOwnership);   // ADMIN only (enforced in controller)
router.delete('/projects/:id', hardDeleteProject);

// Events
router.get('/events', listAdminEvents);
router.put('/events/:id/feature', featureEvent);

// Points & badges (gamification)
router.post('/points/adjust', validate(adjustPointsSchema), adjustPoints);
router.get('/points/events', listPointEvents);
router.post('/points/recompute', recomputePoints);
router.post('/points/badges/grant', validate(grantBadgeSchema), grantBadge);
router.delete('/points/badges/:userId/:badgeId', revokeBadge);
// Directory
router.get('/directory', listAdminDirectory);
router.put('/directory/:id/review', validate(reviewDirectoryListingSchema), reviewDirectoryListing);
router.put('/directory/:id/feature', validate(featureDirectoryListingSchema), featureDirectoryListing);
router.post('/directory/recompute', recomputeDirectoryScores);
router.delete('/directory/:id', deleteDirectoryListing);
router.get('/directory/transfers', listOpenTransfers);
router.post('/directory/:id/owner', validate(staffMoveSchema), staffMoveListing);

// Reports (terms of use §6: reviewed within 24 hours)
router.get('/reports', adminListReports);
router.put('/reports/:id', validate(resolveReportSchema), adminResolveReport);
router.delete('/reports/:id/note', adminRemoveReportedNote);
router.delete('/endorsements/:id', adminDeleteEndorsement);

// Courses
router.get('/courses', listAdminCourses);
router.put('/courses/:id/review', validate(reviewCourseSchema), reviewCourse);
router.put('/courses/:id/feature', validate(featureCourseSchema), featureCourse);
router.delete('/courses/:id', deleteAdminCourse);

// Audit & System
router.get('/audit-logs', getAuditLogs);
router.post('/broadcast', broadcastMessage);
router.post('/cache/clear', clearCache);

// Runtime feature toggles — TRUE admins only (`isAdmin`); MODs pass the
// router-level MOD gate above but are rejected by this ADMIN gate. Never
// feature-gated itself, so a disabled feature can always be re-enabled.
router.put('/flags', requireRole('ADMIN'), validate(updateFlagsSchema), updateFeatureFlags);

// Feedback
router.use('/feedback', adminFeedbackRouter);

// Bounties
router.use('/bounties', adminBountyRouter);

export default router;
