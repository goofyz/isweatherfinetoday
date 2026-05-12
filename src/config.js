import 'dotenv/config';
import admin from 'firebase-admin';
import a from '../serviceAccountKey.json' with { type: 'json' };

// Initialize Firebase Admin SDK
let firebaseAdminApp;
try {
  // Option 1: Load from service account JSON file (recommended)
  // Place your serviceAccountKey.json in the project root or src/
  firebaseAdminApp = admin.initializeApp({
    credential: admin.credential.cert(a),
  });
} catch {
  try {
    // Option 2: Load from environment variables (if service account key is in env)
    const serviceAccount = {
      type: "service_account",
      project_id: process.env.FIREBASE_PROJECT_ID,
      private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
      private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      client_id: process.env.FIREBASE_CLIENT_ID,
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
      client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
    };
    firebaseAdminApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  } catch {
    console.warn('Firebase Admin SDK not initialized. FCM sending will be skipped.');
  }
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
