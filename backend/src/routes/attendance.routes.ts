import { Router } from 'express';
import {
  getTodayAttendance,
  getAttendanceHistory,
  checkIn,
  checkOut,
  requestCorrection,
} from '../controllers/attendance.controller.js';
import { authenticateToken } from '../middlewares/auth.middleware.js';

const router = Router();

router.use(authenticateToken);

router.get('/today', getTodayAttendance);
router.get('/history', getAttendanceHistory);
router.post('/check-in', checkIn);
router.post('/check-out', checkOut);
router.post('/correction', requestCorrection);

export default router;

