import { DateTime } from 'luxon';
import { REGEX_SPECIAL_WEATHER_TIPS_CONTENT } from '../locales.js';
import { query } from '../db.js';
import { getRemotePageAsString } from '../request-helper.js';
import { runGcmGenerator } from './gcm-generator.js';
import logger from '../logger.js';

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
  if (!engContent?.trim()) return [];
  const chiContent = await getRemotePageAsString(
    'https://pda.weather.gov.hk/locspc/android_data/headline_uc.xml',
  );
  const engTips = parseTips(engContent);
  const chiTips = parseTips(chiContent ?? '');
  if (engTips.length !== chiTips.length) return [];

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
      time: parseTipTime({ date: e.date, time: e.time }),
    });
  }
  return out;
}

export function tipsAreEqual(oldRows, newRows) {
  if (oldRows.length !== newRows.length) return false;
  for (let i = 0; i < oldRows.length; i += 1) {
    const x = oldRows[i];
    const y = newRows[i];
    const same =
      x.eng_title === y.eng_title &&
      x.time instanceof Date &&
      y.time instanceof Date &&
      x.time.getTime() === y.time.getTime() &&
      x.eng_content === y.eng_content &&
      x.chi_title === y.chi_title;
    if (!same) return false;
  }
  return true;
}

export async function runSpecialWeatherTipUpdater() {
  logger.info('SpecialWeatherTip - start');
  const oldTips = await query(
    'SELECT eng_title, time, eng_content, chi_title FROM special_weather_tips ORDER BY id',
  );

  try {
    const newTipsRaw = await getAllTips();

    const normalizedOld = oldTips.map((r) => ({
      ...r,
      time: r.time instanceof Date ? r.time : new Date(r.time),
    }));
    const normalizedNew = newTipsRaw.map((r) => ({ ...r, time: r.time }));

    const sendTip = !tipsAreEqual(normalizedOld, normalizedNew);

    if (sendTip) {
      await query('DELETE FROM special_weather_tips');
      logger.info(`SpecialWeatherTips: ${normalizedNew.length}`);
      for (const tip of normalizedNew) {
        await query(
          `INSERT INTO special_weather_tips (eng_title, chi_title, eng_content, chi_content, time,
            created_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,NOW(),NOW())`,
          [tip.eng_title, tip.chi_title, tip.eng_content, tip.chi_content, tip.time],
        );
      }
      await runGcmGenerator(false, true, false);
    }
  }
  catch (e) {
    logger.info('SpecialWeatherTip - error fetching/parsing tips', e);
  }

  logger.info('SpecialWeatherTip - end');
}
