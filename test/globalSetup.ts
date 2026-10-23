import { Client } from 'pg';
import { migrate } from '../src/db/migrate';
import { createPool } from '../src/db/pool';
import { seedPredefinedPlans } from '../src/db/seed';
import { TEST_DATABASE_URL } from './env';

/** Recreates the test database for a clean run, then applies migrations and the predefined-plan seed. */
export default async function setup() {
  const dbName = new URL(TEST_DATABASE_URL).pathname.slice(1);
  const adminUrl = new URL(TEST_DATABASE_URL);
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }
  const pool = createPool(TEST_DATABASE_URL, 2);
  try {
    await migrate(pool);
    await seedPredefinedPlans(pool);
  } finally {
    await pool.end();
  }
}
