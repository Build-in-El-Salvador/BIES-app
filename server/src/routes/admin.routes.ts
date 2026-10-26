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
import { officialSchema, setListingOfficial } from '../controllers/listingTeam.controller';
import {
    adminDeleteEndorsement,
    adminListReports,
    adminRemoveReportedNote,
    adminResolveReport,
    resolveReportSchema,
} from '../controllers/moderation.controller';

const router = Router();

// All admin routes require isAdmin flag or MOD role. Moderators do
// moderation only: Reports and the Directory. Everything else, and anything
// with members' emails, IP addresses, points or roles, is for admins
// (Mike, 2026-10-13).
router.use(authenticate, requireRole('MOD'));
const adminOnly = requireRole('ADMIN'); // admins pass any role gate; there is no ADMIN role

// Users
router.get('/users', adminOnly, listUsers);
router.get('/users/trash', adminOnly, listTrashedUsers);
router.put('/users/:id/ban', adminOnly, banUser);
router.put('/users/:id/role', adminOnly, setUserRole);
router.put('/users/:id/admin', adminOnly, setUserAdmin);
router.put('/users/:id/verify', adminOnly, verifyUser);
router.put('/users/:id/restore', adminOnly, restoreUser);
router.delete('/users/:id', adminOnly, deleteUser);
router.delete('/users/:id/purge', adminOnly, purgeUser);
router.post('/users/sync', adminOnly, syncAccounts);

// Projects
router.get('/investor-requests', adminOnly, listInvestorRequests);
router.put('/investor-requests/:id/review', adminOnly, reviewInvestorRequest);

router.get('/projects', adminOnly, listAdminProjects);
router.put('/projects/:id/feature', adminOnly, featureProject);
router.put('/projects/:id/review', adminOnly, reviewProject);
router.put('/projects/:id/owner', adminOnly, moveProjectOwnership);
router.delete('/projects/:id', adminOnly, hardDeleteProject);

// Events
router.get('/events', adminOnly, listAdminEvents);
router.put('/events/:id/feature', adminOnly, featureEvent);

// Points & badges (gamification)
router.post('/points/adjust', adminOnly, validate(adjustPointsSchema), adjustPoints);
router.get('/points/events', adminOnly, listPointEvents);
router.post('/points/recompute', adminOnly, recomputePoints);
router.post('/points/badges/grant', adminOnly, validate(grantBadgeSchema), grantBadge);
router.delete('/points/badges/:userId/:badgeId', adminOnly, revokeBadge);
// Directory (moderators too)
router.get('/directory', listAdminDirectory);
router.put('/directory/:id/review', validate(reviewDirectoryListingSchema), reviewDirectoryListing);
router.put('/directory/:id/feature', validate(featureDirectoryListingSchema), featureDirectoryListing);
router.post('/directory/recompute', recomputeDirectoryScores);
router.delete('/directory/:id', deleteDirectoryListing);
router.get('/directory/transfers', listOpenTransfers);
router.post('/directory/:id/owner', validate(staffMoveSchema), staffMoveListing);
// BIES's own page: its events are BIES events (admins only)
router.put('/directory/:id/official', adminOnly, validate(officialSchema), setListingOfficial);

// Reports (terms of use §6: reviewed within 24 hours)
router.get('/reports', adminListReports);
router.put('/reports/:id', validate(resolveReportSchema), adminResolveReport);
router.delete('/reports/:id/note', adminRemoveReportedNote);
router.delete('/endorsements/:id', adminDeleteEndorsement);

// Courses
router.get('/courses', adminOnly, listAdminCourses);
router.put('/courses/:id/review', adminOnly, validate(reviewCourseSchema), reviewCourse);
router.put('/courses/:id/feature', adminOnly, validate(featureCourseSchema), featureCourse);
router.delete('/courses/:id', adminOnly, deleteAdminCourse);

// Audit & System
router.get('/audit-logs', adminOnly, getAuditLogs);
router.post('/broadcast', adminOnly, broadcastMessage);
router.post('/cache/clear', adminOnly, clearCache);

// Runtime feature toggles — TRUE admins only (`isAdmin`); MODs pass the
// router-level MOD gate above but are rejected by this ADMIN gate. Never
// feature-gated itself, so a disabled feature can always be re-enabled.
router.put('/flags', requireRole('ADMIN'), validate(updateFlagsSchema), updateFeatureFlags);

// Feedback
router.use('/feedback', adminOnly, adminFeedbackRouter);

// Bounties
router.use('/bounties', adminOnly, adminBountyRouter);

export default router;
