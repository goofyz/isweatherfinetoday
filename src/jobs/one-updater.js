import { DateTime } from 'luxon';
import { query, queryOne } from '../db.js';
import { getJson } from '../request-helper.js';
import { htmlText, squish } from './html-utils.js';

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
  await query(
    `INSERT INTO typhoons (typhoon_type, eng_name, chi_name, hko_id, created_at, updated_at, data_type)
     VALUES (NULL,$1,$2,$3,NOW(),NOW(),$4)
     ON CONFLICT (hko_id) DO UPDATE SET
       chi_name = EXCLUDED.chi_name,
       eng_name = EXCLUDED.eng_name,
       data_type = EXCLUDED.data_type,
       updated_at = NOW()`,
    [engName, chiName, hkoId, dataType],
  );
}

async function getTyphoonIdString() {
  const typhoonNameDoc = await getJson('https://www.hko.gov.hk/wxinfo/json/tcFront.json');
  const id = [];
  const tcList = typhoonNameDoc?.TC ?? [];
  if (!Array.isArray(tcList) || tcList.length === 0) return '';

  for (const typhoon_match of tcList) {
    console.log(`Has typhoon - ${typhoon_match.enName}`);
    id.push(String(typhoon_match.tcId));

    const existing = await queryOne('SELECT id, eng_name, chi_name, data_type FROM typhoons WHERE hko_id = $1', [
      typhoon_match.tcId,
    ]);
    await upsertTyphoonFromTc(typhoon_match);
    if (!existing) console.log(`Insert typhoon - ${typhoon_match.enName}`);
  }
  return id.join(',');
}

export async function runOneUpdater() {
  console.log('OneUpdater - start');
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
  let today = await queryOne('SELECT * FROM todays WHERE forecast_day = $1', [hkToday]);

  if (!today) {
    const yesterday = await queryOne('SELECT * FROM todays ORDER BY forecast_day DESC LIMIT 1');
    const y = yesterday || {};
    await query(
      `INSERT INTO todays (forecast_day, aqhi_current, chi_aqhi_forecast, eng_aqhi_forecast, aqhi_update_time,
        created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW(),NOW())`,
      [
        hkToday,
        y.aqhi_current ?? null,
        y.chi_aqhi_forecast ?? null,
        y.eng_aqhi_forecast ?? null,
        y.aqhi_update_time ?? null,
      ],
    );
    today = await queryOne('SELECT * FROM todays WHERE forecast_day = $1', [hkToday]);
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
        ? astronomical_update_time
        : null,
  };

  const merged = { ...todayData, ...detailBlock, ...moreData };

  await query(
    `UPDATE todays SET
      weather=$1, temperature=$2, humidity=$3, uv=$4, uv_level=$5, update_time=$6, typhoon_id=$7,
      chi_detail=$8, eng_detail=$9, eng_forecast_general=$10, chi_forecast_general=$11,
      sun_rise_time=$12, sun_set_time=$13, moon_rise_time=$14, moon_set_time=$15, tide_info=$16,
      astronomical_update_time=$17, updated_at=NOW()
     WHERE forecast_day=$18`,
    [
      merged.weather ?? null,
      merged.temperature ?? null,
      merged.humidity ?? null,
      merged.uv ?? null,
      merged.uv_level ?? null,
      merged.update_time ?? null,
      merged.typhoon_id || null,
      merged.chi_detail ?? null,
      merged.eng_detail ?? null,
      merged.eng_forecast_general ?? null,
      merged.chi_forecast_general ?? null,
      merged.sun_rise_time ?? null,
      merged.sun_set_time ?? null,
      merged.moon_rise_time ?? null,
      merged.moon_set_time ?? null,
      merged.tide_info ?? null,
      merged.astronomical_update_time,
      hkToday,
    ],
  );

  console.log('OneUpdater - End');
}
