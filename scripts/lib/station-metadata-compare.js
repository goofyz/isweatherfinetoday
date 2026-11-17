import { lookup as dnsLookup } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

export const DEFAULT_PORTAL_URL = 'https://www.hko.gov.hk/en/wxinfo/awsgis/regional_portal.html';
export const DEFAULT_TOLERANCE_DEGREES = 0.0001;
export const DEFAULT_CONFIG_VARIABLE = 'stationConfigAWS';
export const DEFAULT_TIMEOUT_MS = 30000;

export const PROVENANCE = {
  mapHost: 'map.hko.gov.hk',
  mapEntry: 'https://maps.hko.gov.hk/',
  mapEntryRedirect: 'https://maps.weather.gov.hk/',
  gisPage: 'https://www.hko.gov.hk/en/wxinfo/awsgis/regional_weather_gis.html',
  legacyConfigNotLoaded: 'https://www.hko.gov.hk/en/wxinfo/awsgis/files/station-config-aws.js',
  readingsNotCompared: 'https://www.hko.gov.hk/wxinfo/awsgis/latestReadings_AWS1_v2.txt',
};

export const ALLOWED_CONFIG_HOSTS = new Set([
  'hko.gov.hk',
  'www.hko.gov.hk',
  'www.weather.gov.hk',
  'maps.hko.gov.hk',
  'maps.weather.gov.hk',
]);

export const PRIMARY_LAYER_PRIORITY = [
  'temp',
  'rh',
  'mslp',
  'wind',
  'grass',
  'visibility',
  'globalSolar',
  'directSolar',
  'diffuseSolar',
  'hkhi',
];

export const COMPASS_DEGREES = {
  n: 0,
  nne: 22.5,
  ne: 45,
  ene: 67.5,
  e: 90,
  ese: 112.5,
  se: 135,
  sse: 157.5,
  s: 180,
  ssw: 202.5,
  sw: 225,
  wsw: 247.5,
  w: 270,
  wnw: 292.5,
  nw: 315,
  nnw: 337.5,
};

const UNAVAILABLE_TOKENS = new Set(['', '-', '--', 'null', 'na', 'n/a', 'nil']);

export const COMPARISON_COVERAGE = {
  compared: [
    'Station code, matched case-insensitively. A difference in letter case is still reported.',
    'English name: seed eng_name against live name_EN.',
    'Traditional Chinese name: seed chi_name against live name_TC.',
    'Station coordinates: seed lat/lng against the temperature layer when that layer has coordinates. Otherwise the first available layer in temp, rh, mslp, wind, grass, visibility, solar, hkhi order. If the station has no instrument coordinates, the weather photo whose code matches the station.',
    'Wind coordinates: seed wind_lat/wind_lng against the wind layer.',
    'A live wind site that is not the station pin when the seed has no wind_lat/wind_lng.',
    'Weather-photo codes: seed photo_code against live webcam codes, compared as a case-insensitive set.',
    'Webcam bearing when both sides have exactly one photo. Seed 360° is treated as 0°. Live 16-point compass tokens are converted to degrees.',
  ],
  notCompared: [
    'Weather readings and latestReadings files.',
    'Simplified Chinese name_SC.',
    'Seed eng_name_abbr and chi_name_abbr, and live subtitles. Those are different fields.',
    'Seed is_forecast and live ARWF_code. ARWF_code points at a forecast area.',
    'Seed station_operator. Community stations are not part of this map metadata.',
    'mustDisplay, zoom, micro-climate, and anemometer display flags.',
    'Webcam bearing when a station has several cameras, because the seed stores one angle.',
  ],
  coordinateRules: [
    'Empty strings and tokens such as null, NA, and n/a are unavailable. They are never read as zero.',
    'Latitude and longitude are compared separately. A gap strictly greater than the tolerance is a difference. The default tolerance is 0.0001 degrees.',
    'A smaller non-zero gap is reported as within tolerance. It does not fail the run unless --strict is set.',
    'Temperature and wind coordinates stay separate. A wind instrument at another site does not replace the temperature comparison.',
    'Offsets of other live layers or cameras from the station pin are reported as live offsets. They are not seed mismatches.',
  ],
};

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

export function normalizeName(value) {
  if (value == null) return '';
  return String(value).normalize('NFC').replace(/\s+/g, ' ').trim();
}

export function parseCoordinate(value) {
  if (value == null) {
    return { number: null, raw: null, unavailable: true, invalid: false };
  }
  const raw = String(value).trim();
  if (UNAVAILABLE_TOKENS.has(raw.toLowerCase())) {
    return { number: null, raw, unavailable: true, invalid: false };
  }
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(raw)) {
    return { number: null, raw, unavailable: true, invalid: true };
  }
  const number = Number(raw);
  if (!Number.isFinite(number)) {
    return { number: null, raw, unavailable: true, invalid: true };
  }
  return { number, raw, unavailable: false, invalid: false };
}

export function normalizeBearing(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return ((number % 360) + 360) % 360;
}

export function compassToDegrees(token) {
  if (token == null || String(token).trim() === '') {
    return { degrees: null, unmapped: false };
  }
  const key = String(token).trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(COMPASS_DEGREES, key)) {
    return { degrees: COMPASS_DEGREES[key], unmapped: false };
  }
  return { degrees: null, unmapped: true, token: key };
}

export function haversineMeters(lat1, lng1, lat2, lng2) {
  const earthRadius = 6371000;
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const deltaLat = toRadians(lat2 - lat1);
  const deltaLng = toRadians(lng2 - lng1);
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(deltaLng / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.min(1, Math.sqrt(a)));
}

function roundTo(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function coordinateDelta(lat1, lng1, lat2, lng2) {
  return {
    deltaLat: roundTo(Math.abs(lat1 - lat2), 8),
    deltaLng: roundTo(Math.abs(lng1 - lng2), 8),
    distanceMeters: roundTo(haversineMeters(lat1, lng1, lat2, lng2), 2),
  };
}

function classifyDelta(delta, tolerance) {
  const limit = roundTo(tolerance, 8);
  if (delta.deltaLat === 0 && delta.deltaLng === 0) return 'match';
  if (delta.deltaLat > limit || delta.deltaLng > limit) return 'different';
  return 'withinTolerance';
}

function normalizeLayer(raw) {
  const code = raw.code == null ? '' : String(raw.code).trim();
  const latitude = parseCoordinate(raw.latitude);
  const longitude = parseCoordinate(raw.longitude);
  const coordinatesAvailable = !latitude.unavailable && !longitude.unavailable;
  return {
    code,
    latitude: latitude.unavailable ? null : latitude.number,
    longitude: longitude.unavailable ? null : longitude.number,
    latitudeText: latitude.raw,
    longitudeText: longitude.raw,
    coordinatesAvailable,
    coordinatesUnavailable: code !== '' && !coordinatesAvailable,
    present: code !== '',
    invalid: Boolean(latitude.invalid || longitude.invalid),
  };
}

function normalizeWebcam(raw) {
  const latitude = parseCoordinate(raw.latitude);
  const longitude = parseCoordinate(raw.longitude);
  return {
    code: raw.code == null ? '' : String(raw.code).trim(),
    latitude: latitude.unavailable ? null : latitude.number,
    longitude: longitude.unavailable ? null : longitude.number,
    latitudeText: latitude.raw,
    longitudeText: longitude.raw,
    angle: raw.angle == null ? '' : String(raw.angle).trim().toLowerCase(),
    directionEn: raw.direction_EN == null ? '' : String(raw.direction_EN).trim(),
  };
}

export function normalizeLiveStation(raw, key) {
  if (!isPlainObject(raw)) {
    throw new Error(`Live station ${key} is not an object`);
  }
  const layers = {};
  for (const [layerName, value] of Object.entries(raw)) {
    if (!isPlainObject(value) || !('code' in value)) continue;
    if (!('latitude' in value) && !('longitude' in value)) continue;
    layers[layerName] = normalizeLayer(value);
  }
  const webcamRaw = raw.weatherPhoto?.webcam;
  const webcams = Array.isArray(webcamRaw) ? webcamRaw.filter(isPlainObject).map(normalizeWebcam) : [];
  const codeFromRecord = raw.code == null ? '' : String(raw.code).trim();
  const code = codeFromRecord || String(key);
  return {
    key: String(key),
    code,
    nameEn: raw.name_EN == null ? '' : String(raw.name_EN),
    nameTc: raw.name_TC == null ? '' : String(raw.name_TC),
    nameSc: raw.name_SC == null ? '' : String(raw.name_SC),
    subtitleEn: raw.subtitle_EN == null ? '' : String(raw.subtitle_EN),
    subtitleTc: raw.subtitle_TC == null ? '' : String(raw.subtitle_TC),
    layers,
    webcams,
    anemometer: isPlainObject(raw.anemometer)
      ? {
          code: raw.anemometer.code == null ? '' : String(raw.anemometer.code).trim(),
          display: raw.anemometer.display ?? null,
        }
      : null,
    arwfCode: raw.ARWF_code == null || String(raw.ARWF_code).trim() === ''
      ? null
      : String(raw.ARWF_code).trim(),
  };
}

function isStationRecord(value) {
  if (!isPlainObject(value)) return false;
  return value.code != null || value.name_EN != null || value.name_TC != null || value.temp != null || value.wind != null;
}

export function stationsFromConfigTable(table) {
  if (!table || typeof table !== 'object') {
    throw new Error('Station config did not evaluate to an object');
  }
  const stations = [];
  for (const [key, value] of Object.entries(table)) {
    if (!isStationRecord(value)) continue;
    stations.push(normalizeLiveStation(value, key));
  }
  return stations;
}

export function parseStationConfigSource(sourceText, { variableName = DEFAULT_CONFIG_VARIABLE, timeoutMs = 3000 } = {}) {
  if (typeof sourceText !== 'string' || sourceText.trim() === '') {
    throw new Error('Station config source is empty');
  }
  if (!/^[A-Za-z_$][\w$]*$/.test(variableName)) {
    throw new UsageError(`Invalid config variable name: ${variableName}`);
  }
  const sandbox = {};
  vm.createContext(sandbox);
  const script = new vm.Script(
    `${sourceText}\n;globalThis.__stationMetadataCapture = typeof ${variableName} !== "undefined" ? ${variableName} : null;\n`,
    { filename: 'station-config.js' },
  );
  try {
    script.runInContext(sandbox, { timeout: timeoutMs });
  } catch (error) {
    throw new Error(`Failed to read station config: ${error.message}`);
  }
  const table = sandbox.__stationMetadataCapture;
  if (!table || typeof table !== 'object') {
    throw new Error(`Station config did not define ${variableName}`);
  }
  const stations = stationsFromConfigTable(table);
  if (stations.length === 0) {
    throw new Error(`Station config ${variableName} did not contain any stations`);
  }
  return stations;
}

export function normalizeSeedRow(row, index) {
  if (!isPlainObject(row)) throw new Error(`Seed row ${index} is not an object`);
  if (row.code == null || String(row.code).trim() === '') {
    throw new Error(`Seed row ${index} is missing code`);
  }
  const latitude = parseCoordinate(row.lat);
  const longitude = parseCoordinate(row.lng);
  const windLatitude = parseCoordinate(row.wind_lat);
  const windLongitude = parseCoordinate(row.wind_lng);
  const photoCodes = row.photo_code == null || String(row.photo_code).trim() === ''
    ? []
    : String(row.photo_code).split(',').map((part) => part.trim()).filter(Boolean);
  return {
    index,
    code: String(row.code).trim(),
    engName: row.eng_name == null ? '' : String(row.eng_name),
    chiName: row.chi_name == null ? '' : String(row.chi_name),
    latitude,
    longitude,
    coordinatesAvailable: !latitude.unavailable && !longitude.unavailable,
    windLatitude,
    windLongitude,
    windCoordinatesAvailable: !windLatitude.unavailable && !windLongitude.unavailable,
    windCoordinatesPartial: windLatitude.unavailable !== windLongitude.unavailable,
    photoCodes,
    webcamAngle: normalizeBearing(row.webcam_angle),
    webcamAngleRaw: row.webcam_angle ?? null,
    warnings: [
      latitude.invalid ? `lat ${latitude.raw} is not a number and is treated as unavailable` : null,
      longitude.invalid ? `lng ${longitude.raw} is not a number and is treated as unavailable` : null,
      windLatitude.invalid ? `wind_lat ${windLatitude.raw} is not a number and is treated as unavailable` : null,
      windLongitude.invalid ? `wind_lng ${windLongitude.raw} is not a number and is treated as unavailable` : null,
    ].filter(Boolean),
  };
}

export function normalizeSeedRows(rows) {
  if (!Array.isArray(rows)) throw new Error('Seed data must be a JSON array');
  return rows.map((row, index) => normalizeSeedRow(row, index));
}

export function selectPrimaryCoordinate(station) {
  const notes = [];
  const temperature = station.layers.temp;
  if (temperature?.present && !temperature.coordinatesAvailable) {
    notes.push('Temperature instrument code is set but its coordinates are unavailable.');
  }
  for (const name of PRIMARY_LAYER_PRIORITY) {
    const layer = station.layers[name];
    if (layer?.coordinatesAvailable) {
      return {
        source: name,
        latitude: layer.latitude,
        longitude: layer.longitude,
        latitudeText: layer.latitudeText,
        longitudeText: layer.longitudeText,
        instrumentCode: layer.code,
        notes,
      };
    }
  }
  const cameras = station.webcams.filter((camera) => camera.latitude != null && camera.longitude != null);
  if (cameras.length === 0) {
    notes.push('No instrument layer or weather photo has coordinates.');
    return {
      source: null,
      latitude: null,
      longitude: null,
      latitudeText: null,
      longitudeText: null,
      instrumentCode: null,
      notes,
    };
  }
  const ownCamera = cameras.find((camera) => camera.code.toLowerCase() === station.code.toLowerCase());
  if (ownCamera) {
    notes.push('No instrument coordinates; using the weather photo whose code matches the station.');
    return {
      source: 'weatherPhoto',
      latitude: ownCamera.latitude,
      longitude: ownCamera.longitude,
      latitudeText: ownCamera.latitudeText,
      longitudeText: ownCamera.longitudeText,
      instrumentCode: ownCamera.code,
      notes,
    };
  }
  const [first] = cameras;
  const sharedPosition = cameras.every((camera) => camera.latitude === first.latitude && camera.longitude === first.longitude);
  if (sharedPosition) {
    notes.push('No instrument coordinates; the weather photos share one position.');
    return {
      source: 'weatherPhoto',
      latitude: first.latitude,
      longitude: first.longitude,
      latitudeText: first.latitudeText,
      longitudeText: first.longitudeText,
      instrumentCode: first.code,
      notes,
    };
  }
  notes.push('Weather photos disagree and none uses the station code, so the station position is ambiguous.');
  return {
    source: null,
    latitude: null,
    longitude: null,
    latitudeText: null,
    longitudeText: null,
    instrumentCode: null,
    notes,
    ambiguousWebcams: cameras.map((camera) => ({
      code: camera.code,
      latitude: camera.latitudeText,
      longitude: camera.longitudeText,
    })),
  };
}

function point(latitudeText, longitudeText) {
  return { latitude: latitudeText ?? null, longitude: longitudeText ?? null };
}

function compareNames(field, seedValue, liveValue) {
  const seedNormalized = normalizeName(seedValue);
  const liveNormalized = normalizeName(liveValue);
  if (seedNormalized === liveNormalized) return null;
  const finding = {
    field,
    status: 'different',
    seed: seedNormalized === '' ? null : seedValue,
    live: liveNormalized === '' ? null : liveValue,
  };
  if (seedNormalized === '' || liveNormalized === '') {
    finding.note = 'One side has no name. An empty name is unavailable.';
  }
  return finding;
}

function codeSet(codes) {
  return [...new Set(codes.map((code) => String(code).trim().toLowerCase()).filter(Boolean))].sort();
}

function pushCoordinateFinding(findings, { field, status, seedPoint, livePoint, delta, note, layer, instrumentCode }) {
  if (status === 'match') return;
  const finding = {
    field,
    status,
    seed: seedPoint,
    live: livePoint,
  };
  if (layer) finding.layer = layer;
  if (instrumentCode) finding.instrumentCode = instrumentCode;
  if (delta) Object.assign(finding, delta);
  if (note) finding.note = note;
  findings.push(finding);
}

export function diffStation(seed, live, tolerance) {
  const findings = [];
  if (seed.code !== live.code) {
    findings.push({
      field: 'code',
      status: 'different',
      seed: seed.code,
      live: live.code,
      note: 'The codes match case-insensitively and were compared as one station. The letter case still differs.',
    });
  }
  if (live.key.toLowerCase() !== live.code.toLowerCase()) {
    findings.push({
      field: 'configKey',
      status: 'different',
      seed: seed.code,
      live: live.key,
      note: 'The map config key differs from the station code property.',
    });
  }

  const english = compareNames('engName', seed.engName, live.nameEn);
  const chinese = compareNames('chiName', seed.chiName, live.nameTc);
  if (english) findings.push(english);
  if (chinese) findings.push(chinese);

  const temperature = live.layers.temp;
  if (temperature?.present && !temperature.coordinatesAvailable) {
    findings.push({
      field: 'temperatureCoordinates',
      status: 'unavailable',
      layer: 'temp',
      instrumentCode: temperature.code,
      seed: seed.coordinatesAvailable ? point(seed.latitude.raw, seed.longitude.raw) : null,
      live: { latitude: null, longitude: null, layer: 'temp', instrumentCode: temperature.code },
      note: 'Temperature instrument code is set but its coordinates are unavailable. The station pin is compared to the next layer that has coordinates.',
    });
  }

  const primary = selectPrimaryCoordinate(live);
  const primaryNote = primary.notes.filter((note) => !note.startsWith('Temperature instrument')).join(' ');
  if (!seed.coordinatesAvailable || primary.latitude == null) {
    pushCoordinateFinding(findings, {
      field: 'coordinates',
      status: 'unavailable',
      seedPoint: seed.coordinatesAvailable ? point(seed.latitude.raw, seed.longitude.raw) : null,
      livePoint: primary.latitude == null
        ? null
        : {
            latitude: primary.latitudeText,
            longitude: primary.longitudeText,
            layer: primary.source,
            instrumentCode: primary.instrumentCode,
          },
      note: primaryNote || 'Station coordinates are unavailable on one side. An empty coordinate is not zero.',
      layer: primary.source || undefined,
      instrumentCode: primary.instrumentCode || undefined,
    });
  } else {
    const delta = coordinateDelta(seed.latitude.number, seed.longitude.number, primary.latitude, primary.longitude);
    pushCoordinateFinding(findings, {
      field: 'coordinates',
      status: classifyDelta(delta, tolerance),
      seedPoint: point(seed.latitude.raw, seed.longitude.raw),
      livePoint: {
        latitude: primary.latitudeText,
        longitude: primary.longitudeText,
        layer: primary.source,
        instrumentCode: primary.instrumentCode,
      },
      delta,
      note: primary.source === 'temp' ? undefined : (primaryNote || undefined),
      layer: primary.source,
      instrumentCode: primary.instrumentCode,
    });
  }

  const wind = live.layers.wind;
  if (seed.windCoordinatesPartial) {
    findings.push({
      field: 'windCoordinates',
      status: 'unavailable',
      seed: point(
        seed.windLatitude.unavailable ? null : seed.windLatitude.raw,
        seed.windLongitude.unavailable ? null : seed.windLongitude.raw,
      ),
      live: wind?.coordinatesAvailable
        ? { latitude: wind.latitudeText, longitude: wind.longitudeText, instrumentCode: wind.code }
        : null,
      note: 'The seed has only one of wind_lat and wind_lng.',
    });
  } else if (seed.windCoordinatesAvailable) {
    if (!wind?.present) {
      findings.push({
        field: 'windCoordinates',
        status: 'unavailable',
        seed: point(seed.windLatitude.raw, seed.windLongitude.raw),
        live: null,
        note: 'The seed has wind coordinates. This map station has no wind instrument.',
      });
    } else if (!wind.coordinatesAvailable) {
      findings.push({
        field: 'windCoordinates',
        status: 'unavailable',
        seed: point(seed.windLatitude.raw, seed.windLongitude.raw),
        live: { latitude: null, longitude: null, instrumentCode: wind.code },
        note: 'The wind instrument code is set but its coordinates are unavailable.',
      });
    } else {
      const delta = coordinateDelta(
        seed.windLatitude.number,
        seed.windLongitude.number,
        wind.latitude,
        wind.longitude,
      );
      pushCoordinateFinding(findings, {
        field: 'windCoordinates',
        status: classifyDelta(delta, tolerance),
        seedPoint: point(seed.windLatitude.raw, seed.windLongitude.raw),
        livePoint: {
          latitude: wind.latitudeText,
          longitude: wind.longitudeText,
          layer: 'wind',
          instrumentCode: wind.code,
        },
        delta,
        layer: 'wind',
        instrumentCode: wind.code,
      });
    }
  } else if (wind?.present && !wind.coordinatesAvailable) {
    findings.push({
      field: 'windCoordinates',
      status: 'unavailable',
      seed: null,
      live: { latitude: null, longitude: null, instrumentCode: wind.code },
      note: 'The wind instrument code is set but its coordinates are unavailable. The seed has no wind_lat/wind_lng.',
    });
  } else if (wind?.coordinatesAvailable && primary.source !== 'wind' && seed.coordinatesAvailable) {
    const delta = coordinateDelta(seed.latitude.number, seed.longitude.number, wind.latitude, wind.longitude);
    const status = classifyDelta(delta, tolerance);
    if (status !== 'match') {
      pushCoordinateFinding(findings, {
        field: 'windCoordinates',
        status,
        seedPoint: null,
        livePoint: {
          latitude: wind.latitudeText,
          longitude: wind.longitudeText,
          layer: 'wind',
          instrumentCode: wind.code,
        },
        delta,
        note: status === 'withinTolerance'
          ? 'Wind coordinates are within tolerance of the seed station pin. The seed has no separate wind_lat/wind_lng.'
          : 'The map places the wind instrument away from the seed station coordinates, and the seed has no wind_lat/wind_lng.',
        layer: 'wind',
        instrumentCode: wind.code,
      });
    }
  }

  const seedPhotos = codeSet(seed.photoCodes);
  const livePhotos = codeSet(live.webcams.map((camera) => camera.code));
  if (seedPhotos.join('\0') !== livePhotos.join('\0')) {
    findings.push({
      field: 'photoCodes',
      status: 'different',
      seed: seed.photoCodes,
      live: live.webcams.map((camera) => camera.code),
    });
  }

  if (seed.photoCodes.length === 1 && live.webcams.length === 1) {
    const camera = live.webcams[0];
    const liveBearing = compassToDegrees(camera.angle);
    if (seed.webcamAngle == null || liveBearing.unmapped || liveBearing.degrees == null) {
      if (seed.webcamAngle != null || camera.angle) {
        findings.push({
          field: 'webcamAngle',
          status: 'unavailable',
          seed: seed.webcamAngleRaw,
          live: camera.angle || null,
          note: liveBearing.unmapped
            ? `Live compass token "${camera.angle}" is outside the 16-point compass used for comparison.`
            : 'One side has no webcam bearing.',
        });
      }
    } else if (seed.webcamAngle !== liveBearing.degrees) {
      findings.push({
        field: 'webcamAngle',
        status: 'different',
        seed: seed.webcamAngleRaw,
        seedDegrees: seed.webcamAngle,
        live: camera.angle,
        liveDegrees: liveBearing.degrees,
        liveDirection: camera.directionEn || null,
      });
    }
  }

  return { findings, primary };
}

function liveOffsetsFor(live, primary, tolerance) {
  if (primary.latitude == null) return [];
  const offsets = [];
  for (const [layerName, layer] of Object.entries(live.layers)) {
    if (layerName === primary.source || layerName === 'wind') continue;
    if (!layer.present) continue;
    if (!layer.coordinatesAvailable) {
      offsets.push({
        code: live.code,
        layer: layerName,
        instrumentCode: layer.code,
        versus: primary.source,
        status: 'unavailable',
        note: 'This layer has an instrument code but its coordinates are unavailable.',
      });
      continue;
    }
    const delta = coordinateDelta(primary.latitude, primary.longitude, layer.latitude, layer.longitude);
    if (classifyDelta(delta, tolerance) !== 'different') continue;
    offsets.push({
      code: live.code,
      layer: layerName,
      instrumentCode: layer.code,
      versus: primary.source,
      status: 'different',
      latitude: layer.latitudeText,
      longitude: layer.longitudeText,
      ...delta,
    });
  }
  for (const camera of live.webcams) {
    if (camera.latitude == null || camera.longitude == null) {
      if (camera.code) {
        offsets.push({
          code: live.code,
          layer: 'weatherPhoto',
          instrumentCode: camera.code,
          versus: primary.source,
          status: 'unavailable',
          note: 'This weather photo has no coordinates.',
        });
      }
      continue;
    }
    const delta = coordinateDelta(primary.latitude, primary.longitude, camera.latitude, camera.longitude);
    if (classifyDelta(delta, tolerance) !== 'different') continue;
    offsets.push({
      code: live.code,
      layer: 'weatherPhoto',
      instrumentCode: camera.code,
      versus: primary.source,
      status: 'different',
      latitude: camera.latitudeText,
      longitude: camera.longitudeText,
      ...delta,
    });
  }
  return offsets;
}

function groupByCode(stations) {
  const groups = new Map();
  for (const station of stations) {
    const key = station.code.toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(station);
  }
  return groups;
}

function duplicateNameGroups(stations, readName, caseInsensitive) {
  const groups = new Map();
  for (const station of stations) {
    const normalized = normalizeName(readName(station));
    if (!normalized) continue;
    const key = caseInsensitive ? normalized.toLowerCase() : normalized;
    if (!groups.has(key)) groups.set(key, { name: normalized, codes: [] });
    groups.get(key).codes.push(station.code);
  }
  return [...groups.values()]
    .filter((group) => group.codes.length > 1)
    .map((group) => ({ name: group.name, codes: group.codes.slice().sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function identicalCoordinateGroups(stations) {
  const groups = new Map();
  for (const station of stations) {
    if (!station.coordinatesAvailable) continue;
    const key = `${station.latitude.number.toFixed(5)},${station.longitude.number.toFixed(5)}`;
    if (!groups.has(key)) {
      groups.set(key, {
        latitude: station.latitude.raw,
        longitude: station.longitude.raw,
        codes: [],
      });
    }
    groups.get(key).codes.push(station.code);
  }
  return [...groups.values()]
    .filter((group) => group.codes.length > 1)
    .map((group) => ({ ...group, codes: group.codes.slice().sort() }))
    .sort((a, b) => a.codes[0].localeCompare(b.codes[0]));
}

function referenceIndex(liveStations) {
  const index = new Map();
  const add = (code, reference) => {
    if (!code) return;
    const key = String(code).trim().toLowerCase();
    if (!key) return;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(reference);
  };
  for (const station of liveStations) {
    for (const [layerName, layer] of Object.entries(station.layers)) {
      if (!layer.code) continue;
      add(layer.code, {
        stationCode: station.code,
        role: 'layer',
        layer: layerName,
        instrumentCode: layer.code,
      });
    }
    for (const camera of station.webcams) {
      if (!camera.code) continue;
      add(camera.code, {
        stationCode: station.code,
        role: 'webcam',
        instrumentCode: camera.code,
        angle: camera.angle || null,
      });
    }
    if (station.anemometer?.code) {
      add(station.anemometer.code, {
        stationCode: station.code,
        role: 'anemometer',
        instrumentCode: station.anemometer.code,
      });
    }
    if (station.arwfCode) {
      add(station.arwfCode, {
        stationCode: station.code,
        role: 'arwf',
        instrumentCode: station.arwfCode,
      });
    }
  }
  return index;
}

function referencesFor(index, code) {
  const refs = index.get(code.toLowerCase()) || [];
  return refs.filter((reference) => reference.stationCode.toLowerCase() !== code.toLowerCase());
}

function coordinateCompanions(groups, code) {
  const group = groups.find((item) => item.codes.includes(code));
  if (!group) return [];
  return group.codes.filter((other) => other !== code);
}

function compactLive(station, primary) {
  const wind = station.layers.wind;
  return {
    code: station.code,
    configKey: station.key,
    nameEn: normalizeName(station.nameEn),
    nameTc: normalizeName(station.nameTc),
    nameSc: normalizeName(station.nameSc) || null,
    primaryLayer: primary.source,
    latitude: primary.latitudeText,
    longitude: primary.longitudeText,
    wind: wind?.present
      ? {
          instrumentCode: wind.code,
          latitude: wind.coordinatesAvailable ? wind.latitudeText : null,
          longitude: wind.coordinatesAvailable ? wind.longitudeText : null,
          coordinatesUnavailable: wind.coordinatesUnavailable,
        }
      : null,
    photoCodes: station.webcams.map((camera) => camera.code),
    arwfCode: station.arwfCode,
  };
}

export function compareStationMetadata(seedStations, liveStations, {
  toleranceDegrees = DEFAULT_TOLERANCE_DEGREES,
  generatedAt = new Date().toISOString(),
  seedPath = null,
  liveMeta = {},
  mapHost = null,
} = {}) {
  if (!Number.isFinite(toleranceDegrees) || toleranceDegrees < 0) {
    throw new UsageError('--tolerance must be a number greater than or equal to 0');
  }
  const warnings = [];
  for (const seed of seedStations) {
    for (const warning of seed.warnings) warnings.push(`${seed.code}: ${warning}`);
  }

  const seedGroups = groupByCode(seedStations);
  const liveGroups = groupByCode(liveStations);
  const duplicateCodes = [
    ...[...seedGroups.entries()]
      .filter(([, group]) => group.length > 1)
      .map(([code, group]) => ({ side: 'seed', code, codes: group.map((station) => station.code) })),
    ...[...liveGroups.entries()]
      .filter(([, group]) => group.length > 1)
      .map(([code, group]) => ({ side: 'live', code, codes: group.map((station) => station.code) })),
  ];

  const seedNameGroups = {
    english: duplicateNameGroups(seedStations, (station) => station.engName, true),
    chinese: duplicateNameGroups(seedStations, (station) => station.chiName, false),
  };
  const liveNameGroups = {
    english: duplicateNameGroups(liveStations, (station) => station.nameEn, true),
    chinese: duplicateNameGroups(liveStations, (station) => station.nameTc, false),
  };
  const identicalCoordinates = identicalCoordinateGroups(seedStations);
  const references = referenceIndex(liveStations);

  const missingOnLive = [];
  const missingInSeed = [];
  const differences = [];
  const withinTolerance = [];
  const liveOffsets = [];
  let unchanged = 0;

  for (const [code, group] of [...seedGroups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const liveGroup = liveGroups.get(code) || [];
    if (liveGroup.length === 0) {
      for (const seed of group) {
        missingOnLive.push({
          code: seed.code,
          engName: normalizeName(seed.engName),
          chiName: normalizeName(seed.chiName),
          latitude: seed.latitude.raw,
          longitude: seed.longitude.raw,
          windLatitude: seed.windCoordinatesAvailable ? seed.windLatitude.raw : null,
          windLongitude: seed.windCoordinatesAvailable ? seed.windLongitude.raw : null,
          photoCodes: seed.photoCodes,
          references: referencesFor(references, seed.code),
          identicalCoordinatesWith: coordinateCompanions(identicalCoordinates, seed.code),
        });
      }
      continue;
    }
    for (const seed of group) {
      for (const live of liveGroup) {
        const { findings, primary } = diffStation(seed, live, toleranceDegrees);
        const material = findings.filter((finding) => finding.status !== 'withinTolerance');
        const close = findings.filter((finding) => finding.status === 'withinTolerance');
        if (material.length > 0) {
          differences.push({
            code: seed.code,
            liveCode: live.code,
            engName: { seed: normalizeName(seed.engName), live: normalizeName(live.nameEn) },
            chiName: { seed: normalizeName(seed.chiName), live: normalizeName(live.nameTc) },
            primaryLayer: primary.source,
            fields: material,
          });
        }
        if (close.length > 0) {
          withinTolerance.push({ code: seed.code, liveCode: live.code, fields: close });
        }
        if (material.length === 0 && close.length === 0 && group.length === 1 && liveGroup.length === 1) {
          unchanged += 1;
        }
      }
    }
  }

  for (const [code, group] of [...liveGroups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (seedGroups.has(code)) continue;
    for (const live of group) {
      const primary = selectPrimaryCoordinate(live);
      missingInSeed.push(compactLive(live, primary));
    }
  }

  for (const live of liveStations) {
    const primary = selectPrimaryCoordinate(live);
    liveOffsets.push(...liveOffsetsFor(live, primary, toleranceDegrees));
  }
  liveOffsets.sort((a, b) => a.code.localeCompare(b.code) || String(a.layer).localeCompare(String(b.layer)));

  const notes = [
    'The compared metadata is the station-config script loaded by the regional weather portal. Observation files such as latestReadings are not used.',
    `${PROVENANCE.mapEntry} redirects to ${PROVENANCE.mapEntryRedirect}. That index sends browsers to ${PROVENANCE.gisPage}, which redirects to the regional portal.`,
    `The legacy ${PROVENANCE.legacyConfigNotLoaded} file remains on disk, but it sits inside a comment on the pre-redirect page and the current portal does not load it.`,
    'Per-layer coordinates in the station config are the positions the map draws. Temperature and wind sites are kept apart. Empty coordinates stay unavailable and are not coerced to zero.',
  ];
  if (mapHost) {
    notes.push(mapHost.resolved
      ? `${mapHost.hostname} resolved during this run (${mapHost.address}). The station list still comes from the portal script, not from that hostname.`
      : `${mapHost.hostname} did not resolve during this run (${mapHost.error}). The station list comes from the portal script.`);
  }
  if (liveMeta.discoveredFromPortal === false) {
    notes.push('This run did not rediscover the script from the portal HTML. It used the source file or URL given on the command line.');
  }

  return {
    generatedAt,
    toleranceDegrees,
    coverage: COMPARISON_COVERAGE,
    seed: { path: seedPath, count: seedStations.length },
    live: {
      sourceUrl: liveMeta.sourceUrl ?? null,
      requestedUrl: liveMeta.requestedUrl ?? null,
      portalUrl: liveMeta.portalUrl ?? null,
      discoveredFromPortal: Boolean(liveMeta.discoveredFromPortal),
      count: liveStations.length,
      lastModified: liveMeta.lastModified ?? null,
      contentType: liveMeta.contentType ?? null,
    },
    mapHost,
    provenance: { ...PROVENANCE, notes },
    summary: {
      seedCount: seedStations.length,
      liveCount: liveStations.length,
      unchanged,
      missingOnLive: missingOnLive.length,
      missingInSeed: missingInSeed.length,
      fieldDifferenceStations: differences.length,
      withinToleranceStations: withinTolerance.length,
      duplicateCodeGroups: duplicateCodes.length,
      duplicateNameGroups: seedNameGroups.english.length
        + seedNameGroups.chinese.length
        + liveNameGroups.english.length
        + liveNameGroups.chinese.length,
      identicalCoordinateGroups: identicalCoordinates.length,
      liveOffsetCount: liveOffsets.length,
    },
    missingOnLive,
    missingInSeed,
    differences,
    withinTolerance,
    duplicates: {
      codes: duplicateCodes,
      seedNames: seedNameGroups,
      liveNames: liveNameGroups,
      identicalCoordinates,
    },
    liveOffsets,
    warnings,
  };
}

export function hasMaterialDifferences(report, { strict = false } = {}) {
  return report.summary.missingOnLive > 0
    || report.summary.missingInSeed > 0
    || report.summary.fieldDifferenceStations > 0
    || report.summary.duplicateCodeGroups > 0
    || (strict && report.summary.withinToleranceStations > 0);
}

function quote(value) {
  if (value == null || value === '') return 'unavailable';
  return JSON.stringify(value);
}

function formatDistance(meters) {
  if (meters == null) return '';
  if (meters >= 1000) return `${roundTo(meters / 1000, 2)} km`;
  if (meters > 0 && meters < 0.01) return '<0.01 m';
  return `${roundTo(meters, 2)} m`;
}

function formatField(finding) {
  if (finding.field === 'engName') {
    return `English name: seed ${quote(finding.seed)} / live ${quote(finding.live)}`;
  }
  if (finding.field === 'chiName') {
    return `Chinese name: seed ${quote(finding.seed)} / live ${quote(finding.live)}`;
  }
  if (finding.field === 'code' || finding.field === 'configKey') {
    return `${finding.field}: seed ${quote(finding.seed)} / live ${quote(finding.live)}`;
  }
  if (finding.field === 'photoCodes') {
    return `photo codes: seed ${quote(finding.seed)} / live ${quote(finding.live)}`;
  }
  if (finding.field === 'webcamAngle') {
    const liveLabel = finding.liveDirection ? `${finding.live} (${finding.liveDirection})` : finding.live;
    return `webcam bearing: seed ${finding.seedDegrees ?? finding.seed}° / live ${liveLabel}${finding.liveDegrees != null ? ` = ${finding.liveDegrees}°` : ''}`;
  }
  if (finding.field === 'coordinates' || finding.field === 'windCoordinates' || finding.field === 'temperatureCoordinates') {
    const label = finding.field === 'windCoordinates'
      ? 'wind coordinates'
      : finding.field === 'temperatureCoordinates'
        ? 'temperature coordinates'
        : 'coordinates';
    const layer = finding.layer ? ` [${finding.layer}${finding.instrumentCode ? ` ${finding.instrumentCode}` : ''}]` : '';
    if (finding.status === 'unavailable') {
      return `${label}${layer}: seed ${formatPoint(finding.seed)} / live ${formatPoint(finding.live)} (unavailable)`;
    }
    const gap = `${finding.deltaLat}° lat, ${finding.deltaLng}° lng, ${formatDistance(finding.distanceMeters)}`;
    const status = finding.status === 'withinTolerance' ? 'within tolerance' : 'differ';
    return `${label}${layer} ${status} by ${gap}: seed ${formatPoint(finding.seed)} / live ${formatPoint(finding.live)}`;
  }
  return `${finding.field}: ${finding.status}`;
}

function formatPoint(value) {
  if (value == null) return 'unavailable';
  if (value.latitude == null || value.longitude == null) return 'unavailable';
  return `${value.latitude}, ${value.longitude}`;
}

function formatReference(reference) {
  if (reference.role === 'layer') {
    return `referenced by ${reference.stationCode} as ${reference.layer} instrument ${reference.instrumentCode}`;
  }
  if (reference.role === 'webcam') {
    return `referenced by ${reference.stationCode} as weather photo ${reference.instrumentCode}`;
  }
  if (reference.role === 'anemometer') {
    return `referenced by ${reference.stationCode} as anemometer ${reference.instrumentCode}`;
  }
  if (reference.role === 'arwf') {
    return `referenced by ${reference.stationCode} as ARWF code ${reference.instrumentCode}`;
  }
  return `referenced by ${reference.stationCode}`;
}

function writeList(lines, title, entries, render) {
  lines.push(title);
  if (entries.length === 0) {
    lines.push('  none');
    lines.push('');
    return;
  }
  for (const entry of entries) render(entry);
  lines.push('');
}

export function formatTextReport(report) {
  const lines = [];
  lines.push('Weather station metadata comparison');
  lines.push(`Seed: ${report.seed.path || '(memory)'} (${report.seed.count} stations)`);
  lines.push(`Live: ${report.live.sourceUrl || '(memory)'} (${report.live.count} stations)`);
  if (report.live.portalUrl) lines.push(`Portal: ${report.live.portalUrl}`);
  if (report.live.lastModified) lines.push(`Live Last-Modified: ${report.live.lastModified}`);
  lines.push(`Tolerance: ${report.toleranceDegrees} degrees`);
  lines.push('');
  lines.push('Sources');
  for (const note of report.provenance.notes) lines.push(`  ${note}`);
  lines.push('');

  writeList(lines, `Missing on the map (${report.missingOnLive.length})`, report.missingOnLive, (station) => {
    lines.push(`  ${station.code}  ${station.engName || 'unavailable'} / ${station.chiName || 'unavailable'}`);
    lines.push(`    seed coordinates: ${formatPoint(station.latitude == null ? null : { latitude: station.latitude, longitude: station.longitude })}`);
    if (station.references.length === 0) {
      lines.push('    no reference in the live station config');
    } else {
      for (const reference of station.references) lines.push(`    ${formatReference(reference)}`);
    }
    if (station.identicalCoordinatesWith.length > 0) {
      lines.push(`    same seed coordinates as ${station.identicalCoordinatesWith.join(', ')}`);
    }
  });

  writeList(lines, `Missing in the seed (${report.missingInSeed.length})`, report.missingInSeed, (station) => {
    lines.push(`  ${station.code}  ${station.nameEn || 'unavailable'} / ${station.nameTc || 'unavailable'}`);
    lines.push(`    live ${station.primaryLayer || 'position unavailable'}: ${formatPoint(station.latitude == null ? null : station)}`);
  });

  writeList(lines, `Duplicate codes (${report.duplicates.codes.length})`, report.duplicates.codes, (group) => {
    lines.push(`  ${group.side} ${group.code}: ${group.codes.join(', ')}`);
  });

  const nameGroups = [
    ...report.duplicates.seedNames.english.map((group) => ({ side: 'seed English', ...group })),
    ...report.duplicates.seedNames.chinese.map((group) => ({ side: 'seed Chinese', ...group })),
    ...report.duplicates.liveNames.english.map((group) => ({ side: 'live English', ...group })),
    ...report.duplicates.liveNames.chinese.map((group) => ({ side: 'live Chinese', ...group })),
  ];
  writeList(lines, `Duplicate names (${nameGroups.length})`, nameGroups, (group) => {
    lines.push(`  ${group.side} "${group.name}": ${group.codes.join(', ')}`);
  });
  writeList(
    lines,
    `Seed stations with the same coordinates (${report.duplicates.identicalCoordinates.length})`,
    report.duplicates.identicalCoordinates,
    (group) => {
      lines.push(`  ${group.codes.join(', ')} at ${group.latitude}, ${group.longitude}`);
    },
  );

  writeList(lines, `Field differences (${report.differences.length})`, report.differences, (station) => {
    lines.push(`  ${station.code}`);
    for (const finding of station.fields) {
      lines.push(`    ${formatField(finding)}`);
      if (finding.note) lines.push(`      ${finding.note}`);
    }
  });

  writeList(lines, `Within tolerance (${report.withinTolerance.length})`, report.withinTolerance, (station) => {
    lines.push(`  ${station.code}`);
    for (const finding of station.fields) lines.push(`    ${formatField(finding)}`);
  });

  const offsetPreview = report.liveOffsets.slice(0, 40);
  writeList(
    lines,
    `Live layer or camera positions away from the station pin (${report.liveOffsets.length})`,
    offsetPreview,
    (offset) => {
      if (offset.status === 'unavailable') {
        lines.push(`  ${offset.code} ${offset.layer} ${offset.instrumentCode || ''}: coordinates unavailable`);
        return;
      }
      lines.push(`  ${offset.code} ${offset.layer} ${offset.instrumentCode}: ${offset.deltaLat}° lat, ${offset.deltaLng}° lng, ${formatDistance(offset.distanceMeters)} from ${offset.versus} (${offset.latitude}, ${offset.longitude})`);
    },
  );
  if (report.liveOffsets.length > offsetPreview.length) {
    lines.push(`  … ${report.liveOffsets.length - offsetPreview.length} more in the JSON report`);
    lines.push('');
  }

  if (report.warnings.length > 0) {
    lines.push('Warnings');
    for (const warning of report.warnings) lines.push(`  ${warning}`);
    lines.push('');
  }

  const summary = report.summary;
  lines.push(
    `Summary: ${summary.unchanged} unchanged, ${summary.missingOnLive} missing on the map, ${summary.missingInSeed} missing in the seed, ${summary.fieldDifferenceStations} with field differences, ${summary.withinToleranceStations} within tolerance, ${summary.duplicateCodeGroups} duplicate code groups, ${summary.liveOffsetCount} live position offsets.`,
  );
  lines.push('Names were compared after Unicode NFC and whitespace collapsing. Abbreviations such as "HK" and "Hong Kong" are not folded together. Empty coordinates are unavailable, not zero.');
  return lines.join('\n');
}

export function extractActiveAwsConfigPath(html) {
  const withoutComments = String(html).replace(/<!--[\s\S]*?-->/g, '');
  const text = withoutComments
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed && !trimmed.startsWith('//');
    })
    .join('\n');
  const pattern = /['"]([^'"]*?station-config-aws\.js)(?:\?[^'"]*)?['"]/gi;
  const paths = [];
  let match = pattern.exec(text);
  while (match) {
    paths.push(match[1]);
    match = pattern.exec(text);
  }
  const unique = [...new Set(paths)];
  if (unique.length === 0) {
    throw new Error('Portal HTML has no active station-config-aws.js script. Readings files and the legacy config are not used as substitutes.');
  }
  const irwip = unique.filter((item) => item.endsWith('irwip-station-config-aws.js'));
  if (irwip.length === 1) return irwip[0];
  if (irwip.length > 1) {
    throw new Error(`Portal HTML references more than one irwip station config: ${irwip.join(', ')}`);
  }
  if (unique.length === 1) return unique[0];
  throw new Error(`Portal HTML references more than one station-config-aws.js script: ${unique.join(', ')}`);
}

export function assertRemoteSourceUrl(url, { allowAnyHttps = false } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Refusing non-HTTPS station source: ${url}`);
  }
  if (!allowAnyHttps && !ALLOWED_CONFIG_HOSTS.has(parsed.hostname)) {
    throw new Error(`Refusing station metadata URL on ${parsed.hostname}. Discovery only follows Hong Kong Observatory hosts. Pass --source to name a different https URL.`);
  }
  return parsed.href;
}

export async function fetchText(url, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch, maxBytes = 2_000_000 } = {}) {
  const response = await fetchImpl(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      accept: '*/*',
      'user-agent': 'weatherindoubt-station-metadata-compare/1.0',
    },
  });
  if (!response.ok) {
    throw new Error(`GET ${url} failed with HTTP ${response.status}`);
  }
  const text = await response.text();
  if (text.length > maxBytes) throw new Error(`GET ${url} exceeded ${maxBytes} characters`);
  return {
    requestedUrl: url,
    finalUrl: response.url || url,
    text,
    lastModified: typeof response.headers?.get === 'function' ? response.headers.get('last-modified') : null,
    contentType: typeof response.headers?.get === 'function' ? response.headers.get('content-type') : null,
    status: response.status,
  };
}

export async function loadLiveStationConfig(options, { fetchImpl = globalThis.fetch } = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const variableName = options.configVar || DEFAULT_CONFIG_VARIABLE;
  if (options.sourceUrl) {
    const sourceUrl = assertRemoteSourceUrl(options.sourceUrl, { allowAnyHttps: true });
    const body = await fetchText(sourceUrl, { timeoutMs, fetchImpl });
    return {
      stations: parseStationConfigSource(body.text, { variableName, timeoutMs }),
      sourceUrl: body.finalUrl,
      requestedUrl: body.requestedUrl,
      portalUrl: null,
      discoveredFromPortal: false,
      lastModified: body.lastModified,
      contentType: body.contentType,
    };
  }

  const portalUrl = assertRemoteSourceUrl(options.portalUrl || DEFAULT_PORTAL_URL);
  const portal = await fetchText(portalUrl, { timeoutMs, fetchImpl });
  const relativePath = extractActiveAwsConfigPath(portal.text);
  const sourceUrl = assertRemoteSourceUrl(new URL(relativePath, portal.finalUrl).href);
  const config = await fetchText(sourceUrl, { timeoutMs, fetchImpl });
  return {
    stations: parseStationConfigSource(config.text, { variableName, timeoutMs }),
    sourceUrl: config.finalUrl,
    requestedUrl: config.requestedUrl,
    portalUrl: portal.finalUrl,
    discoveredFromPortal: true,
    lastModified: config.lastModified,
    contentType: config.contentType,
  };
}

export async function describeMapHost(hostname = PROVENANCE.mapHost, { lookupImpl = dnsLookup, timeoutMs = 3000 } = {}) {
  let timer;
  try {
    const result = await Promise.race([
      lookupImpl(hostname),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('timeout');
          error.code = 'ETIMEOUT';
          reject(error);
        }, timeoutMs);
      }),
    ]);
    return { hostname, resolved: true, address: result.address };
  } catch (error) {
    return { hostname, resolved: false, error: error.code || error.message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runComparison(options, deps = {}) {
  const seedText = await readFile(options.seedPath, 'utf8');
  let seedJson;
  try {
    seedJson = JSON.parse(seedText);
  } catch (error) {
    throw new Error(`Seed file is not valid JSON: ${error.message}`);
  }
  const seedStations = normalizeSeedRows(seedJson);
  let liveMeta;
  if (options.sourceFile) {
    const text = await readFile(options.sourceFile, 'utf8');
    liveMeta = {
      stations: parseStationConfigSource(text, { variableName: options.configVar || DEFAULT_CONFIG_VARIABLE }),
      sourceUrl: pathToFileURL(path.resolve(options.sourceFile)).href,
      requestedUrl: null,
      portalUrl: null,
      discoveredFromPortal: false,
      lastModified: null,
      contentType: 'application/javascript',
    };
  } else {
    liveMeta = await loadLiveStationConfig(options, deps);
  }
  const mapHost = options.skipMapHostCheck || options.sourceFile
    ? null
    : await describeMapHost(PROVENANCE.mapHost, deps);
  const { stations, ...meta } = liveMeta;
  return compareStationMetadata(seedStations, stations, {
    toleranceDegrees: options.tolerance,
    generatedAt: options.now || new Date().toISOString(),
    seedPath: options.seedPath,
    liveMeta: meta,
    mapHost,
  });
}

function takeValue(args, flag) {
  const value = args.shift();
  if (value == null || value.startsWith('--')) {
    throw new UsageError(`${flag} requires a value`);
  }
  return value;
}

export function parseArgs(argv) {
  const options = {
    help: false,
    seedPath: null,
    portalUrl: DEFAULT_PORTAL_URL,
    sourceUrl: null,
    sourceFile: null,
    configVar: DEFAULT_CONFIG_VARIABLE,
    tolerance: DEFAULT_TOLERANCE_DEGREES,
    jsonPath: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    strict: false,
    exitZero: false,
    skipMapHostCheck: false,
  };
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    const [flag, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, null];
    const value = () => inline ?? takeValue(args, flag);
    switch (flag) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--seed':
        options.seedPath = value();
        break;
      case '--portal':
        options.portalUrl = value();
        break;
      case '--source':
        options.sourceUrl = value();
        break;
      case '--source-file':
        options.sourceFile = value();
        break;
      case '--config-var':
        options.configVar = value();
        break;
      case '--tolerance': {
        const parsed = Number(value());
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new UsageError('--tolerance must be a number greater than or equal to 0');
        }
        options.tolerance = parsed;
        break;
      }
      case '--json':
        options.jsonPath = value();
        break;
      case '--timeout': {
        const parsed = Number(value());
        if (!Number.isInteger(parsed) || parsed <= 0) throw new UsageError('--timeout must be a positive integer number of milliseconds');
        options.timeoutMs = parsed;
        break;
      }
      case '--strict':
        options.strict = true;
        break;
      case '--exit-zero':
        options.exitZero = true;
        break;
      case '--skip-map-host-check':
        options.skipMapHostCheck = true;
        break;
      default:
        throw new UsageError(`Unknown argument: ${arg}`);
    }
  }
  if (options.sourceUrl && options.sourceFile) {
    throw new UsageError('Use either --source or --source-file, not both');
  }
  return options;
}
