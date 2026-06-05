import cron from 'node-cron';

import { runAqhiUpdater } from './jobs/aqhi-updater.js';
import { runCommunityStationUpdater } from './jobs/community-station-updater.js';
import { runFlickrPhotoUpdater } from './jobs/flickr-photo-updater.js';
import { runHeatIndexUpdater } from './jobs/heat-index-updater.js';
import { runHourForecastUpdater } from './jobs/hour-forecast-updater.js';
import { runOneUpdater } from './jobs/one-updater.js';
import { runOneWarningUpdater } from './jobs/one-warning-updater.js';
import { sendGcmImmediate } from './jobs/gcm-sender.js';
import { runSpecialWeatherTipUpdater } from './jobs/special-weather-tip-updater.js';
import { runWeatherForecastUpdater } from './jobs/weather-forecast-updater.js';
import { runWeatherStationUpdater } from './jobs/weather-station-updater.js';
import logger from './logger.js';
import { enableJobTracking, jobTrackingUrls } from './job-tracking-config.js';

process.env.TZ = process.env.TZ || 'Asia/Hong_Kong';

async function trackEvent(url, event) {
  if (!enableJobTracking || !url) return;
  try {
    await fetch(`${url}${event}`);
  } catch (e) {
    logger.warn(e, `[scheduler] Failed to track event: ${url}${event}`);
  }
}

function wrap(name, fn) {
  return async () => {
    const url = jobTrackingUrls[name];
    try {
      await trackEvent(url, '/start');
      await fn();
      await trackEvent(url, '');  // success - no suffix
    } catch (e) {
      // await trackEvent(url, '/fail');
      logger.error(e, `[scheduler] ${name}`);
    }
  };
}

cron.schedule('* * * * *', wrap('gcm', sendGcmImmediate));
cron.schedule('* * * * *', wrap('warnings', runOneWarningUpdater));
cron.schedule('* * * * *', wrap('special_tips', runSpecialWeatherTipUpdater));

cron.schedule('*/2 * * * *', wrap('weather_stations', runWeatherStationUpdater));
cron.schedule('*/3 * * * *', wrap('community_stations', runCommunityStationUpdater));

cron.schedule('*/10 * * * *', wrap('one_updater', runOneUpdater));

cron.schedule('*/12 * * * *', wrap('aqhi', runAqhiUpdater));
cron.schedule('*/13 * * * *', wrap('heat_index', runHeatIndexUpdater));

cron.schedule('*/20 * * * *', wrap('hour_forecast', runHourForecastUpdater));

cron.schedule('*/30 * * * *', wrap('weather_forecast', runWeatherForecastUpdater));

cron.schedule('10 11 * * *', wrap('weather_forecast_11', runWeatherForecastUpdater));

for (const m of [1, 2, 4, 6, 8, 11]) {
  cron.schedule(`${m} 0 * * *`, wrap(`midnight_bundle_${m}`, async () => {
    await runOneUpdater();
    await runWeatherForecastUpdater();
  }));
}

cron.schedule('0 3 * * *', wrap('flickr', runFlickrPhotoUpdater));

logger.info('[scheduler] Clock started (TZ=%s)', process.env.TZ);

const startupTasks = [
  ['one_updater', runOneUpdater],
  ['warnings', runOneWarningUpdater],
  ['special_tips', runSpecialWeatherTipUpdater],
  ['weather_stations', runWeatherStationUpdater],
  ['community_stations', runCommunityStationUpdater],
  ['weather_forecast', runWeatherForecastUpdater],
  ['aqhi', runAqhiUpdater],
  ['heat_index', runHeatIndexUpdater],
  ['hour_forecast', runHourForecastUpdater],
  ['gcm', sendGcmImmediate],
  ['flickr', runFlickrPhotoUpdater],
];

(async () => {
  logger.info('[scheduler] Running initial sequential updates');
  for (const [name, fn] of startupTasks) {
    await wrap(name, fn)();
  }
  logger.info('[scheduler] Initial sequential updates complete');
})();
