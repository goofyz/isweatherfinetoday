import express from 'express';
import { getCache, setCache, getHourForecast, omitNil, logger } from './common.js';

const router = express.Router();

router.post('/', async (req, res) => {
  const code = String(req.body.code ?? '').trim().toLowerCase();
  const cacheKey = `api:hour_forecast:${code || 'all'}`;
  const cached = await getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const inner = await getHourForecast(code);
    const success = !!inner;
    const response = omitNil({
      success,
      info: '',
      data: omitNil(inner ?? {}),
    });
    await setCache(cacheKey, response);
    res.json(response);
  } catch (e) {
    logger.error(e);
    res.json({ success: false, info: '' });
  }
});

export default router;
