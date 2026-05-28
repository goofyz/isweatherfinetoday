import express from 'express';
import { getCacheWithStats, setCache, getCachedWeatherStationsAndData, filterStationsByOperator, omitNil, logger } from './common.js';

const router = express.Router();

router.post('/', async (req, res) => {
  let operator =
    req.body.operator ??
    req.query.operator ??
    '';

  const cacheKey = `api:weather_stations:${operator ?? 'null'}`;
  const cached = await getCacheWithStats(cacheKey);
  if (cached) return res.json(cached);

  let rows;

  try {
    const { stationsMap } = await getCachedWeatherStationsAndData();
    const filterOperator = !operator || String(operator).trim() === '' ? '' : String(operator);
    rows = filterStationsByOperator([...stationsMap.values()], filterOperator);
    rows.sort((a, b) => String(a.eng_name ?? '').localeCompare(String(b.eng_name ?? '')));
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
        chi_name: r.chi_name,
        eng_name: r.eng_name,
        lat: r.lat,
        lng: r.lng,
        wind_lat: r.wind_lat,
        wind_lng: r.wind_lng,
        webcam_angle: r.webcam_angle,
        chi_name_abbr: r.chi_name_abbr,
        eng_name_abbr: r.eng_name_abbr,
        station_operator: r.station_operator,
        photo_code: r.photo_code,
        is_forecast: r.is_forecast,
        photo_2x_code: null,
      }),
    ),
  });

  await setCache(cacheKey, response);
  res.json(response);
});

export default router;
