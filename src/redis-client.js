import { createClient } from 'redis';
import logger from './logger.js';
import { REDIS_URL, REDIS_CACHE_TTL_SECONDS } from './config.js';

const redisClient = REDIS_URL ? createClient({ url: REDIS_URL }) : null;

export async function connectRedis() {
  if (!redisClient) return;

  redisClient.on('error', (error) => {
    logger.warn('Redis client error:', error);
  });

  try {
    await redisClient.connect();
    logger.info('Connected to Redis.');
  } catch (error) {
    logger.warn('Redis connection failed:', error);
  }
}

export async function disconnectRedis() {
  if (!redisClient) return;
  try {
    await redisClient.disconnect();
  } catch (error) {
    logger.warn('Redis disconnect failed:', error);
  }
}

export async function getCache(key) {
  if (!redisClient) return null;
  try {
    const cached = await redisClient.get(key);
    return cached ? JSON.parse(cached) : null;
  } catch (error) {
    logger.warn('Redis get failed:', error);
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
  } catch (error) {
    logger.warn('Redis set failed:', error);
  }
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
    logger.warn('Redis hSet station_data failed:', error);
  }
}

export async function getStationData(code) {
  if (!redisClient) return null;
  try {
    const field = String(code).toLowerCase();
    const raw = await redisClient.hGet(STATION_DATA_KEY, field);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    logger.warn('Redis hGet station_data failed:', error);
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
        logger.warn(`Redis station_data parse failed for ${field}:`, parseErr);
      }
    }
  } catch (error) {
    logger.warn('Redis hGetAll station_data failed:', error);
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

async function getJsonKey(key) {
  if (!redisClient) return null;
  try {
    const raw = await redisClient.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    logger.warn(`Redis get ${key} failed:`, error);
    return null;
  }
}

async function setJsonKey(key, value) {
  if (!redisClient) return;
  try {
    await redisClient.set(key, JSON.stringify(value));
  } catch (error) {
    logger.warn(`Redis set ${key} failed:`, error);
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
        logger.warn(`Redis ${key} parse failed for ${field}:`, parseErr);
      }
    }
  } catch (error) {
    logger.warn(`Redis hGetAll ${key} failed:`, error);
  }
  return result;
}

async function hGetJson(key, field) {
  if (!redisClient) return null;
  try {
    const raw = await redisClient.hGet(key, field);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    logger.warn(`Redis hGet ${key}/${field} failed:`, error);
    return null;
  }
}

async function hSetJson(key, field, value) {
  if (!redisClient) return;
  try {
    await redisClient.hSet(key, field, JSON.stringify(value));
  } catch (error) {
    logger.warn(`Redis hSet ${key}/${field} failed:`, error);
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
  const out = [];
  if (!Array.isArray(hkoIds) || hkoIds.length === 0) return out;
  for (const id of hkoIds) {
    const t = await hGetJson(TYPHOONS_KEY, String(id));
    if (t) out.push(t);
  }
  return out;
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
      logger.warn('Redis del heat_index failed:', error);
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

export async function setFlickrPhoto(photoId, data) {
  await hSetJson(FLICKR_PHOTOS_KEY, String(photoId), {
    ...data,
    updated_at: new Date().toISOString(),
  });
}

export async function getAllFlickrPhotos() {
  return hGetAllJson(FLICKR_PHOTOS_KEY);
}

export async function deleteFlickrPhoto(photoId) {
  if (!redisClient) return;
  try {
    await redisClient.hDel(FLICKR_PHOTOS_KEY, String(photoId));
  } catch (error) {
    logger.warn(`Redis hDel flickr_photos/${photoId} failed:`, error);
  }
}
