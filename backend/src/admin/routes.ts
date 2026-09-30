/**
 * Admin Routes
 * All admin dashboard routes
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAdminAuth } from './middleware';
import authController from './controllers/auth';
import dashboardController from './controllers/dashboard';
import usersController from './controllers/users';
import instancesController from './controllers/instances';
import sessionsController from './controllers/sessions';
import analyticsController from './controllers/analytics';

const router = Router();

// The admin form lives outside /api, so the API rate limiters don't cover it.
// Keep the budget tight (it guards admin accounts) and answer with a redirect
// the HTML login page can display.
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.redirect('/admin/login?error=ratelimit'),
});

// Public routes (login)
router.get('/login', authController.loginPage);
router.post('/login', adminLoginLimiter, authController.handleLogin);

// Protected routes (require admin session)
router.get('/logout', authController.logout);
router.get('/', requireAdminAuth, dashboardController.dashboard);
router.get('/users', requireAdminAuth, usersController.usersList);
router.get('/users/export', requireAdminAuth, usersController.exportUsers);
router.get('/instances', requireAdminAuth, instancesController.instancesList);
router.get('/sessions', requireAdminAuth, sessionsController.sessionsList);
router.get('/analytics', requireAdminAuth, analyticsController.analyticsPage);

export default router;
