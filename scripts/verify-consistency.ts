// Database-wide invariant check (run after load tests):
// for every account and month, account usage == sum(user usage) == sum(accepted request units),
// and no counter exceeds what the decisions recorded.
import { Pool } from 'pg';

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://metering:metering@localhost:55432/metering' });
  try {
    const { rows } = await pool.query(`
      WITH a AS (SELECT account_id, period, used FROM account_monthly_usage),
           u AS (SELECT account_id, period, sum(used)::bigint AS used FROM user_monthly_usage GROUP BY 1, 2),
           r AS (SELECT account_id, period, sum(units)::bigint AS used, count(*)::bigint AS n
                   FROM consumption_requests WHERE accepted GROUP BY 1, 2)
      SELECT coalesce(a.account_id, u.account_id, r.account_id) AS account_id,
             coalesce(a.period, u.period, r.period) AS period,
             coalesce(a.used, 0) AS account_used, coalesce(u.used, 0) AS users_used, coalesce(r.used, 0) AS accepted_units
        FROM a FULL JOIN u USING (account_id, period) FULL JOIN r USING (account_id, period)`);
    const bad = rows.filter((r) => r.account_used !== r.users_used || r.account_used !== r.accepted_units);
    const totals = await pool.query(
      `SELECT count(*)::int AS decisions, count(*) FILTER (WHERE accepted)::int AS accepted FROM consumption_requests`,
    );
    console.log(`checked ${rows.length} account-months; decisions=${totals.rows[0].decisions} accepted=${totals.rows[0].accepted}`);
    if (bad.length) {
      console.error('INCONSISTENT:', bad);
      process.exitCode = 1;
    } else {
      console.log('OK: account usage == sum(user usage) == sum(accepted units) for every account-month');
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
