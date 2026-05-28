import { randomBytes } from 'crypto';
import { query } from '../db.js';
import { enqueueGcmSend } from './gcm-sender.js';
import logger from '../logger.js';
import { getHeatIndex, getSpecialWeatherTips, getWarnings } from '../redis-client.js';

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

function getLangPrefix(lang) {
  if (lang === 'en') return 'eng';
  if (lang === 'zh') return 'chi';
  return '';
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
      const prefix = getLangPrefix(lang);
      const stored = await getWarnings();
      const warnings = stored.map((w) => ({
        warning_type: w.warning_type,
        time: w.time,
        detail: w[`${prefix}_detail`] ?? '',
      }));
      await insertNotification(reg_ids, 'warnings', JSON.stringify(warnings), 'warnings');
    }

    if (sendTips) {
      logger.info(`FCM - add tips - ${lang}`);
      const prefix = getLangPrefix(lang);
      const stored = await getSpecialWeatherTips();
      const tips = stored.map((t) => ({
        title: t[`${prefix}_title`] ?? '',
        time: t.time,
        content: t[`${prefix}_content`] ?? '',
      }));
      await insertNotification(reg_ids, 'tips', JSON.stringify(tips), 'tips');
    }

    if (sendHeat) {
      logger.info('FCM - add Heat Index');
      const prefix = getLangPrefix(lang);
      const heat = await getHeatIndex();
      const heats = heat
        ? [{
            title: heat[`${prefix}_title`] ?? '',
            content: heat[`${prefix}_content`] ?? '',
            time: heat.time,
            warning_type: heat.warning_type,
          }]
        : [];
      await insertNotification(reg_ids, 'tips', JSON.stringify(heats), 'heat');
    }
  }
}

export async function runGcmGenerator(sendWarning, sendTips, sendHeat) {
  await addMsg(sendWarning, sendTips, sendHeat, 'en');
  await addMsg(sendWarning, sendTips, sendHeat, 'zh');
  await enqueueGcmSend();
}
