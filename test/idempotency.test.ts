import { afterAll, describe, expect, it } from 'vitest';
import { assertUsageInvariant, createTestContext, dbUsage, setupAccount } from './helpers';

const ctx = createTestContext();
afterAll(() => ctx.close());

const limits = {
  account: { monthlyAllowance: 1000, maxUnitsPerRequest: 100 },
  users: { u: { monthlyAllowance: 100, maxUnitsPerRequest: 50 }, v: { monthlyAllowance: 100, maxUnitsPerRequest: 50 } },
};

describe('idempotent retries', () => {
  it('replays an accepted request without consuming again', async () => {
    const { api, accountId } = await setupAccount(ctx, limits);
    const first = await api.consume('u', 25, 'req-a').expect(200);
    const retry = await api.consume('u', 25, 'req-a').expect(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.replayed).toBe(true);
    const { replayed: _a, ...o1 } = first.body;
    const { replayed: _b, ...o2 } = retry.body;
    expect(o2).toEqual(o1);
    const usage = await dbUsage(ctx.pool, accountId);
    expect(usage.account[0].used).toBe(25);
    expect(usage.users[0].used).toBe(25);
    const { rows } = await ctx.pool.query('SELECT count(*)::int AS n FROM consumption_requests WHERE account_id = $1', [accountId]);
    expect(rows[0].n).toBe(1);
  });

  it('replays a rejected request as rejected, even after limits change', async () => {
    const { api, userPlans } = await setupAccount(ctx, limits);
    const first = await api.consume('u', 60, 'req-r').expect(200);
    expect(first.body.accepted).toBe(false);
    // Raise the limit: a *new* request would now pass, but the retry must return the original outcome.
    await api.patch(`/v1/plans/${userPlans.u}`, { maxUnitsPerRequest: 100 }).expect(200);
    const retry = await api.consume('u', 60, 'req-r').expect(200);
    expect(retry.body).toMatchObject({ accepted: false, replayed: true, blockedBy: first.body.blockedBy });
    const fresh = await api.consume('u', 60, 'req-r2').expect(200);
    expect(fresh.body.accepted).toBe(true);
  });

  it('returns 409 when a request id is reused with different input', async () => {
    const { api, accountId } = await setupAccount(ctx, limits);
    await api.consume('u', 10, 'req-c').expect(200);
    const diffUnits = await api.consume('u', 11, 'req-c');
    expect(diffUnits.status).toBe(409);
    expect(diffUnits.body.error).toMatchObject({ code: 'idempotency_conflict', details: { original: { userId: 'u', units: 10 } } });
    const diffUser = await api.consume('v', 10, 'req-c');
    expect(diffUser.status).toBe(409);
    expect((await dbUsage(ctx.pool, accountId)).account[0].used).toBe(10);
    // The original is unaffected and still replayable.
    expect((await api.consume('u', 10, 'req-c').expect(200)).body.replayed).toBe(true);
  });

  it('also detects conflicts against stored rejected decisions', async () => {
    const { api } = await setupAccount(ctx, limits);
    await api.consume('u', 99, 'req-x').expect(200);
    expect((await api.consume('u', 5, 'req-x')).status).toBe(409);
  });

  it('processes concurrent duplicates of one request exactly once', async () => {
    const { api, accountId } = await setupAccount(ctx, limits);
    const results = await Promise.all(Array.from({ length: 20 }, () => api.consume('u', 7, 'dup-burst')));
    expect(results.every((r) => r.status === 200 && r.body.accepted)).toBe(true);
    expect(results.filter((r) => !r.body.replayed)).toHaveLength(1);
    const usage = await assertUsageInvariant(ctx.pool, accountId);
    expect(usage.account[0].used).toBe(7);
  });
});
