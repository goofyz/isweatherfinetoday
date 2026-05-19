import path from 'path';
import express from 'express';
import { fileURLToPath } from 'url';

import weather_stations from '../db/weather_stations.json' with { type: 'json' };
import aqhi_stations from '../db/aqhi_stations.json' with { type: 'json' };

import { PORT } from './config.js';
import v1Api from './routes/v1-api.js';
import { connectRedis, loadAqhiStations, loadWeatherStations } from './redis-client.js';
import logger from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const publicDir = path.join(root, 'public');

const app = express();
app.set('trust proxy', 1);

app.use(express.static(publicDir));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/api/v1', v1Api);

await connectRedis();

await loadWeatherStations(weather_stations);
await loadAqhiStations(aqhi_stations);
logger.info(
  `Loaded into Redis: weather_stations=${weather_stations.length}, aqhi_stations=${aqhi_stations.length}`,
);

await import('./scheduler.js');

app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.get('/help', (_req, res) => {
  res.sendFile(path.join(publicDir, 'help.html'));
});

app.get('/credit', (_req, res) => {
  res.sendFile(path.join(publicDir, 'credit.html'));
});

app.get('/terms', (_req, res) => {
  res.sendFile(path.join(publicDir, 'terms.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Listening on http://0.0.0.0:${PORT}`);
});
