import { DateTime } from 'luxon';
import { REGEX_SPECIAL_WEATHER_TIPS_CONTENT } from '../locales.js';
import { getRemotePageAsString } from '../request-helper.js';
import { runGcmGenerator } from './gcm-generator.js';
import logger from '../logger.js';
import { getSpecialWeatherTips, setSpecialWeatherTips, deleteCacheByPattern } from '../redis-client.js';

const HK = 'Asia/Hong_Kong';

function normalizeMatch(block) {
  const m = block.match(REGEX_SPECIAL_WEATHER_TIPS_CONTENT);
  if (!m || !m.groups) return null;
  const g = m.groups;
  if (g.tip && g.time && g.date) {
    return { tip: g.tip.trim(), time: g.time, date: g.date };
  }
  if (g.tip2 && g.time2 && g.date2) {
    const timeZh = `${g.time2}`;
    const timeNormalized = timeZh.replace(/時/g, ':').replace(/分/g, '');
    return { tip: g.tip2.trim(), time: timeNormalized, date: g.date2 };
  }
  return null;
}

function parseTips(xml) {
  const tips = [];
  for (const block of xml.split('####')) {
    const mm = normalizeMatch(block);
    if (mm) tips.push(mm);
  }
  return tips;
}

function parseTipTime(groups) {
  const tryFormats = ['d.M.yyyy H:mm', 'd-M-yyyy H:mm', 'd/M/yyyy H:mm'];
  const combined = `${groups.date} ${groups.time}`;
  for (const fmt of tryFormats) {
    const dt = DateTime.fromFormat(combined, fmt, { zone: HK });
    if (dt.isValid) return dt.toJSDate();
  }
  return DateTime.now().setZone('Asia/Hong_Kong').toJSDate();
}

async function getAllTips() {
  const engContent = await getRemotePageAsString(
    'https://pda.weather.gov.hk/locspc/android_data/headline.xml',
  );
  if (!engContent?.trim()) {
    logger.error('SpecialWeatherTip - no English content found');
    logger.error(`SpecialWeatherTip - English content: ${engContent}`);
    return [];
  }
  const chiContent = await getRemotePageAsString(
    'https://pda.weather.gov.hk/locspc/android_data/headline_uc.xml',
  );
  const engTips = parseTips(engContent);
  const chiTips = parseTips(chiContent ?? '');
  if (engTips.length !== chiTips.length) {
    logger.error('SpecialWeatherTip - mismatched tip counts');
    logger.error(`SpecialWeatherTip - English tips: ${engTips.length}, Chinese tips: ${chiTips.length}`);
    logger.error(`SpecialWeatherTip - English content: ${engContent}`);
    logger.error(`SpecialWeatherTip - Chinese content: ${chiContent}`);
    return [];
  }

  const out = [];
  for (let i = 0; i < engTips.length; i += 1) {
    const e = engTips[i];
    const c = chiTips[i];
    const eng_content = e.tip.trim();
    const chi_content = c.tip.trim();
    out.push({
      eng_content,
      chi_content,
      eng_title: `${eng_content.slice(0, 60)}...`,
      chi_title: `${chi_content.slice(0, 30)}...`,
      time: parseTipTime({ date: e.date, time: e.time }).toISOString(),
    });
  }
  return out;
}

function toMs(t) {
  if (t == null) return NaN;
  if (t instanceof Date) return t.getTime();
  return new Date(t).getTime();
}

export function tipsAreEqual(oldRows, newRows) {
  if (oldRows.length !== newRows.length) return false;
  for (let i = 0; i < oldRows.length; i += 1) {
    const x = oldRows[i];
    const y = newRows[i];
    const xMs = toMs(x.time);
    const yMs = toMs(y.time);
    const same =
      x.eng_title === y.eng_title &&
      !Number.isNaN(xMs) &&
      !Number.isNaN(yMs) &&
      xMs === yMs &&
      x.eng_content === y.eng_content &&
      x.chi_title === y.chi_title;
    if (!same) return false;
  }
  return true;
}

export async function runSpecialWeatherTipUpdater() {
  logger.info('SpecialWeatherTip - start');
  const oldTips = await getSpecialWeatherTips();

  try {
    const newTips = await getAllTips();
    const sendTip = !tipsAreEqual(oldTips, newTips);

    if (sendTip) {
      logger.info(`SpecialWeatherTips: ${newTips.length}`);
      await setSpecialWeatherTips(newTips);
      await deleteCacheByPattern('api:weathers*');
      await runGcmGenerator(false, true, false);
    }
  }
  catch (e) {
    logger.error(e, 'SpecialWeatherTip - error fetching/parsing tips');
  }

  logger.info('SpecialWeatherTip - end');
}
