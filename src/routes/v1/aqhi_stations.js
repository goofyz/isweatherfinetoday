import express from 'express';
import { getCache, setCache, getCachedAqhiStationsAndData, omitNil, isEng } from './common.js';

const router = express.Router();

router.post('/', async (req, res) => {
  const lang = req.body.lang || 'en';
  const cacheKey = 'api:aqhi_stations';
  const cached = await getCache(cacheKey);
  if (cached) return res.json(cached);

  const { stationsMap, dataMap: aqhiMap } = await getCachedAqhiStationsAndData();
  const stations = [...stationsMap.values()].sort((a, b) =>
    String(a.eng_name ?? '').localeCompare(String(b.eng_name ?? '')),
  );

  const response = {
    success: true,
    info: '',
    data: stations.map((s) => {
      const dyn = aqhiMap.get(String(s.code));
      return omitNil({
        code: s.code,
        lat: s.lat != null ? Number(s.lat) : null,
        lng: s.lng != null ? Number(s.lng) : null,
        station_type: s.station_type,
        aqhi_index: dyn?.aqhi_index ?? null,
        update_time: dyn?.update_time ?? null,
        name: isEng(lang) ? s.eng_name : s.chi_name,
      });
    }),
  };

  await setCache(cacheKey, response);
  res.json(response);
});

export default router;
