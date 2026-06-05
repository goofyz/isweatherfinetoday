import express from 'express';
import {
  getCache,
  getCacheWithStats,
  setCacheInBackground,
  WEATHERS_GLOBAL_CACHE_KEY,
  weathersFullCacheKey,
  weathersLocCacheKey,
  fetchWeathersGlobalBundle,
  fetchWeathersLocationBundle,
  buildWeathersResponse,
  loadLiveWeathersFields,
  applyLiveFieldsToResponse,
  DateTime,
  HK,
  getCachedWeatherStationsAndData,
  getCachedAqhiStationsAndData,
  logger,
} from './common.js';

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const api = req.body.api ?? {};

    let lat = api.lat ?? 22.301944;
    let lng = api.lng ?? 114.174297;
    const station_code = api.station_code;
    let operator = api.operator ?? null;

    lat = Number.parseFloat(Number(lat).toFixed(4));
    lng = Number.parseFloat(Number(lng).toFixed(4));
    operator = operator && String(operator).trim().toLowerCase() === 'all' ? 'all' : undefined;

    const lang = api.lang ?? 'en';
    const deviceHeight = Number.parseInt(api.height ?? '0', 10);
    const deviceWidth = Number.parseInt(api.width ?? '0', 10);
    const stationCodeLc = String(station_code ?? '').trim().toLowerCase();
    const operatorKey = operator ?? '';

    const cacheParams = {
      lat,
      lng,
      station_code: stationCodeLc,
      operator: operatorKey,
      lang,
      deviceHeight,
      deviceWidth,
    };
    const fullCacheKey = weathersFullCacheKey(cacheParams);
    const locCacheKey = weathersLocCacheKey(cacheParams);

    const hkTodayIso = DateTime.now().setZone(HK).toISODate();
    const hkTodayMidnightMs = DateTime.fromISO(hkTodayIso, { zone: HK }).startOf('day').toMillis();

    const [fullCached, globalCached, locCached, liveFields] = await Promise.all([
      getCacheWithStats(fullCacheKey),
      getCache(WEATHERS_GLOBAL_CACHE_KEY),
      getCache(locCacheKey),
      loadLiveWeathersFields(hkTodayMidnightMs),
    ]);

    if (fullCached) {
      return res.json(applyLiveFieldsToResponse(fullCached, liveFields, lang));
    }

    let global = globalCached;
    let loc = locCached;

    if (!global && !loc) {
      const [globalBundle] = await Promise.all([
        fetchWeathersGlobalBundle(hkTodayIso),
        getCachedWeatherStationsAndData(),
        getCachedAqhiStationsAndData(),
      ]);
      global = globalBundle;
      setCacheInBackground(WEATHERS_GLOBAL_CACHE_KEY, global);
      loc = await fetchWeathersLocationBundle({
        lat,
        lng,
        station_code: stationCodeLc || null,
        operator: operator === 'all' ? 'all' : undefined,
        todayRow: global.todayRow,
        deviceHeight,
        deviceWidth,
      });
      setCacheInBackground(locCacheKey, loc);
    } else {
      if (!global) {
        global = await fetchWeathersGlobalBundle(hkTodayIso);
        setCacheInBackground(WEATHERS_GLOBAL_CACHE_KEY, global);
      }
      if (!loc) {
        loc = await fetchWeathersLocationBundle({
          lat,
          lng,
          station_code: stationCodeLc || null,
          operator: operator === 'all' ? 'all' : undefined,
          todayRow: global.todayRow,
          deviceHeight,
          deviceWidth,
        });
        setCacheInBackground(locCacheKey, loc);
      }
    }

    const { todayRow, wxRow } = { todayRow: global.todayRow, wxRow: loc.wxRow };
    if (!todayRow || !wxRow || wxRow.sd_update_time == null) {
      const missing = [];
      if (!todayRow) missing.push('today');
      if (!wxRow) missing.push('weather_station');
      else if (wxRow.sd_update_time == null) missing.push('station_data');
      logger.warn(`weathers.json 503 - missing: ${missing.join(',')} (station_code=${station_code ?? ''})`);
      return res.status(503).json({
        success: false,
        info: `no data yet (missing: ${missing.join(',')})`,
        data: null,
      });
    }

    const response = buildWeathersResponse(global, loc, lang, liveFields);
    setCacheInBackground(fullCacheKey, response);
    res.json(response);
  } catch (e) {
    logger.error(e);
    res.status(500).json({ success: false, info: String(e.message ?? e), data: null });
  }
});

export default router;
