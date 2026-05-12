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

process.env.TZ = process.env.TZ || 'Asia/Hong_Kong';

function wrap(name, fn) {
  return async () => {
    try {
      await fn();
    } catch (e) {
      console.error(`[scheduler] ${name}`, e);
    }
  };
}

cron.schedule('* * * * *', wrap('gcm', sendGcmImmediate));
cron.schedule('* * * * *', wrap('warnings', runOneWarningUpdater));
cron.schedule('* * * * *', wrap('special_tips', runSpecialWeatherTipUpdater));

cron.schedule('*/2 * * * *', wrap('weather_stations', runWeatherStationUpdater));
cron.schedule('*/2 * * * *', wrap('community_stations', runCommunityStationUpdater));

cron.schedule('*/10 * * * *', wrap('one_updater', runOneUpdater));

cron.schedule('*/12 * * * *', wrap('aqhi', runAqhiUpdater));
cron.schedule('*/12 * * * *', wrap('heat_index', runHeatIndexUpdater));

cron.schedule('*/1 * * * *', wrap('hour_forecast', runHourForecastUpdater));

cron.schedule('*/30 * * * *', wrap('weather_forecast', runWeatherForecastUpdater));

cron.schedule('11 * * * *', wrap('weather_forecast_11', runWeatherForecastUpdater));

for (const m of [1, 2, 4, 6, 8, 11]) {
  cron.schedule(`${m} 0 * * *`, wrap(`midnight_bundle_${m}`, async () => {
    await runOneUpdater();
    await runWeatherForecastUpdater();
  }));
}

cron.schedule('0 3 * * *', wrap('flickr', runFlickrPhotoUpdater));

console.log('[scheduler] Clock started (TZ=%s)', process.env.TZ);
