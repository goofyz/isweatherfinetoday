import { createHash } from 'crypto';
import { DateTime } from 'luxon';

import { DEVICE_SECRET_KEY, ENABLE_API_LOGGING, ENABLE_FLICKR_PHOTO } from '../../config.js';
import { flickrTagsByHour, flickrTagsByWeather } from '../../flickr-tags.js';
import { distanceKm, pointInPeakPolygon } from '../../geo.js';
import { isEng, naturalNumber, omitNil, truncate, warningSortOrder, toDateStr } from '../../helpers.js';
import { FLICKR_DOWN } from '../../locales.js';
import { query, queryOne } from '../../db.js';
import logger from '../../logger.js';
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
  recordCacheHit,
  recordCacheMiss,
} from '../../redis-client.js';
import {
  getCachedAqhiStationsAndData,
  getCachedFlickrPhotos,
  getCachedWeatherStationsAndData,
} from '../../redis-bulk-cache.js';

const HK = 'Asia/Hong_Kong';

function sha1Hex(s) {
  return createHash('sha1').update(s).digest('hex');
}

// Wrapper function that tracks cache stats for API calls only
async function getCacheWithStats(key) {
  const cached = await getCache(key);
  if (cached) {
    recordCacheHit();
  } else {
    recordCacheMiss();
  }
  return cached;
}

async function fromCacheOrFetch(cacheKey, fetcher) {
  const cached = await getCacheWithStats(cacheKey);
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

function buildTipNode(t, lang) {
  return omitNil({
    time: t.time instanceof Date ? t.time.toISOString() : t.time,
    title: isEng(lang) ? t.eng_title : t.chi_title,
    content: isEng(lang) ? t.eng_content : t.chi_content,
  });
}

function buildHeatIndexField(heatIndexRow, lang) {
  if (!heatIndexRow) return undefined;
  return omitNil({
    time: heatIndexRow.time instanceof Date ? heatIndexRow.time.toISOString() : heatIndexRow.time,
    warning_type: heatIndexRow.warning_type,
    title: isEng(lang) ? heatIndexRow.eng_title : heatIndexRow.chi_title,
    content: isEng(lang) ? heatIndexRow.eng_content : heatIndexRow.chi_content,
  });
}

async function loadLiveWeathersFields(hkTodayMidnightMs) {
  const [warningsRows, tipsRows, heatIndexFull] = await Promise.all([
    getWarnings(),
    getSpecialWeatherTips(),
    getHeatIndex(),
  ]);

  const sortedWarnings = (warningsRows ?? []).slice();
  sortedWarnings.sort((a, b) => warningSortOrder(a.warning_type) - warningSortOrder(b.warning_type));

  const heatIndexRow =
    heatIndexFull && heatIndexFull.time && new Date(heatIndexFull.time).getTime() >= hkTodayMidnightMs
      ? heatIndexFull
      : null;

  return {
    warningsRows: sortedWarnings,
    tipsRows: tipsRows ?? [],
    heatIndexRow,
  };
}

function applyLiveFieldsToResponse(response, liveFields, lang) {
  if (!response?.data) return response;
  const { warningsRows, tipsRows, heatIndexRow } = liveFields;
  const heat_index = buildHeatIndexField(heatIndexRow, lang);
  const data = {
    ...response.data,
    warnings: warningsRows.map((w) => buildWarningNode(w, lang)),
    special_weather_tips: tipsRows.map((t) => buildTipNode(t, lang)),
  };
  if (heat_index !== undefined) {
    data.heat_index = heat_index;
  } else {
    delete data.heat_index;
  }
  return { ...response, data };
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

async function fetchWeathersGlobalBundle(hkTodayIso) {
  const [todayRow, forecastsMap] = await Promise.all([getToday(), getAllForecasts()]);

  const typhoonIds = parseTyphoonIds(todayRow?.typhoon_id);
  const typhoonRows = typhoonIds.length ? await getTyphoons(typhoonIds) : [];

  const forecasts = [...forecastsMap.values()]
    .filter((f) => f.forecast_day && String(f.forecast_day) >= hkTodayIso)
    .sort((a, b) => String(a.forecast_day).localeCompare(String(b.forecast_day)));

  return { todayRow, typhoonRows, forecasts };
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

function buildWeathersResponse(global, loc, lang, liveFields) {
  const { todayRow, typhoonRows, forecasts } = global;
  const { warningsRows, tipsRows, heatIndexRow } = liveFields;
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
    special_weather_tips: tipsRows.map((t) => buildTipNode(t, lang)),
    heat_index: buildHeatIndexField(heatIndexRow, lang),
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

export {
  sha1Hex,
  fromCacheOrFetch,
  mergeStationRow,
  loadStationJoined,
  filterStationsByOperator,
  findNearestWeatherStation,
  findWeatherStation,
  mergeAqhiStation,
  findNearestAqhi,
  flickrPhotosForWeather,
  pickForecastDetail,
  pickForecastWind,
  buildForecastNode,
  buildWarningNode,
  buildTipNode,
  buildHeatIndexField,
  loadLiveWeathersFields,
  applyLiveFieldsToResponse,
  WEATHERS_GLOBAL_CACHE_KEY,
  parseTyphoonIds,
  weathersLocCacheKey,
  weathersFullCacheKey,
  fetchWeathersGlobalBundle,
  buildFlickrImageOuter,
  fetchWeathersLocationBundle,
  buildWeathersResponse,
  getCache,
  getCacheWithStats,
  setCache,
  setCacheInBackground,
  getCachedWeatherStationsAndData,
  getCachedAqhiStationsAndData,
  getHourForecast,
  getCachedFlickrPhotos,
  getToday,
  getWarnings,
  getSpecialWeatherTips,
  getHeatIndex,
  getAllForecasts,
  getTyphoons,
  isEng,
  omitNil,
  truncate,
  logger,
  DateTime,
  HK,
  getCacheStats
};
