import express from 'express';
import { sha1Hex } from './common.js';
import { DEVICE_SECRET_KEY, ENABLE_API_LOGGING } from '../../config.js';
import { query, queryOne } from '../../db.js';
import logger from '../../logger.js';

const router = express.Router();

router.post('/', async (req, res) => {
  const device = req.body.device ?? {};
  const regId = typeof device.reg_id === 'string' ? device.reg_id.trim() : '';
  if (!regId) {
    return res.json({ success: false, info: 'missing required data' });
  }

  const pattern = `lat=${regId}, lng=${device.type ?? ''}, v=${device.app_version ?? ''}, key=${DEVICE_SECRET_KEY}, time=${req.body.t ?? ''}`;
  const hash = sha1Hex(pattern);
  const t = Number(req.body.t ?? 0);
  const submitRequestDate = new Date(t * 1000);

  let message = '';

  let success = false;
  const is_correct_request =
    submitRequestDate.getTime() + 60 * 1000 > Date.now() &&
    typeof req.body.hash === 'string' &&
    hash.localeCompare(req.body.hash, undefined, { sensitivity: 'accent' }) === 0;

  let dbParams;
  try {
    let row = await queryOne(`SELECT * FROM devices WHERE reg_id=$1`, [regId]);
    const remoteIp =
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ??
      req.socket.remoteAddress ??
      '';
    const appVersion = Number(device.app_version);
    const appVersionOrZero = Number.isNaN(appVersion) ? 0 : appVersion;

    if (!row) {
      dbParams = {
        reg_id: regId,
        os_type: String(device.os_type ?? ''),
        app_version: appVersionOrZero,
        lang: device.lang,
        ip_address: remoteIp,
      };
      await query(
        `INSERT INTO devices (reg_id, os_type, app_version, lang, ip_address, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'A',NOW(),NOW())`,
        [
          dbParams.reg_id,
          dbParams.os_type,
          dbParams.app_version,
          dbParams.lang,
          dbParams.ip_address,
        ],
      );
    } else {
      dbParams = {
        ip_address: remoteIp,
        os_type: String(device.os_type ?? ''),
        app_version: appVersionOrZero,
        lang: device.lang,
        id: row.id,
      };
      await query(
        `UPDATE devices SET ip_address=$1, os_type=$2, app_version=$3, lang=$4,
          status='A', updated_at=NOW() WHERE id=$5`,
        [
          dbParams.ip_address,
          dbParams.os_type,
          dbParams.app_version,
          dbParams.lang,
          dbParams.id,
        ],
      );
    }

    success = true;
    if (!is_correct_request && ENABLE_API_LOGGING) {
      // intentionally empty in Rails implementation
    }
  } catch (e) {
    success = false;
    message = 'error in saving devices';
    logger.error({ err: e, params: dbParams, device }, 'error in saving devices');
  }

  res.json({ success, info: message });
});

export default router;
