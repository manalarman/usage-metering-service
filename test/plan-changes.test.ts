import { afterAll, describe, expect, it } from 'vitest';
import { assertUsageInvariant, createTestContext, setupAccount } from './helpers';

const ctx = createTestContext();
afterAll(() => ctx.close());

describe('plan switches and updates', () => {
  it('switching a user plan preserves consumption', async () => {
    const { api, accountId } = await setupAccount(ctx, {
      account: { monthlyAllowance: 100_000, maxUnitsPerRequest: 1000 },
      users: { u: { monthlyAllowance: 1000, maxUnitsPerRequest: 100 } },
    });
    await api.consume('u', 90).expect(200);
    await api.put('/v1/users/u/plan', { planId: 'premium' }).expect(200);
    const usage = await api.get('/v1/users/u/usage').expect(200);
    expect(usage.body.user).toMatchObject({ consumed: 90, remaining: 20_000 - 90, plan: { code: 'premium' } });
    expect(usage.body.account.consumed).toBe(90);
    await api.put('/v1/users/u/plan', { planId: 'basic' }).expect(200);
    expect((await api.get('/v1/users/u/usage').expect(200)).body.user).toMatchObject({ consumed: 90, remaining: 910 });
    await assertUsageInvariant(ctx.pool, accountId);
  });

  it('switching the account plan preserves consumption', async () => {
    const { api } = await setupAccount(ctx, {
      account: { monthlyAllowance: 500, maxUnitsPerRequest: 500 },
      users: { u: { monthlyAllowance: 10_000, maxUnitsPerRequest: 500 } },
    });
    await api.consume('u', 300).expect(200);
    await api.put('/v1/account/plan', { planId: 'starter' }).expect(200);
    expect((await api.get('/v1/usage').expect(200)).body.account).toMatchObject({ consumed: 300, remaining: 9700, plan: { code: 'starter' } });
  });

  it('downgrading below consumed usage shows zero remaining and rejects further consumption', async () => {
    const { api, userPlans } = await setupAccount(ctx, {
      account: { monthlyAllowance: 10_000, maxUnitsPerRequest: 1000 },
      users: { u: { monthlyAllowance: 1000, maxUnitsPerRequest: 500 } },
    });
    await api.consume('u', 400).expect(200);
    await api.patch(`/v1/plans/${userPlans.u}`, { monthlyAllowance: 300 }).expect(200);
    expect((await api.get('/v1/users/u/usage').expect(200)).body.user).toMatchObject({ consumed: 400, remaining: 0 });
    const res = await api.consume('u', 1).expect(200);
    expect(res.body.blockedBy).toMatchObject({ scope: 'user', rule: 'monthly_allowance', consumed: 400, remaining: 0, limit: 300 });
    expect(res.body.user).toMatchObject({ consumed: 400, remaining: 0 });
  });

  it('downgrading the account plan below consumed usage blocks every user', async () => {
    const { api, accountPlanId } = await setupAccount(ctx, {
      account: { monthlyAllowance: 1000, maxUnitsPerRequest: 1000 },
      users: { a: { monthlyAllowance: 1000, maxUnitsPerRequest: 1000 }, b: { monthlyAllowance: 1000, maxUnitsPerRequest: 1000 } },
    });
    await api.consume('a', 600).expect(200);
    await api.patch(`/v1/plans/${accountPlanId}`, { monthlyAllowance: 500 }).expect(200);
    const res = await api.consume('b', 1).expect(200);
    expect(res.body.blockedBy).toMatchObject({ scope: 'account', rule: 'monthly_allowance', remaining: 0 });
    expect((await api.get('/v1/usage').expect(200)).body.account).toMatchObject({ consumed: 600, remaining: 0 });
  });

  it('updating a custom plan changes limits for every assigned user on their next request', async () => {
    const { apiKey } = await ctx.provision();
    const api = ctx.as(apiKey);
    const plan = await api.post('/v1/plans', { name: 'Team', scope: 'user', monthlyAllowance: 1000, maxUnitsPerRequest: 10 }).expect(201);
    for (const u of ['x', 'y']) await api.post('/v1/users', { userId: u, planId: plan.body.id }).expect(201);
    for (const u of ['x', 'y']) expect((await api.consume(u, 20)).body.accepted).toBe(false);
    await api.patch(`/v1/plans/${plan.body.id}`, { maxUnitsPerRequest: 50 }).expect(200);
    for (const u of ['x', 'y']) {
      const res = await api.consume(u, 20);
      expect(res.body.accepted).toBe(true);
      expect(res.body.user.maxUnitsPerRequest).toBe(50);
      expect((await api.get(`/v1/users/${u}`).expect(200)).body.plan.maxUnitsPerRequest).toBe(50);
    }
  });

  it('never changes previously stored outcomes', async () => {
    const { api, userPlans } = await setupAccount(ctx, {
      account: { monthlyAllowance: 10_000, maxUnitsPerRequest: 1000 },
      users: { u: { monthlyAllowance: 1000, maxUnitsPerRequest: 100 } },
    });
    const accepted = (await api.consume('u', 50, 'keep-1').expect(200)).body;
    const rejected = (await api.consume('u', 150, 'keep-2').expect(200)).body;
    await api.patch(`/v1/plans/${userPlans.u}`, { monthlyAllowance: 5, maxUnitsPerRequest: 1000, name: 'renamed' }).expect(200);
    await api.put('/v1/users/u/plan', { planId: 'premium' }).expect(200);

    const strip = ({ replayed: _r, ...o }: Record<string, unknown>) => o;
    expect((await api.get('/v1/requests/keep-1').expect(200)).body).toEqual(strip(accepted));
    expect((await api.get('/v1/requests/keep-2').expect(200)).body).toEqual(strip(rejected));
    const history = (await api.get('/v1/requests').expect(200)).body.data;
    expect(history.find((r: { requestId: string }) => r.requestId === 'keep-1').user).toMatchObject({
      planName: 'plan-u',
      monthlyAllowance: 1000,
      consumed: 50,
    });
  });
});
