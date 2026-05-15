import { createHash } from 'crypto';
import express from 'express';
import { DateTime } from 'luxon';

import { DEVICE_SECRET_KEY, ENABLE_API_LOGGING, ENABLE_FLICKR_PHOTO } from '../config.js';
import { flickrTagsByHour, flickrTagsByWeather } from '../flickr-tags.js';
import { distanceKm, pointInPeakPolygon } from '../geo.js';
import { isEng, naturalNumber, omitNil, truncate, warningSortOrder, toDateStr } from '../helpers.js';
import { FLICKR_DOWN } from '../locales.js';
import { query, queryOne } from '../db.js';
import logger from '../logger.js';
import { getCache, setCache } from '../redis-client.js';

const HK = 'Asia/Hong_Kong';

const router = express.Router();
router.use(express.json({ limit: '2mb' }));
router.use(express.urlencoded({ extended: true }));

function sha1Hex(s) {
  return createHash('sha1').update(s).digest('hex');
}

async function fromCacheOrFetch(cacheKey, fetcher) {
  const cached = await getCache(cacheKey);
  if (cached) return cached;
  const payload = await fetcher();
  await setCache(cacheKey, payload);
  return payload;
}

async function queryStationJoined(codeLc) {
  return queryOne(
    `SELECT
      ws.id AS ws_id, ws.code, ws.chi_name, ws.eng_name, ws.lat, ws.lng, ws.wind_lat, ws.wind_lng,
      ws.webcam_angle, ws.chi_name_abbr, ws.eng_name_abbr, ws.station_operator, ws.photo_code,
      ws.is_forecast,
      sd.id AS sd_id, sd.wind_direction, sd.wind_speed, sd.temperature, sd.max_temp, sd.min_temp,
      sd.humidity, sd.update_time AS sd_update_time, sd.updated_at AS sd_updated_at
     FROM weather_stations ws
     LEFT JOIN station_data sd ON sd.weather_station_id = ws.id
     WHERE lower(ws.code) = lower($1)`,
    [codeLc],
  );
}

async function findNearestWeatherStation(lat, lng, operator) {
  const params = [];
  let filt = '';
  if (operator === 'all') filt = '';
  else if (!operator || operator === '') filt = 'AND ws.station_operator IS NULL';
  else {
    filt = `AND ws.station_operator = $${params.length + 1}`;
    params.push(operator);
  }

  const sql = `
    SELECT ws.id AS ws_id, ws.code, ws.chi_name, ws.eng_name, ws.lat, ws.lng,
      ws.wind_lat, ws.wind_lng, ws.webcam_angle, ws.chi_name_abbr, ws.eng_name_abbr,
      ws.station_operator, ws.photo_code, ws.is_forecast,
      sd.id AS sd_id, sd.wind_direction, sd.wind_speed, sd.temperature,
      sd.max_temp, sd.min_temp, sd.humidity,
      sd.update_time AS sd_update_time, sd.updated_at AS sd_updated_at
    FROM weather_stations ws
    INNER JOIN station_data sd ON sd.weather_station_id = ws.id
    WHERE 1=1 ${filt}
  `;
  const rows = await query(sql, params);

  rows.sort(
    (a, b) =>
      distanceKm(lat, lng, Number(a.lat), Number(a.lng)) -
      distanceKm(lat, lng, Number(b.lat), Number(b.lng)),
  );

  const nowMs = Date.now();
  for (const r of rows) {
    if (!r.sd_updated_at) continue;
    if (new Date(r.sd_updated_at).getTime() + 3 * 3600 * 1000 > nowMs) continue;
    if (String(r.code).toLowerCase() === 'vp1') {
      if (pointInPeakPolygon(lat, lng)) return r;
      continue;
    }
    const t = r.temperature;
    if (t === null || t === undefined) continue;
    const tempNum = Number(t);
    if (Number.isNaN(tempNum) || Math.abs(tempNum + 99.9) < 0.001) continue;
    return r;
  }
  return null;
}

async function findWeatherStation(lat, lng, station_code, operator) {
  if (!station_code || String(station_code).trim() === '') return findNearestWeatherStation(lat, lng, operator);

  let row = await queryStationJoined(String(station_code).trim().toLowerCase());
  if (!row) row = await queryStationJoined('hko');
  if (!row) return findNearestWeatherStation(lat, lng, operator);

  const tempNum = row.temperature == null ? NaN : Number(row.temperature);
  if (
    row.sd_updated_at == null
    || row.temperature == null
    || Number.isNaN(tempNum)
    || Math.abs(tempNum + 99.9) < 0.001
  ) {
    return findNearestWeatherStation(Number(row.lat), Number(row.lng), operator);
  }
  lat = Number(row.lat);
  lng = Number(row.lng);
  return row;
}

async function findNearestAqhi(lat, lng) {
  const rows = await query(`SELECT * FROM aqhi_stations`);
  rows.sort(
    (a, b) =>
      distanceKm(lat, lng, Number(a.lat), Number(a.lng)) -
      distanceKm(lat, lng, Number(b.lat), Number(b.lng)),
  );

  const isNumericIndex = (ix) =>
    ix != null && ix !== '' && /^\d+\+?$/.test(String(ix).trim());

  for (const st of rows) {
    if (!st.update_time) continue;
    if (!isNumericIndex(st.aqhi_index)) continue;
    return st;
  }
  for (const st of rows) {
    if (st.update_time) return st;
  }
  return null;
}

async function flickrPhotosForWeather(weather, hourHK) {
  const timeTags = flickrTagsByHour(hourHK);
  const wt = flickrTagsByWeather(weather);
  const combo = [...new Set([...timeTags, ...wt])];

  async function unionQuery(tagsArr) {
    if (!tagsArr.length) return [];
    return query(
      `SELECT id, photo_id, owner_name, owner_url, mid_res_url, high_res_url
       FROM flickr_photos WHERE tags && $1::text[]`,
      [tagsArr],
    );
  }

  let rows = await unionQuery(combo);
  if ((rows?.length ?? 0) < 3) rows = await unionQuery(timeTags);
  return rows;
}

function pickForecastDetail(f, lang) {
  return isEng(lang) ? f.eng_detail : f.chi_detail;
}

function pickForecastWind(f, lang) {
  return isEng(lang) ? f.eng_wind : f.chi_wind;
}

function buildForecastNode(f, lang) {
  return omitNil({
    day: toDateStr(f.forecast_day),
    max_temp: f.max_temperature,
    min_temp: f.min_temperature,
    weather: f.weather,
    max_humidity: f.max_humidity,
    min_humidity: f.min_humidity,
    psr: f.psr,
    detail: pickForecastDetail(f, lang),
    wind: pickForecastWind(f, lang),
  });
}

function buildWarningNode(w, lang) {
  return omitNil({
    warning_type: w.warning_type,
    time: w.time instanceof Date ? w.time.toISOString() : w.time,
    detail: isEng(lang) ? w.eng_detail : w.chi_detail,
  });
}

router.post('/devices', async (req, res) => {
  const device = req.body.device ?? {};
  const pattern = `lat=${device.reg_id ?? ''}, lng=${device.type ?? ''}, v=${device.app_version ?? ''}, key=${DEVICE_SECRET_KEY}, time=${req.body.t ?? ''}`;
  const hash = sha1Hex(pattern);
  const t = Number(req.body.t ?? 0);
  const submitRequestDate = new Date(t * 1000);

  let message = '';

  let success = false;
  const is_correct_request =
    submitRequestDate.getTime() + 60 * 1000 > Date.now() &&
    typeof req.body.hash === 'string' &&
    hash.localeCompare(req.body.hash, undefined, { sensitivity: 'accent' }) === 0;

  try {
    let row = await queryOne(`SELECT * FROM devices WHERE reg_id=$1`, [device.reg_id]);
    const remoteIp =
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ??
      req.socket.remoteAddress ??
      '';

    if (!row) {
      await query(
        `INSERT INTO devices (reg_id, os_type, app_version, lang, ip_address, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'A',NOW(),NOW())`,
        [
          device.reg_id,
          String(device.os_type ?? ''),
          Number(device.app_version),
          device.lang,
          remoteIp,
        ],
      );
    } else {
      await query(
        `UPDATE devices SET ip_address=$1, os_type=$2, app_version=$3, lang=$4,
          status='A', updated_at=NOW() WHERE id=$5`,
        [remoteIp, String(device.os_type ?? ''), Number(device.app_version), device.lang, row.id],
      );
    }

    success = true;
    if (!is_correct_request && ENABLE_API_LOGGING) {
      // intentionally empty in Rails implementation
    }
  } catch (e) {
    success = false;
    message = 'error in saving devices';
    logger.error(e);
  }

  res.json({ success, info: message });
});

router.post('/station_data.json', async (req, res) => {
  const operator =
    req.body.operator ??
    req.query.operator;

  const cacheKey = `api:station_data:${operator ?? 'null'}`;
  const cached = await getCache(cacheKey);
  if (cached) return res.json(cached);

  let rows;
  logger.info(`operator filter: ${operator}`);

  try {
    if (!operator || operator === '') {
      rows = await query(
        `SELECT ws.code AS code,
           sd.wind_direction, sd.wind_speed, sd.temperature,
           sd.max_temp, sd.min_temp, sd.humidity,
           sd.update_time
         FROM weather_stations ws
         INNER JOIN station_data sd ON sd.weather_station_id = ws.id
         WHERE ws.station_operator IS NULL AND sd.update_time IS NOT NULL`,
      );
    } else if (operator === 'all') {
      rows = await query(
        `SELECT ws.code AS code,
           sd.wind_direction, sd.wind_speed, sd.temperature,
           sd.max_temp, sd.min_temp, sd.humidity,
           sd.update_time
         FROM weather_stations ws
         INNER JOIN station_data sd ON sd.weather_station_id = ws.id
         WHERE sd.update_time IS NOT NULL AND sd.updated_at > NOW() - interval '3 hours'`,
      );
    } else {
      rows = await query(
        `SELECT ws.code AS code,
           sd.wind_direction, sd.wind_speed, sd.temperature,
           sd.max_temp, sd.min_temp, sd.humidity,
           sd.update_time
         FROM weather_stations ws
         INNER JOIN station_data sd ON sd.weather_station_id = ws.id
         WHERE ws.station_operator = $1 AND sd.update_time IS NOT NULL`,
        [operator],
      );
    }
  } catch (e) {
    logger.error(e);
    rows = [];
  }

  const response = omitNil({
    success: true,
    info: '',
    data: rows.map((r) =>
      omitNil({
        code: r.code,
        wind_direction: r.wind_direction,
        wind_speed: r.wind_speed,
        temperature: r.temperature,
        max_temp: r.max_temp,
        min_temp: r.min_temp,
        humidity: r.humidity,
        update_time: r.update_time,
      }),
    ),
  });

  await setCache(cacheKey, response);
  res.json(response);
});

router.post('/weather_stations.json', async (req, res) => {
  let operator =
    req.body.operator ??
    req.query.operator ??
    '';

  const cacheKey = `api:weather_stations:${operator ?? 'null'}`;
  const cached = await getCache(cacheKey);
  if (cached) return res.json(cached);

  let rows;

  try {
    if (!operator || String(operator).trim() === '') {
      rows = await query(
        `SELECT code, chi_name, eng_name, lat, lng, wind_lat, wind_lng,
          webcam_angle, chi_name_abbr, eng_name_abbr, station_operator,
          photo_code, is_forecast
         FROM weather_stations WHERE station_operator IS NULL ORDER BY eng_name`,
      );
    } else if (operator === 'all') {
      rows = await query(
        `SELECT code, chi_name, eng_name, lat, lng, wind_lat, wind_lng,
          webcam_angle, chi_name_abbr, eng_name_abbr, station_operator,
          photo_code, is_forecast
         FROM weather_stations ORDER BY eng_name`,
      );
    } else {
      rows = await query(
        `SELECT code, chi_name, eng_name, lat, lng, wind_lat, wind_lng,
          webcam_angle, chi_name_abbr, eng_name_abbr, station_operator,
          photo_code, is_forecast
         FROM weather_stations WHERE station_operator = $1 ORDER BY eng_name`,
        [operator],
      );
    }
  } catch (e) {
    logger.error(e);
    rows = [];
  }

  const response = omitNil({
    success: true,
    info: '',
    data: rows.map((r) =>
      omitNil({
        ...r,
        photo_2x_code: null,
      }),
    ),
  });

  await setCache(cacheKey, response);
  res.json(response);
});

router.post('/hour_forecast.json', async (req, res) => {
  const code = String(req.body.code ?? '').trim().toLowerCase();
  const cacheKey = `api:hour_forecast:${code || 'all'}`;
  const cached = await getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const hf = await queryOne(`SELECT data FROM hour_forecasts WHERE lower(code)=lower($1)`, [code]);
    const success = !!hf;
    const dataBlob = hf?.data ?? {};
    const inner = typeof dataBlob === 'string' ? JSON.parse(dataBlob) : dataBlob;
    const response = omitNil({
      success,
      info: '',
      data: omitNil(inner),
    });
    await setCache(cacheKey, response);
    res.json(response);
  } catch (e) {
    logger.error(e);
    res.json({ success: false, info: '' });
  }
});

router.post('/aqhi_stations.json', async (req, res) => {
  const lang = req.body.lang || 'en';
  const cacheKey = 'api:aqhi_stations';
  const cached = await getCache(cacheKey);
  if (cached) return res.json(cached);

  const rows =
    await query(`SELECT code, lat, lng, station_type, aqhi_index, update_time, chi_name, eng_name
    FROM aqhi_stations ORDER BY eng_name`);

  const response = {
    success: true,
    info: '',
    data: rows.map((s) =>
      omitNil({
        code: s.code,
        lat: s.lat != null ? Number(s.lat) : null,
        lng: s.lng != null ? Number(s.lng) : null,
        station_type: s.station_type,
        aqhi_index: s.aqhi_index,
        update_time:
          s.update_time instanceof Date ? s.update_time.toISOString() : s.update_time,
        name: isEng(lang) ? s.eng_name : s.chi_name,
      }),
    ),
  };

  await setCache(cacheKey, response);
  res.json(response);
});

router.post('/weathers.json', async (req, res) => {
  let message = '';
  try {
    const api = req.body.api ?? {};
    const cacheKey = `api:weathers:${sha1Hex(JSON.stringify({
      lat: Number.parseFloat(Number(api.lat ?? 22.301944).toFixed(4)),
      lng: Number.parseFloat(Number(api.lng ?? 114.174297).toFixed(4)),
      station_code: String(api.station_code ?? '').trim().toLowerCase(),
      operator: api.operator ? String(api.operator).trim().toLowerCase() : '',
      lang: api.lang ?? 'en',
      height: Number.parseInt(api.height ?? '0', 10),
      width: Number.parseInt(api.width ?? '0', 10),
      flickr: ENABLE_FLICKR_PHOTO ? '1' : '0',
    }))}`;
    const cached = await getCache(cacheKey);
    if (cached) return res.json(cached);

    let lat = api.lat ?? 22.301944;
    let lng = api.lng ?? 114.174297;
    const station_code = api.station_code;
    let operator = api.operator ?? null;

    lat = Number.parseFloat(Number(lat).toFixed(4));
    lng = Number.parseFloat(Number(lng).toFixed(4));
    operator = operator && String(operator).trim().toLowerCase() === 'all' ? 'all' : undefined;

    const lang = api.lang ?? 'en';
    const deviceHeight = Number.parseInt(api.height ?? '0', 10);
    const deviceWidth = Number.parseInt(api.width ?? '0', 10);

    const hkTodayIso = DateTime.now().setZone('Asia/Hong_Kong').toISODate();
    const hkTodayMidnightIso = `${hkTodayIso}T00:00:00.000`;

    const todayRows = await query(`SELECT * FROM todays ORDER BY id DESC LIMIT 1`);
    const todayRow = todayRows[0];

    let warningsRows = await query(`SELECT * FROM weather_warnings`);
    warningsRows.sort((a, b) => warningSortOrder(a.warning_type) - warningSortOrder(b.warning_type));

    const tipsRows =
      await query(`SELECT eng_title, chi_title, eng_content, chi_content, time FROM special_weather_tips`);

    const hiRows = await query(
      `SELECT eng_title, chi_title, eng_content, chi_content, time, warning_type
       FROM heat_indices WHERE time >= $1::timestamp`,
      [hkTodayMidnightIso],
    );
    const heatIndexRow = hiRows.length ? hiRows[0] : null;

    let typhoonRows = [];
    if (todayRow?.typhoon_id && String(todayRow.typhoon_id).trim()) {
      const ids = todayRow.typhoon_id.split(/,/).map((x) => x.trim()).filter(Boolean).map(Number).filter((n)=>!Number.isNaN(n));
      if (ids.length)
        typhoonRows = await query(
          `SELECT hko_id, data_type, eng_name, chi_name FROM typhoons WHERE hko_id = ANY($1::int[])`,
          [ids],
        );
    }

    const forecasts = await query(
      `SELECT * FROM forecasts WHERE forecast_day >= $1::date ORDER BY forecast_day ASC`,
      [hkTodayIso],
    );

    const wxRow = await findWeatherStation(lat, lng, station_code ?? null,
      operator === 'all' ? 'all' : undefined);

    if (!todayRow || !wxRow || wxRow.sd_update_time == null) {
      return res.status(503).json({ success: false, info: 'no data yet', data: null });
    }

    if (
      (wxRow.humidity == null || wxRow.humidity === '')
      && todayRow.humidity != null
    ) {
      wxRow.humidity = todayRow.humidity;
    }

    const aqStation = await findNearestAqhi(lat, lng);

    let imageOuter;
    if (!ENABLE_FLICKR_PHOTO) {
      imageOuter = omitNil({ photo_id: -1 });
      message = FLICKR_DOWN;
    } else {
      const hourHK = DateTime.now().setZone('Asia/Hong_Kong').hour;
      const pool = await flickrPhotosForWeather(String(todayRow.weather ?? ''), hourHK);
      const photoPick = pool?.length ? pool[Math.floor(Math.random() * pool.length)] : null;
      const high =
        deviceHeight > 1280 || deviceWidth > 1000 ? !!(photoPick?.high_res_url) : false;

      imageOuter =
        !photoPick
          ? omitNil({ owner_url: null, owner_name: null, image_url: null })
          : omitNil({
              owner_name: truncate(photoPick.owner_name ?? '', 20),
              owner_url: photoPick.owner_url,
              image_url: high && photoPick.high_res_url ? photoPick.high_res_url : photoPick.mid_res_url,
            });
    }

    const firstFc = forecasts[0];
    const dataPayload = omitNil({
      day: toDateStr(todayRow.forecast_day),
      weather: todayRow.weather,
      temperature: todayRow.temperature,
      humidity: todayRow.humidity,
      uv: todayRow.uv,
      update_time: wxRow.sd_update_time ?? todayRow.update_time,
      sun_rise_time: todayRow.sun_rise_time,
      sun_set_time: todayRow.sun_set_time,
      moon_rise_time: todayRow.moon_rise_time,
      moon_set_time: todayRow.moon_set_time,
      tide_info: todayRow.tide_info,
      astronomical_update_time:
        todayRow.astronomical_update_time instanceof Date
          ? todayRow.astronomical_update_time.toISOString()
          : todayRow.astronomical_update_time,
      detail: isEng(lang) ? todayRow.eng_detail : todayRow.chi_detail,
      forecast_general: isEng(lang) ? todayRow.eng_forecast_general : todayRow.chi_forecast_general,
      id: Math.floor(Date.now() / 1000),
      max_temp: firstFc?.max_temperature ?? null,
      min_temp: firstFc?.min_temperature ?? null,
      station_code: wxRow.code,
      station_lat: wxRow.lat != null ? Number(wxRow.lat) : null,
      station_lng: wxRow.lng != null ? Number(wxRow.lng) : null,
      station_temperature: naturalNumber(wxRow.temperature),
      station_humidity: naturalNumber(wxRow.humidity),
      station_max_temp: naturalNumber(wxRow.max_temp),
      station_min_temp: naturalNumber(wxRow.min_temp),
      location: isEng(lang) ? wxRow.eng_name : wxRow.chi_name,
      image_data: imageOuter,
      forecasts: forecasts.map((f) => buildForecastNode(f, lang)),
      warnings: warningsRows.map((w) => buildWarningNode(w, lang)),
      typhoons: typhoonRows.map((t) =>
        omitNil({
          hko_id: t.hko_id,
          data_type: t.data_type,
          name: isEng(lang) ? t.eng_name : t.chi_name,
        }),
      ),
      special_weather_tips: tipsRows.map((t) =>
        omitNil({
          time: t.time instanceof Date ? t.time.toISOString() : t.time,
          title: isEng(lang) ? t.eng_title : t.chi_title,
          content: isEng(lang) ? t.eng_content : t.chi_content,
        }),
      ),
      heat_index: heatIndexRow
        ? omitNil({
            time: heatIndexRow.time instanceof Date ? heatIndexRow.time.toISOString() : heatIndexRow.time,
            warning_type: heatIndexRow.warning_type,
            title: isEng(lang) ? heatIndexRow.eng_title : heatIndexRow.chi_title,
            content: isEng(lang) ? heatIndexRow.eng_content : heatIndexRow.chi_content,
          })
        : undefined,
      aqhi: todayRow.aqhi_current,
      aqhi_update_time:
        todayRow.aqhi_update_time instanceof Date
          ? todayRow.aqhi_update_time.toISOString()
          : todayRow.aqhi_update_time,
      aqhi_forecast: isEng(lang) ? todayRow.eng_aqhi_forecast : todayRow.chi_aqhi_forecast,
    });

    if (aqStation) {
      dataPayload.aqhi_station = {
        aqhi_index: aqStation.aqhi_index,
        name: isEng(lang) ? aqStation.eng_name : aqStation.chi_name,
        station_type: aqStation.station_type,
        update_time:
          aqStation.update_time instanceof Date ? aqStation.update_time.toISOString() : aqStation.update_time,
      }
    }

    const response = omitNil({ success: true, info: message, data: omitNil(dataPayload) });
    await setCache(cacheKey, response);
    res.json(response);
  } catch (e) {
    logger.error(e);
    res.status(500).json({ success: false, info: String(e.message ?? e), data: null });
  }
});

export default router;
