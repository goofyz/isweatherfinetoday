import { parse } from 'csv-parse/sync';
import { query, queryOne } from '../db.js';
import { REGEX_STATION_DATA_TIME } from '../locales.js';
import { getResponse } from '../request-helper.js';

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
  console.log('Weather.Station - start');
  const res = await getResponse(
    'https://www.hko.gov.hk/wxinfo/awsgis/latestReadings_AWS1_v2.txt',
  );
  const lines = res.body.split(/\r?\n/);
  const headerLine = lines[0] || '';
  const m = headerLine.match(REGEX_STATION_DATA_TIME);
  const update_time = m?.groups?.time ?? '';

  const csvText = lines.slice(1).join('\n');
  const rows = parse(csvText, { columns: true, skip_empty_lines: true, relax_column_count: true });

  console.log('get station data');
  for (const hash_data of rows) {
    const stn = hash_data.STN ?? hash_data.stn;
    if (stn == null) continue;
    const code = String(stn).toLowerCase();
    const ws = await queryOne('SELECT id FROM weather_stations WHERE code = $1', [code]);
    if (!ws) {
      console.log(`ERROR: invalid weather station code: ${code}`);
      continue;
    }
    let sd = await queryOne(
      'SELECT id FROM station_data WHERE weather_station_id = $1',
      [ws.id],
    );
    const fields = {
      wind_direction: handleWindDirection(hash_data.WINDDIRECTION || hash_data.winddirection),
      wind_speed: handleWindDirection(hash_data.WINDSPEED ?? hash_data.windspeed),
      temperature: handleTemperature(hash_data.TEMP ?? hash_data.temp),
      humidity: Math.round(handleTemperature(hash_data.RH ?? hash_data.rh)),
      max_temp: handleTemperature(hash_data.MAXTEMP ?? hash_data.maxtemp),
      min_temp: handleTemperature(hash_data.MINTEMP ?? hash_data.mintemp),
      update_time,
    };
    if (!sd) {
      await query(
        `INSERT INTO station_data (weather_station_id, wind_direction, wind_speed, temperature,
          humidity, max_temp, min_temp, update_time, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())`,
        [
          ws.id,
          fields.wind_direction,
          fields.wind_speed,
          fields.temperature,
          fields.humidity,
          fields.max_temp,
          fields.min_temp,
          fields.update_time,
        ],
      );
    } else {
      await query(
        `UPDATE station_data SET wind_direction=$1, wind_speed=$2, temperature=$3, humidity=$4,
          max_temp=$5, min_temp=$6, update_time=$7, updated_at=NOW() WHERE id=$8`,
        [
          fields.wind_direction,
          fields.wind_speed,
          fields.temperature,
          fields.humidity,
          fields.max_temp,
          fields.min_temp,
          fields.update_time,
          sd.id,
        ],
      );
    }
  }
  console.log('end station data');
  console.log('Weather.Station - end');
}
