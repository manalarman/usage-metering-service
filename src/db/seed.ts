import { Pool } from 'pg';

export interface PredefinedPlan {
  id: string;
  code: string;
  scope: 'account' | 'user';
  name: string;
  monthlyAllowance: number;
  maxUnitsPerRequest: number;
}

/**
 * Predefined, read-only plans. Fixed UUIDs keep references stable across environments.
 * Re-running the seed converges the database to these definitions.
 */
export const PREDEFINED_PLANS: PredefinedPlan[] = [
  { id: '00000000-0000-4000-8000-00000000a001', code: 'starter', scope: 'account', name: 'Starter', monthlyAllowance: 10_000, maxUnitsPerRequest: 500 },
  { id: '00000000-0000-4000-8000-00000000a002', code: 'pro', scope: 'account', name: 'Pro', monthlyAllowance: 1_000_000, maxUnitsPerRequest: 10_000 },
  { id: '00000000-0000-4000-8000-00000000b001', code: 'basic', scope: 'user', name: 'Basic', monthlyAllowance: 1_000, maxUnitsPerRequest: 100 },
  { id: '00000000-0000-4000-8000-00000000b002', code: 'premium', scope: 'user', name: 'Premium', monthlyAllowance: 20_000, maxUnitsPerRequest: 1_000 },
];

export const DEFAULT_ACCOUNT_PLAN_CODE = 'starter';
export const DEFAULT_USER_PLAN_CODE = 'basic';

export async function seedPredefinedPlans(pool: Pool): Promise<void> {
  for (const p of PREDEFINED_PLANS) {
    await pool.query(
      `INSERT INTO plans (id, owner_account_id, code, scope, name, monthly_allowance, max_units_per_request)
       VALUES ($1, NULL, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         monthly_allowance = EXCLUDED.monthly_allowance,
         max_units_per_request = EXCLUDED.max_units_per_request,
         version = plans.version + 1,
         updated_at = now()
       WHERE (plans.name, plans.monthly_allowance, plans.max_units_per_request)
             IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.monthly_allowance, EXCLUDED.max_units_per_request)`,
      [p.id, p.code, p.scope, p.name, p.monthlyAllowance, p.maxUnitsPerRequest],
    );
  }
}
