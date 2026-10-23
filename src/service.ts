import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { generateApiKey, hashApiKey } from './apiKeys';
import { Tx, withTransaction } from './db/pool';
import { DEFAULT_ACCOUNT_PLAN_CODE, DEFAULT_USER_PLAN_CODE } from './db/seed';
import { ApiError, notFound } from './errors';
import { monthOf, periodFromMonth, periodOf } from './time';

export type Scope = 'account' | 'user';
export type RuleName = 'max_units_per_request' | 'monthly_allowance';
type Queryable = Pool | Tx;

interface PlanRow {
  id: string;
  owner_account_id: string | null;
  code: string | null;
  scope: Scope;
  name: string;
  monthly_allowance: number;
  max_units_per_request: number;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface PlanDto {
  id: string;
  code: string | null;
  name: string;
  scope: Scope;
  predefined: boolean;
  monthlyAllowance: number;
  maxUnitsPerRequest: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface RuleViolation {
  scope: Scope;
  rule: RuleName;
  limit: number;
  requested: number;
  /** Units already consumed this month (monthly_allowance rule only). */
  consumed?: number;
  /** Units still available this month (monthly_allowance rule only). */
  remaining?: number;
  message: string;
}

export interface QuotaSnapshot {
  planId: string;
  planName: string;
  monthlyAllowance: number;
  maxUnitsPerRequest: number;
  consumed: number;
  remaining: number;
}

/** Immutable decision record. Stored as JSONB and returned verbatim for retries and history. */
export interface ConsumptionOutcome {
  requestId: string;
  userId: string;
  units: number;
  accepted: boolean;
  decision: 'accepted' | 'rejected';
  /** First violated rule in evaluation order; null when accepted. */
  blockedBy: RuleViolation | null;
  /** Every violated rule, in evaluation order. */
  violations: RuleViolation[];
  month: string;
  processedAt: string;
  account: QuotaSnapshot;
  user: QuotaSnapshot;
}

export interface ConsumeResult {
  outcome: ConsumptionOutcome;
  replayed: boolean;
}

const PG_UNIQUE_VIOLATION = '23505';

const toPlanDto = (p: PlanRow): PlanDto => ({
  id: p.id,
  code: p.code,
  name: p.name,
  scope: p.scope,
  predefined: p.owner_account_id === null,
  monthlyAllowance: p.monthly_allowance,
  maxUnitsPerRequest: p.max_units_per_request,
  version: p.version,
  createdAt: p.created_at.toISOString(),
  updatedAt: p.updated_at.toISOString(),
});

const remainingOf = (allowance: number, consumed: number) => Math.max(0, allowance - consumed);

const isUniqueViolation = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === PG_UNIQUE_VIOLATION;

export class MeteringService {
  constructor(
    private readonly pool: Pool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ---------------------------------------------------------------- accounts & keys

  async createAccount(name: string, planRef?: string) {
    return withTransaction(this.pool, async (tx) => {
      const plan = await this.resolvePlan(tx, null, planRef ?? DEFAULT_ACCOUNT_PLAN_CODE, 'account');
      const id = randomUUID();
      await tx.query('INSERT INTO accounts (id, name, account_plan_id) VALUES ($1, $2, $3)', [id, name, plan.id]);
      const key = await this.insertApiKey(tx, id);
      return { account: await this.getAccount(id, tx), apiKey: key };
    });
  }

  /** Returns the account id for an active API key, or null. */
  async authenticate(rawKey: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ account_id: string }>(
      'SELECT account_id FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL',
      [hashApiKey(rawKey)],
    );
    return rows[0]?.account_id ?? null;
  }

  async createApiKey(accountId: string) {
    return this.insertApiKey(this.pool, accountId);
  }

  async listApiKeys(accountId: string) {
    const { rows } = await this.pool.query(
      `SELECT id, key_prefix, created_at, revoked_at FROM api_keys WHERE account_id = $1 ORDER BY created_at, id`,
      [accountId],
    );
    return rows.map((r) => ({
      id: r.id as string,
      prefix: r.key_prefix as string,
      createdAt: (r.created_at as Date).toISOString(),
      revokedAt: r.revoked_at ? (r.revoked_at as Date).toISOString() : null,
    }));
  }

  async revokeApiKey(accountId: string, keyId: string) {
    const { rowCount } = await this.pool.query(
      `UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now()) WHERE id::text = $1 AND account_id = $2`,
      [keyId, accountId],
    );
    if (!rowCount) throw notFound('api_key_not_found', 'API key not found');
  }

  private async insertApiKey(q: Queryable, accountId: string) {
    const { key, prefix, hash } = generateApiKey();
    const id = randomUUID();
    const { rows } = await q.query<{ created_at: Date }>(
      'INSERT INTO api_keys (id, account_id, key_prefix, key_hash) VALUES ($1, $2, $3, $4) RETURNING created_at',
      [id, accountId, prefix, hash],
    );
    // The plaintext key is returned exactly once and never persisted.
    return { id, key, prefix, createdAt: rows[0].created_at.toISOString() };
  }

  async getAccount(accountId: string, q: Queryable = this.pool) {
    const { rows } = await q.query(
      `SELECT a.id, a.name, a.created_at, row_to_json(p.*) AS plan
         FROM accounts a JOIN plans p ON p.id = a.account_plan_id
        WHERE a.id = $1`,
      [accountId],
    );
    if (!rows[0]) throw notFound('account_not_found', 'Account not found');
    const r = rows[0];
    return {
      id: r.id as string,
      name: r.name as string,
      createdAt: (r.created_at as Date).toISOString(),
      plan: toPlanDto(reviveJsonPlan(r.plan)),
    };
  }

  /** Switches the account plan. Usage counters are untouched, so consumption is preserved. */
  async setAccountPlan(accountId: string, planRef: string) {
    return withTransaction(this.pool, async (tx) => {
      await this.lockAccount(tx, accountId);
      const plan = await this.resolvePlan(tx, accountId, planRef, 'account');
      await tx.query('UPDATE accounts SET account_plan_id = $1 WHERE id = $2', [plan.id, accountId]);
      return this.getAccount(accountId, tx);
    });
  }

  // ---------------------------------------------------------------- plans

  async listPlans(accountId: string, scope?: Scope) {
    const { rows } = await this.pool.query<PlanRow>(
      `SELECT * FROM plans
        WHERE (owner_account_id IS NULL OR owner_account_id = $1)
          AND ($2::text IS NULL OR scope = $2)
        ORDER BY owner_account_id NULLS FIRST, scope, monthly_allowance, name`,
      [accountId, scope ?? null],
    );
    return rows.map(toPlanDto);
  }

  async getPlan(accountId: string, planRef: string) {
    return toPlanDto(await this.resolvePlan(this.pool, accountId, planRef));
  }

  async createPlan(
    accountId: string,
    input: { name: string; scope: Scope; monthlyAllowance: number; maxUnitsPerRequest: number },
  ) {
    try {
      const { rows } = await this.pool.query<PlanRow>(
        `INSERT INTO plans (id, owner_account_id, code, scope, name, monthly_allowance, max_units_per_request)
         VALUES ($1, $2, NULL, $3, $4, $5, $6) RETURNING *`,
        [randomUUID(), accountId, input.scope, input.name, input.monthlyAllowance, input.maxUnitsPerRequest],
      );
      return toPlanDto(rows[0]);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ApiError(409, 'plan_name_taken', `A custom ${input.scope} plan named "${input.name}" already exists`);
      }
      throw err;
    }
  }

  /**
   * Updates a custom plan in place. Every account/user assigned to it sees the new limits on their
   * next request. Lock order (account row, then plan row) matches consumption, so an update and a
   * consume on the same account are strictly serialised: a consume sees either all-old or all-new limits.
   */
  async updatePlan(
    accountId: string,
    planRef: string,
    patch: { name?: string; monthlyAllowance?: number; maxUnitsPerRequest?: number },
  ) {
    return withTransaction(this.pool, async (tx) => {
      await this.lockAccount(tx, accountId);
      const plan = await this.resolvePlan(tx, accountId, planRef);
      if (plan.owner_account_id === null) {
        throw new ApiError(403, 'plan_read_only', 'Predefined plans are read-only; create a custom plan instead');
      }
      try {
        const { rows } = await tx.query<PlanRow>(
          `UPDATE plans SET
             name = COALESCE($2, name),
             monthly_allowance = COALESCE($3, monthly_allowance),
             max_units_per_request = COALESCE($4, max_units_per_request),
             version = version + 1,
             updated_at = now()
           WHERE id = $1 RETURNING *`,
          [plan.id, patch.name ?? null, patch.monthlyAllowance ?? null, patch.maxUnitsPerRequest ?? null],
        );
        return toPlanDto(rows[0]);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ApiError(409, 'plan_name_taken', `A custom ${plan.scope} plan named "${patch.name}" already exists`);
        }
        throw err;
      }
    });
  }

  /**
   * Finds a plan by UUID or predefined code that is visible to the account (predefined, or owned by it).
   * Other accounts' plans are reported as not found so their existence is not disclosed.
   */
  private async resolvePlan(q: Queryable, accountId: string | null, ref: string, expectedScope?: Scope) {
    const { rows } = await q.query<PlanRow>(
      `SELECT * FROM plans
        WHERE (id::text = $1 OR code = $1)
          AND (owner_account_id IS NULL OR owner_account_id = $2)`,
      [ref, accountId],
    );
    const plan = rows[0];
    if (!plan) throw notFound('plan_not_found', `Plan "${ref}" not found`);
    if (expectedScope && plan.scope !== expectedScope) {
      throw new ApiError(
        422,
        'plan_scope_mismatch',
        `Plan "${plan.name}" is a ${plan.scope} plan and cannot be assigned as a${expectedScope === 'account' ? 'n' : ''} ${expectedScope} plan`,
      );
    }
    return plan;
  }

  // ---------------------------------------------------------------- users

  async createUser(accountId: string, externalId: string, planRef?: string) {
    return withTransaction(this.pool, async (tx) => {
      const plan = await this.resolvePlan(tx, accountId, planRef ?? DEFAULT_USER_PLAN_CODE, 'user');
      try {
        await tx.query('INSERT INTO users (id, account_id, external_id, user_plan_id) VALUES ($1, $2, $3, $4)', [
          randomUUID(),
          accountId,
          externalId,
          plan.id,
        ]);
      } catch (err) {
        if (isUniqueViolation(err)) throw new ApiError(409, 'user_exists', `User "${externalId}" already exists`);
        throw err;
      }
      return this.getUser(accountId, externalId, tx);
    });
  }

  async listUsers(accountId: string, limit: number, cursor?: string) {
    const { rows } = await this.pool.query(
      `SELECT u.external_id, u.created_at, row_to_json(p.*) AS plan
         FROM users u JOIN plans p ON p.id = u.user_plan_id
        WHERE u.account_id = $1 AND ($2::text IS NULL OR u.external_id > $2)
        ORDER BY u.external_id
        LIMIT $3`,
      [accountId, cursor ?? null, limit + 1],
    );
    const page = rows.slice(0, limit).map(toUserDto);
    return { data: page, nextCursor: rows.length > limit ? page[page.length - 1].userId : null };
  }

  async getUser(accountId: string, externalId: string, q: Queryable = this.pool) {
    const { rows } = await q.query(
      `SELECT u.external_id, u.created_at, row_to_json(p.*) AS plan
         FROM users u JOIN plans p ON p.id = u.user_plan_id
        WHERE u.account_id = $1 AND u.external_id = $2`,
      [accountId, externalId],
    );
    if (!rows[0]) throw userNotFound(externalId);
    return toUserDto(rows[0]);
  }

  /** Switches a user's plan. Usage counters are untouched, so consumption is preserved. */
  async setUserPlan(accountId: string, externalId: string, planRef: string) {
    return withTransaction(this.pool, async (tx) => {
      await this.lockAccount(tx, accountId);
      const user = await this.lockUser(tx, accountId, externalId);
      const plan = await this.resolvePlan(tx, accountId, planRef, 'user');
      await tx.query('UPDATE users SET user_plan_id = $1 WHERE id = $2', [plan.id, user.id]);
      return this.getUser(accountId, externalId, tx);
    });
  }

  // ---------------------------------------------------------------- consumption

  /**
   * Evaluates and (if allowed) records a consumption request atomically.
   *
   * Exact retries of an already-decided request are answered from the stored outcome without
   * taking any lock (decisions are immutable). Everything else runs in one transaction with
   * four statements, the first of which takes the account lock:
   *
   *   1. accounts row   SELECT ... FOR NO KEY UPDATE   serialises every quota decision, plan switch and
   *                                                   custom-plan update of this account (same lock order
   *                                                   everywhere: account row first)
   *   2. one read       idempotency re-check, user, both plans, both monthly counters. Runs as a new
   *                     statement after the lock is granted, so it sees all previously committed decisions.
   *   3. one write      (accepted only) upsert account + user counters by the same amount, and insert the
   *                     decision row; UNIQUE(account_id, request_id) is the final safety net
   *   4. COMMIT
   */
  async consume(accountId: string, input: { userId: string; units: number; requestId: string }): Promise<ConsumeResult> {
    const replay = await this.findDecision(this.pool, accountId, input);
    if (replay) return replay;
    for (let attempt = 0; ; attempt++) {
      try {
        return await withTransaction(this.pool, (tx) => this.consumeTx(tx, accountId, input));
      } catch (err) {
        // Cannot normally happen thanks to the account lock; on a race, retry once and replay the winner.
        if (isUniqueViolation(err) && attempt === 0) continue;
        throw err;
      }
    }
  }

  /** Stored decision for (account, requestId): replayed if the input matches, 409 if it differs. */
  private async findDecision(
    q: Queryable,
    accountId: string,
    input: { userId: string; units: number; requestId: string },
  ): Promise<ConsumeResult | null> {
    const { rows } = await q.query<{ external_id: string; units: number; outcome: ConsumptionOutcome }>(
      `SELECT u.external_id, cr.units, cr.outcome
         FROM consumption_requests cr JOIN users u ON u.id = cr.user_id
        WHERE cr.account_id = $1 AND cr.request_id = $2`,
      [accountId, input.requestId],
    );
    const prev = rows[0];
    if (!prev) return null;
    if (prev.external_id !== input.userId || prev.units !== input.units) {
      throw new ApiError(
        409,
        'idempotency_conflict',
        `Request id "${input.requestId}" was already used with different parameters`,
        { original: { userId: prev.external_id, units: prev.units } },
      );
    }
    return { outcome: prev.outcome, replayed: true };
  }

  private async consumeTx(
    tx: Tx,
    accountId: string,
    input: { userId: string; units: number; requestId: string },
  ): Promise<ConsumeResult> {
    const account = await this.lockAccount(tx, accountId);

    // Re-check under the lock: a concurrent duplicate may have committed while we waited.
    const replay = await this.findDecision(tx, accountId, input);
    if (replay) return replay;

    const processedAt = this.now();
    const period = periodOf(processedAt);
    const { rows } = await tx.query<{
      user_id: string | null;
      account_plan: Record<string, unknown>;
      user_plan: Record<string, unknown> | null;
      account_used: number;
      user_used: number;
    }>(
      `SELECT u.id AS user_id,
              (SELECT row_to_json(p) FROM plans p WHERE p.id = $3) AS account_plan,
              (SELECT row_to_json(p) FROM plans p WHERE p.id = u.user_plan_id) AS user_plan,
              COALESCE((SELECT used FROM account_monthly_usage WHERE account_id = $1 AND period = $4), 0) AS account_used,
              COALESCE((SELECT used FROM user_monthly_usage WHERE user_id = u.id AND period = $4), 0) AS user_used
         FROM (SELECT 1) AS one
         LEFT JOIN users u ON u.account_id = $1 AND u.external_id = $2`,
      [accountId, input.userId, account.account_plan_id, period],
    );
    const state = rows[0];
    if (!state.user_id || !state.user_plan) throw userNotFound(input.userId);
    const accountPlan = reviveJsonPlan(state.account_plan);
    const userPlan = reviveJsonPlan(state.user_plan);

    const violations = evaluateRules(
      input.units,
      { plan: userPlan, used: state.user_used },
      { plan: accountPlan, used: state.account_used },
    );
    const accepted = violations.length === 0;
    // Exact under the account lock: nobody else can move these counters until we commit.
    const accountAfter = state.account_used + (accepted ? input.units : 0);
    const userAfter = state.user_used + (accepted ? input.units : 0);

    const outcome: ConsumptionOutcome = {
      requestId: input.requestId,
      userId: input.userId,
      units: input.units,
      accepted,
      decision: accepted ? 'accepted' : 'rejected',
      blockedBy: violations[0] ?? null,
      violations,
      month: monthOf(period),
      processedAt: processedAt.toISOString(),
      account: snapshot(accountPlan, accountAfter),
      user: snapshot(userPlan, userAfter),
    };

    // Both counters move by the same amount in the same statement, so account usage always
    // equals the sum of its users' accepted consumption. Rejections touch no counter.
    const written = await tx.query<{ account_used: number | null; user_used: number | null }>(
      `WITH acc AS (
         INSERT INTO account_monthly_usage (account_id, period, used)
         SELECT $1, $2::date, $3 WHERE $4::boolean
         ON CONFLICT (account_id, period) DO UPDATE
           SET used = account_monthly_usage.used + EXCLUDED.used, updated_at = now()
         RETURNING used
       ), usr AS (
         INSERT INTO user_monthly_usage (user_id, account_id, period, used)
         SELECT $5, $1, $2::date, $3 WHERE $4::boolean
         ON CONFLICT (user_id, period) DO UPDATE
           SET used = user_monthly_usage.used + EXCLUDED.used, updated_at = now()
         RETURNING used
       )
       INSERT INTO consumption_requests
         (account_id, request_id, user_id, units, accepted, blocking_scope, blocking_rule, period, outcome, created_at)
       VALUES ($1, $6, $5, $3, $4, $7, $8, $2::date, $9, $10)
       RETURNING (SELECT used FROM acc) AS account_used, (SELECT used FROM usr) AS user_used`,
      [
        accountId,
        period,
        input.units,
        accepted,
        state.user_id,
        input.requestId,
        outcome.blockedBy?.scope ?? null,
        outcome.blockedBy?.rule ?? null,
        JSON.stringify(outcome),
        processedAt,
      ],
    );
    if (accepted && (written.rows[0].account_used !== accountAfter || written.rows[0].user_used !== userAfter)) {
      // Would indicate a counter changed without holding the account lock; abort rather than record it.
      throw new Error('usage counter changed concurrently; aborting decision');
    }
    return { outcome, replayed: false };
  }

  private async lockAccount(tx: Tx, accountId: string) {
    const { rows } = await tx.query<{ id: string; account_plan_id: string }>(
      'SELECT id, account_plan_id FROM accounts WHERE id = $1 FOR NO KEY UPDATE',
      [accountId],
    );
    if (!rows[0]) throw notFound('account_not_found', 'Account not found');
    return rows[0];
  }

  /** Locks a user, scoped to the account: a user id from another account is simply "not found". */
  private async lockUser(tx: Tx, accountId: string, externalId: string) {
    const { rows } = await tx.query<{ id: string; user_plan_id: string }>(
      'SELECT id, user_plan_id FROM users WHERE account_id = $1 AND external_id = $2 FOR NO KEY UPDATE',
      [accountId, externalId],
    );
    if (!rows[0]) throw userNotFound(externalId);
    return rows[0];
  }

  // ---------------------------------------------------------------- usage & history

  /** Account usage for a UTC month (default: the current month), measured against current plan limits. */
  async getAccountUsage(accountId: string, month?: string) {
    const period = month ? periodFromMonth(month) : periodOf(this.now());
    const account = await this.getAccount(accountId);
    const { rows } = await this.pool.query<{ used: number }>(
      'SELECT used FROM account_monthly_usage WHERE account_id = $1 AND period = $2',
      [accountId, period],
    );
    const consumed = rows[0]?.used ?? 0;
    return {
      month: monthOf(period),
      isCurrentMonth: period === periodOf(this.now()),
      account: { id: account.id, name: account.name, ...usageWithLimits(account.plan, consumed) },
    };
  }

  /** User usage plus the shared account usage it draws from. */
  async getUserUsage(accountId: string, externalId: string, month?: string) {
    const period = month ? periodFromMonth(month) : periodOf(this.now());
    const user = await this.getUser(accountId, externalId);
    const { rows } = await this.pool.query<{ used: number }>(
      `SELECT umu.used FROM user_monthly_usage umu JOIN users u ON u.id = umu.user_id
        WHERE u.account_id = $1 AND u.external_id = $2 AND umu.period = $3`,
      [accountId, externalId, period],
    );
    const accountUsage = await this.getAccountUsage(accountId, monthOf(period));
    return {
      month: monthOf(period),
      isCurrentMonth: accountUsage.isCurrentMonth,
      user: { userId: user.userId, ...usageWithLimits(user.plan, rows[0]?.used ?? 0) },
      account: accountUsage.account,
    };
  }

  /** Every month with recorded usage, newest first (for an account or one of its users). */
  async getUsageHistory(accountId: string, externalId?: string) {
    if (externalId) {
      await this.getUser(accountId, externalId);
      const { rows } = await this.pool.query<{ period: string; used: number }>(
        `SELECT umu.period, umu.used FROM user_monthly_usage umu JOIN users u ON u.id = umu.user_id
          WHERE u.account_id = $1 AND u.external_id = $2 ORDER BY umu.period DESC`,
        [accountId, externalId],
      );
      return { userId: externalId, months: rows.map((r) => ({ month: monthOf(r.period), consumed: r.used })) };
    }
    const { rows } = await this.pool.query<{ period: string; used: number }>(
      'SELECT period, used FROM account_monthly_usage WHERE account_id = $1 ORDER BY period DESC',
      [accountId],
    );
    return { months: rows.map((r) => ({ month: monthOf(r.period), consumed: r.used })) };
  }

  /** Paginated decision history, newest first. Keyset pagination on the monotonic seq column. */
  async listRequests(
    accountId: string,
    opts: { limit: number; cursor?: string; userId?: string; decision?: 'accepted' | 'rejected'; month?: string },
  ) {
    const { rows } = await this.pool.query<{ seq: number; outcome: ConsumptionOutcome }>(
      `SELECT cr.seq, cr.outcome
         FROM consumption_requests cr JOIN users u ON u.id = cr.user_id
        WHERE cr.account_id = $1
          AND ($2::bigint IS NULL OR cr.seq < $2)
          AND ($3::boolean IS NULL OR cr.accepted = $3)
          AND ($4::date IS NULL OR cr.period = $4)
          AND ($5::text IS NULL OR u.external_id = $5)
        ORDER BY cr.seq DESC
        LIMIT $6`,
      [
        accountId,
        opts.cursor ?? null,
        opts.decision ? opts.decision === 'accepted' : null,
        opts.month ? periodFromMonth(opts.month) : null,
        opts.userId ?? null,
        opts.limit + 1,
      ],
    );
    const page = rows.slice(0, opts.limit);
    return {
      data: page.map((r) => r.outcome),
      nextCursor: rows.length > opts.limit ? String(page[page.length - 1].seq) : null,
    };
  }

  async getRequest(accountId: string, requestId: string) {
    const { rows } = await this.pool.query<{ outcome: ConsumptionOutcome }>(
      'SELECT outcome FROM consumption_requests WHERE account_id = $1 AND request_id = $2',
      [accountId, requestId],
    );
    if (!rows[0]) throw notFound('request_not_found', `Request "${requestId}" not found`);
    return rows[0].outcome;
  }
}

/**
 * Deterministic rule evaluation order (all rules are always evaluated; the first failure is `blockedBy`):
 *   1. user    max_units_per_request
 *   2. account max_units_per_request
 *   3. user    monthly_allowance
 *   4. account monthly_allowance
 * Per-request caps come first because they are independent of accumulated usage; within each rule
 * type the narrower (user) scope is reported before the shared (account) scope.
 */
export function evaluateRules(
  units: number,
  user: { plan: Pick<PlanRow, 'monthly_allowance' | 'max_units_per_request'>; used: number },
  account: { plan: Pick<PlanRow, 'monthly_allowance' | 'max_units_per_request'>; used: number },
): RuleViolation[] {
  const violations: RuleViolation[] = [];
  const scopes: Array<[Scope, typeof user]> = [
    ['user', user],
    ['account', account],
  ];
  for (const [scope, s] of scopes) {
    if (units > s.plan.max_units_per_request) {
      violations.push({
        scope,
        rule: 'max_units_per_request',
        limit: s.plan.max_units_per_request,
        requested: units,
        message: `${capitalize(scope)} plan allows at most ${s.plan.max_units_per_request} units per request; ${units} requested`,
      });
    }
  }
  for (const [scope, s] of scopes) {
    if (s.used + units > s.plan.monthly_allowance) {
      const remaining = remainingOf(s.plan.monthly_allowance, s.used);
      violations.push({
        scope,
        rule: 'monthly_allowance',
        limit: s.plan.monthly_allowance,
        requested: units,
        consumed: s.used,
        remaining,
        message: `${capitalize(scope)} monthly allowance of ${s.plan.monthly_allowance} units would be exceeded (${s.used} consumed, ${remaining} remaining, ${units} requested)`,
      });
    }
  }
  return violations;
}

function snapshot(plan: PlanRow, consumed: number): QuotaSnapshot {
  return {
    planId: plan.id,
    planName: plan.name,
    monthlyAllowance: plan.monthly_allowance,
    maxUnitsPerRequest: plan.max_units_per_request,
    consumed,
    remaining: remainingOf(plan.monthly_allowance, consumed),
  };
}

function usageWithLimits(plan: PlanDto, consumed: number) {
  return {
    plan,
    limits: { monthlyAllowance: plan.monthlyAllowance, maxUnitsPerRequest: plan.maxUnitsPerRequest },
    consumed,
    remaining: remainingOf(plan.monthlyAllowance, consumed),
  };
}

/** row_to_json() yields timestamps as strings and bigint as numbers; normalise to PlanRow. */
function reviveJsonPlan(p: Record<string, unknown>): PlanRow {
  return {
    ...(p as unknown as PlanRow),
    monthly_allowance: Number(p.monthly_allowance),
    max_units_per_request: Number(p.max_units_per_request),
    created_at: new Date(p.created_at as string),
    updated_at: new Date(p.updated_at as string),
  };
}

function toUserDto(r: { external_id: string; created_at: Date; plan: Record<string, unknown> }) {
  return { userId: r.external_id, createdAt: r.created_at.toISOString(), plan: toPlanDto(reviveJsonPlan(r.plan)) };
}

const userNotFound = (externalId: string) => notFound('user_not_found', `User "${externalId}" not found in this account`);
const capitalize = (s: string) => s[0].toUpperCase() + s.slice(1);
