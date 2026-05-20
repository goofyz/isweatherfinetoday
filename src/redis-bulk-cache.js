import { REDIS_CACHE_TTL_SECONDS } from './config.js';
import {
  getAllAqhiStationData,
  getAllAqhiStations,
  getAllFlickrPhotos,
  getAllStationData,
  getAllWeatherStations,
} from './redis-client.js';

const TTL_MS = () => REDIS_CACHE_TTL_SECONDS * 1000;

function isFresh(entry) {
  return entry?.at && Date.now() - entry.at < TTL_MS();
}

let weatherBulk = { at: 0, stationsMap: null, dataMap: null };
let aqhiBulk = { at: 0, stationsMap: null, dataMap: null };
let flickrBulk = { at: 0, photosMap: null };

export async function getCachedWeatherStationsAndData() {
  if (isFresh(weatherBulk) && weatherBulk.stationsMap && weatherBulk.dataMap) {
    return { stationsMap: weatherBulk.stationsMap, dataMap: weatherBulk.dataMap };
  }
  const [stationsMap, dataMap] = await Promise.all([
    getAllWeatherStations(),
    getAllStationData(),
  ]);
  weatherBulk = { at: Date.now(), stationsMap, dataMap };
  return { stationsMap, dataMap };
}

export async function getCachedAqhiStationsAndData() {
  if (isFresh(aqhiBulk) && aqhiBulk.stationsMap && aqhiBulk.dataMap) {
    return { stationsMap: aqhiBulk.stationsMap, dataMap: aqhiBulk.dataMap };
  }
  const [stationsMap, dataMap] = await Promise.all([
    getAllAqhiStations(),
    getAllAqhiStationData(),
  ]);
  aqhiBulk = { at: Date.now(), stationsMap, dataMap };
  return { stationsMap, dataMap };
}

export async function getCachedFlickrPhotos() {
  if (isFresh(flickrBulk) && flickrBulk.photosMap) {
    return flickrBulk.photosMap;
  }
  const photosMap = await getAllFlickrPhotos();
  flickrBulk = { at: Date.now(), photosMap };
  return photosMap;
}
