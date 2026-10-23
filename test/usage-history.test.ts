import { afterAll, describe, expect, it } from 'vitest';
import { assertUsageInvariant, createTestContext, setupAccount } from './helpers';

const ctx = createTestContext();
afterAll(() => {
  ctx.clock.now = new Date();
  return ctx.close();
});

const limits = {
  account: { monthlyAllowance: 100, maxUnitsPerRequest: 100 },
  users: { u: { monthlyAllowance: 60, maxUnitsPerRequest: 100 }, v: { monthlyAllowance: 60, maxUnitsPerRequest: 100 } },
};

describe('UTC monthly usage', () => {
  it('assigns usage to the UTC month of processing and starts each month at zero', async () => {
    const { api, accountId } = await setupAccount(ctx, limits);

    ctx.clock.now = new Date('2026-01-31T23:59:59.999Z');
    const jan = await api.consume('u', 60).expect(200);
    expect(jan.body).toMatchObject({ accepted: true, month: '2026-01' });
    expect((await api.consume('u', 1)).body.accepted).toBe(false); // user exhausted in January

    ctx.clock.now = new Date('2026-02-01T00:00:00.000Z');
    const feb = await api.consume('u', 60).expect(200);
    expect(feb.body).toMatchObject({ accepted: true, month: '2026-02', user: { consumed: 60 }, account: { consumed: 60 } });

    // Previous month stays queryable; current month defaults to the clock's month.
    expect((await api.get('/v1/users/u/usage?month=2026-01').expect(200)).body).toMatchObject({
      month: '2026-01',
      isCurrentMonth: false,
      user: { consumed: 60, remaining: 0 },
      account: { consumed: 60, remaining: 40 },
    });
    expect((await api.get('/v1/usage').expect(200)).body).toMatchObject({ month: '2026-02', isCurrentMonth: true, account: { consumed: 60 } });
    expect((await api.get('/v1/usage?month=2025-12').expect(200)).body.account).toMatchObject({ consumed: 0, remaining: 100 });

    const history = (await api.get('/v1/usage/history').expect(200)).body;
    expect(history.months).toEqual([
      { month: '2026-02', consumed: 60 },
      { month: '2026-01', consumed: 60 },
    ]);
    expect((await api.get('/v1/usage/history?userId=v').expect(200)).body.months).toEqual([]);
    await assertUsageInvariant(ctx.pool, accountId);
  });

  it('uses UTC, not server-local or client offsets, to pick the month', async () => {
    const { api } = await setupAccount(ctx, limits);
    // 2026-03-01T00:30+01:00 is still February in UTC.
    ctx.clock.now = new Date('2026-03-01T00:30:00+01:00');
    expect((await api.consume('v', 5)).body.month).toBe('2026-02');
    ctx.clock.now = new Date('2026-02-28T23:30:00-01:00'); // = 2026-03-01T00:30Z
    expect((await api.consume('v', 5)).body.month).toBe('2026-03');
  });

  it('handles year boundaries', async () => {
    const { api } = await setupAccount(ctx, limits);
    ctx.clock.now = new Date('2026-12-31T23:59:59Z');
    expect((await api.consume('u', 10)).body.month).toBe('2026-12');
    ctx.clock.now = new Date('2027-01-01T00:00:00Z');
    expect((await api.consume('u', 10)).body).toMatchObject({ month: '2027-01', user: { consumed: 10 } });
  });

  it('validates the month parameter', async () => {
    const { api } = await setupAccount(ctx, limits);
    for (const m of ['2026-13', '2026-1', '26-01', 'abc', '2026-01-01']) {
      expect((await api.get(`/v1/usage?month=${m}`)).status).toBe(400);
    }
  });

  it('reports currently assigned plans and effective limits', async () => {
    ctx.clock.now = new Date();
    const { api } = await setupAccount(ctx, limits);
    const res = await api.get('/v1/users/u/usage').expect(200);
    expect(res.body.user).toMatchObject({ userId: 'u', plan: { name: 'plan-u' }, limits: { monthlyAllowance: 60, maxUnitsPerRequest: 100 } });
    expect(res.body.account).toMatchObject({ plan: { name: 'acct-plan' }, limits: { monthlyAllowance: 100, maxUnitsPerRequest: 100 } });
  });
});

describe('request history', () => {
  it('paginates newest-first with a stable cursor and no gaps or duplicates', async () => {
    ctx.clock.now = new Date();
    const { api } = await setupAccount(ctx, {
      account: { monthlyAllowance: 10_000, maxUnitsPerRequest: 100 },
      users: { u: { monthlyAllowance: 10_000, maxUnitsPerRequest: 10 }, v: { monthlyAllowance: 10_000, maxUnitsPerRequest: 10 } },
    });
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const id = `h-${i}`;
      ids.push(id);
      await api.consume(i % 2 ? 'v' : 'u', i === 3 ? 50 : 1, id).expect(200); // h-3 is rejected
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await api.get(`/v1/requests?limit=3${cursor ? `&cursor=${cursor}` : ''}`).expect(200);
      expect(res.body.data.length).toBeLessThanOrEqual(3);
      seen.push(...res.body.data.map((r: { requestId: string }) => r.requestId));
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual([...ids].reverse());

    // A new request arriving mid-pagination does not shift older pages.
    const first = (await api.get('/v1/requests?limit=3').expect(200)).body;
    await api.consume('u', 1, 'h-late').expect(200);
    const second = (await api.get(`/v1/requests?limit=3&cursor=${first.nextCursor}`).expect(200)).body;
    expect(second.data.map((r: { requestId: string }) => r.requestId)).toEqual(['h-3', 'h-2', 'h-1']);
  });

  it('filters by user, decision and month', async () => {
    ctx.clock.now = new Date();
    const { api } = await setupAccount(ctx, {
      account: { monthlyAllowance: 10_000, maxUnitsPerRequest: 100 },
      users: { u: { monthlyAllowance: 10_000, maxUnitsPerRequest: 10 }, v: { monthlyAllowance: 10_000, maxUnitsPerRequest: 10 } },
    });
    await api.consume('u', 1, 'f1');
    await api.consume('u', 20, 'f2'); // rejected
    await api.consume('v', 1, 'f3');
    const byUser = (await api.get('/v1/requests?userId=u').expect(200)).body.data;
    expect(byUser.map((r: { requestId: string }) => r.requestId)).toEqual(['f2', 'f1']);
    const rejected = (await api.get('/v1/requests?decision=rejected').expect(200)).body.data;
    expect(rejected.map((r: { requestId: string }) => r.requestId)).toEqual(['f2']);
    expect(rejected[0].blockedBy).toMatchObject({ scope: 'user', rule: 'max_units_per_request' });
    expect((await api.get('/v1/requests?month=1999-01').expect(200)).body.data).toEqual([]);
    await api.get('/v1/requests?limit=0').expect(400);
    await api.get('/v1/requests?limit=500').expect(400);
    await api.get('/v1/requests?cursor=abc').expect(400);
    await api.get('/v1/requests/nope').expect(404);
  });
});
