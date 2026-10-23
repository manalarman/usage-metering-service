import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Authed, createTestContext } from './helpers';

const ctx = createTestContext();
let a: Authed;
let b: Authed;
let bPlanId: string;
let bApiKeyId: string;

beforeAll(async () => {
  a = ctx.as((await ctx.provision({ name: 'A' })).apiKey);
  b = ctx.as((await ctx.provision({ name: 'B' })).apiKey);
  await a.post('/v1/users', { userId: 'alice' }).expect(201);
  await b.post('/v1/users', { userId: 'bob' }).expect(201);
  // Same external id in both accounts: they are different users.
  await b.post('/v1/users', { userId: 'shared-name' }).expect(201);
  await a.post('/v1/users', { userId: 'shared-name' }).expect(201);
  bPlanId = (await b.post('/v1/plans', { name: 'B private', scope: 'user', monthlyAllowance: 5, maxUnitsPerRequest: 5 }).expect(201)).body.id;
  bApiKeyId = (await b.get('/v1/api-keys').expect(200)).body.data[0].id;
  await b.consume('bob', 7, 'req-1').expect(200);
});
afterAll(() => ctx.close());

describe('cross-account isolation', () => {
  it("cannot consume for, view, or re-plan another account's user", async () => {
    const consume = await a.consume('bob', 1);
    expect(consume.status).toBe(404);
    expect(consume.body.error.code).toBe('user_not_found');
    await a.get('/v1/users/bob').expect(404);
    await a.get('/v1/users/bob/usage').expect(404);
    await a.put('/v1/users/bob/plan', { planId: 'premium' }).expect(404);
    await a.get('/v1/usage/history?userId=bob').expect(404);
  });

  it("cannot see, update, or assign another account's custom plan", async () => {
    await a.get(`/v1/plans/${bPlanId}`).expect(404);
    await a.patch(`/v1/plans/${bPlanId}`, { monthlyAllowance: 999 }).expect(404);
    await a.put('/v1/users/alice/plan', { planId: bPlanId }).expect(404);
    const plans = await a.get('/v1/plans').expect(200);
    expect(plans.body.data.map((p: { id: string }) => p.id)).not.toContain(bPlanId);
    // Unchanged for B.
    expect((await b.get(`/v1/plans/${bPlanId}`).expect(200)).body.monthlyAllowance).toBe(5);
  });

  it("cannot revoke another account's API key", async () => {
    await a.del(`/v1/api-keys/${bApiKeyId}`).expect(404);
    await b.get('/v1/account').expect(200);
  });

  it('request ids are scoped per account', async () => {
    // B already used "req-1"; A can use it independently.
    const res = await a.consume('alice', 3, 'req-1').expect(200);
    expect(res.body.accepted).toBe(true);
    expect(res.body.replayed).toBe(false);
    await a.get('/v1/requests/req-1').expect(200);
    expect((await b.get('/v1/requests/req-1').expect(200)).body.userId).toBe('bob');
  });

  it("users with the same external id in different accounts have independent usage", async () => {
    await a.consume('shared-name', 10).expect(200);
    expect((await a.get('/v1/users/shared-name/usage').expect(200)).body.user.consumed).toBe(10);
    expect((await b.get('/v1/users/shared-name/usage').expect(200)).body.user.consumed).toBe(0);
  });

  it('usage, users and history only show the calling account', async () => {
    const usersA = (await a.get('/v1/users').expect(200)).body.data.map((u: { userId: string }) => u.userId);
    expect(usersA.sort()).toEqual(['alice', 'shared-name']);
    const historyB = (await b.get('/v1/requests').expect(200)).body.data;
    expect(historyB.every((r: { userId: string }) => r.userId === 'bob')).toBe(true);
    expect((await b.get('/v1/usage').expect(200)).body.account.consumed).toBe(7);
  });
});
