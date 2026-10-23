// Standalone migrate + seed: `npm run migrate` (the API also does this at startup when AUTO_MIGRATE=true).
import { loadConfig } from '../config';
import { migrate } from './migrate';
import { createPool } from './pool';
import { seedPredefinedPlans } from './seed';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL, 2);
  try {
    const applied = await migrate(pool, console.log);
    await seedPredefinedPlans(pool);
    console.log(`migrations applied: ${applied.length}; predefined plans seeded`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
