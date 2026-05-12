import { Client } from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  console.error('Example: export DATABASE_URL=postgres://postgres:abcd1234@localhost:5432/weatherindoubt6_development');
  process.exit(1);
}

const client = new Client({ connectionString: process.env.DATABASE_URL });

try {
  await client.connect();
  const sqlPath = path.join(__dirname, 'create-db-schema.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  await client.query(sql);
  console.log('Schema creation completed.');
} catch (error) {
  console.error('Error creating schema:', error);
  process.exit(1);
} finally {
  await client.end();
}