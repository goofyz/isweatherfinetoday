import express from 'express';

import devicesRouter from './v1/devices.js';
import stationDataRouter from './v1/station_data.js';
import weatherStationsRouter from './v1/weather_stations.js';
import hourForecastRouter from './v1/hour_forecast.js';
import aqhiStationsRouter from './v1/aqhi_stations.js';
import weathersRouter from './v1/weathers.js';
import cacheStatsRouter from './v1/cache_stats.js';

const router = express.Router();
router.use(express.json({ limit: '2mb' }));
router.use(express.urlencoded({ extended: true }));

router.use('/devices', devicesRouter);
router.use('/station_data.json', stationDataRouter);
router.use('/weather_stations.json', weatherStationsRouter);
router.use('/hour_forecast.json', hourForecastRouter);
router.use('/aqhi_stations.json', aqhiStationsRouter);
router.use('/weathers.json', weathersRouter);
router.use('/cache-stats', cacheStatsRouter);

export default router;
