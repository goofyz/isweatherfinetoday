import { parse } from 'csv-parse/sync';
import { queryOne } from '../db.js';
import { REGEX_STATION_DATA_TIME } from '../locales.js';
import { getResponse } from '../request-helper.js';
import logger from '../logger.js';
import { setStationData } from '../redis-client.js';

function isNumber(string) {
  return !Number.isNaN(parseFloat(string));
}

export function handleTemperature(temp) {
  if (temp == null || String(temp).trim() === '') return null;
  const formatted = String(temp).replace(/\*/g, '');
  if (isNumber(formatted)) return formatted;
  return -99.9;
}
export function handleWindDirection(wd) {
  if (wd == null || String(wd).trim() === '') return null;
  const formatted = String(wd).replace(/\*/g, '');
  if (isNumber(formatted)) return formatted;
  return 0;
}

export async function runWeatherStationUpdater() {
  logger.info('Weather.Station - start');
  const res = await getResponse(
    'https://www.hko.gov.hk/wxinfo/awsgis/latestReadings_AWS1_v2.txt',
  );
  const lines = res.body.split(/\r?\n/);
  const headerLine = lines[0] || '';
  const m = headerLine.match(REGEX_STATION_DATA_TIME);
  const update_time = m?.groups?.time ?? '';

  const csvText = lines.slice(1).join('\n');
  const rows = parse(csvText, { columns: true, skip_empty_lines: true, relax_column_count: true });

  logger.info('get station data');
  for (const hash_data of rows) {
    const stn = hash_data.STN ?? hash_data.stn;
    if (stn == null) continue;
    const code = String(stn).toLowerCase();
    const ws = await queryOne('SELECT id FROM weather_stations WHERE code = $1', [code]);
    if (!ws) {
      logger.info(`ERROR: invalid weather station code: ${code}`);
      continue;
    }
    const fields = {
      wind_direction: handleWindDirection(hash_data.WINDDIRECTION || hash_data.winddirection),
      wind_speed: handleWindDirection(hash_data.WINDSPEED ?? hash_data.windspeed),
      temperature: handleTemperature(hash_data.TEMP ?? hash_data.temp),
      humidity: Math.round(handleTemperature(hash_data.RH ?? hash_data.rh)),
      max_temp: handleTemperature(hash_data.MAXTEMP ?? hash_data.maxtemp),
      min_temp: handleTemperature(hash_data.MINTEMP ?? hash_data.mintemp),
      update_time,
    };
    await setStationData(code, fields);
  }
  logger.info('end station data');
  logger.info('Weather.Station - end');
}
