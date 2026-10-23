import { loadConfig } from './config';
import { migrate } from './db/migrate';
import { createPool } from './db/pool';
import { seedPredefinedPlans } from './db/seed';
import { createApp } from './http/app';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL, config.DB_POOL_MAX);

  if (config.AUTO_MIGRATE) {
    await migrate(pool, (m) => console.log(m));
    await seedPredefinedPlans(pool);
    console.log('database ready (migrations applied, predefined plans seeded)');
  }
  if (!config.ADMIN_TOKEN) console.warn('ADMIN_TOKEN is empty: account provisioning endpoint is disabled');

  const app = createApp({ pool, adminToken: config.ADMIN_TOKEN, logRequests: config.LOG_REQUESTS });
  const server = app.listen(config.PORT, () => console.log(`usage-metering-service listening on :${config.PORT}`));

  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down`);
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('fatal startup error', err);
  process.exit(1);
});
