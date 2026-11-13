import { Router } from 'express';
import {
  getOverviewStats,
  getZoneOccupancy,
  recordDetectionEvent,
} from '../controllers/analytics.controller.js';
import { authenticateToken } from '../middlewares/auth.middleware.js';

const router = Router();

// Internal AI detection webhook can post with or without token, or with API key
router.post('/events', recordDetectionEvent);

router.use(authenticateToken);

router.get('/overview', getOverviewStats);
router.get('/occupancy', getZoneOccupancy);

export default router;

