import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import admin from 'firebase-admin';
import logger from './logger.js';

const defaultServiceAccountPath = path.join(path.dirname(new URL(import.meta.url).pathname), '../serviceAccountKey.json');

function loadServiceAccountJson() {
  if (process.env.SERVICE_ACCOUNT_KEY) {
    try {
      return JSON.parse(process.env.SERVICE_ACCOUNT_KEY);
    } catch (error) {
      logger.warn('Failed to parse SERVICE_ACCOUNT_KEY as JSON:', error);
      return null;
    }
  }

  const filePath = process.env.SERVICE_ACCOUNT_KEY_PATH || defaultServiceAccountPath;
  try {
    const fileContents = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(fileContents);
  } catch (error) {
    logger.warn(`Failed to load service account JSON from ${filePath}:`, error);
    return null;
  }
}

// Initialize Firebase Admin SDK
let firebaseAdminApp;
const serviceAccount = loadServiceAccountJson();
if (serviceAccount) {
  try {
    firebaseAdminApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    logger.info('Firebase Admin SDK initialized successfully.');
  } catch (error) {
    logger.warn('Firebase Admin SDK not initialized. FCM sending will be skipped.', error);
  }
} else {
  logger.warn('Firebase Admin SDK not initialized. FCM sending will be skipped.');
}

export const PORT = Number(process.env.PORT || 3000);
export const firebaseApp = firebaseAdminApp;
export const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgres://postgres:abcd1234@localhost:5432/weatherindoubt6_development';

export const ENABLE_FLICKR_PHOTO = process.env.ENABLE_FLICKR_PHOTO !== 'n';
export const ENABLE_API_LOGGING = process.env.ENABLE_API_LOGGING === 'y';

export const FCM_API_KEY = process.env.FCM_API_KEY || '';

export const URL_HOUR_FORECAST_SOURCE =
  process.env.URL_HOUR_FORECAST_SOURCE ||
  'https://www.hko.gov.hk/wxinfo/awsgis/forecast/%{code}.xml';

export const URL_WARNING_SOURCE =
  process.env.URL_WARNING_SOURCE ||
  'https://www.weather.gov.hk/json/DYN_DAT_WARNSUM.json';

export const DEVICE_SECRET_KEY =
  'sjdlkgj4293gumty2q040nd74ETNPBdegtjupQIDOMQ4agjYHBblsopgrwog';
