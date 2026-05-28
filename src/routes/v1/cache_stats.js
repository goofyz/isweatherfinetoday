import express from 'express';
import { getCacheStats, logger } from './common.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const stats = getCacheStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    logger.error('cache-stats error:', error);
    res.status(500).json({ success: false, info: String(error.message ?? error) });
  }
});

export default router;
