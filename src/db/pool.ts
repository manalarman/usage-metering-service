import { Pool, PoolClient, types } from 'pg';

// BIGINT (int8) -> number. Unit counts are bounded well below 2^53 by validation.
types.setTypeParser(20, (v) => Number(v));
// DATE -> keep as 'YYYY-MM-DD' string; avoids local-timezone conversion of usage periods.
types.setTypeParser(1082, (v) => v);

export type Db = Pool;
export type Tx = PoolClient;

export function createPool(connectionString: string, max = 20): Pool {
  return new Pool({ connectionString, max });
}

/** Runs fn inside a READ COMMITTED transaction; rolls back on any error. */
export async function withTransaction<T>(pool: Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
