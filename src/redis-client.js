import { createClient } from 'redis';
import logger from './logger.js';
import { REDIS_URL, REDIS_CACHE_TTL_SECONDS, ENABLE_API_LOGGING } from './config.js';

const redisClient = REDIS_URL ? createClient({ url: REDIS_URL }) : null;

// Cache statistics tracking
let cacheStats = { hits: 0, misses: 0 };

export async function connectRedis() {
  if (!redisClient) return;

  redisClient.on('error', (error) => {
    logger.warn(error, 'Redis client error:');
  });

  try {
    await redisClient.connect();
    logger.info('Connected to Redis.');
  } catch (error) {
    logger.warn(error, 'Redis connection failed.');
  }
}

export async function disconnectRedis() {
  if (!redisClient) return;
  try {
    await redisClient.disconnect();
  } catch (error) {
    logger.warn(error, 'Redis disconnect failed.');
  }
}

export async function getCache(key) {
  if (!redisClient) {
    return null;
  }
  try {
    const cached = await redisClient.get(key);
    return cached ? JSON.parse(cached) : null;
  } catch (error) {
    logger.warn(error, 'Redis get failed.');
    return null;
  }
}

export async function setCache(key, value, ttlSeconds = REDIS_CACHE_TTL_SECONDS) {
  if (!redisClient) return;
  try {
    const payload = JSON.stringify(value);
    if (ttlSeconds > 0) {
      await redisClient.set(key, payload, { EX: ttlSeconds });
    } else {
      await redisClient.set(key, payload);
    }
    try {
      if (ENABLE_API_LOGGING && typeof key === 'string' && key.startsWith('api:')) {
        const payloadSize = payload.length;
        logger.info(`Redis cache created: key=${key}, size=${payloadSize}B, ttl=${ttlSeconds}s`);
      }
    } catch (e) {
      // swallow logging errors
    }
  } catch (error) {
    logger.warn(error, 'Redis set failed');
  }
}

export function setCacheInBackground(key, value, ttlSeconds = REDIS_CACHE_TTL_SECONDS) {
  void setCache(key, value, ttlSeconds);
}

export function getCacheStats() {
  const total = cacheStats.hits + cacheStats.misses;
  const ratio = total > 0 ? ((cacheStats.hits / total) * 100).toFixed(2) : 0;
  return {
    hits: cacheStats.hits,
    misses: cacheStats.misses,
    total,
    hitRatio: `${ratio}%`,
  };
}

export function recordCacheHit() {
  cacheStats.hits++;
}

export function recordCacheMiss() {
  cacheStats.misses++;
}

export function setCacheStats(hits, misses) {
  cacheStats = { hits, misses };
}

const STATION_DATA_KEY = 'weather:station_data';

export async function setStationData(code, data) {
  if (!redisClient) return;
  try {
    const field = String(code).toLowerCase();
    const payload = JSON.stringify({
      ...data,
      updated_at: new Date().toISOString(),
    });
    await redisClient.hSet(STATION_DATA_KEY, field, payload);
  } catch (error) {
    logger.warn(error, 'Redis hSet station_data failed.');
  }
}

export async function getStationData(code) {
  if (!redisClient) return null;
  try {
    const field = String(code).toLowerCase();
    const raw = await redisClient.hGet(STATION_DATA_KEY, field);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    logger.warn(error, 'Redis hGet station_data failed.');
    return null;
  }
}

export async function getAllStationData() {
  const result = new Map();
  if (!redisClient) return result;
  try {
    const all = await redisClient.hGetAll(STATION_DATA_KEY);
    for (const [field, raw] of Object.entries(all ?? {})) {
      try {
        result.set(field, JSON.parse(raw));
      } catch (parseErr) {
        logger.warn(parseErr, `Redis station_data parse failed for ${field}.`);
      }
    }
  } catch (error) {
    logger.warn(error, 'Redis hGetAll station_data failed.');
  }
  return result;
}

const TODAY_KEY = 'weather:today';
const TYPHOONS_KEY = 'weather:typhoons';
const HOUR_FORECAST_KEY = 'weather:hour_forecast';
const WARNINGS_KEY = 'weather:warnings';
const TIPS_KEY = 'weather:special_weather_tips';
const HEAT_INDEX_KEY = 'weather:heat_index';
const AQHI_DATA_KEY = 'weather:aqhi_data';
const FORECASTS_KEY = 'weather:forecasts';
const FLICKR_PHOTOS_KEY = 'weather:flickr_photos';
const FLICKR_TAG_KEY_PREFIX = 'weather:flickr_tag:';
const WEATHER_STATIONS_KEY = 'weather:weather_stations';
const AQHI_STATIONS_KEY = 'weather:aqhi_stations';

function flickrTagKey(tag) {
  return `${FLICKR_TAG_KEY_PREFIX}${tag}`;
}

async function getJsonKey(key) {
  if (!redisClient) return null;
  try {
    const raw = await redisClient.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    logger.warn(error, `Redis get ${key} failed.`);
    return null;
  }
}

async function setJsonKey(key, value) {
  if (!redisClient) return;
  try {
    await redisClient.set(key, JSON.stringify(value));
  } catch (error) {
    logger.warn(error, `Redis set ${key} failed.`);
  }
}

async function hGetAllJson(key) {
  const result = new Map();
  if (!redisClient) return result;
  try {
    const all = await redisClient.hGetAll(key);
    for (const [field, raw] of Object.entries(all ?? {})) {
      try {
        result.set(field, JSON.parse(raw));
      } catch (parseErr) {
        logger.warn(parseErr, `Redis ${key} parse failed for ${field}.`);
      }
    }
  } catch (error) {
    logger.warn(error, `Redis hGetAll ${key} failed.`);
  }
  return result;
}

async function hGetJson(key, field) {
  if (!redisClient) return null;
  try {
    const raw = await redisClient.hGet(key, field);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    logger.warn(error, `Redis hGet ${key}/${field} failed.`);
    return null;
  }
}

async function hSetJson(key, field, value) {
  if (!redisClient) return;
  try {
    await redisClient.hSet(key, field, JSON.stringify(value));
  } catch (error) {
    logger.warn(error, `Redis hSet ${key}/${field} failed.`);
  }
}

export async function getToday() {
  return getJsonKey(TODAY_KEY);
}

export async function mergeToday(patch) {
  const current = (await getToday()) ?? {};
  const next = { ...current, ...patch, updated_at: new Date().toISOString() };
  await setJsonKey(TODAY_KEY, next);
  return next;
}

export async function setTyphoon(hkoId, data) {
  await hSetJson(TYPHOONS_KEY, String(hkoId), data);
}

export async function getTyphoon(hkoId) {
  return hGetJson(TYPHOONS_KEY, String(hkoId));
}

export async function getTyphoons(hkoIds) {
  if (!Array.isArray(hkoIds) || hkoIds.length === 0) return [];
  const rows = await Promise.all(hkoIds.map((id) => hGetJson(TYPHOONS_KEY, String(id))));
  return rows.filter(Boolean);
}

export async function setHourForecast(code, data) {
  await hSetJson(HOUR_FORECAST_KEY, String(code).toLowerCase(), data);
}

export async function getHourForecast(code) {
  return hGetJson(HOUR_FORECAST_KEY, String(code).toLowerCase());
}

export async function getWarnings() {
  return (await getJsonKey(WARNINGS_KEY)) ?? [];
}

export async function setWarnings(list) {
  await setJsonKey(WARNINGS_KEY, list ?? []);
}

export async function getSpecialWeatherTips() {
  return (await getJsonKey(TIPS_KEY)) ?? [];
}

export async function setSpecialWeatherTips(list) {
  await setJsonKey(TIPS_KEY, list ?? []);
}

export async function getHeatIndex() {
  return getJsonKey(HEAT_INDEX_KEY);
}

export async function setHeatIndex(value) {
  if (value == null) {
    if (!redisClient) return;
    try {
      await redisClient.del(HEAT_INDEX_KEY);
    } catch (error) {
      logger.warn(error, 'Redis del heat_index failed.');
    }
    return;
  }
  await setJsonKey(HEAT_INDEX_KEY, value);
}

export async function setAqhiStationData(code, data) {
  await hSetJson(AQHI_DATA_KEY, String(code), {
    ...data,
    updated_at: new Date().toISOString(),
  });
}

export async function getAqhiStationData(code) {
  return hGetJson(AQHI_DATA_KEY, String(code));
}

export async function getAllAqhiStationData() {
  return hGetAllJson(AQHI_DATA_KEY);
}

export async function getForecast(forecastDay) {
  return hGetJson(FORECASTS_KEY, String(forecastDay));
}

export async function setForecast(forecastDay, data) {
  await hSetJson(FORECASTS_KEY, String(forecastDay), data);
}

export async function mergeForecast(forecastDay, patch) {
  const field = String(forecastDay);
  const current = (await hGetJson(FORECASTS_KEY, field)) ?? {};
  const next = { ...current };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v !== undefined) next[k] = v;
  }
  next.updated_at = new Date().toISOString();
  await hSetJson(FORECASTS_KEY, field, next);
  return next;
}

export async function getAllForecasts() {
  return hGetAllJson(FORECASTS_KEY);
}

export async function indexFlickrPhotoTags(photoId, tags) {
  if (!redisClient || !tags?.length) return;
  const id = String(photoId);
  try {
    await Promise.all(
      tags.map((tag) => redisClient.sAdd(flickrTagKey(tag), id)),
    );
  } catch (error) {
    logger.warn(error, `Redis index flickr tags for ${photoId} failed.`);
  }
}

export async function unindexFlickrPhotoTags(photoId, tags) {
  if (!redisClient || !tags?.length) return;
  const id = String(photoId);
  try {
    await Promise.all(
      tags.map((tag) => redisClient.sRem(flickrTagKey(tag), id)),
    );
  } catch (error) {
    logger.warn(error, `Redis unindex flickr tags for ${photoId} failed.`);
  }
}

export async function setFlickrPhoto(photoId, data) {
  const id = String(photoId);
  const old = await hGetJson(FLICKR_PHOTOS_KEY, id);
  if (old?.tags?.length) await unindexFlickrPhotoTags(id, old.tags);
  await hSetJson(FLICKR_PHOTOS_KEY, id, {
    ...data,
    updated_at: new Date().toISOString(),
  });
  if (data?.tags?.length) await indexFlickrPhotoTags(id, data.tags);
}

export async function getAllFlickrPhotos() {
  return hGetAllJson(FLICKR_PHOTOS_KEY);
}

export async function getFlickrPhotosByIds(photoIds) {
  if (!redisClient || !photoIds?.length) return [];
  try {
    const raws = await redisClient.hmGet(FLICKR_PHOTOS_KEY, photoIds.map(String));
    const out = [];
    for (const raw of raws ?? []) {
      if (!raw) continue;
      try {
        out.push(JSON.parse(raw));
      } catch (parseErr) {
        logger.warn(parseErr, 'Redis flickr photo parse failed.');
      }
    }
    return out;
  } catch (error) {
    logger.warn(error, 'Redis hmGet flickr_photos failed.');
    return [];
  }
}

export async function getFlickrPhotosMatchingTags(tags) {
  if (!tags?.length) return [];
  if (!redisClient) return [];

  try {
    const keys = tags.map((tag) => flickrTagKey(tag));
    const ids = await redisClient.sUnion(keys);
    if (ids?.length) return getFlickrPhotosByIds(ids);
  } catch (error) {
    logger.warn(error, 'Redis sUnion flickr tags failed.');
  }
  return [];
}

export async function rebuildFlickrTagIndex() {
  if (!redisClient) return;

  try {
    for await (const key of redisClient.scanIterator({
      MATCH: `${FLICKR_TAG_KEY_PREFIX}*`,
      COUNT: 100,
    })) {
      await redisClient.del(key);
    }
  } catch (error) {
    logger.warn(error, 'Redis clear flickr tag index failed.');
    return;
  }

  const all = await getAllFlickrPhotos();
  await Promise.all(
    [...all.entries()].map(([id, photo]) =>
      photo?.tags?.length ? indexFlickrPhotoTags(id, photo.tags) : Promise.resolve(),
    ),
  );
}

export async function deleteFlickrPhoto(photoId) {
  if (!redisClient) return;
  const id = String(photoId);
  try {
    const old = await hGetJson(FLICKR_PHOTOS_KEY, id);
    if (old?.tags?.length) await unindexFlickrPhotoTags(id, old.tags);
    await redisClient.hDel(FLICKR_PHOTOS_KEY, id);
  } catch (error) {
    logger.warn(error, `Redis hDel flickr_photos/${photoId} failed.`);
  }
}

function normalizeWeatherStation(raw) {
  return {
    code: String(raw.code).toLowerCase(),
    chi_name: raw.chi_name ?? null,
    eng_name: raw.eng_name ?? null,
    lat: raw.lat ?? null,
    lng: raw.lng ?? null,
    wind_lat: raw.wind_lat ?? null,
    wind_lng: raw.wind_lng ?? null,
    webcam_angle: raw.webcam_angle ?? null,
    chi_name_abbr: raw.chi_name_abbr ?? null,
    eng_name_abbr: raw.eng_name_abbr ?? null,
    station_operator: raw.station_operator ?? null,
    photo_code: raw.photo_code ?? null,
    is_forecast: raw.is_forecast ?? false,
  };
}

function normalizeAqhiStation(raw) {
  return {
    code: String(raw.code),
    chi_name: raw.chi_name ?? null,
    eng_name: raw.eng_name ?? null,
    lat: raw.lat ?? null,
    lng: raw.lng ?? null,
    station_type: raw.station_type ?? null,
  };
}

export async function setWeatherStation(station) {
  const normalized = normalizeWeatherStation(station);
  await hSetJson(WEATHER_STATIONS_KEY, normalized.code, normalized);
  return normalized;
}

export async function getWeatherStation(code) {
  if (code == null) return null;
  return hGetJson(WEATHER_STATIONS_KEY, String(code).toLowerCase());
}

export async function getAllWeatherStations() {
  return hGetAllJson(WEATHER_STATIONS_KEY);
}

export async function loadWeatherStations(stations) {
  if (!redisClient || !Array.isArray(stations)) return;
  for (const s of stations) {
    if (!s?.code) continue;
    await setWeatherStation(s);
  }
}

export async function setAqhiStation(station) {
  const normalized = normalizeAqhiStation(station);
  await hSetJson(AQHI_STATIONS_KEY, normalized.code, normalized);
  return normalized;
}

export async function getAqhiStation(code) {
  if (code == null) return null;
  return hGetJson(AQHI_STATIONS_KEY, String(code));
}

export async function getAllAqhiStations() {
  return hGetAllJson(AQHI_STATIONS_KEY);
}

export async function loadAqhiStations(stations) {
  if (!redisClient || !Array.isArray(stations)) return;
  for (const s of stations) {
    if (!s?.code) continue;
    await setAqhiStation(s);
  }
}

export async function deleteCacheByPattern(pattern) {
  if (!redisClient) return [];
  const deletedKeys = [];
  try {
    for await (const key of redisClient.scanIterator({
      MATCH: pattern,
      COUNT: 100,
    })) {
      if (!key) continue;
      const normalizedKey = typeof key === 'string' ? key : String(key ?? '');
      // Skip empty keys which can appear in some Redis client implementations
      if (!normalizedKey) continue;
      try {
        await redisClient.del(normalizedKey);
        deletedKeys.push(normalizedKey);
        try {
          if (ENABLE_API_LOGGING && normalizedKey.startsWith('api:')) logger.info(`Redis deleted cache ${normalizedKey}`);
        } catch (e) {
          // ignore logging errors
        }
      } catch (delErr) {
        logger.warn(delErr, `Redis del ${normalizedKey} failed.`);
      }
    }
    try {
      if (ENABLE_API_LOGGING && pattern && String(pattern).startsWith('api:') && deletedKeys.length > 0) {
        logger.info(`Redis delete pattern ${pattern} removed ${deletedKeys.length} keys`);
      }
    } catch (e) {
      // ignore logging errors
    }
    return deletedKeys;
  } catch (error) {
    logger.warn(error, `Redis delete pattern ${pattern} failed`);
    return deletedKeys;
  }
}
