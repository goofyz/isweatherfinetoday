import * as xpath from 'xpath';
import { DOMParser } from '@xmldom/xmldom';
import { DateTime } from 'luxon';
import { REGEX_AQHI_CURRENT } from '../locales.js';
import { query } from '../db.js';
import { get } from '../request-helper.js';
import logger from '../logger.js';
import { mergeToday, setAqhiStationData } from '../redis-client.js';

const HK = 'Asia/Hong_Kong';

function selectDescriptions(doc) {
  return xpath.select("//description", doc);
}

function rssBodyPolish(txt) {
  return String(txt ?? '')
    .replace(/<p>/g, '\n')
    .replace(/<\/p>/g, '')
    .replace(/^\n+/, '')
    .replace(/\n&lt;/, '\n\n&lt;')
    .trim();
}

function itemText(el, tag) {
  try {
    const nodes = el.getElementsByTagName(tag);
    if (!nodes?.length) return '';
    const n = nodes[0];
    return String(n.textContent ?? '').trim();
  } catch {
    return '';
  }
}

function fixIndex(input) {
  let output = input;
  if (String(output) === '10+') output = 11;
  return String(output ?? '');
}

function parseAqhiCurrent(htmlBlock) {
  const flat = String(htmlBlock).replace(/\s+/g, ' ').trim();
  const m = flat.match(REGEX_AQHI_CURRENT);
  if (!m || !m.groups) return '-1|-1|-1|-1';
  let {
    generalOne,
    generalMin,
    generalMax,
    roadOne,
    roadMin,
    roadMax,
  } = m.groups;
  if (!generalMin) {
    generalMin = generalOne;
    generalMax = generalOne;
  }
  if (!roadMin) {
    roadMin = roadOne;
    roadMax = roadOne;
  }
  return `${fixIndex(generalMin)}|${fixIndex(generalMax)}|${fixIndex(roadMin)}|${fixIndex(roadMax)}`;
}

export async function runAqhiUpdater() {
  logger.info(`AQHI - start`);

  const engXml = await get('https://www.aqhi.gov.hk/epd/ddata/html/out/aqhirss_Eng.xml');
  let doc = new DOMParser().parseFromString(engXml, 'application/xml');
  let descriptions = selectDescriptions(doc);
  const eng_forecast_general = rssBodyPolish(descriptions[2]?.textContent ?? '');
  const currentHtml = String(descriptions[1]?.textContent ?? '').replace(/\s+/g, ' ');
  const aqhi_current = parseAqhiCurrent(currentHtml);

  const chiXml = await get('https://www.aqhi.gov.hk/epd/ddata/html/out/aqhirss_ChT.xml');
  doc = new DOMParser().parseFromString(chiXml, 'application/xml');
  descriptions = selectDescriptions(doc);
  const chi_aqhi_forecast = rssBodyPolish(descriptions[2]?.textContent ?? '');
  const lastBuildRaw = xpath.select("//lastBuildDate", doc)?.[0]?.textContent ?? '';
  const aqhi_update_time = DateTime.fromRFC2822(String(lastBuildRaw).trim(), { zone: HK }).toJSDate();

  const hkToday = DateTime.now().setZone('Asia/Hong_Kong').toISODate();

  await mergeToday({
    forecast_day: hkToday,
    aqhi_current,
    chi_aqhi_forecast,
    eng_aqhi_forecast: eng_forecast_general,
    aqhi_update_time: aqhi_update_time ? aqhi_update_time.toISOString() : null,
  });

  const rssEng = await get('https://www.aqhi.gov.hk/epd/ddata/html/out/aqhi_ind_rss_Eng.xml');
  const rssDoc = new DOMParser().parseFromString(rssEng, 'application/xml');
  const items = xpath.select("//item", rssDoc);
  const list = Array.isArray(items) ? items : [items];

  for (const item of list.filter(Boolean)) {
    const title = itemText(item, 'title');
    const pubRaw = itemText(item, 'pubDate');
    const description = itemText(item, 'description');
    const update_time =
      pubRaw ? DateTime.fromRFC2822(pubRaw.trim(), { zone: HK }).toJSDate() : null;
    const parts = description.split(/: /);
    if (parts.length < 2) continue;
    const engStationName = parts[0].split(/ - /)[0];
    const indexRaw = parts[1].split(' ')[0];
    const stationRows = await query(`SELECT code FROM aqhi_stations WHERE eng_name = $1 LIMIT 1`, [
      engStationName,
    ]);
    const station = stationRows[0];
    if (!station) {
      logger.info(`AQHI Station Not found ${engStationName}`);
      continue;
    }
    await setAqhiStationData(station.code, {
      aqhi_index: fixIndex(indexRaw.trim()),
      update_time: update_time ? update_time.toISOString() : null,
    });
  }

  logger.info(`AQHI - End`);
}
