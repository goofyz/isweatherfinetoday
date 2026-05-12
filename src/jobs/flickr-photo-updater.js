import { query, queryOne } from '../db.js';
import { getJson } from '../request-helper.js';
import logger from '../logger.js';

const FLICKR_API_KEY = '8edb524d5852f6db934a65305b603ebb';
const FLICKR_API_GROUP_ID = '1463451@N25';
const BBOX = '113.68103,22.083731,114.559936,22.577876';
const MID_LABELS = ['Large', 'Medium 800', 'Medium 640'];

async function flickrMethod(method, extra = {}) {
  const params = new URLSearchParams({
    method,
    api_key: FLICKR_API_KEY,
    format: 'json',
    nojsoncallback: '1',
  });
  for (const [k, v] of Object.entries(extra)) {
    params.append(k, String(v));
  }
  return getJson(`https://api.flickr.com/services/rest/?${params}`);
}

function asArray(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

function pickMidUrl(sizeResult) {
  const sizes = asArray(sizeResult?.sizes?.size);
  for (const label of MID_LABELS) {
    const hit = sizes.find((s) => String(s.label) === label && s.source);
    if (hit) return hit.source;
  }
  return null;
}

async function upsertFlickrPhoto(photoJson, mid_res_url, high_res_url) {
  const owner_url = photoJson.owner
    ? `http://www.flickr.com/photos/${photoJson.owner}/${photoJson.id}`
    : null;
  const tags = String(photoJson.tags ?? '')
    .split(/\s+/g)
    .filter(Boolean);

  const existing = await queryOne(`SELECT id FROM flickr_photos WHERE photo_id = $1`, [photoJson.id]);
  if (!existing) {
    await query(
      `INSERT INTO flickr_photos (photo_id, owner_name, owner_url, mid_res_url, high_res_url,
        tags, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW())`,
      [photoJson.id, photoJson.ownername ?? '', owner_url, mid_res_url, high_res_url, tags],
    );
    return;
  }
  await query(
    `UPDATE flickr_photos SET owner_name=$1, owner_url=$2, mid_res_url=$3, high_res_url=$4, tags=$5,
      updated_at=NOW() WHERE id=$6`,
    [photoJson.ownername ?? '', owner_url, mid_res_url, high_res_url, tags, existing.id],
  );
}

async function upsertFromSearchPhoto(ph) {
  const sizesResp = await flickrMethod('flickr.photos.getSizes', { photo_id: ph.id });
  const mid_url = pickMidUrl(sizesResp);
  if (!mid_url) return;
  const highRes = ph.url_h ?? null;

  await upsertFlickrPhoto(ph, mid_url, highRes);
}

export async function runFlickrPhotoUpdater() {
  logger.info('FLICKR - start');
  const resp = await flickrMethod('flickr.photos.search', {
    group_id: FLICKR_API_GROUP_ID,
    extras: 'owner_name,url_h,tags',
    bbox: BBOX,
    accuracy: '1',
    per_page: '500',
    page: '1',
  });
  const photos = asArray(resp?.photos?.photo).filter(Boolean);
  for (const ph of photos) {
    await upsertFromSearchPhoto(ph).catch((e) => logger.error('flickr photo', ph?.id, e));
  }

  await query(`DELETE FROM flickr_photos WHERE updated_at < NOW() - interval '10 day'`);
  logger.info('FLICKR - end');
}
