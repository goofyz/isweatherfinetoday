import { createHash } from 'crypto';
import { DateTime } from 'luxon';

import { DEVICE_SECRET_KEY } from './config.js';

export function isEng(lang) {
  return lang === 'en';
}

export function naturalNumber(input) {
  if (input === null || input === undefined) return '';
  return String(Number.parseFloat(String(input)));
}

export function truncate(s, length) {
  if (s == null || s === '') return s;
  if (s.length <= length) return s;
  const om = 3;
  return s.slice(0, Math.max(0, length - om)) + '...';
}

export function omitNil(obj) {
  if (obj === null || obj === undefined) return undefined;
  if (Array.isArray(obj)) return obj.map((x) => omitNil(x)).filter((x) => x !== undefined);
  if (typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    const inner = omitNil(v);
    if (inner === undefined) continue;
    out[k] = inner;
  }
  return out;
}

export function verifyDeviceHash({ regId, type, appVersion, t, hash }) {
  const pattern = `lat=${String(regId)}, lng=${String(type)}, v=${String(appVersion)}, key=${DEVICE_SECRET_KEY}, time=${String(t)}`;
  const expected = createHash('sha1').update(pattern).digest('hex');
  return typeof hash === 'string' && expected.localeCompare(hash, undefined, { sensitivity: 'accent' }) === 0;
}

export function warningSortOrder(warningType) {
  const o = {
    TSUNAMI: 1,
    T10: 10,
    T9: 20,
    T8NE: 30,
    T8NW: 30,
    T8SE: 30,
    T8SW: 30,
    T3: 40,
    T1: 50,
    RAIN_BLACK: 60,
    RAIN_RED: 70,
    RAIN_AMBER: 80,
    LANDSLIP: 90,
    FLOODING: 100,
    FROST: 110,
    WEATHER_COLD: 120,
    WEATHER_HOT: 130,
    FIRE_YELLOW: 140,
    FIRE_RED: 150,
    MONSOON: 1000,
  };
  return o[warningType] ?? 2000;
}

export function toDateStr(input){
      if (input== null) return null;
      const dt = input instanceof Date
        ? DateTime.fromJSDate(input)
        : DateTime.fromISO(String(input));
      return dt.isValid ? dt.toISODate() : null;
}