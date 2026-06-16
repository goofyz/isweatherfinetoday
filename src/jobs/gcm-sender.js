import { randomBytes } from 'crypto';
import { firebaseApp } from '../config.js';
import { query, queryOne } from '../db.js';
import logger from '../logger.js';

// FCM error code constants
const FCM_ERROR_UNAVAILABLE = 'UNAVAILABLE';
const FCM_ERROR_INTERNAL = 'INTERNAL';
const FCM_ERROR_UNREGISTERED = 'UNREGISTERED';
const FCM_ERROR_INVALID_ARGUMENT = 'INVALID_ARGUMENT';

function newMessageId() {
  return randomBytes(12).toString('base64url');
}

async function sendFcmMulticast(regIds, payload, collapseKey) {
  if (!firebaseApp) {
    throw new Error('Firebase Admin SDK not initialized');
  }

  const message = {
    tokens: regIds,
    data: payload,
  };

  if (collapseKey) {
    message.collapseKey = collapseKey;
  }

  try {
    const response = await firebaseApp.messaging().sendEachForMulticast(message);
    return response;
  } catch (error) {
    logger.error('Error sending FCM multicast:', error);
    throw error;
  }
}

async function disableDevice(regId) {
  await query(`UPDATE devices SET status = 'D', updated_at=NOW() WHERE reg_id = $1`, [regId]);
}

async function enableDevice(regId) {
  await query(`UPDATE devices SET status = 'A', updated_at=NOW() WHERE reg_id = $1`, [regId]);
}

async function handleCanonicalOrSwap(oldRegId, newRegId) {
  const oldDevice = await queryOne(`SELECT * FROM devices WHERE reg_id = $1`, [oldRegId]);
  const newDevice = await queryOne(`SELECT * FROM devices WHERE reg_id = $1`, [newRegId]);
  if (!newDevice && oldDevice) {
    await query(
      `UPDATE devices SET reg_id = $2, status = 'A', updated_at=NOW() WHERE id = $1`,
      [oldDevice.id, newRegId],
    );
    return;
  }
  if (newDevice && oldDevice) {
    await disableDevice(oldDevice.reg_id);
    await enableDevice(newDevice.reg_id);
    return;
  }
  if (newDevice && !oldDevice) await enableDevice(newDevice.reg_id);
  if (!newDevice && !oldDevice) {
    await query(
      `INSERT INTO devices (reg_id, lang, os_type, app_version, status, ip_address,
        created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,null,NOW(),NOW())`,
      [newRegId, 'en', '-1', -1, 'A'],
    );
  }
}

async function enqueueRetry(notifRow, retryIds) {
  const sentCount = (notifRow.sent_count ?? 0) + 1;
  const delaySec = Math.floor(Math.random() * 2 ** sentCount) * 3;
  const targetSent = new Date(Date.now() + delaySec * 1000);
  await query(
    `INSERT INTO gcm_notifications (reg_ids, op, content, collapse_key, target_sent_time, sent_time,
      response, message_id, sent_count, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,null,null,$6,$7,NOW(),NOW())`,
    [
      JSON.stringify(retryIds),
      notifRow.op,
      notifRow.content,
      notifRow.collapse_key,
      targetSent,
      newMessageId(),
      sentCount,
    ],
  );
}

/**
 * Parses FCM multicast results, handles device status updates and retries as needed.
 * @param {string[]} regIds - The registration IDs the message was sent to.
 * @param {object} response - The FCM multicast response object.
 * @param {object} originalNotifRow - The original notification row from the database.
 * @returns {Promise<void>}
 */
async function parseAndHandleResults(regIds, response, originalNotifRow) {
  const retryIds = [];
  if (!response || !Array.isArray(response.responses)) {
    logger.error('Invalid FCM response structure:', response);
    throw new Error('Invalid FCM response structure');
  }

  for (let idx = 0; idx < response.responses.length; idx++) {
    const result = response.responses[idx];
    const regId = regIds[idx];
    if (!result.success) {
      const errorCode = result.error?.code;
      if (errorCode === FCM_ERROR_UNAVAILABLE || errorCode === FCM_ERROR_INTERNAL) {
        logger.info(`FCM - Unavailable, re-try later - ${regId}`);
        retryIds.push(regId);
        continue;
      }
      if (errorCode === FCM_ERROR_UNREGISTERED || errorCode === FCM_ERROR_INVALID_ARGUMENT) {
        logger.info(`FCM - removed from db - ${regId}`);
        const device = await queryOne(`SELECT id FROM devices WHERE reg_id=$1`, [regId]);
        if (device) await disableDevice(regId);
        continue;
      }
      logger.info(`FCM - unknown error ${errorCode} for ${regId}`);
    }
    // Note: Canonical IDs are not returned in FCM v1 API.
    // In FCM v1, token updates (such as when a device's registration token changes)
    // are not provided in the response. The client app is responsible for detecting
    // when its token changes and reporting the new token to your backend.
    // Therefore, server-side handling of canonical IDs or token swaps is not needed here.
  }
  if (retryIds.length > 0) {
    await enqueueRetry(originalNotifRow, retryIds);
  }
}
export async function sendGcmImmediate() {
  logger.info('FCM - Start sending pending notifications');
  if (!firebaseApp) {
    logger.info('FCM - skip (Firebase Admin SDK not initialized)');
    return;
  }

  const pending = await query(
    `SELECT * FROM gcm_notifications
     WHERE sent_time IS NULL AND target_sent_time < NOW()
     ORDER BY id`,
  );

  for (const notif of pending) {
    logger.info(`FCM - send notification ID ${notif.id}`);
    let regIds;
    try {
      regIds = JSON.parse(notif.reg_ids);
    } catch {
      logger.info(`FCM - skip bad reg_ids (${notif.id})`);
      continue;
    }

    const createdIso = (
      notif.created_at instanceof Date ? notif.created_at : new Date(notif.created_at)
    ).toISOString();

    try {
      const response = await sendFcmMulticast(regIds, {
        v: String(1),
        op: String(notif.op),
        content: String(notif.content ?? ''),
        update_time: JSON.stringify(createdIso),
      }, notif.collapse_key);

      await query(
        `UPDATE gcm_notifications SET sent_time=NOW(), response=$2, updated_at=NOW() WHERE id=$1`,
        [notif.id, JSON.stringify({
          successCount: response.successCount,
          failureCount: response.failureCount,
          responses: response.responses.map(r => ({
            success: r.success,
            messageId: r.messageId,
            error: r.error ? { code: r.error.code, message: r.error.message } : null
          }))
        })],
      );
      logger.info(`FCM - result for notification ID ${notif.id}: ${response.successCount} success, ${response.failureCount} failure`);

      await parseAndHandleResults(regIds, response, notif);
    } catch (error) {
      logger.info('FCM - error sending multicast', error);
      await query(
        `UPDATE gcm_notifications SET sent_time=NOW(), response=$2, updated_at=NOW() WHERE id=$1`,
        [notif.id, JSON.stringify({ error: error.message })],
      );
    }
  }
  logger.info('FCM - Finished sending pending notifications');
}

export async function enqueueGcmSend() {
  await sendGcmImmediate();
}
