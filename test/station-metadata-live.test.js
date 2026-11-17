import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORTAL_URL, runComparison } from '../scripts/lib/station-metadata-compare.js';

const seedPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db/weather_stations.json');

const enabled = process.env.COMPARE_STATIONS_LIVE === '1';

describe('live HKO station metadata', { skip: enabled ? false : 'set COMPARE_STATIONS_LIVE=1 to fetch the map portal' }, () => {
  it('loads the station script referenced by the regional portal', { timeout: 60000 }, async () => {
    const report = await runComparison({
      seedPath,
      portalUrl: DEFAULT_PORTAL_URL,
      tolerance: 0.0001,
      configVar: 'stationConfigAWS',
      timeoutMs: 30000,
    });
    assert.equal(report.live.discoveredFromPortal, true);
    assert.match(report.live.sourceUrl, /\/files\/irwip-station-config-aws\.js$/);
    assert.ok(report.live.count >= 50);
    assert.equal(report.seed.count, report.summary.seedCount);
    assert.equal(report.missingInSeed.some((station) => station.code.toLowerCase() === 'hko'), false);
    assert.equal(report.missingOnLive.some((station) => station.code.toLowerCase() === 'hko'), false);
    assert.equal(report.mapHost.hostname, 'map.hko.gov.hk');
    assert.equal(typeof report.mapHost.resolved, 'boolean');
  });
});
