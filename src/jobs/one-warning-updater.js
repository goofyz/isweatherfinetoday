import { DateTime } from 'luxon';
import { URL_WARNING_SOURCE } from '../config.js';
import { getJson, getRemotePageAsString } from '../request-helper.js';
import { runGcmGenerator } from './gcm-generator.js';
import logger from '../logger.js';
import { getWarnings, setWarnings, deleteCacheByPattern } from '../redis-client.js';

const HK = 'Asia/Hong_Kong';

const TYPE = Object.freeze({
  FIRE_RED: 'FIRE_RED',
  FIRE_YELLOW: 'FIRE_YELLOW',
  WEATHER_COLD: 'WEATHER_COLD',
  FLOODING: 'FLOODING',
  FROST: 'FROST',
  WEATHER_HOT: 'WEATHER_HOT',
  LANDSLIP: 'LANDSLIP',
  MONSOON: 'MONSOON',
  THUNDERSTORM: 'THUNDERSTORM',
  T1: 'T1',
  T3: 'T3',
  T8NE: 'T8NE',
  T8NW: 'T8NW',
  T8SE: 'T8SE',
  T8SW: 'T8SW',
  T9: 'T9',
  T10: 'T10',
  RAIN_AMBER: 'RAIN_AMBER',
  RAIN_RED: 'RAIN_RED',
  RAIN_BLACK: 'RAIN_BLACK',
  TSUNAMI: 'TSUNAMI',
});

function checkWarningUp(warnings, key) {
  const obj = warnings[key + '_E'];
  if (!obj) return false;
  const warnAction = String(obj.Warning_Action ?? '').slice(0, 1);
  const bulletinDate = obj.Bulletin_Date;
  const bulletinTime = obj.Bulletin_Time;

  switch (key) {
    case 'WTS':
      return warnAction === 'I' || warnAction === 'R' || warnAction === 'E' || warnAction === 'U';
    case 'WTCSGNL': {
      const tcCode = obj.Warning_Code ?? '';
      return warnAction === 'I' && !String(tcCode).includes('CANCEL');
    }
    case 'WRAIN':
      return warnAction === 'I';
    case 'WFIRE': {
      const issueDateTime = DateTime.fromFormat(String(obj.Issue_Date ?? ''), 'yyyyMMdd', { zone: HK });
      const today = DateTime.now().setZone('Asia/Hong_Kong').toISODate();
      return warnAction === 'I' && issueDateTime.toISODate() <= today;
    }
    case 'WFNTSA':
      return warnAction === 'I' || warnAction === 'R';
    case 'WL':
      return warnAction === 'I';
    case 'WMSGNL':
      return warnAction === 'I';
    case 'WHOT':
      return warnAction === 'I' || warnAction === 'R';
    case 'WCOLD':
      return warnAction === 'I' || warnAction === 'R';
    case 'WFROST':
      return warnAction === 'I';
    case 'WTMW':
      return warnAction === 'I' || warnAction === 'R' || warnAction === 'U';
    case 'WTCPRE8':
      return warnAction === 'I';
    case 'RFEQ':
      return bulletinDate !== '' && bulletinTime !== '';
    default:
      return false;
  }
}

function decodeWarning(warn) {
  switch (warn.Warning_Code) {
    case 'WFIRER':
      return TYPE.FIRE_RED;
    case 'WFIREY':
      return TYPE.FIRE_YELLOW;
    case 'WCOLD':
      return TYPE.WEATHER_COLD;
    case 'WFNTSA':
      return TYPE.FLOODING;
    case 'WFROST':
      return TYPE.FROST;
    case 'WHOT':
      return TYPE.WEATHER_HOT;
    case 'WL':
      return TYPE.LANDSLIP;
    case 'WMSGNL_MONSOON':
      return TYPE.MONSOON;
    case 'WTS':
      return TYPE.THUNDERSTORM;
    case 'TC1':
      return TYPE.T1;
    case 'TC3':
      return TYPE.T3;
    case 'TC8NE':
      return TYPE.T8NE;
    case 'TC8NW':
      return TYPE.T8NW;
    case 'TC8SE':
      return TYPE.T8SE;
    case 'TC8SW':
      return TYPE.T8SW;
    case 'TC9':
      return TYPE.T9;
    case 'TC10':
      return TYPE.T10;
    case 'WRAINA':
      return TYPE.RAIN_AMBER;
    case 'WRAINR':
      return TYPE.RAIN_RED;
    case 'WRAINB':
      return TYPE.RAIN_BLACK;
    case 'WTMW':
      return TYPE.TSUNAMI;
    case 'WTC1_E':
      return TYPE.T1;
    default:
      return '?';
  }
}

async function fetchDetail(link) {
  const urlChi = `http://pda.weather.gov.hk/locspc/android_data/${link}c.xml`;
  const urlEng = `http://pda.weather.gov.hk/locspc/android_data/${link}e.xml`;
  const [chi_detail, eng_detail] = await Promise.all([
    getRemotePageAsString(urlChi),
    getRemotePageAsString(urlEng),
  ]);
  return { chi_detail, eng_detail };
}

function parseIssueDateTime(dateStr, timeRaw) {
  const timeStr = String(timeRaw ?? '').padStart(4, '0');
  const combos = [`${dateStr} ${timeStr.slice(0, 2)}${timeStr.slice(2)}`, `${dateStr} ${timeStr}`];
  const formats = ['yyyyMMdd HHmm', 'yyyyMMdd Hmm'];
  for (const c of combos) {
    for (const fmt of formats) {
      const dt = DateTime.fromFormat(c.trim(), fmt, { zone: HK });
      if (dt.isValid) return dt.toJSDate();
    }
  }
  return DateTime.now().setZone('Asia/Hong_Kong').toJSDate();
}

async function createWarning(warning_type, warns) {
  try {
    const warnJson = warns[`${warning_type}_E`];
    const wt = decodeWarning(warnJson);
    const link = warning_type === 'WTCSGNL' ? 'wtc' : warning_type.toLowerCase();
    const time = parseIssueDateTime(warnJson.Issue_Date, warnJson.Issue_Time);
    const detail = await fetchDetail(link);
    return {
      warning_type: wt,
      time: time.toISOString(),
      chi_detail: detail.chi_detail,
      eng_detail: detail.eng_detail,
    };
  } catch (e) {
    return null;
  }
}

async function loadWarningsFromNetwork(warns) {
  const warningDefs = [
    'WTCSGNL',
    'WRAIN',
    'WTS',
    'WFIRE',
    'WFNTSA',
    'WL',
    'WMSGNL',
    'WHOT',
    'WCOLD',
    'WFROST',
    'WTMW',
  ];
  const warningObjs = [];
  for (const w of warningDefs) {
    if (checkWarningUp(warns, w)) {
      logger.info(`Warning Up: ${w}`);
      const warning = await createWarning(w, warns);
      if (warning) warningObjs.push(warning);
    }
  }
  return warningObjs;
}

/** True when both lists describe the same warnings in the same order. */
export function warningsAreEqual(oldRows, newRows) {
  if (oldRows.length !== newRows.length) return false;
  for (let i = 0; i < oldRows.length; i += 1) {
    const x = oldRows[i];
    const y = newRows[i];
    const same =
      x.warning_type === y.warning_type &&
      new Date(x.time).getTime() === new Date(y.time).getTime() &&
      x.eng_detail === y.eng_detail &&
      x.chi_detail === y.chi_detail;
    if (!same) return false;
  }
  return true;
}

export async function runOneWarningUpdater() {
  logger.info('OneWarningUpdater - start');
  let sendWarning = false;
  try {
    const json = await getJson(URL_WARNING_SOURCE);
    const warns = json?.DYN_DAT_WARNSUM ?? {};

    const oldWarnings = await getWarnings();
    const newWarnings = await loadWarningsFromNetwork(warns);
    sendWarning = !warningsAreEqual(oldWarnings, newWarnings);

    if (sendWarning) {
      logger.info(`Warning - save warnings count: ${newWarnings.length}`);
      await setWarnings(newWarnings);
      await deleteCacheByPattern('api:weathers*');
    }
  } catch (e) {
    // do nothing
    logger.error(e, 'OneWarningUpdater - error fetching/parsing warnings');
  }

  const sendTip = false;
  if (sendTip || sendWarning) {
    await runGcmGenerator(sendWarning, sendTip, false);
  }
  logger.info('OneWarningUpdater - End');
}
