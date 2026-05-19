import { DateTime } from 'luxon';
import { getJson } from '../request-helper.js';
import { htmlText, squish } from './html-utils.js';
import logger from '../logger.js';
import { getToday, mergeToday, getTyphoon, setTyphoon } from '../redis-client.js';

const HK = 'Asia/Hong_Kong';

function typhoonType(type) {
  if (type === 'F3') return 'PB';
  if (type === 'F4') return 'TR';
  return 'TR_PB';
}

function extractTodayDetail(json) {
  const flw = json.FLW ?? {};
  const line1 = htmlText(flw.GeneralSituation);
  const line2 = htmlText(flw.TCInfo);
  let detail = line1;
  detail += line1 === '' ? '' : '\n\n';
  detail += line2;
  detail += line2 === '' ? '' : '\n\n';
  detail += `${flw.ForecastPeriod}:\n${htmlText(flw.ForecastDesc)}\n\n${flw.OutlookTitle}:\n${htmlText(flw.OutlookContent)}`;
  return (detail);
}

async function upsertTyphoonFromTc(typhoon_match) {
  const dataType = typhoonType(typhoon_match.datatype ?? typhoon_match.dataType);
  const hkoId = typhoon_match.tcId;
  const chiName = typhoon_match.tcName;
  const raw = typhoon_match.enName ?? '';
  const engName = raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : '';
  await setTyphoon(hkoId, {
    hko_id: hkoId,
    typhoon_type: null,
    eng_name: engName,
    chi_name: chiName,
    data_type: dataType,
  });
}

async function getTyphoonIdString() {
  const typhoonNameDoc = await getJson('https://www.hko.gov.hk/wxinfo/json/tcFront.json');
  const id = [];
  const tcList = typhoonNameDoc?.TC ?? [];
  if (!Array.isArray(tcList) || tcList.length === 0) return '';

  for (const typhoon_match of tcList) {
    logger.info(`Has typhoon - ${typhoon_match.enName}`);
    id.push(String(typhoon_match.tcId));

    const existing = await getTyphoon(typhoon_match.tcId);
    await upsertTyphoonFromTc(typhoon_match);
    if (!existing) logger.info(`Insert typhoon - ${typhoon_match.enName}`);
  }
  return id.join(',');
}

export async function runOneUpdater() {
  logger.info('OneUpdater - start');
  const eng_json = await getJson('https://www.weather.gov.hk/wxinfo/json/one_json.xml');
  const chi_json = await getJson('https://www.weather.gov.hk/wxinfo/json/one_json_uc.xml');

  const todayData = {
    weather: eng_json?.fcartoon?.Icon1,
    temperature: eng_json?.RHRREAD?.hkotemp,
    humidity: eng_json?.RHRREAD?.hkorh,
    uv: eng_json?.RHRREAD?.UVIndex,
    uv_level: eng_json?.RHRREAD?.Intensity,
    update_time: eng_json?.RHRREAD?.FormattedObsTime,
    typhoon_id: await getTyphoonIdString(),
  };

  const detailBlock = {
    chi_detail: extractTodayDetail(chi_json),
    eng_detail: extractTodayDetail(eng_json),
    eng_forecast_general: eng_json?.F9D?.GeneralSituation ?? null,
    chi_forecast_general: chi_json?.F9D?.GeneralSituation ?? null,
  };

  const hkToday = DateTime.now().setZone('Asia/Hong_Kong').toISODate();
  const existing = (await getToday()) ?? {};
  if (existing.forecast_day !== hkToday) {
    await mergeToday({
      forecast_day: hkToday,
      weather: null,
      temperature: null,
      humidity: null,
      uv: null,
      uv_level: null,
      update_time: null,
      typhoon_id: null,
      chi_detail: null,
      eng_detail: null,
      eng_forecast_general: null,
      chi_forecast_general: null,
      sun_rise_time: null,
      sun_set_time: null,
      moon_rise_time: null,
      moon_set_time: null,
      tide_info: null,
      astronomical_update_time: null,
      aqhi_current: existing.aqhi_current ?? null,
      chi_aqhi_forecast: existing.chi_aqhi_forecast ?? null,
      eng_aqhi_forecast: existing.eng_aqhi_forecast ?? null,
      aqhi_update_time: existing.aqhi_update_time ?? null,
    });
  }

  const cmn = eng_json?.CMN;
  let tide_raw_data = [];
  if (cmn?.tide && Array.isArray(cmn.tide)) {
    tide_raw_data = cmn.tide.map((tide) => `${tide.type[0]}|${tide.time}|${tide.height}m`);
  }
  const astronomical_update_time = DateTime.fromFormat(String(cmn?.GregorianDate ?? ''), 'yyyyMMdd', {
    zone: HK,
  }).toJSDate();

  const moreData = {
    sun_rise_time: cmn?.sunriseTime,
    sun_set_time: cmn?.sunsetTime,
    moon_rise_time: cmn?.moonriseTime,
    moon_set_time: cmn?.moonsetTime,
    tide_info: tide_raw_data.join(','),
    astronomical_update_time:
      astronomical_update_time && !Number.isNaN(astronomical_update_time.getTime())
        ? astronomical_update_time.toISOString()
        : null,
  };

  const merged = { ...todayData, ...detailBlock, ...moreData };

  await mergeToday({
    forecast_day: hkToday,
    weather: merged.weather ?? null,
    temperature: merged.temperature ?? null,
    humidity: merged.humidity ?? null,
    uv: merged.uv ?? null,
    uv_level: merged.uv_level ?? null,
    update_time: merged.update_time ?? null,
    typhoon_id: merged.typhoon_id || null,
    chi_detail: merged.chi_detail ?? null,
    eng_detail: merged.eng_detail ?? null,
    eng_forecast_general: merged.eng_forecast_general ?? null,
    chi_forecast_general: merged.chi_forecast_general ?? null,
    sun_rise_time: merged.sun_rise_time ?? null,
    sun_set_time: merged.sun_set_time ?? null,
    moon_rise_time: merged.moon_rise_time ?? null,
    moon_set_time: merged.moon_set_time ?? null,
    tide_info: merged.tide_info ?? null,
    astronomical_update_time: merged.astronomical_update_time ?? null,
  });

  logger.info('OneUpdater - End');
}
