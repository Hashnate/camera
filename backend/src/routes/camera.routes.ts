import { Router } from 'express';
import {
  getCameras,
  getCameraById,
  syncEZVIZ,
  getStreamUrl,
  captureSnapshot,
  getCameraStatus,
} from '../controllers/camera.controller.js';
import { authenticateToken } from '../middlewares/auth.middleware.js';

const router = Router();

router.use(authenticateToken);

router.get('/', getCameras);
router.post('/sync-ezviz', syncEZVIZ);
router.get('/:id', getCameraById);
router.get('/:id/status', getCameraStatus);
router.get('/:id/stream', getStreamUrl);
router.post('/:id/stream', getStreamUrl);
router.get('/:id/snapshot', captureSnapshot);

export default router;

