import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  compareStationMetadata,
  extractActiveAwsConfigPath,
  hasMaterialDifferences,
  loadLiveStationConfig,
  normalizeName,
  normalizeSeedRows,
  parseArgs,
  parseCoordinate,
  parseStationConfigSource,
  UsageError,
} from '../scripts/lib/station-metadata-compare.js';

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/compare-station-metadata.js');
const configText = readFileSync(path.join(fixtureDir, 'station-config.txt'), 'utf8');
const seedRows = JSON.parse(readFileSync(path.join(fixtureDir, 'seed-stations.json'), 'utf8'));

function compareFixtures(tolerance = 0.0001) {
  return compareStationMetadata(
    normalizeSeedRows(seedRows),
    parseStationConfigSource(configText),
    { toleranceDegrees: tolerance, seedPath: 'test/fixtures/seed-stations.json' },
  );
}

describe('normalization', () => {
  it('collapses whitespace without folding abbreviations or parentheticals', () => {
    assert.equal(normalizeName('  Hong Kong \n Observatory '), 'Hong Kong Observatory');
    assert.notEqual(normalizeName('HK Observatory'), normalizeName('Hong Kong Observatory'));
    assert.notEqual(normalizeName('大埔 (YCT)'), normalizeName('大埔'));
  });

  it('treats an empty coordinate as unavailable rather than zero', () => {
    assert.equal(parseCoordinate('').unavailable, true);
    assert.equal(parseCoordinate('').number, null);
    assert.equal(parseCoordinate('NA').unavailable, true);
    assert.deepEqual(parseCoordinate('0'), { number: 0, raw: '0', unavailable: false, invalid: false });
    assert.equal(parseCoordinate('south').invalid, true);
  });
});

describe('station config parser', () => {
  it('reads the HKO assignment format inside a sandbox', () => {
    const stations = parseStationConfigSource(configText);
    const hko = stations.find((station) => station.code === 'hko');
    assert.equal(hko.nameTc, '香港天文台');
    assert.equal(hko.layers.temp.instrumentCode ?? hko.layers.temp.code, 'hkoc');
    assert.equal(hko.layers.wind.present, false);
    const leaked = parseStationConfigSource(`
      var stationConfigAWS = [];
      stationConfigAWS["a"] = {
        code: "a",
        name_EN: typeof process,
        name_TC: typeof require,
        temp: { code: "a", latitude: "22", longitude: "114" }
      };
    `);
    assert.equal(leaked[0].nameEn, 'undefined');
    assert.equal(leaked[0].nameTc, 'undefined');
  });

  it('rejects a source that does not define the station table', () => {
    assert.throws(() => parseStationConfigSource('var somethingElse = 1;'), /did not define stationConfigAWS/);
    assert.throws(() => parseStationConfigSource('throw new Error("boom")'), /boom/);
  });
});

describe('comparison', () => {
  it('reports names, bearings, separate wind coordinates, and unavailable values', () => {
    const report = compareFixtures();
    const hko = report.differences.find((station) => station.code === 'hko');
    assert.equal(hko.fields.some((field) => field.field === 'engName'), true);
    assert.equal(hko.fields.some((field) => field.field === 'chiName'), false);
    assert.equal(hko.fields.some((field) => field.field === 'webcamAngle'), false);

    const lam = report.differences.find((station) => station.code === 'lam');
    const bearing = lam.fields.find((field) => field.field === 'webcamAngle');
    assert.equal(bearing.seedDegrees, 315);
    assert.equal(bearing.liveDegrees, 0);
    assert.equal(lam.fields.some((field) => field.field === 'coordinates'), false);

    const cch = report.differences.find((station) => station.code === 'cch');
    assert.equal(cch, undefined);
    const sty = report.differences.find((station) => station.code === 'sty');
    assert.equal(sty, undefined);

    const cwbDiff = report.differences.find((station) => station.code === 'cwb');
    assert.equal(cwbDiff, undefined);
    const cwbClose = report.withinTolerance.find((station) => station.code === 'cwb');
    assert.equal(cwbClose.fields[0].field, 'coordinates');
    assert.equal(cwbClose.fields[0].layer, 'temp');
    assert.ok(cwbClose.fields[0].deltaLat > 0);
    assert.ok(cwbClose.fields[0].deltaLat <= 0.0001);

    assert.equal(report.missingOnLive.map((station) => station.code).join(','), 'cwa');
    assert.match(JSON.stringify(report.missingOnLive[0].references), /webcam/);
    assert.deepEqual(report.missingInSeed.map((station) => station.code), ['onlylive']);
    assert.equal(hasMaterialDifferences(report), true);
    assert.equal(hasMaterialDifferences(report, { strict: true }), true);
  });

  it('does not match an empty coordinate to latitude zero', () => {
    const live = parseStationConfigSource(`
      var stationConfigAWS = [];
      stationConfigAWS["zero"] = {
        code: "zero",
        name_EN: "Zero",
        name_TC: "零",
        temp: { code: "", latitude: "", longitude: "", mustDisplay: false },
        wind: { code: "zero", latitude: "0", longitude: "0", mustDisplay: false }
      };
      stationConfigAWS["blank"] = {
        code: "blank",
        name_EN: "Blank",
        name_TC: "空",
        temp: { code: "blank", latitude: "", longitude: "", mustDisplay: false },
        wind: { code: "", latitude: "", longitude: "", mustDisplay: false }
      };
    `);
    const seed = normalizeSeedRows([
      { code: 'zero', eng_name: 'Zero', chi_name: '零', lat: '', lng: '', wind_lat: '0', wind_lng: '0' },
      { code: 'blank', eng_name: 'Blank', chi_name: '空', lat: '0', lng: '0' },
    ]);
    const report = compareStationMetadata(seed, live, { toleranceDegrees: 0 });
    const zero = report.differences.find((station) => station.code === 'zero');
    const zeroCoordinates = zero.fields.find((field) => field.field === 'coordinates');
    assert.equal(zeroCoordinates.status, 'unavailable');
    assert.equal(zeroCoordinates.seed, null);
    assert.equal(zero.fields.some((field) => field.field === 'windCoordinates' && field.status !== 'match'), false);

    const blank = report.differences.find((station) => station.code === 'blank');
    const blankCoordinates = blank.fields.find((field) => field.field === 'coordinates');
    assert.equal(blankCoordinates.status, 'unavailable');
    assert.equal(blankCoordinates.live, null);
    assert.equal(blank.fields.some((field) => field.distanceMeters === 0), false);
    const temperature = blank.fields.find((field) => field.field === 'temperatureCoordinates');
    assert.equal(temperature.status, 'unavailable');
    assert.equal(temperature.instrumentCode, 'blank');
  });

  it('keeps a distinct wind site out of the temperature comparison', () => {
    const live = parseStationConfigSource(`
      var stationConfigAWS = [];
      stationConfigAWS["tu1"] = {
        code: "tu1",
        name_EN: "Tuen Mun",
        name_TC: "屯門",
        temp: { code: "tu1", latitude: "22.385906", longitude: "113.964178", mustDisplay: true },
        wind: { code: "tun", latitude: "22.39056", longitude: "113.9766667", mustDisplay: false }
      };
    `);
    const seed = normalizeSeedRows([{
      code: 'tu1',
      eng_name: 'Tuen Mun',
      chi_name: '屯門',
      lat: '22.385906',
      lng: '113.964178',
    }]);
    const report = compareStationMetadata(seed, live, { toleranceDegrees: 0.0001 });
    const fields = report.differences[0].fields;
    assert.equal(fields.some((field) => field.field === 'coordinates'), false);
    const wind = fields.find((field) => field.field === 'windCoordinates');
    assert.equal(wind.status, 'different');
    assert.equal(wind.instrumentCode, 'tun');
    assert.equal(wind.seed, null);
    assert.ok(wind.distanceMeters > 1000);
  });

  it('uses tolerance on each axis and can treat a boundary gap as within tolerance', () => {
    const live = parseStationConfigSource(`
      var stationConfigAWS = [];
      stationConfigAWS["edge"] = {
        code: "edge",
        name_EN: "Edge",
        name_TC: "邊",
        temp: { code: "edge", latitude: "22.0001", longitude: "114" }
      };
      stationConfigAWS["over"] = {
        code: "over",
        name_EN: "Over",
        name_TC: "過",
        temp: { code: "over", latitude: "22.0002", longitude: "114" }
      };
    `);
    const seed = normalizeSeedRows([
      { code: 'edge', eng_name: 'Edge', chi_name: '邊', lat: '22', lng: '114' },
      { code: 'over', eng_name: 'Over', chi_name: '過', lat: '22', lng: '114' },
    ]);
    const report = compareStationMetadata(seed, live, { toleranceDegrees: 0.0001 });
    assert.equal(report.withinTolerance.map((station) => station.code).join(','), 'edge');
    assert.equal(report.differences.map((station) => station.code).join(','), 'over');
    assert.equal(hasMaterialDifferences(report), true);
    const edgeOnly = compareStationMetadata(seed.slice(0, 1), live.slice(0, 1), { toleranceDegrees: 0.0001 });
    assert.equal(hasMaterialDifferences(edgeOnly), false);
    assert.equal(hasMaterialDifferences(edgeOnly, { strict: true }), true);
  });

  it('flags duplicate codes and identical coordinates without hiding them in the name match', () => {
    const live = parseStationConfigSource(`
      var stationConfigAWS = [];
      stationConfigAWS["hko"] = {
        code: "hko", name_EN: "A", name_TC: "甲",
        temp: { code: "hko", latitude: "22", longitude: "114" }
      };
    `);
    const seed = normalizeSeedRows([
      { code: 'hko', eng_name: 'A', chi_name: '甲', lat: '22', lng: '114' },
      { code: 'HKO', eng_name: 'A', chi_name: '甲', lat: '22', lng: '114' },
    ]);
    const report = compareStationMetadata(seed, live, { toleranceDegrees: 0 });
    assert.equal(report.duplicates.codes.length, 1);
    assert.equal(report.duplicates.identicalCoordinates.length, 1);
    assert.equal(hasMaterialDifferences(report), true);
    const caseDifference = report.differences.find((station) => station.code === 'HKO');
    assert.equal(caseDifference.fields[0].field, 'code');
  });

  it('reports a camera that is plotted away from the station pin', () => {
    const live = parseStationConfigSource(`
      var stationConfigAWS = [];
      stationConfigAWS["cs1"] = {
        code: "cs1",
        name_EN: "Cheung Sha",
        name_TC: "長沙",
        temp: { code: "", latitude: "", longitude: "" },
        wind: { code: "", latitude: "", longitude: "" },
        weatherPhoto: { webcam: [
          { code: "cs1", latitude: "22.235963", longitude: "113.954451", angle: "nw" },
          { code: "cs2", latitude: "22.303056", longitude: "114.160278", angle: "n" }
        ] }
      };
    `);
    const seed = normalizeSeedRows([{
      code: 'cs1',
      eng_name: 'Cheung Sha',
      chi_name: '長沙',
      lat: '22.235963',
      lng: '113.954451',
      photo_code: 'cs1,cs2',
      webcam_angle: 0,
    }]);
    const report = compareStationMetadata(seed, live, { toleranceDegrees: 0.0001 });
    assert.equal(report.differences.length, 0);
    const offset = report.liveOffsets.find((item) => item.instrumentCode === 'cs2');
    assert.equal(offset.layer, 'weatherPhoto');
    assert.ok(offset.distanceMeters > 10000);
  });
});

describe('portal discovery', () => {
  it('follows the active aws script and ignores commented legacy files', async () => {
    const html = readFileSync(path.join(fixtureDir, 'portal-snippet.html'), 'utf8');
    assert.equal(extractActiveAwsConfigPath(html), 'files/irwip-station-config-aws.js');
    assert.throws(() => extractActiveAwsConfigPath('<html><script src="latestReadings_AWS1_v2.txt"></script></html>'), /no active station-config-aws/);

    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      if (String(url).includes('regional_portal.html')) {
        return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
      }
      if (String(url).endsWith('/files/irwip-station-config-aws.js')) {
        return new Response(configText, {
          status: 200,
          headers: {
            'content-type': 'application/javascript',
            'last-modified': 'Thu, 09 Jul 2026 02:20:02 GMT',
          },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    const loaded = await loadLiveStationConfig({
      portalUrl: 'https://www.hko.gov.hk/en/wxinfo/awsgis/regional_portal.html',
      timeoutMs: 1000,
    }, { fetchImpl });
    assert.equal(loaded.discoveredFromPortal, true);
    assert.match(loaded.sourceUrl, /irwip-station-config-aws\.js$/);
    assert.equal(loaded.lastModified, 'Thu, 09 Jul 2026 02:20:02 GMT');
    assert.equal(loaded.stations.some((station) => station.code === 'hko'), true);
    assert.equal(calls.some((url) => url.includes('station-config-rmn') || url.includes('latestReadings')), false);
  });
});

describe('command line', () => {
  it('parses options and rejects conflicting sources', () => {
    const options = parseArgs(['--seed', 'db/weather_stations.json', '--tolerance=0', '--json', '-', '--strict']);
    assert.equal(options.tolerance, 0);
    assert.equal(options.jsonPath, '-');
    assert.equal(options.strict, true);
    assert.throws(() => parseArgs(['--source', 'https://example.com/a.js', '--source-file', 'a.js']), UsageError);
    assert.throws(() => parseArgs(['--tolerance', '-1']), UsageError);
    assert.throws(() => parseArgs(['--nope']), UsageError);
  });

  it('prints help and writes a JSON report for fixtures', () => {
    const help = spawnSync(process.execPath, [scriptPath, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /--seed/);
    assert.match(help.stdout, /irwip-station-config-aws\.js/);

    const unknown = spawnSync(process.execPath, [scriptPath, '--nope'], { encoding: 'utf8' });
    assert.equal(unknown.status, 2);

    const directory = mkdtempSync(path.join(tmpdir(), 'station-metadata-'));
    const jsonPath = path.join(directory, 'report.json');
    const result = spawnSync(process.execPath, [
      scriptPath,
      '--seed', path.join(fixtureDir, 'seed-stations.json'),
      '--source-file', path.join(fixtureDir, 'station-config.txt'),
      '--json', jsonPath,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /Hong Kong Observatory/);
    assert.match(result.stdout, /referenced by cwb as weather photo CWA/);
    assert.match(result.stdout, /Within tolerance/);
    const report = JSON.parse(readFileSync(jsonPath, 'utf8'));
    assert.equal(report.live.discoveredFromPortal, false);
    assert.equal(report.coverage.compared.some((item) => item.includes('wind')), true);
    assert.equal(report.mapHost, null);
  });
});
