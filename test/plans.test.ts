import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PREDEFINED_PLANS } from '../src/db/seed';
import { Authed, createTestContext } from './helpers';

const ctx = createTestContext();
let api: Authed;

beforeAll(async () => {
  api = ctx.as((await ctx.provision()).apiKey);
});
afterAll(() => ctx.close());

describe('predefined plans', () => {
  it('are seeded with the documented limits', async () => {
    const res = await api.get('/v1/plans').expect(200);
    const predefined = res.body.data.filter((p: { predefined: boolean }) => p.predefined);
    expect(predefined.map((p: { code: string }) => p.code).sort()).toEqual(['basic', 'premium', 'pro', 'starter']);
    for (const seed of PREDEFINED_PLANS) {
      expect(predefined).toContainEqual(
        expect.objectContaining({
          id: seed.id,
          code: seed.code,
          scope: seed.scope,
          monthlyAllowance: seed.monthlyAllowance,
          maxUnitsPerRequest: seed.maxUnitsPerRequest,
        }),
      );
    }
  });

  it('can be filtered by scope and fetched by id or code', async () => {
    const userPlans = (await api.get('/v1/plans?scope=user').expect(200)).body.data;
    expect(userPlans.every((p: { scope: string }) => p.scope === 'user')).toBe(true);
    const byCode = await api.get('/v1/plans/premium').expect(200);
    const byId = await api.get(`/v1/plans/${byCode.body.id}`).expect(200);
    expect(byId.body).toEqual(byCode.body);
  });

  it('are read-only', async () => {
    const res = await api.patch('/v1/plans/starter', { monthlyAllowance: 1 });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('plan_read_only');
    expect((await api.get('/v1/plans/starter').expect(200)).body.monthlyAllowance).toBe(10_000);
  });
});

describe('custom plans', () => {
  it('can be created, viewed and updated by their owner', async () => {
    const created = await api.post('/v1/plans', { name: 'Gold', scope: 'user', monthlyAllowance: 500, maxUnitsPerRequest: 50 }).expect(201);
    expect(created.body).toMatchObject({ name: 'Gold', scope: 'user', predefined: false, code: null, version: 1 });
    const updated = await api.patch(`/v1/plans/${created.body.id}`, { monthlyAllowance: 800, name: 'Gold+' }).expect(200);
    expect(updated.body).toMatchObject({ name: 'Gold+', monthlyAllowance: 800, maxUnitsPerRequest: 50, version: 2 });
    expect((await api.get(`/v1/plans/${created.body.id}`).expect(200)).body).toEqual(updated.body);
  });

  it('rejects duplicate names within the same scope', async () => {
    await api.post('/v1/plans', { name: 'Dup', scope: 'account', monthlyAllowance: 1, maxUnitsPerRequest: 1 }).expect(201);
    const dup = await api.post('/v1/plans', { name: 'Dup', scope: 'account', monthlyAllowance: 1, maxUnitsPerRequest: 1 });
    expect(dup.status).toBe(409);
    await api.post('/v1/plans', { name: 'Dup', scope: 'user', monthlyAllowance: 1, maxUnitsPerRequest: 1 }).expect(201);
  });

  it('validates input', async () => {
    const cases = [
      {},
      { name: 'x', scope: 'team', monthlyAllowance: 1, maxUnitsPerRequest: 1 },
      { name: 'x', scope: 'user', monthlyAllowance: -1, maxUnitsPerRequest: 1 },
      { name: 'x', scope: 'user', monthlyAllowance: 1, maxUnitsPerRequest: 0 },
      { name: 'x', scope: 'user', monthlyAllowance: 1.5, maxUnitsPerRequest: 1 },
      { name: '', scope: 'user', monthlyAllowance: 1, maxUnitsPerRequest: 1 },
      { name: 'x', scope: 'user', monthlyAllowance: 1, maxUnitsPerRequest: 1, extra: true },
    ];
    for (const body of cases) {
      const res = await api.post('/v1/plans', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    }
    const plan = await api.post('/v1/plans', { name: 'v', scope: 'user', monthlyAllowance: 1, maxUnitsPerRequest: 1 }).expect(201);
    await api.patch(`/v1/plans/${plan.body.id}`, {}).expect(400);
    await api.patch(`/v1/plans/${plan.body.id}`, { scope: 'account' }).expect(400);
  });
});

describe('plan assignment', () => {
  it('validates plan type on assignment', async () => {
    await api.post('/v1/users', { userId: 'u1' }).expect(201);
    const userAsAccount = await api.put('/v1/account/plan', { planId: 'basic' });
    expect(userAsAccount.status).toBe(422);
    expect(userAsAccount.body.error.code).toBe('plan_scope_mismatch');
    const accountAsUser = await api.put('/v1/users/u1/plan', { planId: 'pro' });
    expect(accountAsUser.status).toBe(422);
    await api.post('/v1/users', { userId: 'u2', planId: 'starter' }).expect(422);
    await api.put('/v1/users/u1/plan', { planId: 'does-not-exist' }).expect(404);
  });

  it('defaults new users to Basic and supports switching', async () => {
    const user = await api.post('/v1/users', { userId: 'u3' }).expect(201);
    expect(user.body.plan.code).toBe('basic');
    const switched = await api.put('/v1/users/u3/plan', { planId: 'premium' }).expect(200);
    expect(switched.body.plan.code).toBe('premium');
    expect((await api.put('/v1/account/plan', { planId: 'pro' }).expect(200)).body.plan.code).toBe('pro');
  });

  it('rejects duplicate user ids within an account', async () => {
    await api.post('/v1/users', { userId: 'dupe' }).expect(201);
    const res = await api.post('/v1/users', { userId: 'dupe' });
    expect(res.status).toBe(409);
  });

  it('lets several users share one plan definition with independent usage', async () => {
    const shared = await api.post('/v1/plans', { name: 'Shared', scope: 'user', monthlyAllowance: 100, maxUnitsPerRequest: 100 }).expect(201);
    for (const u of ['s1', 's2', 's3']) await api.post('/v1/users', { userId: u, planId: shared.body.id }).expect(201);
    expect((await api.consume('s1', 100)).body.accepted).toBe(true);
    expect((await api.consume('s1', 1)).body.accepted).toBe(false);
    expect((await api.consume('s2', 40)).body.accepted).toBe(true);
    expect((await api.get('/v1/users/s1/usage').expect(200)).body.user).toMatchObject({ consumed: 100, remaining: 0 });
    expect((await api.get('/v1/users/s2/usage').expect(200)).body.user).toMatchObject({ consumed: 40, remaining: 60 });
    expect((await api.get('/v1/users/s3/usage').expect(200)).body.user).toMatchObject({ consumed: 0, remaining: 100 });
  });

  it('paginates the user list', async () => {
    const fresh = ctx.as((await ctx.provision()).apiKey);
    for (const u of ['a', 'b', 'c', 'd', 'e']) await fresh.post('/v1/users', { userId: u }).expect(201);
    const p1 = (await fresh.get('/v1/users?limit=2').expect(200)).body;
    const p2 = (await fresh.get(`/v1/users?limit=2&cursor=${p1.nextCursor}`).expect(200)).body;
    const p3 = (await fresh.get(`/v1/users?limit=2&cursor=${p2.nextCursor}`).expect(200)).body;
    expect([...p1.data, ...p2.data, ...p3.data].map((u: { userId: string }) => u.userId)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(p3.nextCursor).toBeNull();
  });
});
