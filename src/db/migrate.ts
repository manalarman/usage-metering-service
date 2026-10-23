import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';

// <root>/migrations, reached from src/db (tsx) or dist/src/db (compiled).
const MIGRATIONS_DIR =
  process.env.MIGRATIONS_DIR ??
  [path.resolve(__dirname, '../../migrations'), path.resolve(__dirname, '../../../migrations')].find((d) =>
    existsSync(d),
  ) ??
  path.resolve('migrations');
// Arbitrary constant; serialises concurrent migrators (e.g. several API replicas starting at once).
const MIGRATION_LOCK_KEY = 815_342_001;

/** Applies every migrations/*.sql file not yet recorded in schema_migrations, in filename order. */
export async function migrate(pool: Pool, log: (msg: string) => void = () => undefined): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
      log(`applied migration ${file}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
  return applied;
}
