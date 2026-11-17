#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  formatTextReport,
  hasMaterialDifferences,
  parseArgs,
  runComparison,
  UsageError,
} from './lib/station-metadata-compare.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const HELP = `Compare weather station seed data with the station metadata used by the HKO regional weather map.

The public hostname map.hko.gov.hk does not serve this map. https://maps.hko.gov.hk/
redirects to https://maps.weather.gov.hk/, which sends browsers to the regional GIS page
and then to the portal. The portal loads files/irwip-station-config-aws.js. That script
holds station codes, English/Traditional/Simplified names, and coordinates for each
weather element, including separate temperature and wind positions. This command compares
that metadata with db/weather_stations.json. It does not compare live temperature or wind
readings, and it does not write the seed file or the database.

Usage
  node scripts/compare-station-metadata.js [options]

Options
  --seed <path>           Seed JSON array. Default: db/weather_stations.json
  --portal <url>          Portal HTML used to discover the station-config script.
                          Default: the regional weather portal.
  --source <url>          Use this HTTPS station-config URL instead of portal discovery.
  --source-file <path>    Read station-config JavaScript from a local file.
  --config-var <name>     Global assigned by that file. Default: stationConfigAWS
  --tolerance <degrees>   Coordinate tolerance on each axis. Default: 0.0001
  --json <path>           Write the machine-readable report. Use - for stdout.
  --timeout <ms>          HTTP timeout. Default: 30000
  --strict                Treat within-tolerance coordinate gaps as failures.
  --exit-zero             Exit 0 after a successful comparison even when stations differ.
  --skip-map-host-check   Do not resolve map.hko.gov.hk. Local --source-file runs skip it.
  -h, --help              Show this help.

Exit codes
  0  Comparison finished and the compared fields agree.
  1  Comparison finished with a station missing on either side, a field difference,
     or a duplicate station code. Within-tolerance gaps and live layer offsets do
     not change this code unless --strict is set.
  2  The command could not read the seed or the live metadata.

What is compared
  Codes, English names, Traditional Chinese names, station coordinates, wind
  coordinates, photo codes, and the bearing of a single webcam. Names are normalized
  with Unicode NFC and collapsed whitespace only. "HK Observatory" and
  "Hong Kong Observatory" stay different. Empty coordinates are unavailable, not zero.
  Temperature and wind positions are compared separately.

Examples
  node scripts/compare-station-metadata.js
  node scripts/compare-station-metadata.js --json reports/station-metadata.json
  node scripts/compare-station-metadata.js --tolerance 0 --strict
  node scripts/compare-station-metadata.js --seed db/weather_stations.json --source-file ./station-config.js --json -

See scripts/COMPARE_STATION_METADATA.md for the map URL chain and the fields left out.
`;

function resolveSeedPath(seedPath) {
  if (seedPath) return path.resolve(seedPath);
  const fromCwd = path.resolve('db/weather_stations.json');
  if (existsSync(fromCwd)) return fromCwd;
  return path.join(repoRoot, 'db', 'weather_stations.json');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  options.seedPath = resolveSeedPath(options.seedPath);
  const report = await runComparison(options);
  const text = formatTextReport(report);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.jsonPath === '-') {
    process.stderr.write(`${text}\n`);
    process.stdout.write(json);
  } else {
    process.stdout.write(`${text}\n`);
    if (options.jsonPath) {
      await writeFile(options.jsonPath, json);
      process.stdout.write(`Wrote ${options.jsonPath}\n`);
    }
  }
  if (options.exitZero) return 0;
  return hasMaterialDifferences(report, { strict: options.strict }) ? 1 : 0;
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
    });
}
