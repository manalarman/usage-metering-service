import { randomUUID } from 'node:crypto';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import request from 'supertest';
import { createPool } from '../src/db/pool';
import { createApp } from '../src/http/app';
import { ADMIN_TOKEN, TEST_DATABASE_URL } from './env';

export interface Authed {
  get: (path: string) => request.Test;
  post: (path: string, body?: object) => request.Test;
  put: (path: string, body?: object) => request.Test;
  patch: (path: string, body?: object) => request.Test;
  del: (path: string) => request.Test;
  consume: (userId: string, units: number, requestId?: string) => request.Test;
}

export function createTestContext() {
  const pool = createPool(TEST_DATABASE_URL, 30);
  /** Settable clock used by the app for UTC month assignment. */
  const clock = { now: new Date() };
  const app = createApp({ pool, adminToken: ADMIN_TOKEN, now: () => clock.now });
  let server: Server | undefined;

  const as = (apiKey: string): Authed => {
    const auth = (t: request.Test) => t.set('x-api-key', apiKey);
    return {
      get: (p) => auth(request(app).get(p)),
      post: (p, b) => auth(request(app).post(p)).send(b ?? {}),
      put: (p, b) => auth(request(app).put(p)).send(b ?? {}),
      patch: (p, b) => auth(request(app).patch(p)).send(b ?? {}),
      del: (p) => auth(request(app).delete(p)),
      consume: (userId, units, requestId = randomUUID()) =>
        auth(request(app).post('/v1/consume')).send({ userId, units, requestId }),
    };
  };

  /** Provisions a fresh account through the admin endpoint. */
  const provision = async (opts: { name?: string; planId?: string } = {}) => {
    const res = await request(app)
      .post('/v1/admin/accounts')
      .set('x-admin-token', ADMIN_TOKEN)
      .send({ name: opts.name ?? `acct-${randomUUID().slice(0, 8)}`, ...(opts.planId ? { planId: opts.planId } : {}) });
    if (res.status !== 201) throw new Error(`provision failed: ${res.status} ${JSON.stringify(res.body)}`);
    return { accountId: res.body.account.id as string, apiKey: res.body.apiKey.key as string };
  };

  return {
    pool,
    app,
    clock,
    http: () => request(app),
    as,
    provision,
    /** Starts a real HTTP listener (for genuinely concurrent requests and the CLI client). */
    async listen() {
      server = await new Promise<Server>((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
      });
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    async close() {
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      await pool.end();
    },
  };
}

export type TestContext = ReturnType<typeof createTestContext>;

type Limits = { monthlyAllowance: number; maxUnitsPerRequest: number };

/** Account on a custom account plan, with each user on its own custom user plan. */
export async function setupAccount(ctx: TestContext, opts: { account: Limits; users: Record<string, Limits> }) {
  const { accountId, apiKey } = await ctx.provision();
  const api = ctx.as(apiKey);
  const accountPlan = await api.post('/v1/plans', { name: 'acct-plan', scope: 'account', ...opts.account }).expect(201);
  await api.put('/v1/account/plan', { planId: accountPlan.body.id }).expect(200);
  const userPlans: Record<string, string> = {};
  for (const [userId, limits] of Object.entries(opts.users)) {
    const plan = await api.post('/v1/plans', { name: `plan-${userId}`, scope: 'user', ...limits }).expect(201);
    userPlans[userId] = plan.body.id;
    await api.post('/v1/users', { userId, planId: plan.body.id }).expect(201);
  }
  return { accountId, apiKey, api, accountPlanId: accountPlan.body.id as string, userPlans };
}

/** Raw counters straight from the database, bypassing the API. */
export async function dbUsage(pool: Pool, accountId: string) {
  const account = await pool.query<{ period: string; used: number }>(
    'SELECT period, used FROM account_monthly_usage WHERE account_id = $1 ORDER BY period',
    [accountId],
  );
  const users = await pool.query<{ external_id: string; period: string; used: number }>(
    `SELECT u.external_id, umu.period, umu.used FROM user_monthly_usage umu JOIN users u ON u.id = umu.user_id
      WHERE umu.account_id = $1 ORDER BY u.external_id, umu.period`,
    [accountId],
  );
  const acceptedSum = await pool.query<{ period: string; total: number }>(
    `SELECT period, sum(units)::bigint AS total FROM consumption_requests
      WHERE account_id = $1 AND accepted GROUP BY period ORDER BY period`,
    [accountId],
  );
  return { account: account.rows, users: users.rows, acceptedSum: acceptedSum.rows };
}

/** Core invariant, per month: account usage == sum(user usage) == sum(accepted request units). */
export async function assertUsageInvariant(pool: Pool, accountId: string) {
  const u = await dbUsage(pool, accountId);
  for (const row of u.account) {
    const usersSum = u.users.filter((x) => x.period === row.period).reduce((a, x) => a + x.used, 0);
    const accepted = u.acceptedSum.find((x) => x.period === row.period)?.total ?? 0;
    if (row.used !== usersSum || row.used !== accepted) {
      throw new Error(`usage invariant broken for ${row.period}: account=${row.used} users=${usersSum} accepted=${accepted}`);
    }
  }
  return u;
}
