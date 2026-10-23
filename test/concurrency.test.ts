import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertUsageInvariant, createTestContext, setupAccount } from './helpers';

const ctx = createTestContext();
let baseUrl: string;

beforeAll(async () => {
  // A real listener + fetch gives genuinely parallel HTTP requests over many pooled DB connections.
  baseUrl = await ctx.listen();
});
afterAll(() => ctx.close());

const consume = (apiKey: string, userId: string, units: number, requestId = randomUUID()) =>
  fetch(`${baseUrl}/v1/consume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ userId, units, requestId }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

describe('concurrent consumption', () => {
  it('never overspends the shared account allowance', async () => {
    const users = Object.fromEntries(['a', 'b', 'c', 'd'].map((u) => [u, { monthlyAllowance: 10_000, maxUnitsPerRequest: 100 }]));
    const { apiKey, accountId } = await setupAccount(ctx, { account: { monthlyAllowance: 300, maxUnitsPerRequest: 100 }, users });
    const results = await Promise.all(Array.from({ length: 120 }, (_, i) => consume(apiKey, 'abcd'[i % 4], 7)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const accepted = results.filter((r) => r.body.accepted);
    expect(accepted).toHaveLength(Math.floor(300 / 7)); // 42
    const rejected = results.filter((r) => !r.body.accepted);
    expect(rejected.every((r) => r.body.blockedBy.scope === 'account' && r.body.blockedBy.rule === 'monthly_allowance')).toBe(true);
    const usage = await assertUsageInvariant(ctx.pool, accountId);
    expect(usage.account[0].used).toBe(294);
  });

  it('never overspends a single user allowance', async () => {
    const { apiKey, accountId } = await setupAccount(ctx, {
      account: { monthlyAllowance: 1_000_000, maxUnitsPerRequest: 100 },
      users: { hot: { monthlyAllowance: 50, maxUnitsPerRequest: 10 } },
    });
    const results = await Promise.all(Array.from({ length: 80 }, () => consume(apiKey, 'hot', 3)));
    expect(results.filter((r) => r.body.accepted)).toHaveLength(16); // 48 of 50
    const usage = await assertUsageInvariant(ctx.pool, accountId);
    expect(usage.users[0].used).toBe(48);
  });

  it('isolates load across accounts (no cross-account interference)', async () => {
    const limits = { account: { monthlyAllowance: 100, maxUnitsPerRequest: 10 }, users: { u: { monthlyAllowance: 100, maxUnitsPerRequest: 10 } } };
    const [x, y] = await Promise.all([setupAccount(ctx, limits), setupAccount(ctx, limits)]);
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) => consume(i % 2 ? x.apiKey : y.apiKey, 'u', 5)),
    );
    expect(results.filter((r) => r.body.accepted)).toHaveLength(40); // 20 per account
    for (const acc of [x, y]) expect((await assertUsageInvariant(ctx.pool, acc.accountId)).account[0].used).toBe(100);
  });

  it('serialises plan updates with in-flight consumption (no lost updates, consistent limits)', async () => {
    const { apiKey, accountId, accountPlanId, api } = await setupAccount(ctx, {
      account: { monthlyAllowance: 100, maxUnitsPerRequest: 10 },
      users: { u: { monthlyAllowance: 100_000, maxUnitsPerRequest: 10 } },
    });
    const consumes = Array.from({ length: 100 }, () => consume(apiKey, 'u', 5));
    const update = api.patch(`/v1/plans/${accountPlanId}`, { monthlyAllowance: 200 }).then((r) => r.status);
    const results = await Promise.all(consumes);
    expect(await update).toBe(200);
    const accepted = results.filter((r) => r.body.accepted);
    // Each decision saw either the old (100) or the new (200) limit, never anything in between.
    for (const r of results) expect([100, 200]).toContain(r.body.account.monthlyAllowance);
    for (const r of accepted) expect(r.body.account.consumed).toBeLessThanOrEqual(r.body.account.monthlyAllowance);
    const usage = await assertUsageInvariant(ctx.pool, accountId);
    expect(usage.account[0].used).toBe(accepted.length * 5);
    expect(usage.account[0].used).toBeLessThanOrEqual(200);
  });

  it('keeps counters consistent under a mix of accepted, rejected and retried requests', async () => {
    const { apiKey, accountId } = await setupAccount(ctx, {
      account: { monthlyAllowance: 500, maxUnitsPerRequest: 50 },
      users: { a: { monthlyAllowance: 300, maxUnitsPerRequest: 20 }, b: { monthlyAllowance: 300, maxUnitsPerRequest: 40 } },
    });
    const ids = Array.from({ length: 50 }, () => randomUUID());
    const jobs = ids.flatMap((id, i) => {
      const userId = i % 2 ? 'a' : 'b';
      const units = 5 + (i % 30); // some exceed a's per-request cap of 20
      return [consume(apiKey, userId, units, id), consume(apiKey, userId, units, id)]; // each sent twice
    });
    const results = await Promise.all(jobs);
    expect(results.every((r) => r.status === 200)).toBe(true);
    // Both copies of each request id agree on the decision.
    for (let i = 0; i < results.length; i += 2) expect(results[i].body.accepted).toBe(results[i + 1].body.accepted);
    const { rows } = await ctx.pool.query('SELECT count(*)::int AS n FROM consumption_requests WHERE account_id = $1', [accountId]);
    expect(rows[0].n).toBe(50);
    await assertUsageInvariant(ctx.pool, accountId);
  });
});
