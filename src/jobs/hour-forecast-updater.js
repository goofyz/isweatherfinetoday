import { DateTime } from 'luxon';
import { query, queryOne } from '../db.js';
import { URL_HOUR_FORECAST_SOURCE } from '../config.js';
import { getJson } from '../request-helper.js';

const HK = 'Asia/Hong_Kong';
const MAX_HOURS_MS = 2 * 24 * 60 * 60 * 1000;
const ALL = ['cch', 'hka', 'hko', 'hks', 'jkb', 'lfs', 'pen', 'sek', 'sha', 'skg', 'tkl', 'tpo', 'tun', 'ty1', 'wgl', 'ssh'];

async function fetchJsonForCode(code) {
  const url = URL_HOUR_FORECAST_SOURCE.replace('%{code}', code.toUpperCase());
  return getJson(url);
}

function parseLastModified(ts) {
  const s = String(ts ?? '').trim();
  if (!s || s.length < 14) return DateTime.now().setZone('Asia/Hong_Kong');
  return DateTime.fromFormat(s, 'yyyyMMddHHmmss', { zone: 'Asia/Hong_Kong' });
}

function extractDayForecast(json) {
  const dayData = [];
  const currentMidnight = DateTime.now().setZone('Asia/Hong_Kong').startOf('day');
  const list = json?.DailyForecast ?? [];
  for (const f of list) {
    const day = parseInt(String(f.ForecastDate), 10);
    const data = { day, rain: f.ForecastChanceOfRain, weather: f.ForecastDailyWeather };
    const dayInDate = DateTime.fromFormat(String(day), 'yyyyMMdd', { zone: 'Asia/Hong_Kong' }).startOf('day');
    if (dayInDate >= currentMidnight && dayInDate <= currentMidnight.plus({ days: 3 })) dayData.push(data);
  }
  return { daily: [...dayData].sort((a, b) => a.day - b.day) };
}

function parseForecastHourToLuxon(raw) {
  const s = String(raw);
  let dt;
  if (s.length === 12) dt = DateTime.fromFormat(`${s}+08:00`, 'yyyyMMddHHmmZZ');
  else if (s.length <= 11) dt = DateTime.fromFormat(`${s.padEnd(10, '0')}+08:00`, 'yyyyMMddHHZZ');
  else dt = DateTime.fromFormat(`${s}+08:00`, 'yyyyMMddHHmmssZZ');
  if (!dt?.isValid) return null;
  return dt;
}

function extractHourForecast(json) {
  const allForecastData = [];
  const currentTime = DateTime.now().setZone('Asia/Hong_Kong');
  let weather = 0;
  const list = json?.HourlyWeatherForecast ?? [];
  for (const f of list) {
    const hourRaw = f.ForecastHour;
    if (f.ForecastWeather != null) weather = f.ForecastWeather;
    const data = {
      hour: parseInt(String(hourRaw), 10),
      temperature: f.ForecastTemperature,
      humidity: f.ForecastRelativeHumidity,
      wind_direction: f.ForecastWindDirection,
      wind_speed: f.ForecastWindSpeed,
      weather,
    };
    const hourInDate = parseForecastHourToLuxon(String(hourRaw));
    if (!hourInDate) continue;
    const endRange = currentTime.plus({ milliseconds: MAX_HOURS_MS });
    if (hourInDate > currentTime && hourInDate <= endRange) allForecastData.push(data);
  }
  return { hourly: [...allForecastData].sort((a, b) => a.hour - b.hour) };
}

async function updateData(code) {
  // console.log(`Weather.Hour.Forecast - get ${code} hour data`);
  let json;
  try {
    json = await fetchJsonForCode(code);
  } catch (e) {
    console.error('hour_forecast_fetch', code, e);
    return;
  }

  const allHourForecast = extractHourForecast(json);
  const allDayForecast = extractDayForecast(json);

  const allData = { updated_at: parseLastModified(json.LastModified).toJSDate(),
    ...allHourForecast,
    ...allDayForecast,
  };

  const existing = await queryOne(`SELECT id FROM hour_forecasts WHERE code = $1`, [code]);
  if (!existing) {
    await query(`INSERT INTO hour_forecasts (code, data, created_at, updated_at) VALUES ($1,$2::jsonb,NOW(),NOW())`, [
      code,
      JSON.stringify(allData),
    ]);
    return;
  }
  await query(`UPDATE hour_forecasts SET data=$2::jsonb, updated_at=NOW() WHERE code=$1`, [
    code,
    JSON.stringify(allData),
  ]);
}

export async function runHourForecastUpdater() {
  console.log(`Weather.Hour.Forecast - start`);
  for (const code of ALL) await updateData(code);
  console.log(`Weather.Hour.Forecast - end`);
}
