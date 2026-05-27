import express from 'express';
import { getCache, setCache, getCachedWeatherStationsAndData, filterStationsByOperator, omitNil, logger } from './common.js';

const router = express.Router();

router.post('/', async (req, res) => {
  const operator =
    req.body.operator ??
    req.query.operator;

  const cacheKey = `api:station_data:${operator ?? 'null'}`;
  const cached = await getCache(cacheKey);
  if (cached) return res.json(cached);

  let rows = [];
  logger.info(`operator filter: ${operator}`);

  try {
    const { stationsMap, dataMap } = await getCachedWeatherStationsAndData();
    const stations = filterStationsByOperator([...stationsMap.values()], operator);
    const freshCutoffMs = Date.now() - 3 * 3600 * 1000;

    for (const st of stations) {
      const sd = dataMap.get(String(st.code).toLowerCase());
      if (!sd) continue;
      if (sd.update_time == null) continue;
      if (operator === 'all') {
        if (!sd.updated_at) continue;
        if (new Date(sd.updated_at).getTime() <= freshCutoffMs) continue;
      }
      rows.push({
        code: st.code,
        wind_direction: sd.wind_direction,
        wind_speed: sd.wind_speed,
        temperature: sd.temperature,
        max_temp: sd.max_temp,
        min_temp: sd.min_temp,
        humidity: sd.humidity,
        update_time: sd.update_time,
      });
    }
  } catch (e) {
    logger.error(e);
    rows = [];
  }

  const response = omitNil({
    success: true,
    info: '',
    data: rows.map((r) =>
      omitNil({
        code: r.code,
        wind_direction: r.wind_direction,
        wind_speed: r.wind_speed,
        temperature: r.temperature,
        max_temp: r.max_temp,
        min_temp: r.min_temp,
        humidity: r.humidity,
        update_time: r.update_time,
      }),
    ),
  });

  await setCache(cacheKey, response);
  res.json(response);
});

export default router;
