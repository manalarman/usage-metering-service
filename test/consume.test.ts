import { afterAll, describe, expect, it } from 'vitest';
import { evaluateRules } from '../src/service';
import { assertUsageInvariant, createTestContext, dbUsage, setupAccount } from './helpers';

const ctx = createTestContext();
afterAll(() => ctx.close());

describe('rule evaluation order (unit)', () => {
  const plan = (monthly: number, perReq: number) => ({ monthly_allowance: monthly, max_units_per_request: perReq });

  it('reports every violation in the documented order', () => {
    const v = evaluateRules(50, { plan: plan(60, 10), used: 20 }, { plan: plan(55, 20), used: 10 });
    expect(v.map((x) => `${x.scope}:${x.rule}`)).toEqual([
      'user:max_units_per_request',
      'account:max_units_per_request',
      'user:monthly_allowance',
      'account:monthly_allowance',
    ]);
    expect(v[2]).toMatchObject({ limit: 60, consumed: 20, remaining: 40, requested: 50 });
  });

  it('accepts usage up to exactly the limits', () => {
    expect(evaluateRules(10, { plan: plan(30, 10), used: 20 }, { plan: plan(30, 10), used: 20 })).toEqual([]);
  });
});

describe('consumption rules', () => {
  it('accepts a request within all limits and increments user and account usage equally', async () => {
    const { api, accountId } = await setupAccount(ctx, {
      account: { monthlyAllowance: 1000, maxUnitsPerRequest: 100 },
      users: { u: { monthlyAllowance: 500, maxUnitsPerRequest: 50 } },
    });
    const res = await api.consume('u', 30, 'r1').expect(200);
    expect(res.headers['idempotent-replayed']).toBe('false');
    expect(res.body).toMatchObject({
      requestId: 'r1',
      userId: 'u',
      units: 30,
      accepted: true,
      decision: 'accepted',
      blockedBy: null,
      violations: [],
      replayed: false,
      user: { consumed: 30, remaining: 470, monthlyAllowance: 500, maxUnitsPerRequest: 50 },
      account: { consumed: 30, remaining: 970, monthlyAllowance: 1000, maxUnitsPerRequest: 100 },
    });
    expect(res.body.month).toMatch(/^\d{4}-\d{2}$/);
    await assertUsageInvariant(ctx.pool, accountId);
  });

  it('rejects on the user per-request limit (scope user)', async () => {
    const { api, accountId } = await setupAccount(ctx, {
      account: { monthlyAllowance: 1000, maxUnitsPerRequest: 100 },
      users: { u: { monthlyAllowance: 500, maxUnitsPerRequest: 50 } },
    });
    const res = await api.consume('u', 51).expect(200);
    expect(res.body.accepted).toBe(false);
    expect(res.body.blockedBy).toMatchObject({ scope: 'user', rule: 'max_units_per_request', limit: 50, requested: 51 });
    expect((await dbUsage(ctx.pool, accountId)).account).toEqual([]);
  });

  it('rejects on the account per-request limit (scope account)', async () => {
    const { api } = await setupAccount(ctx, {
      account: { monthlyAllowance: 1000, maxUnitsPerRequest: 20 },
      users: { u: { monthlyAllowance: 500, maxUnitsPerRequest: 50 } },
    });
    const res = await api.consume('u', 21).expect(200);
    expect(res.body.blockedBy).toMatchObject({ scope: 'account', rule: 'max_units_per_request', limit: 20 });
  });

  it('rejects on the user monthly allowance, at the exact boundary', async () => {
    const { api } = await setupAccount(ctx, {
      account: { monthlyAllowance: 1000, maxUnitsPerRequest: 100 },
      users: { u: { monthlyAllowance: 100, maxUnitsPerRequest: 100 } },
    });
    expect((await api.consume('u', 60)).body.accepted).toBe(true);
    expect((await api.consume('u', 40)).body.accepted).toBe(true); // exactly 100
    const res = await api.consume('u', 1).expect(200);
    expect(res.body.blockedBy).toMatchObject({ scope: 'user', rule: 'monthly_allowance', limit: 100, consumed: 100, remaining: 0 });
    expect(res.body.user).toMatchObject({ consumed: 100, remaining: 0 });
  });

  it('enforces the shared account allowance across users', async () => {
    const { api, accountId } = await setupAccount(ctx, {
      account: { monthlyAllowance: 100, maxUnitsPerRequest: 100 },
      users: {
        a: { monthlyAllowance: 1000, maxUnitsPerRequest: 100 },
        b: { monthlyAllowance: 1000, maxUnitsPerRequest: 100 },
      },
    });
    expect((await api.consume('a', 70)).body.accepted).toBe(true);
    const res = await api.consume('b', 40).expect(200);
    expect(res.body.accepted).toBe(false);
    expect(res.body.blockedBy).toMatchObject({ scope: 'account', rule: 'monthly_allowance', consumed: 70, remaining: 30 });
    expect(res.body.user).toMatchObject({ consumed: 0, remaining: 1000 });
    expect((await api.consume('b', 30)).body.accepted).toBe(true);
    const usage = await api.get('/v1/usage').expect(200);
    expect(usage.body.account).toMatchObject({ consumed: 100, remaining: 0 });
    await assertUsageInvariant(ctx.pool, accountId);
  });

  it('rejects fully, with no partial consumption, when only one scope fails', async () => {
    const { api, accountId } = await setupAccount(ctx, {
      account: { monthlyAllowance: 50, maxUnitsPerRequest: 100 },
      users: { u: { monthlyAllowance: 1000, maxUnitsPerRequest: 100 } },
    });
    await api.consume('u', 40).expect(200);
    // 40 + 20 fits the user plan but not the account plan: nothing at all may be consumed.
    const res = await api.consume('u', 20).expect(200);
    expect(res.body.accepted).toBe(false);
    expect(res.body.violations).toHaveLength(1);
    const usage = await dbUsage(ctx.pool, accountId);
    expect(usage.account.map((r) => r.used)).toEqual([40]);
    expect(usage.users.map((r) => r.used)).toEqual([40]);
    // The rejected decision is still recorded.
    const { rows } = await ctx.pool.query('SELECT accepted, blocking_scope, blocking_rule FROM consumption_requests WHERE account_id = $1 ORDER BY seq', [accountId]);
    expect(rows).toEqual([
      { accepted: true, blocking_scope: null, blocking_rule: null },
      { accepted: false, blocking_scope: 'account', blocking_rule: 'monthly_allowance' },
    ]);
  });

  it('applies the documented order when several rules fail', async () => {
    const { api } = await setupAccount(ctx, {
      account: { monthlyAllowance: 10, maxUnitsPerRequest: 5 },
      users: { u: { monthlyAllowance: 10, maxUnitsPerRequest: 5 } },
    });
    const res = await api.consume('u', 20).expect(200);
    expect(res.body.blockedBy).toMatchObject({ scope: 'user', rule: 'max_units_per_request' });
    expect(res.body.violations.map((v: { scope: string; rule: string }) => `${v.scope}:${v.rule}`)).toEqual([
      'user:max_units_per_request',
      'account:max_units_per_request',
      'user:monthly_allowance',
      'account:monthly_allowance',
    ]);
  });

  it('validates the consume body', async () => {
    const { api } = await setupAccount(ctx, {
      account: { monthlyAllowance: 10, maxUnitsPerRequest: 5 },
      users: { u: { monthlyAllowance: 10, maxUnitsPerRequest: 5 } },
    });
    const bodies = [
      { userId: 'u', units: 0, requestId: 'x' },
      { userId: 'u', units: -1, requestId: 'x' },
      { userId: 'u', units: 1.5, requestId: 'x' },
      { userId: 'u', units: '1', requestId: 'x' },
      { userId: 'u', units: 1 },
      { units: 1, requestId: 'x' },
      { userId: '', units: 1, requestId: 'x' },
      { userId: 'u', units: 1, requestId: '' },
    ];
    for (const body of bodies) {
      const res = await api.post('/v1/consume', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    }
    const unknown = await api.consume('ghost', 1);
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('user_not_found');
  });
});
