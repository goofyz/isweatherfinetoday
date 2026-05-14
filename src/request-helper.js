import https from 'https';
import http from 'http';
import { URL } from 'url';

// Legacy Ruby code used VERIFY_NONE; keep compatibility by default.
// Set ALLOW_INSECURE_TLS=0 to enforce strict certificate validation.
const ALLOW_INSECURE_TLS = process.env.ALLOW_INSECURE_TLS !== '0';

function requestRaw(urlString, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers: {
          'User-Agent': 'weatherindoubt-node/1',
          ...headers,
        },
        timeout: 15_000,
        ...(u.protocol === 'https:' && ALLOW_INSECURE_TLS
          ? { rejectUnauthorized: false }
          : {}),
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: buf.toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    if (body) req.write(body);
    req.end();
  });
}

export async function get(url) {
  const res = await requestRaw(url);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`Request failed with status ${res.statusCode}`);
  }
  return res.body;
}

export async function getResponse(url) {
  const res = await requestRaw(url);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`Request failed with status ${res.statusCode}`);
  }
  return res;
}

export async function getJson(url) {
  const text = await get(url);
  return JSON.parse(text);
}

export async function getRemotePageAsString(url) {
  const res = await requestRaw(url);
  if (res.statusCode !== 200) {
    throw new Error(`Request failed with status ${res.statusCode}`);
  }
  return res.body;
}
