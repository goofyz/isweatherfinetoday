import { DateTime } from 'luxon';
import { query, queryOne } from '../db.js';
import { getJson } from '../request-helper.js';
import { handleTemperature, handleWindDirection } from './weather-station-updater.js';
import logger from '../logger.js';

const HK = 'Asia/Hong_Kong';

function decodeWindDirection(wd) {
  if (wd === null || wd === undefined || wd === '') return '';
  const n = typeof wd === 'number' ? wd : parseInt(String(wd), 10);
  if (Number.isNaN(n)) return '';
  return ((((360 / 16) * n) % 360) + 360) % 360;
}

export async function runCommunityStationUpdater() {
  logger.info('Community.Station - start');
  const t = DateTime.now().setZone('Asia/Hong_Kong').toFormat("yyyy-MM-dd'T'HH:mm:00");
  const url = `https://cowin.hku.hk/API/data/CoWIN/map?time=${encodeURIComponent(t)}`;
  const json = await getJson(url);

  for (const station of json) {
    const code = `co_${station.station}`;
    let ws = await queryOne('SELECT id FROM weather_stations WHERE code = $1', [code]);

    if (!ws) {
      logger.info(`ERROR: invalid weather station code: ${station.station}`);
      const ins = await queryOne(
        `INSERT INTO weather_stations (code, chi_name, eng_name, chi_name_abbr, eng_name_abbr, lat, lng,
          station_operator, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW()) RETURNING id`,
        [
          code,
          station.mc_name,
          station.me_name,
          station.mc_name,
          station.me_name,
          station.lat,
          station.lon,
          'cowin',
        ],
      );
      ws = ins;
      logger.info(`createing Community Station ${station.station}`);
    }

    let sd = await queryOne(
      'SELECT id FROM station_data WHERE weather_station_id = $1',
      [ws.id],
    );
    const updateTime = DateTime.fromISO(String(station.time), { zone: HK }).toFormat('HH:mm');
    const row = [
      handleWindDirection(station.wd),
      Math.round(handleWindDirection(station.ws)),
      handleTemperature(station.temp),
      handleTemperature(station.rh),
      handleTemperature(station.maxt),
      handleTemperature(station.mint),
      updateTime,
    ];
    if (!sd) {
      await query(
        `INSERT INTO station_data (weather_station_id, wind_direction, wind_speed, temperature,
          humidity, max_temp, min_temp, update_time, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())`,
        [ws.id, ...row],
      );
    } else {
      await query(
        `UPDATE station_data SET wind_direction=$1, wind_speed=$2, temperature=$3, humidity=$4,
          max_temp=$5, min_temp=$6, update_time=$7, updated_at=NOW() WHERE id=$8`,
        [...row, sd.id],
      );
    }
  }
  logger.info('Community.Station - end');
}
