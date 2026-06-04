export const enableJobTracking = process.env.ENABLE_JOB_TRACK === 'true';

export const jobTrackingUrls = {
  'gcm': process.env.TRACKING_URL_GCM ||  "https://hc-ping.com/vhqcnux6nao2xf3wy6nxfq/gcm" ,
  'warnings': process.env.TRACKING_URL_WARNINGS || "https://hc-ping.com/vhqcnux6nao2xf3wy6nxfq/warnings",
  'special_tips': process.env.TRACKING_URL_SPECIAL_TIPS || "https://hc-ping.com/vhqcnux6nao2xf3wy6nxfq/special_tips",
  'weather_stations': process.env.TRACKING_URL_WEATHER_STATIONS || "https://hc-ping.com/vhqcnux6nao2xf3wy6nxfq/weather_stations",
  'community_stations': process.env.TRACKING_URL_COMMUNITY_STATIONS || "https://hc-ping.com/vhqcnux6nao2xf3wy6nxfq/community_stations",
  'one_updater': process.env.TRACKING_URL_ONE_UPDATER || "https://hc-ping.com/vhqcnux6nao2xf3wy6nxfq/one_updater",
  'aqhi': process.env.TRACKING_URL_AQHI || "https://hc-ping.com/vhqcnux6nao2xf3wy6nxfq/aqhi",
  'heat_index': process.env.TRACKING_URL_HEAT_INDEX || "https://hc-ping.com/vhqcnux6nao2xf3wy6nxfq/heat_index",
  'hour_forecast': process.env.TRACKING_URL_HOUR_FORECAST || "https://hc-ping.com/vhqcnux6nao2xf3wy6nxfq/hour_forecast",
  'weather_forecast': process.env.TRACKING_URL_WEATHER_FORECAST || "https://hc-ping.com/vhqcnux6nao2xf3wy6nxfq/weather_forecast",
  'weather_forecast_11': process.env.TRACKING_URL_WEATHER_FORECAST_11 || "https://hc-ping.com/vhqcnux6nao2xf3wy6nxfq/weather_forecast_11",
  'flickr': process.env.TRACKING_URL_FLICKR || "https://hc-ping.com/vhqcnux6nao2xf3wy6nxfq/flickr",
  'midnight_bundle': process.env.TRACKING_URL_MIDNIGHT_BUNDLE || "https://hc-ping.com/vhqcnux6nao2xf3wy6nxfq/midnight_bundle",
};