import { randomBytes } from 'crypto';
import { query } from '../db.js';
import { enqueueGcmSend } from './gcm-sender.js';
import logger from '../logger.js';

const ACTIVE = 'A';

function newMessageId() {
  return randomBytes(12).toString('base64url');
}

async function countDevices(lang) {
  const rows = await query(`SELECT COUNT(*)::int AS c FROM devices WHERE lang = $1 AND status = $2`, [
    lang,
    ACTIVE,
  ]);
  return rows[0]?.c ?? 0;
}

async function insertNotification(regIds, op, content, collapse_key) {
  logger.info(`FCM - insert notification for ${op} (${regIds.length} devices)`);
  await query(
    `INSERT INTO gcm_notifications (reg_ids, op, content, collapse_key, target_sent_time, sent_time,
      response, message_id, sent_count, created_at, updated_at)
     VALUES ($1,$2,$3,$4,NOW() - INTERVAL '1 second',null,null,$5,$6,NOW(),NOW())`,
    [JSON.stringify(regIds), op, typeof content === 'string' ? content : JSON.stringify(content), collapse_key, newMessageId(), 0],
  );
}

async function addMsg(sendWarning, sendTips, sendHeat, lang) {
  const cnt = await countDevices(lang);
  for (let n = 0; n <= cnt; n += 1000) {
    const batch = await query(
      `SELECT reg_id FROM devices WHERE lang = $1 AND status = $2 ORDER BY id LIMIT $3 OFFSET $4`,
      [lang, ACTIVE, 1000, n],
    );
    const reg_ids = batch.map((r) => r.reg_id);
    if (reg_ids.length === 0) continue;

    if (sendWarning) {
      logger.info('FCM - add warnings');
      const warnings = await query(
        `SELECT warning_type AS "warning_type", time, eng_detail, chi_detail FROM weather_warnings`,
      );
      await insertNotification(reg_ids, 'warn', JSON.stringify(warnings), 'warnings');
    }

    if (sendTips) {
      logger.info(`FCM - add tips - ${lang}`);
      if(lang == 'en') {
        const tips = await query(`SELECT eng_title as "title", time, eng_content as "content" FROM special_weather_tips`);
        await insertNotification(reg_ids, 'tips', JSON.stringify(tips), 'tips');
      } else {
        const tips = await query(`SELECT chi_title as "title", time, chi_content as "content" FROM special_weather_tips`);
        await insertNotification(reg_ids, 'tips', JSON.stringify(tips), 'tips');
      }
    }

    if (sendHeat) {
      logger.info('FCM - add Heat Index');
      const heats = await query(
        `SELECT eng_title, chi_title, eng_content, chi_content, time, warning_type FROM heat_indices`,
      );
      await insertNotification(reg_ids, 'tips', JSON.stringify(heats), 'heat');
    }
  }
}

export async function runGcmGenerator(sendWarning, sendTips, sendHeat) {
  await addMsg(sendWarning, sendTips, sendHeat, 'en');
  await addMsg(sendWarning, sendTips, sendHeat, 'zh');
  await enqueueGcmSend();
}
