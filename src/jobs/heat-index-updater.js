import { DateTime } from 'luxon';
import { getJson } from '../request-helper.js';
import { runGcmGenerator } from './gcm-generator.js';
import logger from '../logger.js';
import { getHeatIndex, setHeatIndex, deleteCacheByPattern} from '../redis-client.js';

const HK = 'Asia/Hong_Kong';

export async function runHeatIndexUpdater() {
  logger.info('HeatIndexUpdater - start');

  const json = await getJson('https://www.hko.gov.hk/wxinfo/hkhi/hkhi_icon.xml');
  const chi_title = json.TitleTC ?? '';
  const eng_title = json.TitleEN ?? '';
  const chi_content = `${json.MessageTC1 ?? ''} ${json.MessageTC2 ?? ''} \n\n ${json.MessageTC3 ?? ''}`;
  const eng_content = `${json.MessageEN1 ?? ''} ${json.MessageEN2 ?? ''} \n\n ${json.MessageEN3 ?? ''}`;
  const warning_type = String(json.iconIndex ?? '');
  let time = new Date().toISOString();
  const ds = String(json.date ?? '').trim();
  if (ds.length >= 12) {
    const dt = DateTime.fromFormat(`${ds}+08:00`, 'yyyyMMddHHmmZZ');
    if (dt.isValid) time = dt.toJSDate().toISOString();
  }

  const oldIndex = await getHeatIndex();
  let changed = false;
  if (!oldIndex && warning_type !== '-1') {
    changed = true;
  } else if (oldIndex && String(oldIndex.warning_type) !== warning_type) {
    changed = true;
  }

  await setHeatIndex({
    eng_title,
    chi_title,
    eng_content,
    chi_content,
    warning_type,
    time,
  });

  if (changed) {
    logger.info(`HeatIndexUpdater - Changed ? ${changed}`);
    
    await deleteCacheByPattern('api:weathers*');
    await runGcmGenerator(false, false, true);
  }

  logger.info('HeatIndexUpdater - End');
}
