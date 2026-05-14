import { DateTime } from 'luxon';
import { query } from '../db.js';
import { getJson } from '../request-helper.js';
import logger from '../logger.js';

const HK = 'Asia/Hong_Kong';

const WARNING_ENG = 'http://pda.weather.gov.hk/locspc/android_data/fnd_e.xml';
const WARNING_CHI = 'http://pda.weather.gov.hk/locspc/android_data/fnd_uc.xml';

export async function runWeatherForecastUpdater() {
  logger.info('Weather.forecast - start');
  try {
    const eng_json = await getJson(WARNING_ENG);
    const chi_json = await getJson(WARNING_CHI);

    const forecasts = new Map();

    for (const data of eng_json?.forecast_detail ?? []) {
      const forecast_day = DateTime.fromFormat(String(data.forecast_date), 'yyyyMMdd', {
        zone: HK,
      }).toISODate();

      forecasts.set(forecast_day, {
        forecast_day,
        weather: data.wx_icon,
        min_temperature: data.min_temp,
        max_temperature: data.max_temp,
        min_humidity: data.min_rh,
        max_humidity: data.max_rh,
        eng_detail: data.wx_desc ?? null,
        eng_wind: data.wind_info ?? null,
        chi_detail: null,
        chi_wind: null,
        psr: data.psr_id ?? null,
      });
    }

    for (const data of chi_json?.forecast_detail ?? []) {
      const forecast_day = DateTime.fromFormat(String(data.forecast_date), 'yyyyMMdd', {
        zone: HK,
      }).toISODate();
      const prev = forecasts.get(forecast_day);
      if (!prev) continue;
      prev.chi_detail = data.wx_desc ?? null;
      prev.chi_wind = data.wind_info ?? null;
    }

    const chiForecastGeneral = chi_json?.general_situation ?? null;
    const engForecastGeneral = eng_json?.general_situation ?? null;

    const hkToday = DateTime.now().setZone('Asia/Hong_Kong').toISODate();

    for (const f of forecasts.values()) {
      const merged = {};
      merged.weather = f.weather;
      merged.min_temperature = f.min_temperature;
      merged.max_temperature = f.max_temperature;
      merged.min_humidity = f.min_humidity;
      merged.max_humidity = f.max_humidity;
      merged.psr = f.psr;
      if (f.eng_detail != null) merged.eng_detail = f.eng_detail;
      if (f.chi_detail != null) merged.chi_detail = f.chi_detail;
      if (f.eng_wind != null) merged.eng_wind = f.eng_wind;
      if (f.chi_wind != null) merged.chi_wind = f.chi_wind;

      await query(
        `INSERT INTO forecasts (forecast_day, weather, max_temperature, min_temperature, max_humidity,
          min_humidity, chi_detail, eng_detail, chi_wind, eng_wind, psr, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())
         ON CONFLICT (forecast_day) DO UPDATE SET
         weather = $2,
         min_temperature = $4,
         max_temperature = $3,
         min_humidity = $6,
         max_humidity = $5,
         psr = $11,
         eng_detail = COALESCE(EXCLUDED.eng_detail, forecasts.eng_detail),
         chi_detail = COALESCE(EXCLUDED.chi_detail, forecasts.chi_detail),
         eng_wind = COALESCE(EXCLUDED.eng_wind, forecasts.eng_wind),
         chi_wind = COALESCE(EXCLUDED.chi_wind, forecasts.chi_wind),
         updated_at = NOW()`,
        [
          f.forecast_day,
          merged.weather,
          merged.max_temperature,
          merged.min_temperature,
          merged.max_humidity,
          merged.min_humidity,
          merged.chi_detail ?? null,
          merged.eng_detail ?? null,
          merged.chi_wind ?? null,
          merged.eng_wind ?? null,
          merged.psr,
        ],
      );

      await query(
        `UPDATE todays SET eng_forecast_general=$1, chi_forecast_general=$2, updated_at=NOW()
         WHERE forecast_day=$3`,
        [engForecastGeneral, chiForecastGeneral, hkToday],
      );
    }
  } catch (e) {
    // do nothing
    logger.info('Weather.forecast - error fetching/parsing forecast', e);
  }
  logger.info('Weather.forecast - end');
}
