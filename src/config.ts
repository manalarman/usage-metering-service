import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1).default('postgres://metering:metering@localhost:55432/metering'),
  PORT: z.coerce.number().int().positive().default(3000),
  // Shared secret for the operator-only account provisioning endpoint. Empty disables provisioning.
  ADMIN_TOKEN: z.string().default(''),
  DB_POOL_MAX: z.coerce.number().int().positive().default(20),
  // Run migrations and the predefined-plan seed automatically at startup.
  AUTO_MIGRATE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  LOG_REQUESTS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return envSchema.parse(env);
}
