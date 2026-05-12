import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import weather_stations from '../db/weather_stations.json' with { type: 'json' };
import aqhi_stations from '../db/aqhi_stations.json' with { type: 'json' };

import { pool, query } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SEEDS_RB = path.join(ROOT, 'seeds.rb');


function cleanRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v === '' ? null : v;
  }
  return out;
}

async function upsertWeatherStations(rows) {
  for (const raw of rows) {
    const r = cleanRow(raw);
    await query(
      `INSERT INTO weather_stations (
        code, chi_name, eng_name, lat, lng, wind_lat, wind_lng, webcam_angle,
        chi_name_abbr, eng_name_abbr, station_operator, photo_code, is_forecast,
        created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),NOW()
      )
      ON CONFLICT (code) DO UPDATE SET
        chi_name = EXCLUDED.chi_name,
        eng_name = EXCLUDED.eng_name,
        lat = EXCLUDED.lat,
        lng = EXCLUDED.lng,
        wind_lat = EXCLUDED.wind_lat,
        wind_lng = EXCLUDED.wind_lng,
        webcam_angle = EXCLUDED.webcam_angle,
        chi_name_abbr = EXCLUDED.chi_name_abbr,
        eng_name_abbr = EXCLUDED.eng_name_abbr,
        station_operator = EXCLUDED.station_operator,
        photo_code = EXCLUDED.photo_code,
        is_forecast = EXCLUDED.is_forecast,
        updated_at = NOW()`,
      [
        r.code,
        r.chi_name,
        r.eng_name,
        r.lat,
        r.lng,
        r.wind_lat ?? null,
        r.wind_lng ?? null,
        r.webcam_angle ?? null,
        r.chi_name_abbr ?? null,
        r.eng_name_abbr ?? null,
        r.station_operator ?? null,
        r.photo_code ?? null,
        r.is_forecast ?? false,
      ],
    );
  }
}

async function upsertAqhiStations(rows) {
  for (const raw of rows) {
    const r = cleanRow(raw);
    await query(
      `INSERT INTO aqhi_stations (
        code, chi_name, eng_name, lat, lng, station_type, created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,NOW(),NOW()
      )
      ON CONFLICT (code) DO UPDATE SET
        chi_name = EXCLUDED.chi_name,
        eng_name = EXCLUDED.eng_name,
        lat = EXCLUDED.lat,
        lng = EXCLUDED.lng,
        station_type = EXCLUDED.station_type,
        updated_at = NOW()`,
      [r.code, r.chi_name, r.eng_name, r.lat, r.lng, r.station_type],
    );
  }
}

async function main() {
  const weatherStations = weather_stations;
  const aqhiStations = aqhi_stations;

  await upsertWeatherStations(weatherStations);
  await upsertAqhiStations(aqhiStations);

  console.log(
    `Seeded: weather_stations=${weatherStations.length}, aqhi_stations=${aqhiStations.length}`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
