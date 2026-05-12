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
