import { DateTime } from 'luxon';
import { getJson } from '../request-helper.js';
import { handleTemperature, handleWindDirection } from './weather-station-updater.js';
import logger from '../logger.js';
import { getWeatherStation, setStationData, setWeatherStation, deleteCacheByPattern } from '../redis-client.js';

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
    let ws = await getWeatherStation(code);

    if (!ws) {
      logger.info(`ERROR: invalid weather station code: ${station.station}`);
      ws = await setWeatherStation({
        code,
        chi_name: station.mc_name,
        eng_name: station.me_name,
        chi_name_abbr: station.mc_name,
        eng_name_abbr: station.me_name,
        lat: station.lat,
        lng: station.lon,
        station_operator: 'cowin',
        is_forecast: false,
      });
      logger.info(`createing Community Station ${station.station}`);
    }

    const updateTime = DateTime.fromISO(String(station.time), { zone: HK }).toFormat('HH:mm');
    await setStationData(code, {
      wind_direction: handleWindDirection(station.wd),
      wind_speed: Math.round(handleWindDirection(station.ws)),
      temperature: handleTemperature(station.temp),
      humidity: handleTemperature(station.rh),
      max_temp: handleTemperature(station.maxt),
      min_temp: handleTemperature(station.mint),
      update_time: updateTime,
    });
  }
  await deleteCacheByPattern('api:weathers*');
  await deleteCacheByPattern('api:station_data*');
  logger.info('Community.Station - end');
}
