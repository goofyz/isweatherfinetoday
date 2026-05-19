import { DateTime } from 'luxon';
import { getJson } from '../request-helper.js';
import logger from '../logger.js';
import { mergeForecast, mergeToday } from '../redis-client.js';

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
      const patch = {
        forecast_day: f.forecast_day,
        weather: f.weather,
        min_temperature: f.min_temperature,
        max_temperature: f.max_temperature,
        min_humidity: f.min_humidity,
        max_humidity: f.max_humidity,
        psr: f.psr,
      };
      if (f.eng_detail != null) patch.eng_detail = f.eng_detail;
      if (f.chi_detail != null) patch.chi_detail = f.chi_detail;
      if (f.eng_wind != null) patch.eng_wind = f.eng_wind;
      if (f.chi_wind != null) patch.chi_wind = f.chi_wind;

      await mergeForecast(f.forecast_day, patch);

      await mergeToday({
        forecast_day: hkToday,
        eng_forecast_general: engForecastGeneral,
        chi_forecast_general: chiForecastGeneral,
      });
    }
  } catch (e) {
    // do nothing
    logger.info('Weather.forecast - error fetching/parsing forecast', e);
  }
  logger.info('Weather.forecast - end');
}
