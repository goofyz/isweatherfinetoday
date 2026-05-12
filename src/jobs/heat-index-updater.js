import { DateTime } from 'luxon';
import { query } from '../db.js';
import { getJson } from '../request-helper.js';
import { runGcmGenerator } from './gcm-generator.js';
import logger from '../logger.js';

const HK = 'Asia/Hong_Kong';

export async function runHeatIndexUpdater() {
  logger.info('HeatIndexUpdater - start');

  const json = await getJson('https://www.hko.gov.hk/wxinfo/hkhi/hkhi_icon.xml');
  const chi_title = json.TitleTC ?? '';
  const eng_title = json.TitleEN ?? '';
  const chi_content = `${json.MessageTC1 ?? ''} ${json.MessageTC2 ?? ''} \n\n ${json.MessageTC3 ?? ''}`;
  const eng_content = `${json.MessageEN1 ?? ''} ${json.MessageEN2 ?? ''} \n\n ${json.MessageEN3 ?? ''}`;
  const warning_type = String(json.iconIndex ?? '');
  let time = Date.now();
  const ds = String(json.date ?? '').trim();
  if (ds.length >= 12) {
    const dt = DateTime.fromFormat(`${ds}+08:00`, 'yyyyMMddHHmmZZ');
    if (dt.isValid) time = dt.toString();
  }

  const oldIndex = await query('SELECT warning_type FROM heat_indices ORDER BY id LIMIT 5');
  let changed = false;
  if ((!oldIndex || oldIndex.length === 0) && warning_type !== '-1') {
    changed = true;
  } else if (oldIndex.length > 0 && String(oldIndex[0].warning_type) !== warning_type) {
    changed = true;
  }

  await query('DELETE FROM heat_indices');
  await query(
    `INSERT INTO heat_indices (eng_title, chi_title, eng_content, chi_content, warning_type, time,
      created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW())`,
    [eng_title, chi_title, eng_content, chi_content, warning_type, time],
  );

  if (changed) {
    logger.info(`HeatIndexUpdater - Changed ? ${changed}`);
    await runGcmGenerator(false, false, true);
  }

  logger.info('HeatIndexUpdater - End');
}
