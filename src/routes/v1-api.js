import { createHash } from 'crypto';
import express from 'express';
import { DateTime } from 'luxon';

import { DEVICE_SECRET_KEY, ENABLE_API_LOGGING, ENABLE_FLICKR_PHOTO } from '../config.js';
import { flickrTagsByHour, flickrTagsByWeather } from '../flickr-tags.js';
import { distanceKm, pointInPeakPolygon } from '../geo.js';
import { isEng, naturalNumber, omitNil, truncate, warningSortOrder, toDateStr } from '../helpers.js';
import { FLICKR_DOWN } from '../locales.js';
import { query, queryOne } from '../db.js';
import logger from '../logger.js';
import {
  getCache,
  getFlickrPhotosMatchingTags,
  getHeatIndex,
  getHourForecast,
  getSpecialWeatherTips,
  getStationData,
  getToday,
  getTyphoons,
  getWarnings,
  getWeatherStation,
  getAllForecasts,
  setCache,
  setCacheInBackground,
  getCacheStats,
  resetCacheStats,
} from '../redis-client.js';
import {
  getCachedAqhiStationsAndData,
  getCachedFlickrPhotos,
  getCachedWeatherStationsAndData,
} from '../redis-bulk-cache.js';

const HK = 'Asia/Hong_Kong';

const router = express.Router();
router.use(express.json({ limit: '2mb' }));
router.use(express.urlencoded({ extended: true }));

function sha1Hex(s) {
  return createHash('sha1').update(s).digest('hex');
}

async function fromCacheOrFetch(cacheKey, fetcher) {
  const cached = await getCache(cacheKey);
  if (cached) return cached;
  const payload = await fetcher();
  await setCache(cacheKey, payload);
  return payload;
}

function mergeStationRow(ws, sd) {
  return {
    code: ws.code,
    chi_name: ws.chi_name,
    eng_name: ws.eng_name,
    lat: ws.lat,
    lng: ws.lng,
    wind_lat: ws.wind_lat,
    wind_lng: ws.wind_lng,
    webcam_angle: ws.webcam_angle,
    chi_name_abbr: ws.chi_name_abbr,
    eng_name_abbr: ws.eng_name_abbr,
    station_operator: ws.station_operator,
    photo_code: ws.photo_code,
    is_forecast: ws.is_forecast,
    wind_direction: sd?.wind_direction ?? null,
    wind_speed: sd?.wind_speed ?? null,
    temperature: sd?.temperature ?? null,
    max_temp: sd?.max_temp ?? null,
    min_temp: sd?.min_temp ?? null,
    humidity: sd?.humidity ?? null,
    sd_update_time: sd?.update_time ?? null,
    sd_updated_at: sd?.updated_at ?? null,
  };
}

async function loadStationJoined(codeLc) {
  const ws = await getWeatherStation(codeLc);
  if (!ws) return null;
  const sd = await getStationData(ws.code);
  return mergeStationRow(ws, sd);
}

function filterStationsByOperator(stations, operator) {
  if (operator === 'all') return stations;
  if (!operator || operator === '') {
    return stations.filter((s) => s.station_operator == null);
  }
  return stations.filter((s) => s.station_operator === operator);
}

async function findNearestWeatherStation(lat, lng, operator, weatherBulk) {
  const { stationsMap, dataMap } =
    weatherBulk ?? (await getCachedWeatherStationsAndData());
  const stations = filterStationsByOperator([...stationsMap.values()], operator);

  const rows = [];
  for (const ws of stations) {
    const sd = dataMap.get(String(ws.code).toLowerCase());
    if (!sd) continue;
    rows.push(mergeStationRow(ws, sd));
  }

  rows.sort(
    (a, b) =>
      distanceKm(lat, lng, Number(a.lat), Number(a.lng)) -
      distanceKm(lat, lng, Number(b.lat), Number(b.lng)),
  );

  const nowMs = Date.now();
  const staleCutoffMs = nowMs - 3 * 3600 * 1000;
  for (const r of rows) {
    if (!r.sd_updated_at) continue;
    if (new Date(r.sd_updated_at).getTime() < staleCutoffMs) continue;
    if (String(r.code).toLowerCase() === 'vp1') {
      if (pointInPeakPolygon(lat, lng)) return r;
      continue;
    }
    const t = r.temperature;
    if (t === null || t === undefined) continue;
    const tempNum = Number(t);
    if (Number.isNaN(tempNum) || Math.abs(tempNum + 99.9) < 0.001) continue;
    return r;
  }
  logger.info(`findNearestWeatherStation: no fresh station (operator=${operator ?? ''}, candidates=${rows.length})`);
  return null;
}

async function findWeatherStation(lat, lng, station_code, operator, weatherBulk) {
  if (!station_code || String(station_code).trim() === '') {
    return findNearestWeatherStation(lat, lng, operator, weatherBulk);
  }

  let row = await loadStationJoined(String(station_code).trim().toLowerCase());
  if (!row) row = await loadStationJoined('hko');
  if (!row) return findNearestWeatherStation(lat, lng, operator, weatherBulk);

  const tempNum = row.temperature == null ? NaN : Number(row.temperature);
  if (
    row.sd_updated_at == null
    || row.temperature == null
    || Number.isNaN(tempNum)
    || Math.abs(tempNum + 99.9) < 0.001
  ) {
    return findNearestWeatherStation(Number(row.lat), Number(row.lng), operator, weatherBulk);
  }
  return row;
}

function mergeAqhiStation(meta, dyn) {
  return {
    ...meta,
    aqhi_index: dyn?.aqhi_index ?? null,
    update_time: dyn?.update_time ?? null,
  };
}

async function findNearestAqhi(lat, lng, aqhiBulk) {
  const { stationsMap, dataMap: aqhiMap } =
    aqhiBulk ?? (await getCachedAqhiStationsAndData());
  const rows = [...stationsMap.values()].map((s) =>
    mergeAqhiStation(s, aqhiMap.get(String(s.code))),
  );

  rows.sort(
    (a, b) =>
      distanceKm(lat, lng, Number(a.lat), Number(a.lng)) -
      distanceKm(lat, lng, Number(b.lat), Number(b.lng)),
  );

  const isNumericIndex = (ix) =>
    ix != null && ix !== '' && /^\d+\+?$/.test(String(ix).trim());

  for (const st of rows) {
    if (!st.update_time) continue;
    if (!isNumericIndex(st.aqhi_index)) continue;
    return st;
  }
  for (const st of rows) {
    if (st.update_time) return st;
  }
  return null;
}

async function flickrPhotosForWeather(weather, hourHK) {
  const timeTags = flickrTagsByHour(hourHK);
  const wt = flickrTagsByWeather(weather);
  const combo = [...new Set([...timeTags, ...wt])];

  let rows = await getFlickrPhotosMatchingTags(combo);
  if ((rows?.length ?? 0) < 3) rows = await getFlickrPhotosMatchingTags(timeTags);

  if ((rows?.length ?? 0) >= 3) return rows;

  const all = [...(await getCachedFlickrPhotos()).values()];
  const filterByTags = (tagsArr) => {
    if (!tagsArr.length) return [];
    const wanted = new Set(tagsArr);
    return all.filter((p) => Array.isArray(p.tags) && p.tags.some((t) => wanted.has(t)));
  };

  rows = filterByTags(combo);
  if ((rows?.length ?? 0) < 3) rows = filterByTags(timeTags);
  return rows;
}

function pickForecastDetail(f, lang) {
  return isEng(lang) ? f.eng_detail : f.chi_detail;
}

function pickForecastWind(f, lang) {
  return isEng(lang) ? f.eng_wind : f.chi_wind;
}

function buildForecastNode(f, lang) {
  return omitNil({
    day: toDateStr(f.forecast_day),
    max_temp: f.max_temperature,
    min_temp: f.min_temperature,
    weather: f.weather,
    max_humidity: f.max_humidity,
    min_humidity: f.min_humidity,
    psr: f.psr,
    detail: pickForecastDetail(f, lang),
    wind: pickForecastWind(f, lang),
  });
}

function buildWarningNode(w, lang) {
  return omitNil({
    warning_type: w.warning_type,
    time: w.time instanceof Date ? w.time.toISOString() : w.time,
    detail: isEng(lang) ? w.eng_detail : w.chi_detail,
  });
}

const WEATHERS_GLOBAL_CACHE_KEY = 'api:weathers:global';

function parseTyphoonIds(typhoonId) {
  if (!typhoonId || !String(typhoonId).trim()) return [];
  return typhoonId
    .split(/,/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => !Number.isNaN(n));
}

function weathersLocCacheKey({ lat, lng, station_code, operator, deviceHeight, deviceWidth }) {
  return `api:weathers:loc:${sha1Hex(
    JSON.stringify({
      lat,
      lng,
      station_code: station_code ?? '',
      operator: operator ?? '',
      flickr: ENABLE_FLICKR_PHOTO ? '1' : '0',
      height: deviceHeight,
      width: deviceWidth,
    }),
  )}`;
}

function weathersFullCacheKey({
  lat,
  lng,
  station_code,
  operator,
  lang,
  deviceHeight,
  deviceWidth,
}) {
  return `api:weathers:${sha1Hex(
    JSON.stringify({
      lat,
      lng,
      station_code: station_code ?? '',
      operator: operator ?? '',
      lang,
      height: deviceHeight,
      width: deviceWidth,
      flickr: ENABLE_FLICKR_PHOTO ? '1' : '0',
    }),
  )}`;
}

async function fetchWeathersGlobalBundle(hkTodayIso, hkTodayMidnightMs) {
  const [todayRow, warningsRows, tipsRows, heatIndexFull, forecastsMap] = await Promise.all([
    getToday(),
    getWarnings(),
    getSpecialWeatherTips(),
    getHeatIndex(),
    getAllForecasts(),
  ]);

  warningsRows.sort((a, b) => warningSortOrder(a.warning_type) - warningSortOrder(b.warning_type));

  const heatIndexRow =
    heatIndexFull && heatIndexFull.time && new Date(heatIndexFull.time).getTime() >= hkTodayMidnightMs
      ? heatIndexFull
      : null;

  const typhoonIds = parseTyphoonIds(todayRow?.typhoon_id);
  const typhoonRows = typhoonIds.length ? await getTyphoons(typhoonIds) : [];

  const forecasts = [...forecastsMap.values()]
    .filter((f) => f.forecast_day && String(f.forecast_day) >= hkTodayIso)
    .sort((a, b) => String(a.forecast_day).localeCompare(String(b.forecast_day)));

  return { todayRow, warningsRows, tipsRows, heatIndexRow, typhoonRows, forecasts };
}

async function buildFlickrImageOuter(todayRow, deviceHeight, deviceWidth) {
  if (!ENABLE_FLICKR_PHOTO) {
    return { imageOuter: omitNil({ photo_id: -1 }), message: FLICKR_DOWN };
  }

  const hourHK = DateTime.now().setZone(HK).hour;
  const pool = await flickrPhotosForWeather(String(todayRow?.weather ?? ''), hourHK);
  const photoPick = pool?.length ? pool[Math.floor(Math.random() * pool.length)] : null;
  const high = deviceHeight > 1280 || deviceWidth > 1000 ? !!(photoPick?.high_res_url) : false;

  const imageOuter = !photoPick
    ? omitNil({ owner_url: null, owner_name: null, image_url: null })
    : omitNil({
        owner_name: truncate(photoPick.owner_name ?? '', 20),
        owner_url: photoPick.owner_url,
        image_url: high && photoPick.high_res_url ? photoPick.high_res_url : photoPick.mid_res_url,
      });

  return { imageOuter, message: '' };
}

async function fetchWeathersLocationBundle({
  lat,
  lng,
  station_code,
  operator,
  todayRow,
  deviceHeight,
  deviceWidth,
}) {
  const [weatherBulk, aqhiBulk] = await Promise.all([
    getCachedWeatherStationsAndData(),
    getCachedAqhiStationsAndData(),
  ]);

  const [wxRow, aqStation, flickr] = await Promise.all([
    findWeatherStation(lat, lng, station_code ?? null, operator, weatherBulk),
    findNearestAqhi(lat, lng, aqhiBulk),
    buildFlickrImageOuter(todayRow, deviceHeight, deviceWidth),
  ]);

  if (
    wxRow
    && (wxRow.humidity == null || wxRow.humidity === '')
    && todayRow?.humidity != null
  ) {
    wxRow.humidity = todayRow.humidity;
  }

  return {
    wxRow,
    aqStation,
    imageOuter: flickr.imageOuter,
    message: flickr.message,
  };
}

function buildWeathersResponse(global, loc, lang) {
  const { todayRow, warningsRows, tipsRows, heatIndexRow, typhoonRows, forecasts } = global;
  const { wxRow, aqStation, imageOuter, message } = loc;
  const firstFc = forecasts[0];

  const dataPayload = omitNil({
    day: toDateStr(todayRow.forecast_day),
    weather: todayRow.weather,
    temperature: todayRow.temperature,
    humidity: todayRow.humidity,
    uv: todayRow.uv,
    update_time: wxRow.sd_update_time ?? todayRow.update_time,
    sun_rise_time: todayRow.sun_rise_time,
    sun_set_time: todayRow.sun_set_time,
    moon_rise_time: todayRow.moon_rise_time,
    moon_set_time: todayRow.moon_set_time,
    tide_info: todayRow.tide_info,
    astronomical_update_time:
      todayRow.astronomical_update_time instanceof Date
        ? todayRow.astronomical_update_time.toISOString()
        : todayRow.astronomical_update_time,
    detail: isEng(lang) ? todayRow.eng_detail : todayRow.chi_detail,
    forecast_general: isEng(lang) ? todayRow.eng_forecast_general : todayRow.chi_forecast_general,
    id: Math.floor(Date.now() / 1000),
    max_temp: firstFc?.max_temperature ?? null,
    min_temp: firstFc?.min_temperature ?? null,
    station_code: wxRow.code,
    station_lat: wxRow.lat != null ? Number(wxRow.lat) : null,
    station_lng: wxRow.lng != null ? Number(wxRow.lng) : null,
    station_temperature: naturalNumber(wxRow.temperature),
    station_humidity: naturalNumber(wxRow.humidity),
    station_max_temp: naturalNumber(wxRow.max_temp),
    station_min_temp: naturalNumber(wxRow.min_temp),
    location: isEng(lang) ? wxRow.eng_name : wxRow.chi_name,
    image_data: imageOuter,
    forecasts: forecasts.map((f) => buildForecastNode(f, lang)),
    warnings: warningsRows.map((w) => buildWarningNode(w, lang)),
    typhoons: typhoonRows.map((t) =>
      omitNil({
        hko_id: t.hko_id,
        data_type: t.data_type,
        name: isEng(lang) ? t.eng_name : t.chi_name,
      }),
    ),
    special_weather_tips: tipsRows.map((t) =>
      omitNil({
        time: t.time instanceof Date ? t.time.toISOString() : t.time,
        title: isEng(lang) ? t.eng_title : t.chi_title,
        content: isEng(lang) ? t.eng_content : t.chi_content,
      }),
    ),
    heat_index: heatIndexRow
      ? omitNil({
          time: heatIndexRow.time instanceof Date ? heatIndexRow.time.toISOString() : heatIndexRow.time,
          warning_type: heatIndexRow.warning_type,
          title: isEng(lang) ? heatIndexRow.eng_title : heatIndexRow.chi_title,
          content: isEng(lang) ? heatIndexRow.eng_content : heatIndexRow.chi_content,
        })
      : undefined,
    aqhi: todayRow.aqhi_current,
    aqhi_update_time:
      todayRow.aqhi_update_time instanceof Date
        ? todayRow.aqhi_update_time.toISOString()
        : todayRow.aqhi_update_time,
    aqhi_forecast: isEng(lang) ? todayRow.eng_aqhi_forecast : todayRow.chi_aqhi_forecast,
  });

  if (aqStation) {
    dataPayload.aqhi_station = {
      aqhi_index: aqStation.aqhi_index,
      name: isEng(lang) ? aqStation.eng_name : aqStation.chi_name,
      station_type: aqStation.station_type,
      update_time:
        aqStation.update_time instanceof Date ? aqStation.update_time.toISOString() : aqStation.update_time,
    };
  }

  return omitNil({ success: true, info: message, data: omitNil(dataPayload) });
}

router.post('/devices', async (req, res) => {
  const device = req.body.device ?? {};
  const regId = typeof device.reg_id === 'string' ? device.reg_id.trim() : '';
  if (!regId) {
    return res.json({ success: false, info: 'missing required data' });
  }

  const pattern = `lat=${regId}, lng=${device.type ?? ''}, v=${device.app_version ?? ''}, key=${DEVICE_SECRET_KEY}, time=${req.body.t ?? ''}`;
  const hash = sha1Hex(pattern);
  const t = Number(req.body.t ?? 0);
  const submitRequestDate = new Date(t * 1000);

  let message = '';

  let success = false;
  const is_correct_request =
    submitRequestDate.getTime() + 60 * 1000 > Date.now() &&
    typeof req.body.hash === 'string' &&
    hash.localeCompare(req.body.hash, undefined, { sensitivity: 'accent' }) === 0;

  let dbParams;
  try {
    let row = await queryOne(`SELECT * FROM devices WHERE reg_id=$1`, [regId]);
    const remoteIp =
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ??
      req.socket.remoteAddress ??
      '';
    const appVersion = Number(device.app_version);
    const appVersionOrZero = Number.isNaN(appVersion) ? 0 : appVersion;

    if (!row) {
      dbParams = {
        reg_id: regId,
        os_type: String(device.os_type ?? ''),
        app_version: appVersionOrZero,
        lang: device.lang,
        ip_address: remoteIp,
      };
      await query(
        `INSERT INTO devices (reg_id, os_type, app_version, lang, ip_address, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'A',NOW(),NOW())`,
        [
          dbParams.reg_id,
          dbParams.os_type,
          dbParams.app_version,
          dbParams.lang,
          dbParams.ip_address,
        ],
      );
    } else {
      dbParams = {
        ip_address: remoteIp,
        os_type: String(device.os_type ?? ''),
        app_version: appVersionOrZero,
        lang: device.lang,
        id: row.id,
      };
      await query(
        `UPDATE devices SET ip_address=$1, os_type=$2, app_version=$3, lang=$4,
          status='A', updated_at=NOW() WHERE id=$5`,
        [
          dbParams.ip_address,
          dbParams.os_type,
          dbParams.app_version,
          dbParams.lang,
          dbParams.id,
        ],
      );
    }

    success = true;
    if (!is_correct_request && ENABLE_API_LOGGING) {
      // intentionally empty in Rails implementation
    }
  } catch (e) {
    success = false;
    message = 'error in saving devices';
    logger.error({ err: e, params: dbParams, device }, 'error in saving devices');
  }

  res.json({ success, info: message });
});

router.post('/station_data.json', async (req, res) => {
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

router.post('/weather_stations.json', async (req, res) => {
  let operator =
    req.body.operator ??
    req.query.operator ??
    '';

  const cacheKey = `api:weather_stations:${operator ?? 'null'}`;
  const cached = await getCache(cacheKey);
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

router.post('/hour_forecast.json', async (req, res) => {
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

router.post('/aqhi_stations.json', async (req, res) => {
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

router.post('/weathers.json', async (req, res) => {
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

    const [fullCached, globalCached, locCached] = await Promise.all([
      getCache(fullCacheKey),
      getCache(WEATHERS_GLOBAL_CACHE_KEY),
      getCache(locCacheKey),
    ]);

    if (fullCached) return res.json(fullCached);

    const hkTodayIso = DateTime.now().setZone(HK).toISODate();
    const hkTodayMidnightMs = DateTime.fromISO(hkTodayIso, { zone: HK }).startOf('day').toMillis();

    let global = globalCached;
    let loc = locCached;

    if (!global && !loc) {
      const [globalBundle] = await Promise.all([
        fetchWeathersGlobalBundle(hkTodayIso, hkTodayMidnightMs),
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
        global = await fetchWeathersGlobalBundle(hkTodayIso, hkTodayMidnightMs);
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

    const response = buildWeathersResponse(global, loc, lang);
    setCacheInBackground(fullCacheKey, response);
    res.json(response);
  } catch (e) {
    logger.error(e);
    res.status(500).json({ success: false, info: String(e.message ?? e), data: null });
  }
});

router.get('/cache-stats', async (req, res) => {
  try {
    const stats = getCacheStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    logger.error('cache-stats error:', error);
    res.status(500).json({ success: false, info: String(error.message ?? error) });
  }
});

router.post('/cache-stats/reset', async (req, res) => {
  try {
    resetCacheStats();
    res.json({ success: true, info: 'Cache statistics reset' });
  } catch (error) {
    logger.error('cache-stats/reset error:', error);
    res.status(500).json({ success: false, info: String(error.message ?? error) });
  }
});

export default router;
