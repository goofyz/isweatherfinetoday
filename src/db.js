import pg from 'pg';
import { DATABASE_URL } from './config.js';

const { Pool } = pg;

export const pool = new Pool({ connectionString: DATABASE_URL });

export async function query(text, params = []) {
  const r = await pool.query(text, params);
  return r.rows;
}

export async function queryOne(text, params = []) {
  const rows = await query(text, params);
  return rows[0] ?? null;
}
