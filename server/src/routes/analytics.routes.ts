import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import {
    getBuilderDashboard,
    getInvestorDashboard,
    getProjectAnalytics,
    getPlatformStats,
} from '../controllers/analytics.controller';

const router = Router();

// Protected analytics
router.get('/dashboard', authenticate, requireRole('BUILDER'), getBuilderDashboard);
router.get('/investor-dashboard', authenticate, requireRole('INVESTOR'), getInvestorDashboard);
router.get('/project/:id', authenticate, getProjectAnalytics);
router.get('/platform', authenticate, requireRole('ADMIN'), getPlatformStats);

export default router;
