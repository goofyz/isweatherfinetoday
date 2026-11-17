# Compare weather station seed data with the HKO map

`scripts/compare-station-metadata.js` compares `db/weather_stations.json` with the station metadata drawn by the Hong Kong Observatory regional weather map. It reports stations missing on either side, duplicate codes and names, and differences in the fields both sides actually share.

The script only reads data. It does not update the seed file, the database, or Redis, and it does not start the scheduler.

## Where the live metadata comes from

`map.hko.gov.hk` is not the map. That hostname does not resolve in public DNS (the script checks this on a live run and records the result). The public entry point is:

1. `https://maps.hko.gov.hk/` returns a 301 to `https://maps.weather.gov.hk/`.
2. `https://maps.weather.gov.hk/index_e.html` sends the browser to `https://www.hko.gov.hk/en/wxinfo/awsgis/regional_weather_gis.html`.
3. That page immediately redirects to `https://www.hko.gov.hk/en/wxinfo/awsgis/regional_portal.html`.
4. The portal's active script tag loads `files/irwip-station-config-aws.js`, resolved as `https://www.hko.gov.hk/en/wxinfo/awsgis/files/irwip-station-config-aws.js`.

That file is a JavaScript object, `stationConfigAWS`, keyed by station code. Each station has English, Traditional Chinese, and Simplified Chinese names, plus a coordinate pair for every instrument layer (`temp`, `rh`, `wind`, `grass`, `visibility`, `mslp`, solar layers, `hkhi`) and for each weather photo. An empty `code` or an empty latitude/longitude means that layer is not available. The same file also carries webcam direction, an anemometer block, and an `ARWF_code` forecast-area pointer.

The portal HTML is fetched on every default run, and the script URL is taken from the active `station-config-aws.js` reference. Commented markup is ignored. Discovery refuses any URL that is not an `https` Hong Kong Observatory host, so a changed page cannot silently switch the comparison to a readings file or another site.

These are not the map's station list, and the script does not compare them:

- `https://www.hko.gov.hk/wxinfo/awsgis/latestReadings_AWS1_v2.txt`, the observation feed already used by `src/jobs/weather-station-updater.js`. Those rows are temperature, wind, and humidity readings, not station metadata.
- `https://www.hko.gov.hk/en/wxinfo/awsgis/files/station-config-aws.js`, an older config. It is still on the server, but on the pre-redirect page it sits inside an HTML comment. The portal does not load it. `files/station-config-rmn.js` (ambient gamma radiation) is commented out on the portal as well.
- `files/irwip-station-config-api.js`, which is helper functions, not a station catalogue.

The station file is executable JavaScript. It is evaluated in a `vm` context that is not given `process`, `require`, or the filesystem, with a short timeout. `--source` can name another `https` URL; that body is still evaluated in the same sandbox.

## What is compared

Stations are paired by code, case-insensitively. A code that differs only by letter case is still reported.

| Seed field | Live field | Rule |
| --- | --- | --- |
| `code` | config key and `code` | Case-insensitive match. Case and key mismatches are reported. |
| `eng_name` | `name_EN` | Unicode NFC, trim, and collapsed whitespace. Abbreviations are not expanded, and parenthetical qualifiers are not removed. |
| `chi_name` | `name_TC` | Same whitespace normalization. Simplified `name_SC` is not compared. |
| `lat`, `lng` | Primary layer coordinates | Temperature coordinates when that layer has a code and numeric coordinates. Otherwise the first available layer in this order: `rh`, `mslp`, `wind`, `grass`, `visibility`, `globalSolar`, `directSolar`, `diffuseSolar`, `hkhi`. If no instrument has coordinates, the weather photo whose code equals the station code. |
| `wind_lat`, `wind_lng` | `wind` layer | Compared on their own. If the seed has no wind coordinates but the map's wind site is not the station pin, that gap is reported instead of being merged into the temperature comparison. |
| `photo_code` | `weatherPhoto.webcam[].code` | Case-insensitive set. Order does not matter. |
| `webcam_angle` | webcam `angle` | Only when both sides have exactly one photo. `360` is normalized to `0`. Live tokens such as `ne` and `wnw` use the 16-point compass. Several cameras cannot be reduced to the seed's single angle, so only the photo-code set is compared in that case. |

Coordinate tolerance defaults to `0.0001` degrees on latitude and on longitude (about 11 m). A gap strictly greater than that is a difference. A smaller non-zero gap is listed under "within tolerance" and does not fail the process unless `--strict` is set. Empty strings and tokens such as `NA` are unavailable. They are never treated as zero, including when the other side really is `0`.

These seed fields have no counterpart on the map and are not scored: `eng_name_abbr`, `chi_name_abbr`, `station_operator`, and `is_forecast`. Live `ARWF_code` is a pointer to a forecast area, not a boolean, so it is not compared with `is_forecast`. It is shown when a seed-only code is used as another station's ARWF code, wind-instrument code, or webcam code. Duplicate names and seed rows that share coordinates are reported and do not by themselves set the exit code. Duplicate codes do.

Other live layers (for example heat-index `hkhi`, or a webcam plotted somewhere other than the station pin) are listed as live position offsets. They explain what the map draws. They are not seed mismatches, because the seed stores one pin plus an optional wind pin.

## Commands

From the repository root:

```sh
node scripts/compare-station-metadata.js
node scripts/compare-station-metadata.js --json reports/station-metadata.json
node scripts/compare-station-metadata.js --seed db/weather_stations.json --tolerance 0.0001
node scripts/compare-station-metadata.js --help
```

`--json -` writes the JSON report to stdout and the text report to stderr.

Exit `0` means the comparison finished and the scored fields agree. Exit `1` means a station is missing on either side, a scored field differs, or a code is duplicated. Exit `2` means the seed or the live source could not be read. `--exit-zero` keeps a successful read at exit 0.

Unit tests use local fixtures and do not touch the network:

```sh
npm test
node --test test/station-metadata-compare.test.js
```

The live check fetches the portal and the station script. It is skipped unless you opt in:

```sh
npm run test:stations-live
COMPARE_STATIONS_LIVE=1 node --test test/station-metadata-live.test.js
```

`npm run stations:compare` is the same live comparison as the first command above.
